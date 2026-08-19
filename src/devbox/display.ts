/**
 * Devbox display access over VNC (RFB 3.8).
 *
 * Devboxes with a display (macOS devboxes) expose a VNC service through the
 * instance ingress. The SDK speaks just enough RFB to capture raw-encoded
 * framebuffer screenshots and inject pointer events: version and security
 * handshake with Apple Remote Desktop authentication, raw encoding only, and
 * client-side PNG encoding — no native dependencies.
 */
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { Code, ConnectError, createClient, type Client as RpcClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import WebSocket, { type RawData } from "ws";
import { bearerAuthInterceptor } from "../api/interceptors.js";
import type { TokenSource } from "../auth/types.js";
import {
	ComputeService,
	type GetVNCConfigResponse,
} from "../proto/namespace/cloud/compute/v1beta/compute_pb.js";
import { DevboxDisplayUnavailableError, DevboxGatewayError, DevboxTimeoutError } from "./errors.js";
import type { ClickOptions, OperationOptions, Screenshot } from "./models.js";

const rfbVersion = Buffer.from("RFB 003.008\n");
const ardSecurityType = 30;
const noSecurityType = 1;
const rawEncoding = 0;
const maxPixels = 100_000_000;

export type ComputeClient = RpcClient<typeof ComputeService>;

/**
 * Derive the regional Compute API endpoint from an instance's ingress domain
 * (`GetVNCConfig` must be answered by the region that runs the instance).
 */
export function computeApiBaseUrl(ingressDomain: string): string {
	const shortRegion = ingressDomain.replace(/\.nscluster\.cloud$/, "");
	if (shortRegion !== ingressDomain) return `https://${shortRegion}.compute.namespaceapis.com`;
	return `https://api.${ingressDomain}`;
}

export function createComputeClient(tokenSource: TokenSource, baseUrl: string): ComputeClient {
	return createClient(ComputeService, createConnectTransport({
		httpVersion: "1.1",
		baseUrl,
		interceptors: [bearerAuthInterceptor(tokenSource)],
	}));
}

/**
 * Fetch the VNC endpoint and credentials for an instance. The server answers
 * `FailedPrecondition` when the instance has no VNC service; translate that
 * into the typed `DevboxDisplayUnavailableError`.
 */
export async function fetchVncConfig(
	client: ComputeClient,
	instanceId: string,
	options: OperationOptions,
): Promise<GetVNCConfigResponse> {
	try {
		return await client.getVNCConfig({ instanceId }, {
			signal: options.signal,
			timeoutMs: options.timeoutMs,
		});
	} catch (error) {
		if (error instanceof ConnectError && error.code === Code.FailedPrecondition) {
			throw new DevboxDisplayUnavailableError(`devbox does not expose a display: ${error.rawMessage}`);
		}
		throw error;
	}
}

export interface OpenDisplayOptions {
	instanceId: string;
	/** VNC websocket endpoint from `GetVNCConfig`. */
	endpoint: string;
	username: string;
	password: string;
	/** Gateway bearer token, sent as `x-nsc-ingress-auth`. */
	token: string;
	signal: AbortSignal;
	timeoutMs: number;
}

/**
 * Open a VNC session to an instance display: connect the gateway websocket
 * and complete the RFB handshake (version, security, `ClientInit`,
 * `ServerInit`, pixel format, and encodings).
 */
export async function openDisplay(options: OpenDisplayOptions): Promise<DisplayConnection> {
	const url = new URL(options.endpoint.includes("://") ? options.endpoint : `wss://${options.endpoint}`);
	if (url.protocol !== "ws:" && url.protocol !== "wss:") {
		throw new Error(`unsupported VNC endpoint protocol ${url.protocol}`);
	}
	const websocket = new WebSocket(url, {
		headers: { "x-nsc-ingress-auth": `Bearer ${options.token}` },
		handshakeTimeout: options.timeoutMs,
	});
	const reader = new BufferedReader();
	websocket.on("message", (data: RawData) => reader.push(rawDataToBuffer(data)));
	websocket.on("error", (error) => reader.fail(error));
	websocket.on("close", () => reader.fail(new Error("devbox display connection closed")));

	const timer = setTimeout(() => {
		reader.fail(new DevboxTimeoutError("timed out performing devbox display handshake", options.timeoutMs));
		websocket.terminate();
	}, options.timeoutMs);
	const onAbort = () => {
		reader.fail(abortError(options.signal));
		websocket.terminate();
	};
	options.signal.addEventListener("abort", onAbort, { once: true });
	try {
		if (options.signal.aborted) throw abortError(options.signal);
		await opened(websocket);
		const write = (data: Buffer) => new Promise<void>((resolve, reject) => {
			websocket.send(data, { binary: true }, (error) => (error ? reject(error) : resolve()));
		});
		const { width, height, desktopName } = await handshake(reader, write, options.username, options.password);
		return new DisplayConnection(options.instanceId, websocket, reader, write, width, height, desktopName);
	} catch (error) {
		websocket.terminate();
		throw error;
	} finally {
		clearTimeout(timer);
		options.signal.removeEventListener("abort", onAbort);
	}
}

/**
 * An established VNC session to a devbox display.
 *
 * RFB is a stateful byte stream, so operations run one at a time; an
 * operation abandoned mid-message (timeout or abort) leaves the stream
 * unusable and closes the connection, and the next operation reconnects.
 */
export class DisplayConnection {
	private queue: Promise<void> = Promise.resolve();
	private closed = false;

	constructor(
		readonly instanceId: string,
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
			if (this.closed) throw new Error("devbox display connection is closed");
			return operation();
		});
		this.queue = perform.then(() => {}, () => {});
		let finished = false;
		void perform.finally(() => { finished = true; }).catch(() => {});
		try {
			return await waitFor(perform, options);
		} catch (error) {
			// A timed-out or aborted operation may still be mid-message;
			// the stream position is unknown, so the session is unusable.
			if (!finished) this.close();
			throw error;
		}
	}
}

