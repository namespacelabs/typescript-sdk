import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { connect, type AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import ssh2, { type Client as SshClient, type SFTPWrapper } from "ssh2";
import WebSocket, { WebSocketServer } from "ws";
import { ConnectionManager, GatewaySocket, SshConnection } from "../src/devbox/connection.js";
import { DevboxHandle } from "../src/devbox/devbox.js";

const { Client, Server } = ssh2;

test("closing the gateway rejects an in-flight fs.exists() instead of hanging", { timeout: 5_000 }, async (t) => {
	let receivedStat!: () => void;
	const statReceived = new Promise<void>((resolve) => { receivedStat = resolve; });
	const port = await startSftpServer(t, () => receivedStat());
	const { devbox, connections } = createPooledDevbox(t, port);

	// The server receives STAT but deliberately never answers it. No operation timeout is set.
	const pending = devbox.fs.exists("/amp");
	const rejected = assert.rejects(pending, /No response from server/);
	await statReceived;
	assert.equal(connections.length, 1);

	const { gateway, client } = connections[0];
	const sshClosed = once(client, "close");
	gateway.peer.close();

	await rejected;
	await sshClosed;
	assert.equal(gateway.websocket.readyState, WebSocket.CLOSED);
	assert.equal(gateway.socket.destroyed, true);
});

test("the next filesystem call replaces a pooled connection whose gateway closed", { timeout: 5_000 }, async (t) => {
	const port = await startSftpServer(t, (sftp, id) => {
		sftp.attrs(id, { mode: 0o100644, uid: 0, gid: 0, size: 42, atime: 0, mtime: 0 });
	});
	const { devbox, connections } = createPooledDevbox(t, port);

	// A successful operation leaves one healthy connection in the pool.
	assert.equal(await devbox.fs.exists("/amp"), true);
	assert.equal(connections.length, 1);
	const original = connections[0];

	const sshClosed = once(original.client, "close");
	original.gateway.peer.close();
	await sshClosed;

	// The same Devbox handle must reconnect, not reuse the dead pooled connection.
	assert.equal(await devbox.fs.exists("/amp"), true);
	assert.equal(connections.length, 2);
	assert.notEqual(connections[1].connection, original.connection);
});

test("gateway closure drains buffered incoming data before destroying the socket", { timeout: 5_000 }, async (t) => {
	const { socket, websocket, peer } = await openGateway(t);
	const transportClosed = once(websocket, "close");
	peer.send(Buffer.from("final response"));
	peer.close();
	await transportClosed;

	// Start consuming only after the WebSocket closes, leaving its final bytes buffered until now.
	const closed = once(socket, "close");
	const chunks: Buffer[] = [];
	socket.on("data", (chunk: Buffer) => chunks.push(chunk));
	await closed;
	assert.equal(Buffer.concat(chunks).toString(), "final response");
	assert.equal(socket.readableEnded, true);
});

async function startSftpServer(t: TestContext, onStat: (sftp: SFTPWrapper, id: number) => void) {
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const server = new Server({ hostKeys: [privateKey.export({ type: "pkcs1", format: "pem" })] }, (client) => {
		client.on("error", () => {});
		t.after(() => client.end());
		client.on("authentication", (context) => context.accept());
		client.on("ready", () => {
			client.on("session", (accept) => {
				accept().on("sftp", (acceptSftp) => {
					const sftp = acceptSftp();
					sftp.on("STAT", (id) => onStat(sftp, id));
				});
			});
		});
	});
	t.after(() => server.close());
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return (server.address() as AddressInfo).port;
}

function createPooledDevbox(t: TestContext, sshPort: number) {
	const manager = new ConnectionManager({} as never, { issueToken: async () => "token" }, 1_000);
	t.after(() => manager.close());
	const connections: Array<{
		gateway: Awaited<ReturnType<typeof openGateway>>;
		client: SshClient;
		connection: SshConnection;
	}> = [];

	// Replace activation/dialing only; filesystem calls, SFTP caching, and pool eviction are real SDK code.
	(manager as unknown as { connect: () => Promise<SshConnection> }).connect = async () => {
		const gateway = await openGateway(t);
		const bridge = connect(sshPort, "127.0.0.1");
		t.after(() => bridge.destroy());
		const { peer } = gateway;
		bridge.on("error", () => {});
		bridge.on("data", (data) => {
			if (peer.readyState === WebSocket.OPEN) peer.send(data);
		});
		peer.on("message", (data) => bridge.write(data as Buffer));
		peer.on("close", () => bridge.destroy());

		const client = new Client();
		client.on("error", () => {});
		const ready = once(client, "ready");
		client.connect({ sock: gateway.socket, username: "test", keepaliveInterval: 15_000 });
		await ready;
		const connection = new SshConnection("instance", client);
		connections.push({ gateway, client, connection });
		return connection;
	};

	const devbox = new DevboxHandle({ id: "devbox" } as never, manager, {} as never);
	return { devbox, connections };
}

async function openGateway(t: TestContext) {
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	t.after(() => {
		for (const client of server.clients) client.terminate();
		server.close();
	});
	await once(server, "listening");
	const accepted = once(server, "connection");
	const websocket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
	t.after(() => websocket.terminate());
	await once(websocket, "open");
	const [peer] = (await accepted) as [WebSocket];
	const socket = new GatewaySocket(websocket);
	t.after(() => socket.destroy());
	return { socket, websocket, peer };
}
