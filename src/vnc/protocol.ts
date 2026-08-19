/**
 * RFB 3.8 wire protocol: handshake, Apple Remote Desktop authentication,
 * client message encoders, and server message decoders.
 */
import { createCipheriv, createHash, randomBytes } from "node:crypto";

const rfbVersion = Buffer.from("RFB 003.008\n");
const ardSecurityType = 30;
const noSecurityType = 1;
export const rawEncoding = 0;
const maxPixels = 100_000_000;

export interface ServerInit {
	width: number;
	height: number;
	desktopName: string;
}

/**
 * Complete the RFB handshake: version, security (Apple Remote Desktop or
 * none), `ClientInit`, `ServerInit`, pixel format, and encodings.
 */
export async function handshake(
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

export function framebufferUpdateRequest(width: number, height: number): Buffer {
	const message = Buffer.alloc(10);
	message.writeUInt8(3, 0);
	message.writeUInt8(0, 1); // Non-incremental: request the full framebuffer.
	message.writeUInt16BE(width, 6);
	message.writeUInt16BE(height, 8);
	return message;
}

export function pointerEvent(buttons: number, x: number, y: number): Buffer {
	const message = Buffer.alloc(6);
	message.writeUInt8(5, 0);
	message.writeUInt8(buttons, 1);
	message.writeUInt16BE(x, 2);
	message.writeUInt16BE(y, 4);
	return message;
}

export function buttonMask(button: "left" | "middle" | "right"): number {
	return button === "left" ? 1 : button === "middle" ? 2 : 4;
}

export function keyEvent(down: boolean, keysym: number): Buffer {
	const message = Buffer.alloc(8);
	message.writeUInt8(4, 0);
	message.writeUInt8(down ? 1 : 0, 1);
	message.writeUInt32BE(keysym, 4);
	return message;
}

/**
 * Map a character to its X11 keysym: printable ASCII maps directly, control
 * characters map to their dedicated keysyms, and other Unicode code points
 * use the `0x01000000 | codepoint` form from the keysym encoding.
 */
export function keysymForChar(char: string): number {
	const codePoint = char.codePointAt(0);
	if (codePoint === undefined) throw new RangeError("empty character");
	if (codePoint === 0x0a || codePoint === 0x0d) return 0xff0d; // Return
	if (codePoint === 0x09) return 0xff09; // Tab
	if (codePoint === 0x08) return 0xff08; // BackSpace
	if (codePoint === 0x1b) return 0xff1b; // Escape
	if (codePoint === 0x7f) return 0xffff; // Delete
	if (codePoint >= 0x20 && codePoint <= 0x7e) return codePoint;
	if (codePoint >= 0xa0 && codePoint <= 0xff) return codePoint;
	if (codePoint < 0x20) throw new RangeError(`unsupported control character U+${codePoint.toString(16).padStart(4, "0")}`);
	return 0x01000000 | codePoint;
}

export async function readFramebufferUpdate(
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

export async function skipColorMap(reader: BufferedReader): Promise<void> {
	await reader.read(1);
	await reader.read(2);
	const colorCount = await reader.uint16();
	await reader.read(colorCount * 6);
}

/**
 * Reassembles websocket messages into a byte stream with typed reads; RFB
 * message boundaries do not align with websocket frames.
 */
export class BufferedReader {
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
