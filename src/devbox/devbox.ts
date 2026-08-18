// ssh2 is CommonJS; Node's ESM named-export detection does not surface
// `utils`, so import the default export and destructure.
import ssh2 from "ssh2";
import type { FileEntryWithStats, SFTPWrapper, Stats } from "ssh2";
import { ConnectionManager, operationDeadline, withDeadline } from "./connection.js";
import { DevboxTimeoutError } from "./errors.js";
import type {
	CopyOptions,
	Devbox as DevboxModel,
	DevboxFileSystem,
	DevboxInfo,
	DirEntry,
	ExecOptions,
	ExecResult,
	MkdirOptions,
	OperationOptions,
	RemoveOptions,
	ShellOptions,
	TerminalOpenOptions,
	TerminalSession,
	TransferOptions,
	UpdateDevboxInput,
	WriteFileOptions,
} from "./models.js";

const { utils: sshUtils } = ssh2;

export interface DevboxController {
	start(devbox: DevboxHandle, options?: OperationOptions): Promise<DevboxInfo>;
	stop(devbox: DevboxHandle, options?: OperationOptions): Promise<DevboxInfo>;
	delete(devbox: DevboxHandle, options?: OperationOptions): Promise<void>;
	refresh(devbox: DevboxHandle, options?: OperationOptions): Promise<DevboxInfo>;
	update(devbox: DevboxHandle, input: UpdateDevboxInput, options?: OperationOptions): Promise<DevboxInfo>;
}

export class DevboxHandle implements DevboxModel {
	readonly fs: DevboxFileSystem;
	readonly terminal: {
		open: (options?: TerminalOpenOptions) => Promise<TerminalSession>;
	};

	constructor(
		private currentInfo: DevboxInfo,
		private readonly connections: ConnectionManager,
		private readonly controller: DevboxController,
	) {
		this.fs = new RemoteFileSystem(this);
		this.terminal = { open: (options) => this.openTerminal(options) };
	}

	get id(): string {
		return this.currentInfo.id;
	}

	get name(): string {
		return this.currentInfo.name;
	}

	get info(): Readonly<DevboxInfo> {
		return this.currentInfo;
	}

	async exec(argv: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
		const deadline = operationDeadline(options);
		const connection = await this.connections.getAgent(this.id, withDeadline(options, deadline));
		this.markRunning(connection.instanceId);
		return connection.exec(argv, withDeadline(options, deadline));
	}

	async shell(script: string, options: ShellOptions = {}): Promise<ExecResult> {
		const deadline = operationDeadline(options);
		const connection = await this.connections.getAgent(this.id, withDeadline(options, deadline));
		this.markRunning(connection.instanceId);
		return connection.shell(script, {
			...withDeadline(options, deadline),
			shell: options.shell ?? this.currentInfo.shell,
		});
	}

	async start(options?: OperationOptions): Promise<this> {
		this.replaceInfo(await this.controller.start(this, options));
		return this;
	}

	async stop(options?: OperationOptions): Promise<this> {
		this.replaceInfo(await this.controller.stop(this, options));
		return this;
	}

	async delete(options?: OperationOptions): Promise<void> {
		await this.controller.delete(this, options);
	}

	async refresh(options?: OperationOptions): Promise<this> {
		this.replaceInfo(await this.controller.refresh(this, options));
		return this;
	}

	async update(input: UpdateDevboxInput, options?: OperationOptions): Promise<this> {
		this.replaceInfo(await this.controller.update(this, input, options));
		return this;
	}

	async connection(options: OperationOptions = {}) {
		return this.connections.get(this.id, options);
	}

	private async openTerminal(options: TerminalOpenOptions = {}): Promise<TerminalSession> {
		const deadline = operationDeadline(options);
		const connection = await this.connection(withDeadline(options, deadline));
		this.markRunning(connection.instanceId);
		return connection.openTerminal(withDeadline(options, deadline));
	}

	private markRunning(instanceId: string): void {
		if (this.currentInfo.instanceId === instanceId && this.currentInfo.state === "running") return;
		this.currentInfo = { ...this.currentInfo, state: "running", instanceId };
	}

	private replaceInfo(info: DevboxInfo): void {
		this.currentInfo = info;
	}
}

class RemoteFileSystem implements DevboxFileSystem {
	constructor(private readonly devbox: DevboxHandle) {}

	async upload(localPath: string, remotePath: string, options: TransferOptions = {}): Promise<void> {
		await this.withSftp(options, (sftp, operationOptions) => sftpCall<void>(operationOptions, (callback) => {
			sftp.fastPut(localPath, remotePath, {
				step: options.onProgress ? (transferred, _chunk, total) => options.onProgress!(transferred, total) : undefined,
			}, callback);
		}));
	}

	async download(remotePath: string, localPath: string, options: TransferOptions = {}): Promise<void> {
		await this.withSftp(options, (sftp, operationOptions) => sftpCall<void>(operationOptions, (callback) => {
			sftp.fastGet(remotePath, localPath, {
				step: options.onProgress ? (transferred, _chunk, total) => options.onProgress!(transferred, total) : undefined,
			}, callback);
		}));
	}

	async copy(sourcePath: string, destinationPath: string, options: CopyOptions = {}): Promise<void> {
		const result = await this.devbox.exec([
			"cp",
			...(options.recursive ? ["-R"] : []),
			"--",
			sourcePath,
			destinationPath,
		], options);
		if (result.exitCode !== 0) {
			throw new Error(result.stderr.trim() || `copy failed with exit code ${result.exitCode}`);
		}
	}

	async readFile(remotePath: string, options: OperationOptions = {}): Promise<Uint8Array> {
		return this.withSftp(options, (sftp, operationOptions) => sftpCall<Buffer>(operationOptions, (callback) => {
			sftp.readFile(remotePath, callback);
		}));
	}

