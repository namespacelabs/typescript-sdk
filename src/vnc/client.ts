/**
 * VNC client: connect a websocket endpoint, complete the RFB handshake, and
 * expose screenshots and pointer events.
 */
import WebSocket, { type RawData } from "ws";
import { VncEndpointError, VncTimeoutError } from "./errors.js";
import { encodePng } from "./png.js";
import {
	BufferedReader,
	buttonMask,
	framebufferUpdateRequest,
	handshake,
	keyEvent,
	keysymForChar,
	pointerEvent,
	readFramebufferUpdate,
	skipColorMap,
} from "./protocol.js";

const defaultConnectTimeoutMs = 30_000;

/** Mouse button for pointer events. */
export type PointerButton = "left" | "middle" | "right";

export interface OperationOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface ClickOptions extends OperationOptions {
	/** Mouse button to click. Defaults to `"left"`. */
	button?: PointerButton;
}

export interface Screenshot {
	/** PNG-encoded image data. */
	png: Uint8Array;
	/** Framebuffer width in pixels. */
	width: number;
	/** Framebuffer height in pixels. */
	height: number;
	/** Desktop name reported by the VNC server. */
	desktopName: string;
}

export interface OpenVncOptions {
	/** Websocket endpoint (`ws://` or `wss://`); bare hosts default to `wss://`. */
	endpoint: string;
	username: string;
	password: string;
	/** Additional headers for the websocket upgrade request. */
	headers?: Record<string, string>;
	signal?: AbortSignal;
	/**
	 * Budget for connecting and completing the RFB handshake. Defaults to
	 * 30 seconds.
	 */
	timeoutMs?: number;
}

/**
 * Open a VNC session: connect the websocket and complete the RFB handshake
 * (version, security, `ClientInit`, `ServerInit`, pixel format, and
 * encodings).
 *
 * Rejects with `VncTimeoutError` when the handshake exceeds `timeoutMs` and
 * `VncEndpointError` when the endpoint answers the upgrade with an HTTP
 * error.
 */
