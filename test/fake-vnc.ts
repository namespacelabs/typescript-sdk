/**
 * A minimal fake VNC (RFB 3.8) server for tests: performs the handshake with
 * Apple Remote Desktop authentication, answers framebuffer update requests
 * with a fixed 2x2 image, and records pointer events and upgrade headers.
 */
import assert from "node:assert/strict";
import { createDecipheriv, createHash } from "node:crypto";
import { once } from "node:events";
import type { IncomingHttpHeaders } from "node:http";
import type { Duplex } from "node:stream";
import { inflateSync } from "node:zlib";
import { createWebSocketStream, WebSocketServer } from "ws";

export interface FakeVncState {
	headers: IncomingHttpHeaders;
	pointerEvents: Array<{ buttons: number; x: number; y: number }>;
}

export interface FakeVncServer {
	url: string;
	state: FakeVncState;
	close(): void;
}

export async function startFakeVncServer(): Promise<FakeVncServer> {
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await once(server, "listening");
	const state: FakeVncState = { headers: {}, pointerEvents: [] };
	server.on("connection", (socket, request) => {
		state.headers = request.headers;
		void serveFakeVnc(createWebSocketStream(socket), state);
	});
	const address = server.address();
	assert(address && typeof address !== "string");
	return {
		url: `ws://127.0.0.1:${address.port}/i-123/5900`,
		state,
		close: () => server.close(),
	};
}

async function serveFakeVnc(socket: Duplex, state: FakeVncState): Promise<void> {
	const reader = new SocketReader(socket);
	socket.write("RFB 003.008\n");
	assert.equal((await reader.read(12)).toString(), "RFB 003.008\n");
	socket.write(Buffer.from([1, 30]));
	assert.equal((await reader.read(1))[0], 30);

	const keyLength = 16;
	const generator = Buffer.from([0, 2]);
	const prime = bigIntToBuffer(0xffffffffffffffffffffffffffffff61n, keyLength);
	const serverPrivateKey = bigIntToBuffer(0x123456789abcdefn, keyLength);
	const serverPublicKey = modPow(generator, serverPrivateKey, prime);
	const ardChallenge = Buffer.alloc(4 + keyLength * 2);
	generator.copy(ardChallenge, 0);
	ardChallenge.writeUInt16BE(keyLength, 2);
	prime.copy(ardChallenge, 4);
	serverPublicKey.copy(ardChallenge, 4 + keyLength);
	socket.write(ardChallenge);

	const ardResponse = await reader.read(128 + keyLength);
	const clientPublicKey = ardResponse.subarray(128);
	const sharedKey = modPow(clientPublicKey, serverPrivateKey, prime);
	const aesKey = createHash("md5").update(sharedKey).digest();
	const decipher = createDecipheriv("aes-128-ecb", aesKey, null);
	decipher.setAutoPadding(false);
	const credentials = Buffer.concat([
		decipher.update(ardResponse.subarray(0, 128)),
		decipher.final(),
	]);
	assert.equal(credentials.subarray(0, 6).toString(), "admin\0");
	assert.equal(credentials.subarray(64, 70).toString(), "admin\0");

	socket.write(Buffer.alloc(4)); // Security result: OK.
	assert.equal((await reader.read(1))[0], 1); // ClientInit.
	socket.write(serverInit());
	assert.equal((await reader.read(20))[0], 0); // SetPixelFormat.
	assert.equal((await reader.read(8))[0], 2); // SetEncodings.

	for (;;) {
		const messageType = (await reader.read(1))[0];
		if (messageType === 3) {
			await reader.read(9);
			socket.write(framebufferUpdate());
		} else if (messageType === 5) {
			const event = await reader.read(5);
			state.pointerEvents.push({
				buttons: event[0]!,
				x: event.readUInt16BE(1),
				y: event.readUInt16BE(3),
			});
		} else {
			throw new Error(`unexpected client message type ${messageType}`);
		}
	}
}

function serverInit(): Buffer {
	const name = Buffer.from("fake mac");
	const message = Buffer.alloc(24 + name.length);
	message.writeUInt16BE(2, 0);
	message.writeUInt16BE(2, 2);
	message.writeUInt8(32, 4);
	message.writeUInt8(24, 5);
	message.writeUInt8(0, 6);
	message.writeUInt8(1, 7);
	message.writeUInt16BE(255, 8);
	message.writeUInt16BE(255, 10);
	message.writeUInt16BE(255, 12);
	message.writeUInt8(16, 14);
	message.writeUInt8(8, 15);
	message.writeUInt8(0, 16);
	message.writeUInt32BE(name.length, 20);
	name.copy(message, 24);
	return message;
}

function framebufferUpdate(): Buffer {
	const top = rawRectangle(0, 0, [255, 0, 0, 0, 0, 255, 0, 0]);
	const bottom = rawRectangle(0, 1, [0, 0, 255, 0, 255, 255, 255, 0]);
	return Buffer.concat([Buffer.from([0, 0, 0, 2]), top, bottom]);
}

function rawRectangle(x: number, y: number, pixels: number[]): Buffer {
	const rectangle = Buffer.alloc(12 + pixels.length);
	rectangle.writeUInt16BE(x, 0);
	rectangle.writeUInt16BE(y, 2);
	rectangle.writeUInt16BE(2, 4);
	rectangle.writeUInt16BE(1, 6);
	rectangle.writeInt32BE(0, 8);
	Buffer.from(pixels).copy(rectangle, 12);
	return rectangle;
}

/** The RGBA pixels the fake server's 2x2 framebuffer decodes to. */
export const fakeFramebufferPixels = Buffer.from([
	255, 0, 0, 255, 0, 255, 0, 255,
	0, 0, 255, 255, 255, 255, 255, 255,
]);

export function decodePngPixels(png: Buffer): Buffer {
	assert.deepEqual(png.subarray(0, 8), Buffer.from("89504e470d0a1a0a", "hex"));
	const compressed: Buffer[] = [];
	let offset = 8;
	while (offset < png.length) {
		const length = png.readUInt32BE(offset);
		const type = png.subarray(offset + 4, offset + 8).toString("ascii");
		if (type === "IDAT") {
			compressed.push(png.subarray(offset + 8, offset + 8 + length));
		}
		offset += length + 12;
	}
	const scanlines = inflateSync(Buffer.concat(compressed));
	assert.equal(scanlines[0], 0);
	assert.equal(scanlines[9], 0);
	return Buffer.concat([scanlines.subarray(1, 9), scanlines.subarray(10, 18)]);
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
	return Buffer.from(value.toString(16).padStart(length * 2, "0"), "hex");
}

class SocketReader {
	private chunks: Buffer[] = [];
	private available = 0;
	private wake: (() => void) | undefined;

	constructor(socket: Duplex) {
		socket.on("data", (data: Buffer) => {
			this.chunks.push(data);
			this.available += data.length;
			this.wake?.();
			this.wake = undefined;
		});
	}

	async read(length: number): Promise<Buffer> {
		while (this.available < length) {
			await new Promise<void>((resolve) => {
				this.wake = resolve;
			});
		}
		const result = Buffer.alloc(length);
		let offset = 0;
		while (offset < length) {
			const chunk = this.chunks[0]!;
			const count = Math.min(chunk.length, length - offset);
			chunk.copy(result, offset, 0, count);
			offset += count;
			this.available -= count;
			if (count === chunk.length) {
				this.chunks.shift();
			} else {
				this.chunks[0] = chunk.subarray(count);
			}
		}
		return result;
	}
}
