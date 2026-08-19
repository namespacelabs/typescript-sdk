import { Duplex } from "node:stream";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Client as RpcClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { Client, type ClientChannel, type SFTPWrapper } from "ssh2";
import WebSocket, { type RawData } from "ws";
import { TOKEN_MIN_VALIDITY_MS } from "../auth/caching.js";
import type { TokenSource } from "../auth/types.js";
import { DevBoxService } from "../proto/namespace/private/devbox/devbox_pb.js";
import {
	AgentService,
	StartExecRequestSchema,
	type ExecLogChunk,
	type StartExecRequest,
} from "../proto/namespace/private/devbox/wire/wire_pb.js";
import {
	computeApiBaseUrl,
	createComputeClient,
	fetchVncConfig,
	openDisplay,
	type ComputeClient,
	type DisplayConnection,
} from "./display.js";
import { DevboxGatewayError, DevboxTimeoutError, IncompleteResponseError } from "./errors.js";
import type {
	ExecOptions,
	ExecResult,
	OperationOptions,
	ShellOptions,
	TerminalOpenOptions,
	TerminalSession,
} from "./models.js";

type DevboxRpcClient = RpcClient<typeof DevBoxService>;

class GatewaySocket extends Duplex {
	constructor(private readonly websocket: WebSocket) {
		super();
		websocket.on("message", (data: RawData) => this.push(rawDataBuffer(data)));
		websocket.on("close", () => this.push(null));
		websocket.on("error", (error) => this.destroy(error));
	}

	_read(): void {}

	_write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		if (this.websocket.readyState !== WebSocket.OPEN) {
			callback(new Error("devbox gateway connection is closed"));
			return;
		}
		this.websocket.send(chunk, { binary: true }, callback);
	}

	_final(callback: (error?: Error | null) => void): void {
		this.websocket.close();
		callback();
	}

	_destroy(error: Error | null, callback: (error?: Error | null) => void): void {
		this.websocket.terminate();
		callback(error);
	}

	/**
	 * Invoke `listener` once the underlying gateway websocket closes. Unlike
	 * the Duplex "close" event, this fires as soon as the transport is gone,
	 * even while a consumer still holds the writable side open.
	 */
	onceClosed(listener: () => void): void {
		this.websocket.once("close", listener);
	}
}

function rawDataBuffer(data: RawData): Buffer {
	if (Array.isArray(data)) return Buffer.concat(data);
	if (data instanceof ArrayBuffer) return Buffer.from(data);
	return data;
}

export class SshConnection {
	private sftpPromise?: Promise<SFTPWrapper>;

	constructor(
		readonly instanceId: string,
		private readonly client: Client,
	) {}

	close(): void {
		this.client.end();
	}

	onClose(listener: () => void): void {
		this.client.once("close", listener);
	}

	async openTerminal(options: TerminalOpenOptions = {}): Promise<TerminalSession> {
		const deadline = operationDeadline(options);
		const channel = await openChannel<ClientChannel>(
			(callback) => this.client.shell({
				cols: options.columns ?? 80,
				rows: options.rows ?? 24,
				term: options.term ?? "xterm-256color",
			}, { env: options.env }, callback),
			withDeadline(options, deadline),
		);
		return new SshTerminal(channel, options.signal);
	}

	/**
	 * Get the SFTP channel for this connection.
	 *
	 * The channel is opened once and cached: concurrent callers share a
	 * single in-flight open, and subsequent callers reuse the open channel.
	 * The cache is invalidated when the channel errors or closes, so the next
	 * caller opens a fresh one.
	 */
	async sftp(options: OperationOptions = {}): Promise<SFTPWrapper> {
		const deadline = operationDeadline(options);
		if (!this.sftpPromise) {
			const promise = openChannel<SFTPWrapper>(
				(callback) => this.client.sftp(callback),
				withDeadline(options, deadline),
			);
			this.sftpPromise = promise;
			const invalidate = () => {
				if (this.sftpPromise === promise) this.sftpPromise = undefined;
			};
			promise.then((sftp) => {
				sftp.once("error", invalidate);
				sftp.once("close", invalidate);
			}, invalidate);
		}
		return waitFor(this.sftpPromise, withDeadline(options, deadline));
	}
}

/**
 * gRPC connection to the devbox agent, used for command execution.
 *
 * Commands run through `AgentService.RunExec`: argv, cwd, environment, and
 * stdin travel structurally (no shell quoting), and the agent retains the
 * command and its output for later inspection (`devbox logs`).
 */
