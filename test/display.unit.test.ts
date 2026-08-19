import assert from "node:assert/strict";
import { createDecipheriv, createHash } from "node:crypto";
import { once } from "node:events";
import type { Duplex } from "node:stream";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { Code, ConnectError } from "@connectrpc/connect";
import { createWebSocketStream, WebSocketServer } from "ws";
import { ConnectionManager } from "../src/devbox/connection.js";
import {
	computeApiBaseUrl,
	fetchVncConfig,
	openDisplay,
	type ComputeClient,
	type DisplayConnection,
} from "../src/devbox/display.js";
import { DevboxDisplayUnavailableError, DevboxTimeoutError } from "../src/devbox/errors.js";

test("compute API endpoint derives from the instance ingress domain", () => {
	assert.equal(computeApiBaseUrl("fra.nscluster.cloud"), "https://fra.compute.namespaceapis.com");
	assert.equal(computeApiBaseUrl("custom.example.com"), "https://api.custom.example.com");
});

test("missing VNC service maps to DevboxDisplayUnavailableError", async () => {
	const unavailable = {
		getVNCConfig: async () => {
			throw new ConnectError('instance "i-123" does not expose a VNC service', Code.FailedPrecondition);
		},
	} as unknown as ComputeClient;
	await assert.rejects(
		fetchVncConfig(unavailable, "i-123", {}),
		DevboxDisplayUnavailableError,
	);

	const failing = {
		getVNCConfig: async () => {
			throw new ConnectError("internal error", Code.Internal);
		},
	} as unknown as ComputeClient;
	await assert.rejects(fetchVncConfig(failing, "i-123", {}), (error: unknown) => {
		assert(!(error instanceof DevboxDisplayUnavailableError));
		return true;
	});
});

test("screenshots capture the framebuffer through ARD authentication", async (t) => {
	const { display, server } = await connectFakeDisplay(t);
	assert.equal(display.width, 2);
	assert.equal(display.height, 2);
	assert.equal(display.desktopName, "fake mac");
	assert.equal(server.authHeader, "Bearer test-token");

	const screenshot = await display.screenshot();
	assert.equal(screenshot.width, 2);
	assert.equal(screenshot.height, 2);
	assert.equal(screenshot.desktopName, "fake mac");
	assert.deepEqual(
		decodePngPixels(Buffer.from(screenshot.png)),
		Buffer.from([
			255, 0, 0, 255, 0, 255, 0, 255,
			0, 0, 255, 255, 255, 255, 255, 255,
		]),
	);
});

test("clicks send the pointer press and release sequence", async (t) => {
	const { display, server } = await connectFakeDisplay(t);
	await display.click(1, 0);
	await display.click(0, 1, { button: "right" });
	// Serialize against the server's event log by taking a screenshot.
	await display.screenshot();
	assert.deepEqual(server.pointerEvents, [
		{ buttons: 0, x: 1, y: 0 },
		{ buttons: 1, x: 1, y: 0 },
		{ buttons: 0, x: 1, y: 0 },
		{ buttons: 0, x: 0, y: 1 },
		{ buttons: 4, x: 0, y: 1 },
		{ buttons: 0, x: 0, y: 1 },
	]);

	await assert.rejects(display.click(2, 0), RangeError);
	await assert.rejects(display.click(0, -1), RangeError);
	await assert.rejects(display.click(0.5, 0), RangeError);
});

test("display handshakes time out", async (t) => {
	// A server that never speaks RFB stalls the handshake.
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await once(server, "listening");
	t.after(() => server.close());
	const address = server.address();
	assert(address && typeof address !== "string");

	await assert.rejects(
		openDisplay({
			instanceId: "i-123",
			endpoint: `ws://127.0.0.1:${address.port}/i-123/5900`,
			username: "admin",
			password: "admin",
			token: "test-token",
			signal: new AbortController().signal,
			timeoutMs: 200,
		}),
		DevboxTimeoutError,
	);
});

test("display connections are cached and invalidated by the manager", async () => {
	let connects = 0;
	const manager = new ConnectionManager(
		{} as never,
		{ issueToken: async () => "token" },
		1_000,
	);
	const internals = manager as unknown as {
		connectDisplay: () => Promise<unknown>;
	};
	internals.connectDisplay = async () => {
		connects += 1;
		return { close: () => {}, onClose: () => {} };
	};

	const [first, second] = await Promise.all([
		manager.getDisplay("devbox_1"),
		manager.getDisplay("devbox_1"),
	]);
	assert.equal(first, second);
	assert.equal(connects, 1);

	manager.invalidate("devbox_1");
	await manager.getDisplay("devbox_1");
	assert.equal(connects, 2);
});

interface FakeVncServer {
	authHeader: string | undefined;
	pointerEvents: Array<{ buttons: number; x: number; y: number }>;
}

async function connectFakeDisplay(
	t: Parameters<NonNullable<Parameters<typeof test>[0]>>[0],
): Promise<{ display: DisplayConnection; server: FakeVncServer }> {
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await once(server, "listening");
	const state: FakeVncServer = { authHeader: undefined, pointerEvents: [] };
	server.on("connection", (socket, request) => {
		state.authHeader = request.headers["x-nsc-ingress-auth"] as string | undefined;
		void serveFakeVnc(createWebSocketStream(socket), state);
	});

	const address = server.address();
	assert(address && typeof address !== "string");
	const display = await openDisplay({
		instanceId: "i-123",
		endpoint: `ws://127.0.0.1:${address.port}/i-123/5900`,
		username: "admin",
		password: "admin",
		token: "test-token",
		signal: new AbortController().signal,
		timeoutMs: 5_000,
	});
	t.after(() => {
		display.close();
		server.close();
	});
	return { display, server: state };
}

/**
 * A minimal RFB 3.8 server with Apple Remote Desktop authentication: it
 * performs the handshake, then answers framebuffer update requests with a
 * fixed 2x2 image and records pointer events.
 */
async function serveFakeVnc(socket: Duplex, state: FakeVncServer): Promise<void> {
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

function decodePngPixels(png: Buffer): Buffer {
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
