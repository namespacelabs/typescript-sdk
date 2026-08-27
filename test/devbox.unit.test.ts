import assert from "node:assert/strict";
import test from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
	DevBoxSchema,
	DevboxTemplateSchema,
} from "../src/proto/namespace/private/devbox/devbox_pb.js";
import {
	blueprint,
	blueprintSpec,
	DEFAULT_SITE,
	cursorFromBytes,
	cursorToBytes,
	imageSelector,
	positiveBigInt,
	toProtoMachineSize,
	toProtoShape,
} from "../src/devbox/conversion.js";
import { createResources } from "../src/devbox/resources.js";
import { EventEmitter } from "node:events";
import {
	buildExecRequest,
	collectExec,
	ConnectionManager,
	operationDeadline,
	SshConnection,
	withDeadline,
} from "../src/devbox/connection.js";
import { ExecLogChunkSchema, type ExecLogChunk } from "../src/proto/namespace/private/devbox/wire/wire_pb.js";
import { cachingTokenSource } from "../src/auth/caching.js";

test("blueprint conversion preserves native SDK fields", () => {
	const spec = blueprintSpec("typescript", {
		image: "node:22",
		size: "m",
		site: "ord",
		description: "TypeScript development",
		access: "workspace",
		environment: { NODE_ENV: "development" },
		volumeSizeGB: 50,
		ephemeral: { stoppedRetentionMs: 60_000 },
		features: [],
		networkPolicy: { allowedDomains: ["registry.npmjs.org"] },
		busyTimeoutMs: 30_000,
	});

	const converted = blueprint(create(DevboxTemplateSchema, {
		id: "blueprint_123",
		version: 7n,
		spec,
	}));

	assert.equal(converted.name, "typescript");
	assert.equal(converted.definition.image, "node:22");
	assert.equal(converted.definition.size, "m");
	assert.equal(spec.instance?.shape?.virtualCpu, 8);
	assert.equal(spec.instance?.shape?.memoryMegabytes, 16 * 1024);
	assert.equal(spec.instance?.shape?.machineArch, "amd64");
	assert.equal(spec.instance?.shape?.os, "linux");
	assert.deepEqual(converted.definition.environment, { NODE_ENV: "development" });
	assert.deepEqual(converted.definition.features, []);
	assert.equal(
		typeof converted.definition.ephemeral === "object"
			? converted.definition.ephemeral.stoppedRetentionMs
			: undefined,
		60_000,
	);
	assert.equal(converted.definition.busyTimeoutMs, 30_000);
});

test("machine sizes serialize as backend-resolved names", () => {
	// Creation passes the name through; the backend resolves it to a shape.
	assert.equal(toProtoMachineSize("m"), "m");
	assert.equal(toProtoMachineSize("xxl"), "xxl");
	assert.equal(toProtoMachineSize(undefined), "");
});

test("shape resolution rejects sizes unknown to this SDK version", () => {
	// Update and blueprints require a concrete shape, so unknown names throw.
	assert.throws(() => toProtoShape("xxl"), TypeError);
});

test("macOS sizes resolve client-side to Apple Silicon shapes", () => {
	assert.deepEqual(toProtoShape("m", "macos"), {
		virtualCpu: 6,
		memoryMegabytes: 14 * 1024,
		machineArch: "arm64",
		os: "macos",
	});
	assert.deepEqual(toProtoShape("l", "macos"), {
		virtualCpu: 12,
		memoryMegabytes: 28 * 1024,
		machineArch: "arm64",
		os: "macos",
	});
	// Linux-only sizes are not valid for macOS.
	assert.throws(() => toProtoShape("s", "macos"), TypeError);
	assert.throws(() => toProtoShape("xl", "macos"), TypeError);
});

test("blueprints default to iad", () => {
	assert.equal(DEFAULT_SITE, "iad");
	assert.equal(blueprintSpec("default", { image: "node:22" }).site, "iad");
});

test("pagination cursors round-trip as opaque strings", () => {
	const bytes = Uint8Array.from([0, 1, 2, 250, 255]);
	const cursor = cursorFromBytes(bytes);
	assert.ok(cursor);
	assert.deepEqual(Array.from(cursorToBytes(cursor)), Array.from(bytes));
	assert.equal(cursorFromBytes(new Uint8Array()), undefined);
});

test("numeric inputs reject unsafe protobuf integer values", () => {
	assert.equal(positiveBigInt(50, "volumeSizeGB"), 50n);
	assert.throws(() => positiveBigInt(-1, "volumeSizeGB"), RangeError);
	assert.throws(() => positiveBigInt(Number.MAX_SAFE_INTEGER + 1, "volumeSizeGB"), RangeError);
});