export class AgentConnection {
	private readonly client: RpcClient<typeof AgentService>;

	constructor(
		readonly instanceId: string,
		private readonly socket: GatewaySocket,
	) {
		let consumed = false;
		const transport = createGrpcTransport({
			// The gateway websocket is already bound to this devbox's agent;
			// the authority is synthetic and never resolved.
			baseUrl: "http://devbox-agent",
			nodeOptions: {
				createConnection: () => {
					// The HTTP/2 session owns the socket. If the session ever
					// reconnects, the socket is gone: fail fast so the caller
					// retries through a fresh AgentConnection.
					if (consumed) throw new Error("devbox agent connection is closed");
					consumed = true;
					return socket;
				},
			},
		});
		this.client = createClient(AgentService, transport);
	}

	close(): void {
		this.socket.destroy();
	}

	onClose(listener: () => void): void {
		this.socket.onceClosed(listener);
	}

	async exec(argv: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
		const deadline = operationDeadline(options);
		return this.run(buildExecRequest(argv, options), options, deadline);
	}

	async shell(script: string, options: ShellOptions = {}): Promise<ExecResult> {
		const deadline = operationDeadline(options);
		const shell = options.shell ?? "/bin/sh";
		return this.run(buildExecRequest([shell, "-lc", script], options), options, deadline);
	}

	private async run(request: StartExecRequest, options: ExecOptions, deadline: number | undefined): Promise<ExecResult> {
		const callOptions = withDeadline(options, deadline);
		try {
			return await collectExec(this.client.runExec(request, {
				signal: callOptions.signal,
				timeoutMs: callOptions.timeoutMs,
			}), options);
		} catch (error) {
			if (error instanceof ConnectError && error.code === Code.DeadlineExceeded && callOptions.timeoutMs !== undefined) {
				throw new DevboxTimeoutError(`devbox command timed out after ${callOptions.timeoutMs}ms`, callOptions.timeoutMs);
			}
			throw error;
		}
	}
}

/**
 * Build a `RunExec` request from argv and exec options. Arguments,
 * environment, and stdin are structured protobuf fields — nothing passes
 * through a shell.
 */
export function buildExecRequest(
	argv: readonly string[],
	options: Pick<ExecOptions, "cwd" | "env" | "stdin"> = {},
): StartExecRequest {
	if (argv.length === 0) throw new TypeError("exec requires at least one argument");
	const environment = Object.entries(options.env ?? {});
	for (const [name] of environment) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new TypeError(`invalid environment variable name: ${name}`);
	}
	return create(StartExecRequestSchema, {
		command: {
			command: argv[0],
			args: argv.slice(1),
			cwd: options.cwd === undefined ? undefined : options.cwd.startsWith("/")
				? { absolute: options.cwd }
				: { workspaceRelative: options.cwd },
			additionalEnvironment: environment.map(([name, value]) => ({ name, value })),
			stdin: options.stdin === undefined ? undefined : {
				value: typeof options.stdin === "string" ? new TextEncoder().encode(options.stdin) : options.stdin,
			},
		},
	});
}

/**
 * Consume an exec log stream: route stdout/stderr chunks to callbacks while
 * buffering them, and map the final result chunk to an `ExecResult`.
 */
export async function collectExec(
	stream: AsyncIterable<ExecLogChunk>,
	options: Pick<ExecOptions, "onStdout" | "onStderr">,
): Promise<ExecResult> {
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let result: { exitCode: number; error: string } | undefined;
	for await (const chunk of stream) {
		if (chunk.stdout.length > 0) {
			const data = Buffer.from(chunk.stdout);
			stdout.push(data);
			options.onStdout?.(data);
		}
		if (chunk.stderr.length > 0) {
			const data = Buffer.from(chunk.stderr);
			stderr.push(data);
			options.onStderr?.(data);
		}
		if (chunk.result) result = chunk.result;
	}
	if (!result) throw new IncompleteResponseError("devbox exec stream");
	return {
		exitCode: result.exitCode,
		signal: null,
		...(result.error === "" ? {} : { error: result.error }),
		stdout: Buffer.concat(stdout).toString("utf8"),
		stderr: Buffer.concat(stderr).toString("utf8"),
	};
}