interface ServerInit {
	width: number;
	height: number;
	desktopName: string;
}

async function handshake(
	reader: BufferedReader,
	write: (data: Buffer) => Promise<void>,
	username: string,
	password: string,
): Promise<ServerInit> {
	const serverVersion = await reader.read(rfbVersion.length);
	const versionMatch = /^RFB (\d{3})\.(\d{3})\n$/.exec(serverVersion.toString("ascii"));
	if (!versionMatch || Number(versionMatch[1]) < 3 || Number(versionMatch[2]) < 8) {
		throw new Error(`unsupported RFB version ${JSON.stringify(serverVersion.toString())}`);
	}
	await write(rfbVersion);

	const securityTypeCount = await reader.uint8();
	if (securityTypeCount === 0) {
		throw new Error(`VNC server rejected the connection: ${await readReason(reader)}`);
	}
	const securityTypes = [...(await reader.read(securityTypeCount))];
	const securityType = securityTypes.includes(ardSecurityType)
		? ardSecurityType
		: securityTypes.includes(noSecurityType)
			? noSecurityType
			: undefined;
	if (securityType === undefined) {
		throw new Error(`VNC server offered unsupported security types: ${securityTypes.join(", ")}`);
	}
	await write(Buffer.from([securityType]));
	if (securityType === ardSecurityType) {
		await authenticateArd(reader, write, username, password);
	}
	const securityResult = await reader.uint32();
	if (securityResult !== 0) {
		throw new Error(`VNC authentication failed: ${await readReason(reader)}`);
	}

	await write(Buffer.from([1])); // ClientInit: shared session.
	const width = await reader.uint16();
	const height = await reader.uint16();
	if (width === 0 || height === 0 || width * height > maxPixels) {
		throw new Error(`invalid framebuffer size ${width}x${height}`);
	}
	await reader.read(16); // Server pixel format; replaced by SetPixelFormat below.
	const desktopName = (await reader.read(await reader.uint32())).toString("utf8");
	await write(setPixelFormatMessage());
	await write(setEncodingsMessage());
	return { width, height, desktopName };
}

/**
 * Apple Remote Desktop authentication (RFB security type 30): anonymous
 * Diffie-Hellman key agreement, then username and password encrypted with
 * AES-128-ECB under the MD5 digest of the shared secret.
 */