test("image selectors accept names and returned repository digest refs", () => {
	assert.deepEqual(imageSelector("node-22"), { name: "node-22" });
	assert.deepEqual(imageSelector("registry.example.com/node@sha256:abc"), { digest: "sha256:abc" });
});

test("devbox creation forwards explicit image names", async () => {
	const requests: Array<{ imageRef?: string; imageName?: string }> = [];
	const rpc = {
		create: async (request: { imageRef?: string; imageName?: string }) => {
			requests.push(request);
			return { devbox: create(DevBoxSchema, { id: "devbox_123", name: "test" }) };
		},
	} as never;
	const { devboxes } = createResources(rpc, {} as ConnectionManager);

	await devboxes.create({ name: "named", imageName: "builtin:agents", start: false });
	await devboxes.create({ name: "ref", image: "node:22", start: false });
	await devboxes.create({ name: "legacy-name", image: "node-22", start: false });

	assert.equal(requests[0]?.imageName, "builtin:agents");
	assert.equal(requests[0]?.imageRef, undefined);
	assert.equal(requests[1]?.imageRef, "node:22");
	assert.equal(requests[1]?.imageName, undefined);
	assert.equal(requests[2]?.imageName, "node-22");
	assert.equal(requests[2]?.imageRef, undefined);
});

test("devbox creation rejects incompatible image name options", async () => {
	const { devboxes } = createResources({} as never, {} as ConnectionManager);

	await assert.rejects(
		devboxes.create({ name: "invalid", image: "node:22", imageName: "builtin:agents" } as never),
		/cannot be used together/,
	);
	await assert.rejects(
		devboxes.create({ name: "invalid", blueprint: "typescript", imageName: "builtin:agents" } as never),
		/"imageName" cannot be used with a blueprint/,
	);
	await assert.rejects(
		devboxes.create({ name: "invalid", os: "macos", imageName: "builtin:agents" } as never),
		/"imageName" cannot be used with os "macos"/,
	);
});

test("devbox existence checks by id or name", async () => {
	const requests: Array<{ idOrName?: string; returnActivatedInstance?: boolean }> = [];
	const callOptions: unknown[] = [];
	const rpc = {
		fetch: async (
			request: { idOrName?: string; returnActivatedInstance?: boolean },
			options: unknown,
		) => {
			requests.push(request);
			callOptions.push(options);
			if (request.idOrName === "missing") {
				throw new ConnectError("devbox not found", Code.NotFound);
			}
			if (request.idOrName === "broken") {
				throw new ConnectError("internal error", Code.Internal);
			}
			return { devbox: create(DevBoxSchema, { id: "devbox_123", name: "existing" }) };
		},
	} as never;
	const { devboxes } = createResources(rpc, {} as ConnectionManager);
	const options = { timeoutMs: 1_000 };

	assert.equal(await devboxes.exists("devbox_123", options), true);
	assert.equal(await devboxes.exists("missing"), false);
	await assert.rejects(devboxes.exists("broken"), (error: unknown) => {
		return error instanceof ConnectError && error.code === Code.Internal;
	});
	assert.deepEqual(requests.map((request) => request.idOrName), ["devbox_123", "missing", "broken"]);
	assert.equal(requests[0]?.returnActivatedInstance, true);
	assert.equal(callOptions[0], options);
});

test("operation deadlines preserve one timeout budget across phases", () => {
	const options = { timeoutMs: 1_000 };
	const deadline = operationDeadline(options);
	assert.ok(deadline);
	const remaining = withDeadline(options, deadline);
	assert.ok(remaining.timeoutMs <= 1_000);
	assert.ok(remaining.timeoutMs >= 0);
	assert.throws(() => operationDeadline({ timeoutMs: -1 }), RangeError);
});

test("invalidating an in-flight connection closes a late result", async () => {
	let resolveConnection!: (connection: SshConnection) => void;
	const manager = new ConnectionManager(
		{} as never,
		{ issueToken: async () => "token" },
		1_000,
	);
	(manager as unknown as {
		connect: () => Promise<SshConnection>;
	}).connect = () => new Promise((resolve) => {
		resolveConnection = resolve;
	});

	let closeCount = 0;
	const connection = {
		close: () => { closeCount += 1; },
		onClose: () => {},
	} as unknown as SshConnection;
	const pending = manager.get("devbox_123");
	manager.invalidate("devbox_123");
	resolveConnection(connection);

	assert.equal(await pending, connection);
	assert.equal(closeCount, 1);
});

