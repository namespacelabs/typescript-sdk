import { Readable } from "node:stream";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";

// ssh2 is CommonJS; Node's ESM named-export detection does not surface
// `utils`, so import the default export and destructure.
import ssh2 from "ssh2";
import type {
	FileEntryWithStats,
	ReadStream as SftpReadStream,
	SFTPWrapper,
	Stats,
} from "ssh2";
import {
	CreatePortRequestSchema,
	ListPortsRequestSchema,
	Port_Owner,
	PortSpec_Kind,
	type Port as ProtoPort,
} from "../proto/namespace/private/devbox/wire/wire_pb.js";
import { collectExec, ConnectionManager, operationDeadline, withDeadline } from "./connection.js";
import type { AgentConnection } from "./connection.js";
import {
	DevboxTimeoutError,
	ExecutionNotFoundError,
	ExposedPortNotFoundError,
	IncompleteResponseError,
} from "./errors.js";
import type {
	ClickOptions,
	CopyOptions,
	Devbox as DevboxModel,
	DevboxDisplay,
	DevboxExecution,
	DevboxExecutions,
	DevboxFileSystem,
	DevboxInfo,
	DirEntry,
	ExecutionLogChunk,
	ExecutionStatus,
	ExecutionStopOptions,
	ExecutionWaitOptions,
	ExecOptions,
	ExecResult,
	ExposedPort,
	ExposedPortInfo,
	ExposedPortResource,
	ExposedPortSelector,
	MkdirOptions,
	OperationOptions,
	ReadOptions,
	RemoveOptions,
	Screenshot,
	ServiceResource,
	ShellOptions,
	StartExecOptions,
	StartShellOptions,
	TerminalOpenOptions,
	TerminalSession,
	TransferOptions,
	UpdateDevboxInput,
	WriteFileOptions,
} from "./models.js";
import { ServiceResources } from "./services.js";

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
	readonly display: DevboxDisplay;
	readonly executions: DevboxExecutions;
	readonly services: ServiceResource;
	readonly exposedPorts: ExposedPortResource;

	constructor(
		private currentInfo: DevboxInfo,
		private readonly connections: ConnectionManager,
		private readonly controller: DevboxController,
	) {
		this.fs = new RemoteFileSystem(this);
		this.terminal = { open: (options) => this.openTerminal(options) };
		this.display = {
			screenshot: (options) => this.screenshot(options),
			click: (x, y, options) => this.click(x, y, options),
		};
		this.executions = {
			start: (argv, options) => this.startExec(argv, options),
			startShell: (script, options) => this.startShell(script, options),
			get: (id, options) => this.getExecution(id, options),
			list: (options) => this.listExecutions(options),
		};
		this.services = new ServiceResources(this.id, connections);
		this.exposedPorts = {
			create: (input, options) => this.createExposedPort(input, options),
			get: (selector, options) => this.getExposedPort(selector, options),
			list: (options) => this.listExposedPorts(options),
			delete: (selector, options) => this.deleteExposedPort(selector, options),
		};
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

	private async startExec(argv: readonly string[], options: StartExecOptions = {}): Promise<DevboxExecution> {
		const deadline = operationDeadline(options);
		const connection = await this.connections.getAgent(this.id, withDeadline(options, deadline));
		this.markRunning(connection.instanceId);
		const id = await connection.startExec(argv, withDeadline(options, deadline));
		return new ExecutionHandle(id, this.id, this.connections);
	}

	private async startShell(script: string, options: StartShellOptions = {}): Promise<DevboxExecution> {
		return this.startExec([options.shell ?? this.currentInfo.shell ?? "/bin/sh", "-lc", script], options);
	}

	private async getExecution(id: string, options: OperationOptions = {}): Promise<DevboxExecution> {
		if (!id) throw new TypeError("execution id must not be empty");
		const execution = new ExecutionHandle(id, this.id, this.connections);
		if ((await execution.status(options)).state === "missing") throw new ExecutionNotFoundError(id);
		return execution;
	}

	private async listExecutions(options: OperationOptions = {}): Promise<DevboxExecution[]> {
		const deadline = operationDeadline(options);
		const connection = await this.connections.getAgent(this.id, withDeadline(options, deadline));
		const actions = await connection.listExecutions(withDeadline(options, deadline));
		return actions.map((action) => new ExecutionHandle(action.id, this.id, this.connections));
	}

	private async createExposedPort(
		input: ExposedPort,
		options: OperationOptions = {},
	): Promise<ExposedPortInfo> {
		validateExposedPort(input);

		const request = create(CreatePortRequestSchema, {
			spec: {
				name: input.name ?? "",
				number: input.number,
				kind: PortSpec_Kind.HTTP_INGRESS,
			},
		});
		const deadline = operationDeadline(options);
		const agent = await this.connections.getAgent(this.id, withDeadline(options, deadline));
		const response = await agent.createPort(request, withDeadline(options, deadline));
		return exposedPort(required(response.port, "create exposed port response"), this.id);
	}

	private async getExposedPort(
		selector: ExposedPortSelector,
		options: OperationOptions = {},
	): Promise<ExposedPortInfo> {
		validateExposedPortSelector(selector);
		const deadline = operationDeadline(options);
		const agent = await this.connections.getAgent(this.id, withDeadline(options, deadline));
		return resolveExposedPort(
			await listExposedPorts(agent, this.id, withDeadline(options, deadline)),
			selector,
		);
	}

	private async listExposedPorts(options: OperationOptions = {}): Promise<ExposedPortInfo[]> {
		const deadline = operationDeadline(options);
		const agent = await this.connections.getAgent(this.id, withDeadline(options, deadline));
		return listExposedPorts(agent, this.id, withDeadline(options, deadline));
	}

	private async deleteExposedPort(
		selector: ExposedPortSelector,
		options: OperationOptions = {},
	): Promise<void> {
		validateExposedPortSelector(selector);
		const deadline = operationDeadline(options);
		const agent = await this.connections.getAgent(this.id, withDeadline(options, deadline));
		const selected = resolveExposedPort(
			await listExposedPorts(agent, this.id, withDeadline(options, deadline)),
			selector,
		);

		try {
			await agent.deletePort(selected.id, withDeadline(options, deadline));
		} catch (error) {
			if (error instanceof ConnectError && error.code === Code.NotFound) {
				throw new ExposedPortNotFoundError(selector);
			}
			throw error;
		}
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

	private async screenshot(options: OperationOptions = {}): Promise<Screenshot> {
		const deadline = operationDeadline(options);
		const connection = await this.connections.getDisplay(this.id, withDeadline(options, deadline));
		this.markRunning(connection.instanceId);
		return connection.screenshot(withDeadline(options, deadline));
	}

	private async click(x: number, y: number, options: ClickOptions = {}): Promise<void> {
		const deadline = operationDeadline(options);
		const connection = await this.connections.getDisplay(this.id, withDeadline(options, deadline));
		this.markRunning(connection.instanceId);
		return connection.click(x, y, withDeadline(options, deadline));
	}

	private markRunning(instanceId: string): void {
		if (this.currentInfo.instanceId === instanceId && this.currentInfo.state === "running") return;
		this.currentInfo = { ...this.currentInfo, state: "running", instanceId };
	}

	private replaceInfo(info: DevboxInfo): void {
		this.currentInfo = info;
	}
}

class ExecutionHandle implements DevboxExecution {
	constructor(
		readonly id: string,
		private readonly devboxId: string,
		private readonly connections: ConnectionManager,
	) {}

	async status(options: OperationOptions = {}): Promise<ExecutionStatus> {
		const deadline = operationDeadline(options);
		const connection = await this.connections.getAgent(this.devboxId, withDeadline(options, deadline));
		return connection.executionStatus(this.id, withDeadline(options, deadline));
	}

	async stop(options: ExecutionStopOptions = {}): Promise<void> {
		if (options.mode !== undefined && options.mode !== "graceful" && options.mode !== "force") {
			throw new TypeError('execution stop mode must be "graceful" or "force"');
		}
		const deadline = operationDeadline(options);
		const connection = await this.connections.getAgent(this.devboxId, withDeadline(options, deadline));
		await connection.stopExecution(this.id, withDeadline(options, deadline));
	}

	async *logs(options: OperationOptions = {}): AsyncIterableIterator<ExecutionLogChunk> {
		operationDeadline(options);
		// Connection acquisition has its own client-wide budget; it does not consume the read timeout.
		const connection = await this.connections.getAgent(this.devboxId, { signal: options.signal });
		yield* connection.executionLogs(this.id, options);
	}

	wait(options: ExecutionWaitOptions = {}): Promise<ExecResult> {
		return collectExec(this.logs(options), { ...options, maxOutputBytes: options.maxOutputBytes ?? 10 * 1024 * 1024 });
	}
}

async function listExposedPorts(
	agent: AgentConnection,
	devboxId: string,
	options: OperationOptions,
): Promise<ExposedPortInfo[]> {
	const response = await agent.listPorts(create(ListPortsRequestSchema, {
		kinds: [PortSpec_Kind.HTTP_INGRESS],
	}), options);

	return response.ports.map((entry) => {
		return exposedPort(required(entry.port, "list exposed ports response"), devboxId);
	});
}

function resolveExposedPort(ports: ExposedPortInfo[], selector: ExposedPortSelector): ExposedPortInfo {
	const selected = selector.id !== undefined
		? ports.find((candidate) => candidate.id === selector.id)
		: selector.name !== undefined
			? ports.find((candidate) => candidate.name === selector.name)
			: ports.find((candidate) => candidate.number === selector.number);

	if (!selected) {
		throw new ExposedPortNotFoundError(selector);
	}

	return selected;
}

function exposedPort(proto: ProtoPort, devboxId: string): ExposedPortInfo {
	if (
		!proto.id ||
		!proto.spec ||
		!validPortNumber(proto.spec.number) ||
		proto.spec.kind !== PortSpec_Kind.HTTP_INGRESS
	) {
		throw new IncompleteResponseError("devbox exposed port response");
	}

	return {
		id: proto.id,
		name: proto.spec.name || undefined,
		number: proto.spec.number,
		url: `https://dbx${devboxId}-p${proto.spec.number}.devbox.so/`,
		owner: exposedPortOwner(proto.owner),
	};
}

function exposedPortOwner(value: Port_Owner): ExposedPortInfo["owner"] {
	switch (value) {
		case Port_Owner.USER:
			return "user";
		case Port_Owner.NAMESPACE:
			return "namespace";
		default:
			return "unknown";
	}
}

function validateExposedPort(input: ExposedPort): void {
	if (!validPortNumber(input.number)) {
		throw new RangeError("exposed port number must be an integer between 1 and 65535");
	}
	if (input.name !== undefined && !input.name.trim()) {
		throw new TypeError("exposed port name must not be empty");
	}
}

function validateExposedPortSelector(selector: ExposedPortSelector): void {
	if (!selector || typeof selector !== "object") {
		throw new TypeError("exposed port selector must specify exactly one of id, name, or number");
	}

	const specified = [selector.id, selector.name, selector.number].filter((value) => value !== undefined);
	if (specified.length !== 1) {
		throw new TypeError("exposed port selector must specify exactly one of id, name, or number");
	}
	if (selector.id !== undefined && !selector.id) {
		throw new TypeError("exposed port id must not be empty");
	}
	if (selector.name !== undefined && !selector.name.trim()) {
		throw new TypeError("exposed port name must not be empty");
	}
	if (selector.number !== undefined && !validPortNumber(selector.number)) {
		throw new RangeError("exposed port number must be an integer between 1 and 65535");
	}
}

function validPortNumber(value: number): boolean {
	return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function required<T>(value: T | undefined, context: string): T {
	if (value === undefined) {
		throw new IncompleteResponseError(context);
	}

	return value;
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

	async read(
		remotePath: string,
		options?: ReadOptions & {
			format?: "text";
		},
	): Promise<string>;

	async read(
		remotePath: string,
		options: ReadOptions & {
			format: "bytes";
		},
	): Promise<Uint8Array>;

	async read(
		remotePath: string,
		options: ReadOptions & {
			format: "stream";
		},
	): Promise<ReadableStream<Uint8Array>>;

	async read(
		remotePath: string,
		options: ReadOptions & {
			format?: "text" | "bytes" | "stream";
		} = {},
	): Promise<string | Uint8Array | ReadableStream<Uint8Array>> {
		validateReadOptions(options);

		const stream = await this.withSftp(options, async (sftp, operationOptions) => {
			const nodeStream = sftp.createReadStream(remotePath, {
				start: options.offset,
				end: options.length === undefined
					? undefined
					: (options.offset ?? 0) + options.length - 1,
			});

			watchStream(nodeStream, operationOptions);
			return nodeStream;
		});

		if (options.format === "stream") {
			return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
		}

		const chunks: Uint8Array[] = [];
		for await (const chunk of stream) {
			chunks.push(chunk);
		}

		const bytes = Buffer.concat(chunks);
		if (options.format === "bytes") {
			return bytes;
		}

		return new TextDecoder().decode(bytes);
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

function validateReadOptions(options: ReadOptions & { format?: string }): void {
	if (
		options.format !== undefined
		&& options.format !== "text"
		&& options.format !== "bytes"
		&& options.format !== "stream"
	) {
		throw new TypeError('read format must be "text", "bytes", or "stream"');
	}

	if (
		options.offset !== undefined
		&& (!Number.isSafeInteger(options.offset) || options.offset < 0)
	) {
		throw new RangeError("read offset must be a non-negative safe integer");
	}

	if (
		options.length !== undefined
		&& (!Number.isSafeInteger(options.length) || options.length <= 0)
	) {
		throw new RangeError("read length must be a positive safe integer");
	}

	if (
		options.length !== undefined
		&& (options.offset ?? 0) > Number.MAX_SAFE_INTEGER - options.length
	) {
		throw new RangeError("read range exceeds the maximum safe integer");
	}
}

function watchStream(stream: SftpReadStream, options: OperationOptions): void {
	const timer = options.timeoutMs === undefined
		? undefined
		: setTimeout(() => {
			const error = new DevboxTimeoutError(
				`devbox filesystem operation timed out after ${options.timeoutMs}ms`,
				options.timeoutMs,
			);

			stream.destroy(error);
		}, options.timeoutMs);

	const onAbort = () => {
		stream.destroy(abortError(options.signal));
	};

	const cleanup = () => {
		if (timer) {
			clearTimeout(timer);
		}

		options.signal?.removeEventListener("abort", onAbort);
	};

	stream.once("close", cleanup);
	stream.once("end", cleanup);

	if (options.signal?.aborted) {
		onAbort();
	} else {
		options.signal?.addEventListener("abort", onAbort, { once: true });
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