class SshTerminal implements TerminalSession {
	private readonly dataListeners = new Set<(data: Uint8Array) => void>();
	private readonly exitListeners = new Set<(exitCode: number | null, signal: string | null) => void>();
	private readonly errorListeners = new Set<(error: Error) => void>();
	private readonly abortSignal?: AbortSignal;
	private readonly handleAbort = () => this.close();
	private closed = false;
	private exitResult?: { exitCode: number | null; signal: string | null };
	private readonly waitResolvers: Array<(result: { exitCode: number | null; signal: string | null }) => void> = [];

	constructor(
		private readonly channel: ClientChannel,
		signal?: AbortSignal,
	) {
		channel.on("data", (data: Buffer) => this.emitData(data));
		channel.stderr.on("data", (data: Buffer) => this.emitData(data));
		channel.once("close", (code: number, exitSignal: string) => {
			this.closed = true;
			this.removeAbortListener();
			this.exitResult = { exitCode: code ?? null, signal: exitSignal || null };
			for (const listener of this.exitListeners) listener(this.exitResult.exitCode, this.exitResult.signal);
			for (const resolve of this.waitResolvers.splice(0)) resolve(this.exitResult);
		});
		channel.on("error", (error: Error) => {
			for (const listener of this.errorListeners) listener(error);
		});
		if (signal) {
			this.abortSignal = signal;
			if (signal.aborted) this.close();
			else signal.addEventListener("abort", this.handleAbort, { once: true });
		}
	}

	write(data: string | Uint8Array): void {
		if (this.closed) throw new Error("terminal is closed");
		this.channel.write(typeof data === "string" ? data : Buffer.from(data));
	}

	resize(columns: number, rows: number): void {
		if (this.closed) throw new Error("terminal is closed");
		this.channel.setWindow(rows, columns, 0, 0);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.removeAbortListener();
		this.channel.close();
	}

	onData(listener: (data: Uint8Array) => void): () => void {
		this.dataListeners.add(listener);
		return () => this.dataListeners.delete(listener);
	}

	onExit(listener: (exitCode: number | null, signal: string | null) => void): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	onError(listener: (error: Error) => void): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	wait(): Promise<{ exitCode: number | null; signal: string | null }> {
		if (this.exitResult) return Promise.resolve(this.exitResult);
		return new Promise((resolve) => this.waitResolvers.push(resolve));
	}

	private emitData(data: Buffer): void {
		for (const listener of this.dataListeners) listener(data);
	}

	private removeAbortListener(): void {
		this.abortSignal?.removeEventListener("abort", this.handleAbort);
	}
}

interface ManagedConnection {
	close(): void;
	onClose(listener: () => void): void;
}

interface ConnectionRecord<T extends ManagedConnection> {
	controller: AbortController;
	promise: Promise<T>;
	connection?: T;
}

export class ConnectionManager {
	private readonly sshRecords = new Map<string, ConnectionRecord<SshConnection>>();
	private readonly agentRecords = new Map<string, ConnectionRecord<AgentConnection>>();
	private readonly displayRecords = new Map<string, ConnectionRecord<DisplayConnection>>();
	private readonly computeClients = new Map<string, ComputeClient>();
	private closed = false;

	constructor(
		private readonly rpc: DevboxRpcClient,
		private readonly tokenSource: TokenSource,
		private readonly connectTimeoutMs: number,
	) {}

	async get(ref: string, options: OperationOptions = {}): Promise<SshConnection> {
		return this.acquire(this.sshRecords, ref, (signal) => this.connect(ref, signal), options);
	}

	async getAgent(ref: string, options: OperationOptions = {}): Promise<AgentConnection> {
		return this.acquire(this.agentRecords, ref, (signal) => this.connectAgent(ref, signal), options);
	}

	async getDisplay(ref: string, options: OperationOptions = {}): Promise<DisplayConnection> {
		return this.acquire(this.displayRecords, ref, (signal) => this.connectDisplay(ref, signal), options);
	}