function fakeJwt(expiresAtSeconds?: number): string {
	const payload = Buffer.from(JSON.stringify(expiresAtSeconds === undefined ? {} : { exp: expiresAtSeconds }))
		.toString("base64url");
	return `header.${payload}.signature`;
}

test("caching token source reuses valid tokens and single-flights issuance", async () => {
	let issued = 0;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const source = cachingTokenSource({
		issueToken: async () => {
			issued += 1;
			await gate;
			return fakeJwt(Math.floor(Date.now() / 1000) + 3600);
		},
	});

	const first = source.issueToken(60_000);
	const second = source.issueToken(60_000);
	release();
	assert.equal(await first, await second);
	assert.equal(issued, 1);

	// Cached token still satisfies the requested validity.
	assert.equal(await source.issueToken(60_000), await first);
	assert.equal(issued, 1);
});

test("caching token source refreshes expiring and forced tokens", async () => {
	let issued = 0;
	const source = cachingTokenSource({
		issueToken: async () => {
			issued += 1;
			// Expires in 30s: valid for a 10s minimum, not for a 60s minimum.
			return fakeJwt(Math.floor(Date.now() / 1000) + 30) + issued;
		},
	});

	const first = await source.issueToken(10_000);
	assert.equal(await source.issueToken(10_000), first);
	assert.equal(issued, 1);

	const refreshed = await source.issueToken(60_000);
	assert.notEqual(refreshed, first);
	assert.equal(issued, 2);

	const forced = await source.issueToken(10_000, true);
	assert.notEqual(forced, refreshed);
	assert.equal(issued, 3);
});

test("caching token source constructs a provided source lazily, once", async () => {
	let constructed = 0;
	let issued = 0;
	const source = cachingTokenSource(async () => {
		constructed += 1;
		if (constructed === 1) throw new Error("transient load failure");
		return {
			issueToken: async () => {
				issued += 1;
				return fakeJwt(Math.floor(Date.now() / 1000) + 3600);
			},
		};
	});
	assert.equal(constructed, 0); // Not constructed until a token is needed.

	await assert.rejects(source.issueToken(10_000), /transient load failure/);
	const token = await source.issueToken(10_000); // Failed construction is retried.
	assert.equal(await source.issueToken(10_000, true), token);
	assert.equal(constructed, 2); // Successful construction is reused, even when forced.
	assert.equal(issued, 2);
});

function fakeSshClient(overrides: Record<string, unknown> = {}) {
	return Object.assign(new EventEmitter(), { end: () => {}, ...overrides });
}

test("sftp channel is opened once and shared", async () => {
	let opens = 0;
	const channel = new EventEmitter();
	const connection = new SshConnection("instance", fakeSshClient({
		sftp: (callback: (error: Error | undefined, sftp: EventEmitter) => void) => {
			opens += 1;
			queueMicrotask(() => callback(undefined, channel));
		},
	}) as never);

	const [first, second] = await Promise.all([connection.sftp(), connection.sftp()]);
	assert.equal(first, second);
	assert.equal(await connection.sftp(), first);
	assert.equal(opens, 1);
});

test("sftp cache is invalidated on channel close and failed open", async () => {
	let opens = 0;
	const channels: EventEmitter[] = [];
	const connection = new SshConnection("instance", fakeSshClient({
		sftp: (callback: (error: Error | undefined, sftp?: EventEmitter) => void) => {
			opens += 1;
			if (opens === 2) {
				queueMicrotask(() => callback(new Error("channel open failure")));
				return;
			}
			const channel = new EventEmitter();
			channels.push(channel);
			queueMicrotask(() => callback(undefined, channel));
		},
	}) as never);

	const first = await connection.sftp();
	first.emit("close");
	await assert.rejects(connection.sftp(), /channel open failure/);
	const third = await connection.sftp();
	assert.notEqual(third, first);
	assert.equal(opens, 3);
});

function fakeTerminalChannel() {
	const channel = Object.assign(new EventEmitter(), {
		stderr: new EventEmitter(),
		write: () => {},
		setWindow: () => {},
		close: () => {},
	});
	return channel;
}

test("terminal wait resolves on exit and preserves onExit listeners", async () => {
	const channel = fakeTerminalChannel();
	const connection = new SshConnection("instance", fakeSshClient({
		shell: (
			_window: unknown,
			_options: unknown,
			callback: (error: Error | undefined, channel: unknown) => void,
		) => queueMicrotask(() => callback(undefined, channel)),
	}) as never);

	const terminal = await connection.openTerminal();
	const exits: Array<{ exitCode: number | null; signal: string | null }> = [];
	terminal.onExit((exitCode, signal) => exits.push({ exitCode, signal }));

	const pending = terminal.wait();
	channel.emit("close", 3, "");
	assert.deepEqual(await pending, { exitCode: 3, signal: null });
	// wait() after exit resolves immediately with the same result.
	assert.deepEqual(await terminal.wait(), { exitCode: 3, signal: null });
	assert.deepEqual(exits, [{ exitCode: 3, signal: null }]);
});