	async writeFile(
		remotePath: string,
		data: string | Uint8Array,
		options: WriteFileOptions = {},
	): Promise<void> {
		await this.withSftp(options, (sftp, operationOptions) => sftpCall<void>(operationOptions, (callback) => {
			sftp.writeFile(remotePath, typeof data === "string" ? data : Buffer.from(data), {
				mode: options.mode,
			}, callback);
		}));
	}

	async exists(remotePath: string, options: OperationOptions = {}): Promise<boolean> {
		return this.withSftp(options, async (sftp, operationOptions) => {
			try {
				await sftpCall<Stats>(operationOptions, (callback) => sftp.stat(remotePath, callback));
				return true;
			} catch (error) {
				if (isNoSuchFile(error)) return false;
				throw error;
			}
		});
	}

	async rename(oldPath: string, newPath: string, options: OperationOptions = {}): Promise<void> {
		await this.withSftp(options, (sftp, operationOptions) => sftpCall<void>(operationOptions, (callback) => {
			sftp.rename(oldPath, newPath, callback);
		}));
	}

	async mkdir(remotePath: string, options: MkdirOptions = {}): Promise<void> {
		await this.withSftp(options, async (sftp, operationOptions) => {
			const attributes = options.mode === undefined ? {} : { mode: options.mode };
			if (!options.recursive) {
				await sftpCall<void>(operationOptions, (callback) => sftp.mkdir(remotePath, attributes, callback));
				return;
			}
			for (const prefix of directoryPrefixes(remotePath)) {
				try {
					await sftpCall<void>(operationOptions, (callback) => sftp.mkdir(prefix, attributes, callback));
				} catch (error) {
					// Tolerate already-existing directories; surface anything else.
					const stats = await sftpCall<Stats>(operationOptions, (callback) => sftp.stat(prefix, callback))
						.catch(() => undefined);
					if (!stats?.isDirectory()) throw error;
				}
			}
		});
	}

	async remove(remotePath: string, options: RemoveOptions = {}): Promise<void> {
		if (options.recursive) {
			const result = await this.devbox.exec(["rm", "-rf", "--", remotePath], options);
			if (result.exitCode !== 0) {
				throw new Error(result.stderr.trim() || `remove failed with exit code ${result.exitCode}`);
			}
			return;
		}
		await this.withSftp(options, async (sftp, operationOptions) => {
			const stats = await sftpCall<Stats>(operationOptions, (callback) => sftp.lstat(remotePath, callback));
			if (stats.isDirectory()) {
				await sftpCall<void>(operationOptions, (callback) => sftp.rmdir(remotePath, callback));
			} else {
				await sftpCall<void>(operationOptions, (callback) => sftp.unlink(remotePath, callback));
			}
		});
	}

	async readdir(remotePath: string, options: OperationOptions = {}): Promise<DirEntry[]> {
		return this.withSftp(options, async (sftp, operationOptions) => {
			const entries = await sftpCall<FileEntryWithStats[]>(operationOptions, (callback) => {
				sftp.readdir(remotePath, callback);
			});
			return entries.map((entry) => ({ name: entry.filename, type: entryType(entry.attrs) }));
		});
	}

	private async withSftp<T>(
		options: OperationOptions,
		operation: (sftp: SFTPWrapper, options: OperationOptions) => Promise<T>,
	): Promise<T> {
		const deadline = operationDeadline(options);
		const connection = await this.devbox.connection(withDeadline(options, deadline));
		// The SFTP channel is cached per connection; do not close it here.
		const sftp = await connection.sftp(withDeadline(options, deadline));
		return operation(sftp, withDeadline(options, deadline));
	}
}

function entryType(stats: Stats): DirEntry["type"] {
	if (stats.isDirectory()) return "directory";
	if (stats.isSymbolicLink()) return "symlink";
	if (stats.isFile()) return "file";
	return "other";
}

function isNoSuchFile(error: unknown): boolean {
	return error instanceof Error
		&& (error as Error & { code?: unknown }).code === sshUtils.sftp.STATUS_CODE.NO_SUCH_FILE;
}

function directoryPrefixes(remotePath: string): string[] {
	const isAbsolute = remotePath.startsWith("/");
	const parts = remotePath.split("/").filter((part) => part !== "" && part !== ".");
	const prefixes: string[] = [];
	let current = "";
	for (const part of parts) {
		current = current === "" ? (isAbsolute ? `/${part}` : part) : `${current}/${part}`;
		prefixes.push(current);
	}
	return prefixes.length > 0 ? prefixes : [remotePath];
}

function sftpCall<T>(
	options: OperationOptions,
	start: (callback: (error?: Error | null, result?: T) => void) => void,
): Promise<T> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const timer = options.timeoutMs === undefined ? undefined : setTimeout(
			() => finish(new DevboxTimeoutError(`devbox filesystem operation timed out after ${options.timeoutMs}ms`, options.timeoutMs)),
			options.timeoutMs,
		);
		const onAbort = () => finish(abortError(options.signal));
		const finish = (error?: Error | null, result?: T) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			// The SFTP channel is shared; channel-level failures invalidate the
			// connection's cache via its error/close events.
			if (error) reject(error);
			else resolve(result as T);
		};
		if (options.signal?.aborted) onAbort();
		else {
			options.signal?.addEventListener("abort", onAbort, { once: true });
			start(finish);
		}
	});
}

function abortError(signal?: AbortSignal): Error {
	if (signal?.reason instanceof Error) return signal.reason;
	const error = new Error("operation aborted");
	error.name = "AbortError";
	return error;
}