export async function openVnc(options: OpenVncOptions): Promise<VncClient> {
	const url = new URL(options.endpoint.includes("://") ? options.endpoint : `wss://${options.endpoint}`);
	if (url.protocol !== "ws:" && url.protocol !== "wss:") {
		throw new Error(`unsupported VNC endpoint protocol ${url.protocol}`);
	}
	const timeoutMs = options.timeoutMs ?? defaultConnectTimeoutMs;
	const websocket = new WebSocket(url, {
		headers: options.headers,
		handshakeTimeout: timeoutMs,
	});
	const reader = new BufferedReader();
	websocket.on("message", (data: RawData) => reader.push(rawDataToBuffer(data)));
	websocket.on("error", (error) => reader.fail(error));
	websocket.on("close", () => reader.fail(new Error("VNC connection closed")));

	const timer = setTimeout(() => {
		reader.fail(new VncTimeoutError("timed out performing VNC handshake", timeoutMs));
		websocket.terminate();
	}, timeoutMs);
	const onAbort = () => {
		reader.fail(abortError(options.signal));
		websocket.terminate();
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		if (options.signal?.aborted) throw abortError(options.signal);
		await opened(websocket);
		const write = (data: Buffer) => new Promise<void>((resolve, reject) => {
			websocket.send(data, { binary: true }, (error) => (error ? reject(error) : resolve()));
		});
		const { width, height, desktopName } = await handshake(reader, write, options.username, options.password);
		return new VncClient(websocket, reader, write, width, height, desktopName);
	} catch (error) {
		websocket.terminate();
		throw error;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * An established VNC session.
 *
 * RFB is a stateful byte stream, so operations run one at a time; an
 * operation abandoned mid-message (timeout or abort) leaves the stream
 * unusable and closes the connection.
 */
export class VncClient {
	private queue: Promise<void> = Promise.resolve();
	private closed = false;

	constructor(
		private readonly websocket: WebSocket,
		private readonly reader: BufferedReader,
		private readonly write: (data: Buffer) => Promise<void>,
		readonly width: number,
		readonly height: number,
		readonly desktopName: string,
	) {}

	close(): void {
		this.closed = true;
		this.websocket.terminate();
	}

	onClose(listener: () => void): void {
		this.websocket.once("close", listener);
	}

	/** Capture the full framebuffer and encode it as a PNG. */
	async screenshot(options: OperationOptions = {}): Promise<Screenshot> {
		return this.run(options, () => this.captureScreenshot());
	}

	/** Click at framebuffer coordinates: move, press, release. */
	async click(x: number, y: number, options: ClickOptions = {}): Promise<void> {
		if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= this.width || y < 0 || y >= this.height) {
			throw new RangeError(`click position ${x},${y} is outside ${this.width}x${this.height}`);
		}
		const mask = buttonMask(options.button ?? "left");
		return this.run(options, async () => {
			await this.write(pointerEvent(0, x, y));
			await this.write(pointerEvent(mask, x, y));
			await this.write(pointerEvent(0, x, y));
		});
	}

	/**
	 * Type text by sending a key press and release per character. Newlines
	 * send Return; tabs, backspaces, and escapes send their dedicated keys.
	 * Other control characters reject with `RangeError`.
	 */
	async type(text: string, options: OperationOptions = {}): Promise<void> {
		const keysyms = [...text].map(keysymForChar);
		return this.run(options, async () => {
			for (const keysym of keysyms) {
				await this.write(keyEvent(true, keysym));
				await this.write(keyEvent(false, keysym));
			}
		});
	}

	private async captureScreenshot(): Promise<Screenshot> {
		await this.write(framebufferUpdateRequest(this.width, this.height));
		const rgba = Buffer.alloc(this.width * this.height * 4);
		for (;;) {
			const messageType = await this.reader.uint8();
			if (messageType === 0) {
				const rectangles = await readFramebufferUpdate(this.reader, rgba, this.width, this.height);
				if (rectangles > 0) {
					return {
						png: encodePng(rgba, this.width, this.height),
						width: this.width,
						height: this.height,
						desktopName: this.desktopName,
					};
				}
				await this.write(framebufferUpdateRequest(this.width, this.height));
			} else if (messageType === 1) {
				await skipColorMap(this.reader);
			} else if (messageType === 2) {
				continue; // Bell: no payload.
			} else if (messageType === 3) {
				await this.reader.read(3);
				await this.reader.read(await this.reader.uint32());
			} else {
				throw new Error(`unsupported RFB server message type ${messageType}`);
			}
		}
	}

	private async run<T>(options: OperationOptions, operation: () => Promise<T>): Promise<T> {
		const perform = this.queue.then(async () => {
			if (this.closed) throw new Error("VNC connection is closed");
			return operation();
		});
		this.queue = perform.then(() => {}, () => {});
		try {
			return await waitFor(perform, options);
		} catch (error) {
			// A failed operation may have stopped mid-message (timeout,
			// abort, or an in-stream protocol error); the stream position
			// is unknown, so the session is unusable.
			this.close();
			throw error;
		}
	}
}

function rawDataToBuffer(data: RawData): Buffer {
	if (Array.isArray(data)) return Buffer.concat(data);
	if (data instanceof ArrayBuffer) return Buffer.from(data);
	return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function opened(websocket: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			websocket.off("open", onOpen);
			websocket.off("error", onError);
			websocket.off("close", onClose);
			websocket.off("unexpected-response", onUnexpectedResponse);
		};
		const onOpen = () => { cleanup(); resolve(); };
		const onError = (error: Error) => { cleanup(); reject(error); };
		const onClose = () => { cleanup(); reject(new Error("VNC connection closed while connecting")); };
		const onUnexpectedResponse = (_request: unknown, response: { statusCode: number }) => {
			cleanup();
			reject(new VncEndpointError(response.statusCode));
		};
		websocket.once("open", onOpen);
		websocket.once("error", onError);
		websocket.once("close", onClose);
		websocket.once("unexpected-response", onUnexpectedResponse);
	});
}

function waitFor<T>(promise: Promise<T>, options: OperationOptions): Promise<T> {
	if (!options.signal && options.timeoutMs === undefined) return promise;
	return new Promise((resolve, reject) => {
		let settled = false;
		const timer = options.timeoutMs === undefined ? undefined : setTimeout(
			() => finish(new VncTimeoutError(`VNC operation timed out after ${options.timeoutMs}ms`, options.timeoutMs)),
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

function abortError(signal?: AbortSignal): Error {
	if (signal?.reason instanceof Error) return signal.reason;
	const error = new Error("operation aborted");
	error.name = "AbortError";
	return error;
}