	invalidate(ref: string): void {
		invalidateRecord(this.sshRecords, ref);
		invalidateRecord(this.agentRecords, ref);
		invalidateRecord(this.displayRecords, ref);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const records of [this.sshRecords, this.agentRecords, this.displayRecords] as const) {
			for (const record of records.values()) {
				record.controller.abort();
				record.connection?.close();
			}
			records.clear();
		}
	}

	private async acquire<T extends ManagedConnection>(
		records: Map<string, ConnectionRecord<T>>,
		ref: string,
		connect: (signal: AbortSignal) => Promise<T>,
		options: OperationOptions,
	): Promise<T> {
		if (this.closed) throw new Error("devbox client is closed");
		let record = records.get(ref);
		if (!record) {
			const controller = new AbortController();
			const createdRecord: ConnectionRecord<T> = {
				controller,
				promise: connect(controller.signal),
			};
			record = createdRecord;
			records.set(ref, createdRecord);
			createdRecord.promise.then((connection) => {
				if (this.closed || records.get(ref) !== createdRecord) {
					connection.close();
					return;
				}
				createdRecord.connection = connection;
				connection.onClose(() => {
					if (records.get(ref) === createdRecord) records.delete(ref);
				});
			}, () => {
				if (records.get(ref) === createdRecord) records.delete(ref);
			});
		}
		return waitFor(record.promise, options);
	}

	private async connect(ref: string, signal: AbortSignal): Promise<SshConnection> {
		const deadline = operationDeadline({ timeoutMs: this.connectTimeoutMs });
		const activation = await this.rpc.activate({
			idOrName: ref,
			includeSshCredentials: true,
			waitForReadiness: true,
		}, withDeadline({ signal, timeoutMs: this.connectTimeoutMs }, deadline));
		const user = activation.devbox?.mainUser || activation.devbox?.spec?.remoteUser || "root";
		const ingressDomain = activation.instanceMetadataSummary?.ingressDomain;
		if (!activation.instanceId || !ingressDomain || activation.privateSshKey.length === 0) {
			throw new IncompleteResponseError("devbox activation response");
		}

		return connectSsh({
			instanceId: activation.instanceId,
			ingressDomain,
			privateKey: activation.privateSshKey,
			token: await this.issueGatewayToken(signal, deadline),
			user,
			signal,
			timeoutMs: withDeadline({ timeoutMs: this.connectTimeoutMs }, deadline).timeoutMs!,
		});
	}

	private async connectAgent(ref: string, signal: AbortSignal): Promise<AgentConnection> {
		const deadline = operationDeadline({ timeoutMs: this.connectTimeoutMs });
		const activation = await this.rpc.activate({
			idOrName: ref,
			waitForReadiness: true,
		}, withDeadline({ signal, timeoutMs: this.connectTimeoutMs }, deadline));
		const ingressDomain = activation.instanceMetadataSummary?.ingressDomain;
		if (!activation.instanceId || !ingressDomain) {
			throw new IncompleteResponseError("devbox activation response");
		}

		return connectAgent({
			instanceId: activation.instanceId,
			ingressDomain,
			token: await this.issueGatewayToken(signal, deadline),
			signal,
			timeoutMs: withDeadline({ timeoutMs: this.connectTimeoutMs }, deadline).timeoutMs!,
		});
	}

	private async connectDisplay(ref: string, signal: AbortSignal): Promise<DisplayConnection> {
		const deadline = operationDeadline({ timeoutMs: this.connectTimeoutMs });
		const activation = await this.rpc.activate({
			idOrName: ref,
			waitForReadiness: true,
		}, withDeadline({ signal, timeoutMs: this.connectTimeoutMs }, deadline));
		const instanceId = activation.instanceId;
		const ingressDomain = activation.instanceMetadataSummary?.ingressDomain;
		if (!instanceId || !ingressDomain) {
			throw new IncompleteResponseError("devbox activation response");
		}

		// The VNC endpoint and credentials come from the regional Compute
		// API; this rejects with DevboxDisplayUnavailableError when the
		// instance has no display.
		const compute = this.computeClient(computeApiBaseUrl(ingressDomain));
		const config = await fetchVncConfig(compute, instanceId, withDeadline({ signal, timeoutMs: this.connectTimeoutMs }, deadline));
		const token = await this.issueGatewayToken(signal, deadline);
		return connectWithRetry({
			signal,
			timeoutMs: withDeadline({ timeoutMs: this.connectTimeoutMs }, deadline).timeoutMs!,
		}, (remainingMs) => openDisplay({
			instanceId,
			endpoint: config.endpoint,
			username: config.username,
			password: config.password,
			token,
			signal,
			timeoutMs: remainingMs,
		}));
	}

	private computeClient(baseUrl: string): ComputeClient {
		let client = this.computeClients.get(baseUrl);
		if (!client) {
			client = createComputeClient(this.tokenSource, baseUrl);
			this.computeClients.set(baseUrl, client);
		}
		return client;
	}

	/**
	 * Issue a gateway token with the SDK's standard minimum validity, which
	 * must be enough for the token to work; there is no refresh-and-retry
	 * on authentication failures.
	 */
	private issueGatewayToken(signal: AbortSignal, deadline: number | undefined): Promise<string> {
		return waitFor(
			this.tokenSource.issueToken(TOKEN_MIN_VALIDITY_MS),
			withDeadline({ signal, timeoutMs: this.connectTimeoutMs }, deadline),
		);
	}
}

