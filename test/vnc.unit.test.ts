import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { openVnc, VncTimeoutError, type VncClient } from "../src/vnc/index.js";
import { decodePngPixels, fakeFramebufferPixels, startFakeVncServer } from "./fake-vnc.js";

test("screenshots capture the framebuffer through ARD authentication", async (t) => {
	const { client, server } = await connectFakeVnc(t);
	assert.equal(client.width, 2);
	assert.equal(client.height, 2);
	assert.equal(client.desktopName, "fake mac");
	assert.equal(server.state.headers["x-test-header"], "test-value");

	const screenshot = await client.screenshot();
	assert.equal(screenshot.width, 2);
	assert.equal(screenshot.height, 2);
	assert.equal(screenshot.desktopName, "fake mac");
	assert.deepEqual(decodePngPixels(Buffer.from(screenshot.png)), fakeFramebufferPixels);
});

test("clicks send the pointer press and release sequence", async (t) => {
	const { client, server } = await connectFakeVnc(t);
	await client.click(1, 0);
	await client.click(0, 1, { button: "right" });
	// Serialize against the server's event log by taking a screenshot.
	await client.screenshot();
	assert.deepEqual(server.state.pointerEvents, [
		{ buttons: 0, x: 1, y: 0 },
		{ buttons: 1, x: 1, y: 0 },
		{ buttons: 0, x: 1, y: 0 },
		{ buttons: 0, x: 0, y: 1 },
		{ buttons: 4, x: 0, y: 1 },
		{ buttons: 0, x: 0, y: 1 },
	]);

	await assert.rejects(client.click(2, 0), RangeError);
	await assert.rejects(client.click(0, -1), RangeError);
	await assert.rejects(client.click(0.5, 0), RangeError);
});

test("typing sends a key press and release per character", async (t) => {
	const { client, server } = await connectFakeVnc(t);
	await client.type("Hi!\n");
	// Serialize against the server's event log by taking a screenshot.
	await client.screenshot();
	assert.deepEqual(server.state.keyEvents, [
		{ down: true, keysym: 0x48 }, // H
		{ down: false, keysym: 0x48 },
		{ down: true, keysym: 0x69 }, // i
		{ down: false, keysym: 0x69 },
		{ down: true, keysym: 0x21 }, // !
		{ down: false, keysym: 0x21 },
		{ down: true, keysym: 0xff0d }, // Return
		{ down: false, keysym: 0xff0d },
	]);

	await assert.rejects(client.type("\u0001"), RangeError);
});

test("in-stream protocol errors close the session", async (t) => {
	const { client, server } = await connectFakeVnc(t);
	// Inject a server message the client does not understand; the failing
	// operation must poison the session so follow-ups reject instead of
	// waiting forever on a stream at an unknown position.
	server.sendRaw(Buffer.from([200]));
	await assert.rejects(client.screenshot(), /unsupported RFB server message type 200/);
	await assert.rejects(client.screenshot(), /VNC connection is closed/);
});

test("VNC handshakes time out", async (t) => {
	// A server that never speaks RFB stalls the handshake.
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await once(server, "listening");
	t.after(() => server.close());
	const address = server.address();
	assert(address && typeof address !== "string");

	await assert.rejects(
		openVnc({
			endpoint: `ws://127.0.0.1:${address.port}/i-123/5900`,
			username: "admin",
			password: "admin",
			timeoutMs: 200,
		}),
		VncTimeoutError,
	);
});

async function connectFakeVnc(
	t: Parameters<NonNullable<Parameters<typeof test>[0]>>[0],
): Promise<{ client: VncClient; server: Awaited<ReturnType<typeof startFakeVncServer>> }> {
	const server = await startFakeVncServer();
	const client = await openVnc({
		endpoint: server.url,
		username: "admin",
		password: "admin",
		headers: { "x-test-header": "test-value" },
		timeoutMs: 5_000,
	});
	t.after(() => {
		client.close();
		server.close();
	});
	return { client, server };
}
