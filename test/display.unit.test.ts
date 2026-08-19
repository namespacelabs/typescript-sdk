import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { WebSocketServer } from "ws";
import { ConnectionManager } from "../src/devbox/connection.js";
import {
	computeApiBaseUrl,
	fetchVncConfig,
	openDisplay,
	type ComputeClient,
} from "../src/devbox/display.js";
import { DevboxDisplayUnavailableError, DevboxTimeoutError } from "../src/devbox/errors.js";
import { decodePngPixels, fakeFramebufferPixels, startFakeVncServer } from "./fake-vnc.js";

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

test("openDisplay authenticates the gateway and screenshots", async (t) => {
	const server = await startFakeVncServer();
	const display = await openDisplay({
		instanceId: "i-123",
		endpoint: server.url,
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

	assert.equal(server.state.headers["x-nsc-ingress-auth"], "Bearer test-token");
	assert.equal(display.instanceId, "i-123");
	assert.equal(display.width, 2);
	assert.equal(display.height, 2);
	assert.equal(display.desktopName, "fake mac");

	const screenshot = await display.screenshot();
	assert.deepEqual(decodePngPixels(Buffer.from(screenshot.png)), fakeFramebufferPixels);
});

test("display handshake timeouts map to DevboxTimeoutError", async (t) => {
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