async function authenticateArd(
	reader: BufferedReader,
	write: (data: Buffer) => Promise<void>,
	username: string,
	password: string,
): Promise<void> {
	if (Buffer.byteLength(username) > 63 || Buffer.byteLength(password) > 63) {
		throw new Error("VNC username and password must each be at most 63 bytes");
	}
	const generator = await reader.read(2);
	const keyLength = await reader.uint16();
	if (keyLength < 16 || keyLength > 512) {
		throw new Error(`invalid ARD Diffie-Hellman key length ${keyLength}`);
	}
	const prime = await reader.read(keyLength);
	const serverPublicKey = await reader.read(keyLength);
	const clientPrivateKey = randomBytes(keyLength);
	const clientPublicKey = modPow(generator, clientPrivateKey, prime);
	const sharedKey = modPow(serverPublicKey, clientPrivateKey, prime);
	const padding = randomBytes(64);
	const credentials = Buffer.concat([
		paddedCredential(username, padding),
		paddedCredential(password, padding),
	]);
	const aesKey = createHash("md5").update(sharedKey).digest();
	const cipher = createCipheriv("aes-128-ecb", aesKey, null);
	cipher.setAutoPadding(false);
	const encryptedCredentials = Buffer.concat([cipher.update(credentials), cipher.final()]);
	await write(Buffer.concat([encryptedCredentials, clientPublicKey]));
}

function paddedCredential(value: string, padding: Buffer): Buffer {
	return Buffer.concat([Buffer.from(value), Buffer.from([0]), padding]).subarray(0, 64);
}

function modPow(baseBytes: Buffer, exponentBytes: Buffer, modulusBytes: Buffer): Buffer {
	const modulus = bytesToBigInt(modulusBytes);
	let base = bytesToBigInt(baseBytes) % modulus;
	let exponent = bytesToBigInt(exponentBytes);
	let result = 1n;
	while (exponent > 0n) {
		if ((exponent & 1n) === 1n) result = (result * base) % modulus;
		exponent >>= 1n;
		base = (base * base) % modulus;
	}
	return bigIntToBuffer(result, modulusBytes.length);
}

function bytesToBigInt(value: Buffer): bigint {
	return BigInt(`0x${value.toString("hex") || "0"}`);
}

function bigIntToBuffer(value: bigint, length: number): Buffer {
	const encoded = value.toString(16).padStart(length * 2, "0");
	return Buffer.from(encoded, "hex").subarray(-length);
}

async function readReason(reader: BufferedReader): Promise<string> {
	const length = await reader.uint32();
	return (await reader.read(length)).toString("utf8");
}

/** SetPixelFormat: 32-bit RGBX, big endian, true color. */
function setPixelFormatMessage(): Buffer {
	const message = Buffer.alloc(20);
	message.writeUInt8(0, 0);
	message.writeUInt8(32, 4);
	message.writeUInt8(24, 5);
	message.writeUInt8(0, 6);
	message.writeUInt8(1, 7);
	message.writeUInt16BE(255, 8);
	message.writeUInt16BE(255, 10);
	message.writeUInt16BE(255, 12);
	message.writeUInt8(0, 14);
	message.writeUInt8(8, 15);
	message.writeUInt8(16, 16);
	return message;
}

function setEncodingsMessage(): Buffer {
	const message = Buffer.alloc(8);
	message.writeUInt8(2, 0);
	message.writeUInt16BE(1, 2);
	message.writeInt32BE(rawEncoding, 4);
	return message;
}

function framebufferUpdateRequest(width: number, height: number): Buffer {
	const message = Buffer.alloc(10);
	message.writeUInt8(3, 0);
	message.writeUInt8(0, 1); // Non-incremental: request the full framebuffer.
	message.writeUInt16BE(width, 6);
	message.writeUInt16BE(height, 8);
	return message;
}

function pointerEvent(buttons: number, x: number, y: number): Buffer {
	const message = Buffer.alloc(6);
	message.writeUInt8(5, 0);
	message.writeUInt8(buttons, 1);
	message.writeUInt16BE(x, 2);
	message.writeUInt16BE(y, 4);
	return message;
}

function buttonMask(button: "left" | "middle" | "right"): number {
	return button === "left" ? 1 : button === "middle" ? 2 : 4;
}