test("exec requests carry argv, cwd, env, and stdin structurally", () => {
	const request = buildExecRequest(["git", "status", "--short"], {
		cwd: "/workspace/repo",
		env: { NODE_ENV: "test" },
		stdin: "hello",
	});
	assert.equal(request.command?.command, "git");
	assert.deepEqual(request.command?.args, ["status", "--short"]);
	assert.equal(request.command?.cwd?.absolute, "/workspace/repo");
	assert.equal(request.command?.cwd?.workspaceRelative, "");
	assert.deepEqual(
		request.command?.additionalEnvironment.map((entry) => [entry.name, entry.value]),
		[["NODE_ENV", "test"]],
	);
	assert.deepEqual(request.command?.stdin?.value, new TextEncoder().encode("hello"));

	const relative = buildExecRequest(["ls"], { cwd: "src" });
	assert.equal(relative.command?.cwd?.absolute, "");
	assert.equal(relative.command?.cwd?.workspaceRelative, "src");

	const bare = buildExecRequest(["true"]);
	assert.equal(bare.command?.cwd, undefined);
	assert.equal(bare.command?.stdin, undefined);
	assert.deepEqual(bare.command?.additionalEnvironment, []);

	assert.throws(() => buildExecRequest([]), TypeError);
	assert.throws(() => buildExecRequest(["env"], { env: { "BAD NAME": "1" } }), TypeError);
});

async function* execChunks(...chunks: Array<Parameters<typeof create<typeof ExecLogChunkSchema>>[1]>): AsyncIterable<ExecLogChunk> {
	for (const chunk of chunks) yield create(ExecLogChunkSchema, chunk);
}

test("exec streams route output to callbacks and map the final result", async () => {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const result = await collectExec(execChunks(
		{ stdout: new TextEncoder().encode("out1") },
		{ stderr: new TextEncoder().encode("err1") },
		{ stdout: new TextEncoder().encode("out2") },
		{ result: { exitCode: 3, error: "exit status 3" } },
	), {
		onStdout: (data) => stdout.push(Buffer.from(data).toString()),
		onStderr: (data) => stderr.push(Buffer.from(data).toString()),
	});

	assert.deepEqual(stdout, ["out1", "out2"]);
	assert.deepEqual(stderr, ["err1"]);
	// Non-zero exits resolve normally with the agent-reported error detail.
	assert.deepEqual(result, {
		exitCode: 3,
		signal: null,
		error: "exit status 3",
		stdout: "out1out2",
		stderr: "err1",
	});
});

test("exec streams without a final result fail", async () => {
	await assert.rejects(
		collectExec(execChunks({ stdout: new TextEncoder().encode("partial") }), {}),
		/devbox exec stream/,
	);

	const success = await collectExec(execChunks({ result: { exitCode: 0 } }), {});
	assert.deepEqual(success, { exitCode: 0, signal: null, stdout: "", stderr: "" });
});

test("ssh and agent connections are cached independently", async () => {
	const connects = { ssh: 0, agent: 0 };
	const manager = new ConnectionManager(
		{} as never,
		{ issueToken: async () => "token" },
		1_000,
	);
	const fakeConnection = () => ({ close: () => {}, onClose: () => {} });
	const internals = manager as unknown as {
		connect: () => Promise<unknown>;
		connectAgent: () => Promise<unknown>;
	};
	internals.connect = async () => {
		connects.ssh += 1;
		return fakeConnection();
	};
	internals.connectAgent = async () => {
		connects.agent += 1;
		return fakeConnection();
	};

	const [ssh1, ssh2] = await Promise.all([manager.get("devbox_1"), manager.get("devbox_1")]);
	const [agent1, agent2] = await Promise.all([manager.getAgent("devbox_1"), manager.getAgent("devbox_1")]);
	assert.equal(ssh1, ssh2);
	assert.equal(agent1, agent2);
	assert.notEqual(ssh1 as unknown, agent1 as unknown);
	assert.deepEqual(connects, { ssh: 1, agent: 1 });

	manager.invalidate("devbox_1");
	await manager.get("devbox_1");
	await manager.getAgent("devbox_1");
	assert.deepEqual(connects, { ssh: 2, agent: 2 });
});