function invalidateRecord<T extends ManagedConnection>(records: Map<string, ConnectionRecord<T>>, ref: string): void {
	const record = records.get(ref);
	if (!record) return;
	records.delete(ref);
	record.controller.abort();
	record.connection?.close();
}

interface ConnectSshOptions {
	instanceId: string;
	ingressDomain: string;
	privateKey: Uint8Array;
	token: string;
	user: string;
	signal: AbortSignal;
	timeoutMs: number;
}

async function connectSsh(options: ConnectSshOptions): Promise<SshConnection> {
	return connectWithRetry(options, (remainingMs) => connectSshOnce(options, remainingMs));
}

interface ConnectAgentOptions {
	instanceId: string;
	ingressDomain: string;
	token: string;
	signal: AbortSignal;
	timeoutMs: number;
}

async function connectAgent(options: ConnectAgentOptions): Promise<AgentConnection> {
	return connectWithRetry(options, async (remainingMs) => {
		const socket = await openGatewaySocket({ ...options, socketName: "agent" }, remainingMs);
		return new AgentConnection(options.instanceId, socket);
	});
}

/**
 * The gateway may not be routable right after an instance starts; retry
 * transient failures with exponential backoff until the deadline.
 */
async function connectWithRetry<T>(
	options: { signal: AbortSignal; timeoutMs: number },
	attempt: (remainingMs: number) => Promise<T>,
): Promise<T> {
	const deadline = Date.now() + options.timeoutMs;
	let delayMs = 500;
	let lastError: unknown;
	while (Date.now() < deadline) {
		if (options.signal.aborted) throw abortError(options.signal);
		try {
			return await attempt(deadline - Date.now());
		} catch (error) {
			lastError = error;
			if (isPermanentConnectionError(error)) throw error;
			await delay(Math.min(delayMs, Math.max(0, deadline - Date.now())), options.signal);
			delayMs = Math.min(delayMs * 2, 5_000);
		}
	}
	throw lastError instanceof Error ? lastError : new DevboxTimeoutError("timed out connecting to devbox", options.timeoutMs);
}

interface GatewayDialOptions {
	instanceId: string;
	ingressDomain: string;
	token: string;
	signal: AbortSignal;
	socketName: string;
}

async function openGatewaySocket(options: GatewayDialOptions, timeoutMs: number): Promise<GatewaySocket> {
	const gatewayUrl = new URL(`wss://gate.${options.ingressDomain}/${encodeURIComponent(options.instanceId)}/hsvc.unixsocket`);
	gatewayUrl.searchParams.set("name", options.socketName);
	const websocket = new WebSocket(gatewayUrl, {
		headers: { Authorization: `Bearer ${options.token}` },
		handshakeTimeout: timeoutMs,
	});
	return openWebSocket(websocket, options.signal, timeoutMs);
}

async function connectSshOnce(options: ConnectSshOptions, timeoutMs: number): Promise<SshConnection> {
	const socket = await openGatewaySocket({ ...options, socketName: "ssh" }, timeoutMs);
	const client = new Client();
	try {
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const onAbort = () => finish(abortError(options.signal));
			const timer = setTimeout(() => finish(new DevboxTimeoutError("timed out performing devbox SSH handshake", timeoutMs)), timeoutMs);
			const cleanup = () => {
				clearTimeout(timer);
				options.signal.removeEventListener("abort", onAbort);
				client.off("ready", onReady);
				client.off("error", onError);
			};
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				if (error) reject(error);
				else resolve();
			};
			const onReady = () => finish();
			const onError = (error: Error) => finish(error);
			if (options.signal.aborted) {
				finish(abortError(options.signal));
			} else {
				options.signal.addEventListener("abort", onAbort, { once: true });
				client.once("ready", onReady);
				client.once("error", onError);
				client.connect({
					host: "devbox",
					username: options.user,
					privateKey: Buffer.from(options.privateKey),
					// The bearer-authenticated TLS gateway and per-instance key are the trust boundary.
					hostVerifier: () => true,
					keepaliveInterval: 15_000,
					keepaliveCountMax: 3,
					readyTimeout: timeoutMs,
					sock: socket,
				});
			}
		});
	} catch (error) {
		client.destroy();
		throw error;
	}
	client.on("error", () => {});
	return new SshConnection(options.instanceId, client);
}