async function readFramebufferUpdate(
	reader: BufferedReader,
	rgba: Buffer,
	screenWidth: number,
	screenHeight: number,
): Promise<number> {
	await reader.read(1);
	const rectangleCount = await reader.uint16();
	for (let index = 0; index < rectangleCount; index++) {
		const x = await reader.uint16();
		const y = await reader.uint16();
		const width = await reader.uint16();
		const height = await reader.uint16();
		const encoding = await reader.int32();
		if (encoding !== rawEncoding) {
			throw new Error(`RFB server selected unsupported encoding ${encoding}`);
		}
		if (x + width > screenWidth || y + height > screenHeight) {
			throw new Error(`framebuffer rectangle ${x},${y} ${width}x${height} is outside ${screenWidth}x${screenHeight}`);
		}
		const pixels = await reader.read(width * height * 4);
		for (let row = 0; row < height; row++) {
			const sourceStart = row * width * 4;
			const targetStart = ((y + row) * screenWidth + x) * 4;
			for (let column = 0; column < width; column++) {
				const source = sourceStart + column * 4;
				const target = targetStart + column * 4;
				rgba[target] = pixels[source] ?? 0;
				rgba[target + 1] = pixels[source + 1] ?? 0;
				rgba[target + 2] = pixels[source + 2] ?? 0;
				rgba[target + 3] = 255;
			}
		}
	}
	return rectangleCount;
}

async function skipColorMap(reader: BufferedReader): Promise<void> {
	await reader.read(1);
	await reader.read(2);
	const colorCount = await reader.uint16();
	await reader.read(colorCount * 6);
}

class BufferedReader {
	private chunks: Buffer[] = [];
	private available = 0;
	private failure: Error | undefined;
	private wake: (() => void) | undefined;

	push(data: Buffer): void {
		if (data.length === 0 || this.failure) return;
		this.chunks.push(data);
		this.available += data.length;
		this.wake?.();
		this.wake = undefined;
	}

	fail(error: Error): void {
		if (this.failure) return;
		this.failure = error;
		this.wake?.();
		this.wake = undefined;
	}

	async read(length: number): Promise<Buffer> {
		while (this.available < length) {
			if (this.failure) throw this.failure;
			await new Promise<void>((resolve) => {
				this.wake = resolve;
			});
		}
		const result = Buffer.allocUnsafe(length);
		let offset = 0;
		while (offset < length) {
			const chunk = this.chunks[0];
			if (!chunk) throw new Error("RFB receive buffer became inconsistent");
			const count = Math.min(chunk.length, length - offset);
			chunk.copy(result, offset, 0, count);
			offset += count;
			this.available -= count;
			if (count === chunk.length) this.chunks.shift();
			else this.chunks[0] = chunk.subarray(count);
		}
		return result;
	}

	async uint8(): Promise<number> {
		return (await this.read(1)).readUInt8(0);
	}

	async uint16(): Promise<number> {
		return (await this.read(2)).readUInt16BE(0);
	}

	async uint32(): Promise<number> {
		return (await this.read(4)).readUInt32BE(0);
	}

	async int32(): Promise<number> {
		return (await this.read(4)).readInt32BE(0);
	}
}

function rawDataToBuffer(data: RawData): Buffer {
	if (Array.isArray(data)) return Buffer.concat(data);
	if (data instanceof ArrayBuffer) return Buffer.from(data);
	return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function encodePng(rgba: Buffer, width: number, height: number): Buffer {
	const scanlines = Buffer.alloc((width * 4 + 1) * height);
	for (let row = 0; row < height; row++) {
		const scanlineStart = row * (width * 4 + 1);
		scanlines[scanlineStart] = 0;
		rgba.copy(scanlines, scanlineStart + 1, row * width * 4, (row + 1) * width * 4);
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.writeUInt8(8, 8);
	header.writeUInt8(6, 9);
	return Buffer.concat([
		Buffer.from("89504e470d0a1a0a", "hex"),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(scanlines)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

function pngChunk(type: string, data: Buffer): Buffer {
	const typeBytes = Buffer.from(type, "ascii");
	const chunk = Buffer.alloc(data.length + 12);
	chunk.writeUInt32BE(data.length, 0);
	typeBytes.copy(chunk, 4);
	data.copy(chunk, 8);
	chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), data.length + 8);
	return chunk;
}

function crc32(data: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
	let crc = value;
	for (let bit = 0; bit < 8; bit++) {
		crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	}
	return crc >>> 0;
});

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
		const onClose = () => { cleanup(); reject(new Error("devbox display connection closed while connecting")); };
		const onUnexpectedResponse = (_request: unknown, response: { statusCode: number }) => {
			cleanup();
			reject(new DevboxGatewayError(response.statusCode));
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
			() => finish(new DevboxTimeoutError(`devbox display operation timed out after ${options.timeoutMs}ms`, options.timeoutMs)),
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