async function openWebSocket(websocket: WebSocket, signal: AbortSignal, timeoutMs: number): Promise<GatewaySocket> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => finish(new DevboxTimeoutError("timed out connecting to devbox gateway", timeoutMs)), timeoutMs);
		const onAbort = () => finish(abortError(signal));
		const onOpen = () => finish();
		const onError = () => finish(new Error("failed to connect to devbox gateway"));
		const onClose = () => finish(new Error("devbox gateway closed while connecting"));
		const onUnexpectedResponse = (_request: unknown, response: { statusCode: number }) => {
			finish(new DevboxGatewayError(response.statusCode));
		};
		const cleanup = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			websocket.off("open", onOpen);
			websocket.off("error", onError);
			websocket.off("close", onClose);
			websocket.off("unexpected-response", onUnexpectedResponse);
		};
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) {
				websocket.terminate();
				reject(error);
			} else {
				resolve(new GatewaySocket(websocket));
			}
		};
		if (signal.aborted) finish(abortError(signal));
		else {
			signal.addEventListener("abort", onAbort, { once: true });
			websocket.once("open", onOpen);
			websocket.once("error", onError);
			websocket.once("close", onClose);
			websocket.once("unexpected-response", onUnexpectedResponse);
		}
	});
}

function isPermanentConnectionError(error: unknown): boolean {
	if (error instanceof DevboxGatewayError) return error.statusCode === 401 || error.statusCode === 403;
	if (!(error instanceof Error)) return false;
	return /authentication|private key|no matching host key/i.test(error.message);
}

function openChannel<T>(
	open: (callback: (error: Error | undefined, channel: T) => void) => void,
	options: OperationOptions,
): Promise<T> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const timer = options.timeoutMs === undefined ? undefined : setTimeout(
			() => finish(new DevboxTimeoutError(`devbox operation timed out after ${options.timeoutMs}ms`, options.timeoutMs)),
			options.timeoutMs,
		);
		const onAbort = () => finish(abortError(options.signal));
		const finish = (error?: Error, channel?: T) => {
			if (settled) {
				closeOpenedChannel(channel);
				return;
			}
			settled = true;
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve(channel as T);
		};
		if (options.signal?.aborted) onAbort();
		else {
			options.signal?.addEventListener("abort", onAbort, { once: true });
			open((error, channel) => finish(error, channel));
		}
	});
}

function closeOpenedChannel(channel: unknown): void {
	if (!channel || typeof channel !== "object") return;
	if ("close" in channel && typeof channel.close === "function") channel.close();
	else if ("end" in channel && typeof channel.end === "function") channel.end();
}

function waitFor<T>(promise: Promise<T>, options: OperationOptions): Promise<T> {
	if (!options.signal && options.timeoutMs === undefined) return promise;
	return new Promise((resolve, reject) => {
		let settled = false;
		const timer = options.timeoutMs === undefined ? undefined : setTimeout(
			() => finish(new DevboxTimeoutError(`devbox operation timed out after ${options.timeoutMs}ms`, options.timeoutMs)),
			options.timeoutMs,
		);
		const onAbort = () => finish(abortError(options.signal));
		const finish = (error?: Error, result?: T) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve(result as T);
		};
		if (options.signal?.aborted) onAbort();
		else {
			options.signal?.addEventListener("abort", onAbort, { once: true });
			promise.then((result) => finish(undefined, result), (error) => finish(error));
		}
	});
}

export function operationDeadline(options: OperationOptions): number | undefined {
	if (options.timeoutMs === undefined) return undefined;
	if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
		throw new RangeError("timeoutMs must be a non-negative finite number");
	}
	return Date.now() + options.timeoutMs;
}

export function withDeadline<T extends OperationOptions>(options: T, deadline: number | undefined): T {
	if (deadline === undefined) return options;
	return { ...options, timeoutMs: Math.max(0, deadline - Date.now()) };
}

function abortError(signal?: AbortSignal): Error {
	if (signal?.reason instanceof Error) return signal.reason;
	const error = new Error("operation aborted");
	error.name = "AbortError";
	return error;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
	if (milliseconds <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(finish, milliseconds);
		const onAbort = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			reject(abortError(signal));
		};
		function finish() {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
