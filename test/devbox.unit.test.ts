import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
	CreateRequestSchema,
	DevBoxSchema,
	DevboxTemplateSchema,
	DevboxTemplateSpecSchema,
	DevboxTemplateSpec_Type,
	PersistenceMode,
	PortSpec_Kind,
	type DevboxTemplateSpec,
} from "../src/proto/namespace/private/devbox/devbox_pb.js";
import {
	blueprint,
	blueprintSpec,
	DEFAULT_SITE,
	devboxInfo,
	deserializeVersionControl,
	cursorFromBytes,
	cursorToBytes,
	imageSelector,
	positiveBigInt,
	toProtoShape,
	serializeVersionControl,
} from "../src/devbox/conversion.js";
import { createResources } from "../src/devbox/resources.js";
import { createDevboxClient, type CreateDevboxInput } from "../src/devbox/index.js";
import { fromBearerToken } from "../src/auth/index.js";
import { EventEmitter, once } from "node:events";
import { posix, win32 } from "node:path";
import { Readable } from "node:stream";
import type { SFTPWrapper, Stats } from "ssh2";
import { Code, ConnectError } from "@connectrpc/connect";
import {
	AgentConnection,
	buildExecRequest,
	collectExec,
	ConnectionManager,
	operationDeadline,
	SshConnection,
	withDeadline,
} from "../src/devbox/connection.js";
import { DevboxHandle } from "../src/devbox/devbox.js";
import { ExecLogChunkSchema, type ExecLogChunk, type StartExecRequest } from "../src/proto/namespace/private/devbox/wire/wire_pb.js";
import { cachingTokenSource } from "../src/auth/caching.js";

test("blueprint conversion preserves native SDK fields", () => {
	const spec = blueprintSpec("typescript", {
		image: "node:22",
		size: "m",
		site: "ord",
		description: "TypeScript development",
		access: "workspace",
		environment: {
			NODE_ENV: "development",
			API_TOKEN: { secretId: "sec_api" },
		},
		volumeSizeGB: 50,
		ephemeral: { stoppedRetentionMs: 60_000 },
		features: [],
		networkPolicy: { allowedDomains: ["registry.npmjs.org"] },
		busyTimeoutMs: 30_000,
		initScript: "npm install",
		sessions: [
			{ name: "server", command: "npm run dev" },
			{ name: "shell", command: "exec bash" },
		],
		portForwards: [
			{ name: "server", number: 3000 },
			{ number: 5432 },
		],
		exposedPorts: [
			{ name: "web", number: 8080 },
			{ number: 8000 },
		],
		versionControl: {
			repositories: [
				{ repository: "github.com/example/frontend", ref: "feature/ui" },
				{ repository: "github.com/example/backend", checkoutMethod: "git-snapshot-unpack" },
			],
		},
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
	assert.deepEqual(spec.environment.map(({ name, value, fromSecretId }) => ({ name, value, fromSecretId })), [
		{ name: "NODE_ENV", value: "development", fromSecretId: "" },
		{ name: "API_TOKEN", value: "", fromSecretId: "sec_api" },
	]);
	assert.deepEqual(converted.definition.environment, {
		NODE_ENV: "development",
		API_TOKEN: { secretId: "sec_api" },
	});
	assert.deepEqual(converted.definition.features, []);
	assert.equal(
		typeof converted.definition.ephemeral === "object"
			? converted.definition.ephemeral.stoppedRetentionMs
			: undefined,
		60_000,
	);
	assert.equal(converted.definition.busyTimeoutMs, 30_000);
	assert.equal(converted.definition.initScript, "npm install");
	assert.deepEqual(spec.sessions.map(({ name, command }) => ({ name, command })), [
		{ name: "server", command: "npm run dev" },
		{ name: "shell", command: "exec bash" },
	]);
	assert.deepEqual(converted.definition.sessions, [
		{ name: "server", command: "npm run dev" },
		{ name: "shell", command: "exec bash" },
	]);
	assert.deepEqual(spec.ports.map(({ name, number, kind }) => ({ name, number, kind })), [
		{ name: "server", number: 3000, kind: PortSpec_Kind.PORT_FORWARD },
		{ name: "", number: 5432, kind: PortSpec_Kind.PORT_FORWARD },
		{ name: "web", number: 8080, kind: PortSpec_Kind.HTTP_INGRESS },
		{ name: "", number: 8000, kind: PortSpec_Kind.HTTP_INGRESS },
	]);
	assert.deepEqual(converted.definition.portForwards, [
		{ name: "server", number: 3000 },
		{ name: undefined, number: 5432 },
	]);
	assert.deepEqual(converted.definition.exposedPorts, [
		{ name: "web", number: 8080 },
		{ name: undefined, number: 8000 },
	]);
	assert.deepEqual(converted.definition.versionControl, {
		repositories: [
			{ repository: "github.com/example/frontend", ref: "feature/ui", checkoutMethod: undefined },
			{ repository: "github.com/example/backend", ref: undefined, checkoutMethod: "git-snapshot-unpack" },
		],
	});
});

test("blueprint conversion treats built-in images as image names", () => {
	const spec = blueprintSpec("default", { image: "builtin:default" });

	assert.equal(spec.instance?.linux?.imageName, "builtin:default");
	assert.equal(spec.instance?.linux?.imageRef, "");

	const converted = blueprint(create(DevboxTemplateSchema, {
		id: "blueprint_123",
		version: 1n,
		spec,
	}));
	assert.equal(converted.definition.image, "builtin:default");

	const roundTripped = blueprintSpec(converted.name, converted.definition);
	assert.equal(roundTripped.instance?.linux?.imageName, "builtin:default");
	assert.equal(roundTripped.instance?.linux?.imageRef, "");

	const containerSpec = blueprintSpec("node", { image: "node:22" });
	assert.equal(containerSpec.instance?.linux?.imageName, "");
	assert.equal(containerSpec.instance?.linux?.imageRef, "node:22");
});

test("managed blueprints use platform defaults and roundtrip through resource methods", async () => {
	for (const os of ["macos", "windows"] as const) {
		let stored = create(DevboxTemplateSchema, { id: "blueprint", version: 1n });
		const { blueprints } = createResources({
			createTemplate: async ({ spec }: { spec: DevboxTemplateSpec }) => {
				stored.spec = spec;
				return { template: stored };
			},
			fetchTemplate: async () => ({ template: stored }),
			listTemplates: async () => ({ templates: [stored], paginationCursor: new Uint8Array() }),
			updateTemplate: async ({ spec }: { spec: DevboxTemplateSpec }) => {
				stored = create(DevboxTemplateSchema, { id: stored.id, version: stored.version + 1n, spec });
				return { template: stored };
			},
		} as never, {} as ConnectionManager);
		const created = await blueprints.create(os, { os, ephemeral: true });
		assert.equal(stored.spec?.instance?.shape?.os, os);
		assert.equal(stored.spec?.instance?.shape?.machineArch, os === "macos" ? "arm64" : "amd64");
		assert.equal(stored.spec?.instance?.shape?.virtualCpu, os === "macos" ? 6 : 8);
		assert.equal(stored.spec?.instance?.linux, undefined);
		assert.ok(stored.spec?.ephemeral);
		assert.equal(created.definition.image, "");
		assert.equal(created.definition.os, os);
		assert.equal((await blueprints.get(os)).definition.size, "m");
		assert.equal((await blueprints.list()).items[0].definition.os, os);
		for await (const item of blueprints.iterate()) {
			assert.equal(item.definition.os, os);
		}
		const updated = await blueprints.update(os, { ...created.definition, description: "updated" });
		assert.equal(updated.definition.os, os);
		assert.equal(updated.definition.description, "updated");
		assert.equal(stored.spec?.instance?.linux, undefined);
	}
});

test("blueprint updates retain managed shape selectors and nonstandard sizes without exposing selectors", async () => {
	for (const os of ["macos", "windows"]) {
		const original = create(DevboxTemplateSpecSchema, {
			name: "managed", ephemeral: {}, type: DevboxTemplateSpec_Type.GENERAL,
			persistenceMode: os === "macos" ? PersistenceMode.WHOLE_SYSTEM : PersistenceMode.UNSPECIFIED,
			privileged: true,
			environment: [{ name: "OLD", value: "clear me" }],
			instance: { shape: {
				os, machineArch: os === "macos" ? "arm64" : "amd64",
				virtualCpu: 7, memoryMegabytes: 19_456,
				selectors: [{ name: "image.with", value: "tools" }, { name: "image.with", value: "extra" }],
			} },
		});
		let stored = create(DevboxTemplateSchema, { id: "blueprint", spec: original });
		const { blueprints } = createResources({
			fetchTemplate: async () => ({ template: stored }),
			updateTemplate: async ({ spec }: { spec: DevboxTemplateSpec }) => {
				stored = create(DevboxTemplateSchema, { id: stored.id, spec });
				return { template: stored };
			},
		} as never, {} as ConnectionManager);
		const fetched = await blueprints.get("managed");
		assert.equal(fetched.definition.size, undefined);
		assert.equal("selectors" in fetched.definition, false);
		await blueprints.update("managed", { ...fetched.definition, description: "metadata-only" });
		assert.deepEqual(stored.spec?.instance?.shape, original.instance?.shape);
		assert.equal(stored.spec?.type, original.type);
		assert.equal(stored.spec?.persistenceMode, original.persistenceMode);
		assert.equal(stored.spec?.privileged, true);
		await blueprints.update("managed", { ...fetched.definition, size: "l" });
		assert.equal(stored.spec?.instance?.shape?.virtualCpu, os === "macos" ? 12 : 16);
		assert.deepEqual(stored.spec?.instance?.shape?.selectors, original.instance?.shape?.selectors);
		await blueprints.update("managed", { ephemeral: true });
		assert.equal(stored.spec?.instance?.shape?.os, os);
		assert.equal(stored.spec?.instance?.shape?.virtualCpu, os === "macos" ? 12 : 16);
		assert.deepEqual(stored.spec?.environment, []);
		assert.equal(stored.spec?.description, "");
		assert.equal(original.instance?.shape?.virtualCpu, 7);
		assert.equal(original.description, "");
		await assert.rejects(blueprints.update("managed", {
			...fetched.definition, os: "linux", image: "node:22",
		}), /cannot change the operating system/);
		assert.equal(stored.spec?.instance?.shape?.os, os);
	}
});

test("managed blueprint validation matches platform creation constraints", async () => {
	const { blueprints } = createResources({} as never, {} as ConnectionManager);
	await assert.rejects(blueprints.create("linux", {}), /Linux blueprints require "image"/);
	for (const os of ["macos", "windows"] as const) {
		await assert.rejects(blueprints.create("custom", { os, ephemeral: true, image: "custom" }), /"image"/);
	}
	for (const ephemeral of [undefined, false]) {
		await assert.rejects(blueprints.create("windows", { os: "windows", ephemeral }), /require "ephemeral"/);
	}
	await assert.rejects(blueprints.create("windows", {
		os: "windows", ephemeral: true, volumeSizeGB: 1,
	}), /"volumeSizeGB"/);
	await assert.rejects(blueprints.create("macos", { os: "macos", size: "s" }), /machine size "s"/);
	const spec = blueprintSpec("windows", {
		os: "windows", size: "s", image: "", volumeSizeGB: 0,
		ephemeral: { stoppedRetentionMs: 60_000 }, initScript: "Write-Output 'hello'",
	});
	assert.equal(spec.instance?.shape?.virtualCpu, 4);
	assert.equal(spec.instance?.shape?.memoryMegabytes, 8192);
	assert.equal(spec.initScript, "Write-Output 'hello'");
	assert.equal(spec.ephemeral?.stoppedRetentionDuration?.seconds, 60n);
	assert.equal(blueprintSpec("linux", { image: "node:22" }).instance?.shape, undefined);
	assert.equal(blueprintSpec("legacy-empty", { image: "" }).instance?.linux?.imageName, "");
});

test("version control conversion normalizes legacy reads without collapsing multiple repositories", () => {
	assert.deepEqual(deserializeVersionControl(serializeVersionControl({
		gitRepository: "github.com/example/legacy",
		ref: "main",
		checkoutMethod: "git-clone",
	})), {
		repositories: [{ repository: "github.com/example/legacy", ref: "main", checkoutMethod: "git-clone" }],
	});

	const versionControl = serializeVersionControl({
		repositories: [
			{ repository: "github.com/example/frontend" },
			{ repository: "github.com/example/backend", ref: "release", checkoutMethod: "git-snapshot-unpack" },
		],
	});
	assert.equal(versionControl?.gitRepository, "");
	assert.deepEqual(deserializeVersionControl(versionControl), {
		repositories: [
			{ repository: "github.com/example/frontend", ref: undefined, checkoutMethod: undefined },
			{ repository: "github.com/example/backend", ref: "release", checkoutMethod: "git-snapshot-unpack" },
		],
	});
});

test("devbox info includes repository configuration", () => {
	const info = devboxInfo(create(DevBoxSchema, {
		id: "devbox_123",
		name: "multi-repo",
		versionControl: serializeVersionControl({
			repositories: [
				{ repository: "github.com/example/frontend" },
				{ repository: "github.com/example/backend" },
			],
		}),
	}));
	assert.deepEqual(info.versionControl?.repositories?.map(({ repository }) => repository), [
		"github.com/example/frontend",
		"github.com/example/backend",
	]);
});

test("shape resolution rejects sizes unknown to this SDK version", () => {
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
	const requests: Array<{
		imageRef?: string;
		imageName?: string;
		instanceShape?: { virtualCpu?: number; memoryMegabytes?: number };
	}> = [];
	const rpc = {
		create: async (request: typeof requests[number]) => {
			requests.push(request);
			return { devbox: create(DevBoxSchema, { id: "devbox_123", name: "test" }) };
		},
	} as never;
	const { devboxes } = createResources(rpc, {} as ConnectionManager);

	await devboxes.create({ name: "named", imageName: "builtin:agents", size: "m", start: false });
	await devboxes.create({ name: "ref", image: "node:22", start: false });
	await devboxes.create({ name: "legacy-name", image: "node-22", start: false });

	assert.equal(requests[0]?.imageName, "builtin:agents");
	assert.equal(requests[0]?.imageRef, undefined);
	assert.equal(requests[0]?.instanceShape?.virtualCpu, 8);
	assert.equal(requests[0]?.instanceShape?.memoryMegabytes, 16 * 1024);
	assert.equal(requests[1]?.imageRef, "node:22");
	assert.equal(requests[1]?.imageName, undefined);
	assert.equal(requests[2]?.imageName, "node-22");
	assert.equal(requests[2]?.imageRef, undefined);
});

test("Windows creation uses managed ephemeral amd64 shapes and reads back sizes", async () => {
	let request = create(CreateRequestSchema);
	const rpc = {
		create: async (input: MessageInitShape<typeof CreateRequestSchema>) => {
			request = create(CreateRequestSchema, input);
			return {
				devbox: create(DevBoxSchema, {
					id: "windows_123",
					name: request.name,
					instanceShape: request.instanceShape,
					ephemeral: request.ephemeral,
				}),
				instanceId: request.activate ? "instance_123" : "",
			};
		},
	} as never;
	const { devboxes } = createResources(rpc, {} as ConnectionManager);
	const shapes = [
		{ size: "s", vCPUs: 4, memoryMB: 8192 },
		{ size: "m", vCPUs: 8, memoryMB: 16384 },
		{ size: "l", vCPUs: 16, memoryMB: 32768 },
		{ size: "xl", vCPUs: 32, memoryMB: 65536 },
	] as const;
	for (const { size, vCPUs, memoryMB } of shapes) {
		const devbox = await devboxes.create({
			name: `windows-${size}`, os: "windows", size, ephemeral: true, start: false,
		});
		assert.equal(request.instanceShape?.os, "windows");
		assert.equal(request.instanceShape?.machineArch, "amd64");
		assert.equal(request.instanceShape?.virtualCpu, vCPUs);
		assert.equal(request.instanceShape?.memoryMegabytes, memoryMB);
		assert.deepEqual(request.instanceShape?.selectors, []);
		assert.equal(request.imageName, "");
		assert.equal(request.imageRef, "");
		assert.ok(request.ephemeral);
		assert.equal(request.activate, false);
		assert.equal(devbox.info.state, "stopped");
		assert.equal(devbox.info.size, size);
		assert.equal(devbox.info.ephemeral, true);
		assert.equal(devbox.info.image, "");
		assert.deepEqual(devbox.info.shape, { vCPUs, memoryMB, architecture: "amd64", os: "windows" });
	}

	const devbox = await devboxes.create({
		name: "windows-retention", os: "windows",
		ephemeral: { stoppedRetentionMs: 91_234 },
	});
	assert.deepEqual(devbox.info.shape, { vCPUs: 8, memoryMB: 16384, architecture: "amd64", os: "windows" });
	assert.equal(devbox.info.size, "m");
	assert.equal(devbox.info.state, "running");
	assert.equal(devbox.info.instanceId, "instance_123");
	assert.equal(request.ephemeral?.stoppedRetentionDuration?.seconds, 91n);
	assert.equal(request.ephemeral?.stoppedRetentionDuration?.nanos, 234_000_000);
});

test("Windows creation rejects unsupported inputs before making RPCs", async () => {
	const { devboxes } = createResources({} as never, {} as ConnectionManager);
	const windows = { name: "windows", os: "windows", size: "m", ephemeral: true };
	for (const [options, message] of [
		[{ size: "xxl" }, /machine size/],
		[{ ephemeral: undefined }, /ephemeral/],
		[{ ephemeral: false }, /ephemeral/],
		[{ image: "node:22" }, /image/],
		[{ imageName: "windows-2022" }, /imageName/],
		[{ volumeSizeGB: 50 }, /volumeSizeGB/],
		[{ privileged: true }, /privileged/],
	] as const) {
		await assert.rejects(devboxes.create({ ...windows, ...options } as never), message);
	}
});

test("devbox creation serializes literal and secret environment values", async () => {
	let requestEnvironment: Array<{ name: string; value?: string; fromSecretId?: string }> | undefined;
	const rpc = {
		create: async (request: { environment?: typeof requestEnvironment }) => {
			requestEnvironment = request.environment;
			return { devbox: create(DevBoxSchema, { id: "devbox_123", name: "test" }) };
		},
	} as never;
	const { devboxes } = createResources(rpc, {} as ConnectionManager);

	await devboxes.create({
		name: "environment",
		image: "node:22",
		start: false,
		environment: {
			EMPTY: "",
			API_TOKEN: { secretId: "sec_api" },
		},
	});

	assert.deepEqual(requestEnvironment, [
		{ name: "EMPTY", value: "" },
		{ name: "API_TOKEN", fromSecretId: "sec_api" },
	]);
});

test("devbox creation serializes sessions", async () => {
	let requestSessions: Array<{ name: string; command: string }> | undefined;
	const rpc = {
		create: async (request: { sessions?: typeof requestSessions }) => {
			requestSessions = request.sessions;
			return { devbox: create(DevBoxSchema, { id: "devbox_123", name: "test" }) };
		},
	} as never;
	const { devboxes } = createResources(rpc, {} as ConnectionManager);

	await devboxes.create({
		name: "sessions",
		start: false,
		sessions: [
			{ name: "server", command: "npm run dev" },
			{ name: "shell", command: "exec bash" },
		],
	});

	assert.deepEqual(requestSessions, [
		{ name: "server", command: "npm run dev" },
		{ name: "shell", command: "exec bash" },
	]);
});

test("devbox creation serializes configured ports", async () => {
	let requestPorts: Array<{ name: string; number: number; kind: PortSpec_Kind }> | undefined;
	const rpc = {
		create: async (request: { ports?: typeof requestPorts }) => {
			requestPorts = request.ports;
			return { devbox: create(DevBoxSchema, { id: "devbox_123", name: "test" }) };
		},
	} as never;
	const { devboxes } = createResources(rpc, {} as ConnectionManager);

	await devboxes.create({
		name: "ports",
		start: false,
		portForwards: [
			{ name: "server", number: 3000 },
			{ number: 5432 },
		],
		exposedPorts: [
			{ name: "web", number: 8080 },
			{ number: 8000 },
		],
	});

	assert.deepEqual(requestPorts, [
		{ name: "server", number: 3000, kind: PortSpec_Kind.PORT_FORWARD },
		{ name: "", number: 5432, kind: PortSpec_Kind.PORT_FORWARD },
		{ name: "web", number: 8080, kind: PortSpec_Kind.HTTP_INGRESS },
		{ name: "", number: 8000, kind: PortSpec_Kind.HTTP_INGRESS },
	]);
});

test("devbox creation sends and returns labels", async () => {
	const inputLabels = {
		environment: "staging",
		team: "sdk",
	};
	const protoLabels = [
		{ name: "environment", value: "staging" },
		{ name: "team", value: "sdk" },
	];
	let requestLabels: typeof protoLabels | undefined;
	const rpc = {
		create: async (request: { labels?: typeof protoLabels }) => {
			requestLabels = request.labels;
			return {
				devbox: create(DevBoxSchema, {
					id: "devbox_123",
					name: "labeled",
					labels: protoLabels,
				}),
			};
		},
	} as never;
	const { devboxes } = createResources(rpc, {} as ConnectionManager);

	const devbox = await devboxes.create({
		name: "labeled",
		labels: inputLabels,
		start: false,
	});

	assert.deepEqual(requestLabels, protoLabels);
	assert.deepEqual(devbox.info.labels, inputLabels);
});

test("blueprint devbox creation sends labels", async () => {
	const inputLabels = {
		environment: "staging",
		team: "sdk",
	};
	const protoLabels = [
		{ name: "environment", value: "staging" },
		{ name: "team", value: "sdk" },
	];
	let requestLabels: typeof protoLabels | undefined;
	const rpc = {
		fetchTemplate: async () => ({
			template: create(DevboxTemplateSchema, {
				id: "blueprint_123",
				version: 7n,
				spec: blueprintSpec("typescript", { image: "node:22" }),
			}),
		}),
		createFromTemplate: async (request: { labels?: typeof protoLabels }) => {
			requestLabels = request.labels;
			return {
				devbox: create(DevBoxSchema, {
					id: "devbox_123",
					name: "labeled",
					labels: protoLabels,
				}),
			};
		},
	} as never;
	const { devboxes } = createResources(rpc, {} as ConnectionManager);

	const devbox = await devboxes.create({
		name: "labeled",
		blueprint: "typescript",
		labels: inputLabels,
		start: false,
	});

	assert.deepEqual(requestLabels, protoLabels);
	assert.deepEqual(devbox.info.labels, inputLabels);
});

test("get and list return devbox labels", async () => {
	const protoDevbox = create(DevBoxSchema, {
		id: "devbox_123",
		name: "labeled",
		labels: [
			{ name: "environment", value: "staging" },
			{ name: "team", value: "sdk" },
		],
	});
	const rpc = {
		fetch: async () => ({ devbox: protoDevbox }),
		list: async () => ({
			devboxes: [protoDevbox],
			paginationCursor: new Uint8Array(),
		}),
	} as never;
	const { devboxes } = createResources(rpc, {} as ConnectionManager);
	const expectedLabels = {
		environment: "staging",
		team: "sdk",
	};

	const fetched = await devboxes.get("labeled");
	const listed = await devboxes.list();

	assert.deepEqual(fetched.info.labels, expectedLabels);
	assert.deepEqual(listed.items[0]?.info.labels, expectedLabels);
});

test("devbox creation serializes instance event callbacks", async (t) => {
	const requests: Record<string, unknown>[] = [];

	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));

		requests.push(JSON.parse(Buffer.concat(chunks).toString()));
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ devbox: { id: "devbox_123", name: "callback" } }));
	});

	t.after(() => server.close());
	server.listen(0, "127.0.0.1");
	await once(server, "listening");

	const address = server.address();
	assert(address && typeof address !== "string");

	const client = createDevboxClient({
		baseUrl: `http://127.0.0.1:${address.port}`,
		tokenSource: fromBearerToken("test-token"),
	});
	t.after(() => client.close());

	await client.devboxes.create({
		name: "callback",
		start: false,
		instanceEventCallback: {
			url: "https://example.com/instance-events",
			headers: [
				{ name: "X-Source", value: "managed-agent" },
				{ name: "Authorization", secretId: "sec_callback_token" },
			],
			signingSecretId: "sec_callback_signing",
		},
	});

	assert.deepEqual(requests[0]?.instanceEventCallback, {
		postUrl: "https://example.com/instance-events",
		headers: [
			{ name: "X-Source", valueFrom: { static: "managed-agent" } },
			{ name: "Authorization", valueFrom: { fromSecretId: "sec_callback_token" } },
		],
		signWithSecretId: "sec_callback_signing",
	});
});

test("list serializes ANDed label filters with explicit OR groups", async (t) => {
	const requests: Record<string, unknown>[] = [];
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		requests.push(JSON.parse(Buffer.concat(chunks).toString()));
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ devboxes: [] }));
	});
	t.after(() => server.close());
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert(address && typeof address !== "string");
	const client = createDevboxClient({
		baseUrl: `http://127.0.0.1:${address.port}`,
		tokenSource: fromBearerToken("test-token"),
	});
	t.after(() => client.close());

	await client.devboxes.list({
		labelFilters: [
			{ name: "environment", value: "development" },
			{
				anyOf: [
					{ name: "cursor", operator: "exists" },
					{ name: "lifecycle", value: "deprecated", operator: "not-equal" },
				],
			},
		],
	});

	assert.deepEqual(requests[0]?.matchLabels, [
		{
			anyOf: [
				{ name: "environment", value: "development", op: "EQUAL" },
			],
		},
		{
			anyOf: [
				{ name: "cursor", op: "EXIST" },
				{ name: "lifecycle", value: "deprecated", op: "NOT_EQUAL" },
			],
		},
	]);
});

test("iterate forwards label filters to every page", async () => {
	const requests: Array<{
		matchLabels?: unknown;
		paginationCursor?: Uint8Array;
	}> = [];
	const rpc = {
		list: async (request: {
			matchLabels?: unknown;
			paginationCursor?: Uint8Array;
		}) => {
			requests.push(request);
			return {
				devboxes: [],
				paginationCursor: requests.length === 1 ? new Uint8Array([1]) : new Uint8Array(),
			};
		},
	} as never;
	const { devboxes } = createResources(rpc, {} as ConnectionManager);

	for await (const _ of devboxes.iterate({
		labelFilters: [{ name: "managed-agent", operator: "exists" }],
	})) {
		// No results are needed to exercise pagination.
	}

	assert.equal(requests.length, 2);
	assert.deepEqual(requests[0]?.matchLabels, requests[1]?.matchLabels);
	assert.deepEqual(requests[0]?.matchLabels, [
		{
			anyOf: [
				{ name: "managed-agent", op: 3 },
			],
		},
	]);
});

test("devbox checkout options preserve presence in serialized requests", async (t) => {
	const requests: Record<string, unknown>[] = [];
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		requests.push(JSON.parse(Buffer.concat(chunks).toString()));
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ devbox: { id: "devbox_123", name: "test" } }));
	});
	t.after(() => server.close());
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert(address && typeof address !== "string");
	const client = createDevboxClient({
		baseUrl: `http://127.0.0.1:${address.port}`,
		tokenSource: fromBearerToken("test-token"),
	});
	t.after(() => client.close());

	const repository = "https://github.com/namespacelabs/typescript-sdk";
	const cases: Array<{
		input: CreateDevboxInput;
		repository?: string;
		versionControl?: Record<string, unknown>;
	}> = [
		{ input: { name: "inherit" } },
		{ input: { name: "empty-repository", repository: "" } },
		{ input: { name: "undefined", versionControl: undefined } },
		{ input: { name: "checkout", repository }, repository },
		{ input: { name: "scratch", versionControl: {} }, versionControl: {} },
		{ input: { name: "scratch-modern", versionControl: { repositories: [] } }, versionControl: {} },
		{
			input: { name: "configured-checkout", versionControl: { gitRepository: repository } },
			versionControl: { gitRepository: repository },
		},
		{
			input: { name: "checkout-ref", versionControl: { gitRepository: repository, ref: "feature/sdk" } },
			versionControl: { gitRepository: repository, ref: "feature/sdk" },
		},
		{
			input: {
				name: "multiple-checkouts",
				versionControl: {
					repositories: [
						{ repository, ref: "main", checkoutMethod: "git-clone" },
						{ repository: "https://github.com/namespacelabs/docs" },
					],
				},
			},
			versionControl: {
				repositories: [
					{ repository, ref: "main", checkoutMethod: "CHECKOUT_METHOD_GIT_CLONE" },
					{ repository: "https://github.com/namespacelabs/docs" },
				],
			},
		},
	];
	for (const expected of cases) {
		await t.test(expected.input.name, async () => {
			await client.devboxes.create({ ...expected.input, start: false });
			assert.equal(requests.length, 1);
			const request = requests.shift()!;
			assert.equal(request.repository, expected.repository);
			assert.deepEqual(request.versionControl, expected.versionControl);
			assert.equal("versionControl" in request, expected.versionControl !== undefined);
		});
	}

	for (const repository of ["", "https://github.com/namespacelabs/typescript-sdk"]) {
		for (const versionControl of [{}, { gitRepository: repository }]) {
			await assert.rejects(
				client.devboxes.create({ name: "invalid", repository, versionControl } as never),
				{ name: "TypeError", message: 'create options "repository" and "versionControl" cannot be used together' },
			);
		}
	}
	await assert.rejects(
		client.devboxes.create({ name: "invalid", blueprint: "typescript", versionControl: {} } as never),
		{ name: "TypeError", message: 'create option "versionControl" cannot be used with a blueprint' },
	);
	await assert.rejects(
		client.devboxes.create({
			name: "invalid",
			versionControl: {
				repositories: [{ repository }],
				gitRepository: repository,
			},
		} as never),
		{ name: "TypeError", message: 'versionControl "repositories" cannot be combined with legacy fields' },
	);
	await assert.rejects(
		client.devboxes.create({
			name: "invalid",
			versionControl: {
				repositories: Array.from({ length: 21 }, (_, index) => ({ repository: `github.com/example/repo-${index}` })),
			},
		}),
		{ name: "RangeError", message: "versionControl.repositories must contain at most 20 repositories" },
	);
	assert.equal(requests.length, 0, "invalid options must be rejected before sending any RPC");
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
	const connection = new SshConnection(
		"instance",
		fakeSshClient({
			sftp: (callback: (error: Error | undefined, sftp: EventEmitter) => void) => {
				opens += 1;
				queueMicrotask(() => callback(undefined, channel));
			},
		}) as never,
		{} as never,
	);

	const [first, second] = await Promise.all([connection.sftp(), connection.sftp()]);
	assert.equal(first, second);
	assert.equal(await connection.sftp(), first);
	assert.equal(opens, 1);
});

test("sftp cache is invalidated on channel close and failed open", async () => {
	let opens = 0;
	const channels: EventEmitter[] = [];
	const connection = new SshConnection(
		"instance",
		fakeSshClient({
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
		}) as never,
		{} as never,
	);

	const first = await connection.sftp();
	first.emit("close");
	await assert.rejects(connection.sftp(), /channel open failure/);
	const third = await connection.sftp();
	assert.notEqual(third, first);
	assert.equal(opens, 3);
});

function devboxWithSftp(sftp: {
	createReadStream?: (path: string, options: { start?: number; end?: number }) => Readable;
	mkdir?: SFTPWrapper["mkdir"];
	stat?: SFTPWrapper["stat"];
}, os?: "windows" | "linux" | "macos") {
	let connections = 0;
	const box = new DevboxHandle(
		{ id: "devbox", name: "devbox", state: "running", ephemeral: false, shape: { os } } as never,
		{
			get: async () => {
				connections += 1;
				return { sftp: async () => sftp };
			},
		} as never,
		{} as never,
	);
	return { box, connectionCount: () => connections };
}

test("filesystem recursive mkdir creates guest directories without changing path semantics", async (t) => {
	for (const os of ["windows", "linux", "macos", undefined] as const) {
		await t.test(os ?? "unknown OS", async () => {
			const paths = os === "windows" ? win32 : posix;
			const workspace = os === "windows" ? "C:\\workspace" : "/workspace";
			const resolve = (value: string) => paths.resolve(workspace,
				os === "windows" ? value.replace(/^\/([a-z]:)/i, "$1") : value);
			const directories = new Map<string, number | undefined>([
				[paths.parse(workspace).root, undefined],
				[workspace, undefined],
				["\\\\server\\share\\", undefined],
			]);
			const file = resolve("file");
			const missing = () => Object.assign(new Error("missing parent"), { code: 2 });
			const { box } = devboxWithSftp({
				mkdir: ((value: string, attrs: { mode?: number }, callback: (error?: Error) => void) => {
					const path = resolve(value);
					if (directories.has(path) || path === file) {
						callback(new Error("already exists"));
					} else if (!directories.has(paths.dirname(path))) {
						callback(missing());
					} else {
						directories.set(path, attrs.mode);
						callback();
					}
				}) as SFTPWrapper["mkdir"],
				stat: (value, callback) => {
					const path = resolve(value);
					if (directories.has(path) || path === file) {
						callback(undefined, { isDirectory: () => directories.has(path) } as Stats);
					} else {
						callback(missing(), undefined as never);
					}
				},
			}, os);
			const cases = os === "windows" ? [
				"C:\\native\\one\\two", "C:/forward/one/two", "relative\\one\\two",
				"mixed/one\\two", "C:drive\\child", "\\\\server\\share\\one\\two",
				"\\rooted\\child", "/C:/sftp/one/two", "C:\\", "\\\\server\\share\\",
				"dots\\.\\child\\..\\sibling",
			] : [
				"/absolute/one/two", "relative/one/two", "literal\\backslash/child",
				"C:\\literal/child", "/", "dots/./child/../sibling",
			];
			for (const path of cases) {
				await box.fs.mkdir(path, { recursive: true, mode: 0o750 });
				assert.equal(await box.fs.exists(path), true, path);
				await box.fs.mkdir(path, { recursive: true });
			}
			assert.equal(directories.get(resolve(cases[0])), 0o750);
			await assert.rejects(box.fs.mkdir("file/child", { recursive: true }), /already exists/);
			await assert.rejects(box.fs.mkdir("missing/child"), /missing parent/);
			assert.equal(await box.fs.exists("missing"), false);
			await assert.rejects(box.fs.mkdir("cancelled", {
				recursive: true, signal: AbortSignal.abort(),
			}));
			assert.equal(await box.fs.exists("cancelled"), false);
		});
	}
});

function devboxWithFile(contents: Uint8Array) {
	const ranges: Array<{ start?: number; end?: number }> = [];
	const result = devboxWithSftp({
		createReadStream: (_path, options) => {
			ranges.push(options);
			const start = options.start ?? 0;
			const end = options.end === undefined ? contents.byteLength : options.end + 1;
			return Readable.from([contents.slice(start, end)]);
		},
	});
	return { ...result, ranges };
}

test("filesystem read supports text, byte ranges, and streams", async () => {
	const { box, ranges } = devboxWithFile(new TextEncoder().encode("zero-one-two"));

	assert.equal(await box.fs.read("/log"), "zero-one-two");
	assert.deepEqual(await box.fs.read("/log", { format: "bytes", offset: 5, length: 3 }), Buffer.from("one"));
	assert.deepEqual(await box.fs.read("/log", { format: "bytes", offset: 10, length: 10 }), Buffer.from("wo"));
	assert.deepEqual(await box.fs.read("/log", { format: "bytes", offset: 20, length: 10 }), Buffer.alloc(0));

	const stream = await box.fs.read("/log", { format: "stream", offset: 9 });
	const chunks: Uint8Array[] = [];
	for await (const chunk of stream) chunks.push(chunk);
	assert.equal(Buffer.concat(chunks).toString(), "two");
	assert.deepEqual(ranges, [
		{ start: undefined, end: undefined },
		{ start: 5, end: 7 },
		{ start: 10, end: 19 },
		{ start: 20, end: 29 },
		{ start: 9, end: undefined },
	]);
});

test("filesystem read validates byte ranges before connecting", async () => {
	const { box, connectionCount } = devboxWithFile(new Uint8Array());

	await assert.rejects(box.fs.read("/log", { offset: -1 }), /non-negative safe integer/);
	await assert.rejects(box.fs.read("/log", { length: 0 }), /positive safe integer/);
	await assert.rejects(box.fs.read("/log", { format: "json" } as never), /read format/);
	await assert.rejects(
		box.fs.read("/log", { offset: Number.MAX_SAFE_INTEGER, length: 2 }),
		/range exceeds/,
	);
	assert.equal(connectionCount(), 0);
});

function controlledRead() {
	let destroyed = false;
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => { markStarted = resolve; });
	const { box } = devboxWithSftp({
		createReadStream: () => {
			markStarted();
			return new Readable({
				read() {},
				destroy(error, callback) {
					destroyed = true;
					callback(error);
				},
			});
		},
	});
	return { box, started, isDestroyed: () => destroyed };
}

test("filesystem read closes streams on abort, timeout, and cancellation", async (t) => {
	await t.test("abort", async () => {
		const { box, started, isDestroyed } = controlledRead();
		const controller = new AbortController();
		const pending = box.fs.read("/log", { format: "bytes", signal: controller.signal });
		await started;
		controller.abort();
		await assert.rejects(pending, { name: "AbortError" });
		assert.equal(isDestroyed(), true);
	});

	await t.test("timeout", async () => {
		const { box, started, isDestroyed } = controlledRead();
		const pending = box.fs.read("/log", { format: "bytes", timeoutMs: 5 });
		await started;
		await assert.rejects(pending, /timed out/);
		assert.equal(isDestroyed(), true);
	});

	await t.test("stream cancellation", async () => {
		const { box, started, isDestroyed } = controlledRead();
		const stream = await box.fs.read("/log", { format: "stream" });
		await started;
		await stream.cancel();
		assert.equal(isDestroyed(), true);
	});
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
	const connection = new SshConnection(
		"instance",
		fakeSshClient({
			shell: (
				_window: unknown,
				_options: unknown,
				callback: (error: Error | undefined, channel: unknown) => void,
			) => queueMicrotask(() => callback(undefined, channel)),
		}) as never,
		{} as never,
	);

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

test("foreground and detached shells honor guest platform and shell overrides", async () => {
	const cases: Array<{ os?: string; reported?: string; configured?: string; override?: string; executable: string; flags: string[] }> = [
		{ os: "windows", executable: "powershell.exe", flags: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"] },
		{ os: "windows", configured: "C:\\Windows\\PowerShell.EXE", executable: "C:\\Windows\\PowerShell.EXE", flags: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"] },
		{ os: "windows", reported: "cmd.exe", configured: "powershell.exe", executable: "cmd.exe", flags: ["/d", "/c"] },
		{ os: "windows", reported: "cmd.exe", override: "C:/tools/PWSH.exe", executable: "C:/tools/PWSH.exe", flags: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"] },
		{ os: "windows", override: "C:\\Windows\\CMD.EXE", executable: "C:\\Windows\\CMD.EXE", flags: ["/d", "/c"] },
		{ os: "windows", override: "sh", executable: "sh", flags: ["-lc"] },
		{ os: "windows", reported: "pwsh", executable: "pwsh", flags: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"] },
		{ os: "linux", executable: "/bin/sh", flags: ["-lc"] },
		{ os: "macos", reported: "/bin/zsh", executable: "/bin/zsh", flags: ["-lc"] },
		{ os: "linux", override: "pwsh", executable: "pwsh", flags: ["-lc"] },
		{ reported: "/bin/bash", executable: "/bin/bash", flags: ["-lc"] },
		{ override: "cmd", executable: "cmd", flags: ["-lc"] },
	];
	const script = 'echo "quotes, $variables, and \\paths";\necho Ω; exit 7';
	for (const { os, reported, configured, override, executable, flags } of cases) {
		const requests: StartExecRequest[] = [];
		const agent = new AgentConnection("instance", {} as never, os, configured);
		Object.assign(agent, { client: {
			runExec: (request: StartExecRequest) => {
				requests.push(request);
				return execChunks({ stdout: new TextEncoder().encode("out"), result: { exitCode: 7 } });
			},
			startExec: async (request: StartExecRequest) => {
				requests.push(request);
				return { execId: "execution" };
			},
			streamExecLogs: () => execChunks({ stdout: new TextEncoder().encode("out"), result: { exitCode: 7 } }),
		} });
		const box = new DevboxHandle(
			{ id: "devbox", name: "test", state: "running", image: "", labels: {}, ephemeral: true, shell: reported },
			{ getAgent: async () => agent } as never,
			{} as never,
		);
		const cwd = os === "windows" ? "C:\\work dir" : "src";
		const options = { shell: override, env: { VALUE: "literal $value" }, stdin: "caller input", cwd };
		const result = await box.shell(script, options);
		const detached = await box.executions.startShell(script, options);
		assert.deepEqual(await detached.wait(), result);
		assert.equal(result.exitCode, 7);
		assert.equal(result.stdout, "out");
		for (const request of requests) {
			assert.equal(request.command?.command, executable);
			assert.deepEqual(request.command?.args, [...flags, script]);
			assert.equal(request.command?.cwd?.absolute, os === "windows" ? cwd : "");
			assert.equal(request.command?.cwd?.workspaceRelative, os === "windows" ? "" : cwd);
			assert.equal(request.command?.additionalEnvironment[0]?.value, "literal $value");
			assert.deepEqual(request.command?.stdin?.value, new TextEncoder().encode("caller input"));
		}
	}
});

test("retained Windows devboxes restart while expired metadata preserves errors and the last snapshot", async () => {
	const proto = create(DevBoxSchema, { id: "devbox", name: "test", ephemeral: {}, instanceShape: { os: "windows" } });
	const missing = new ConnectError("devbox expired", Code.NotFound, { "x-request-id": "request-123" });
	let expired = false;
	const { devboxes } = createResources({
		fetch: async () => {
			if (expired) {
				throw missing;
			}
			return { devbox: proto };
		},
		stop: async () => ({ devbox: proto }),
		activate: async () => {
			if (expired) {
				throw missing;
			}
			return { devbox: proto, instanceId: "new-instance" };
		},
	} as never, { invalidate: () => {} } as never);
	const box = await devboxes.get("devbox");
	await box.stop();
	await box.refresh();
	assert.equal(box.info.state, "stopped");
	assert.equal(box.info.instanceId, undefined);
	await box.start();
	assert.equal(box.id, "devbox");
	assert.equal(box.info.instanceId, "new-instance");
	assert.equal(box.info.state, "running");
	const snapshot = { ...box.info };
	expired = true;
	await assert.rejects(box.refresh(), (error) => error === missing);
	await assert.rejects(box.start(), (error) => error === missing);
	assert.deepEqual(box.info, snapshot);
});

test("exec cwd uses the guest OS without rewriting paths", () => {
	for (const path of ["C:\\work dir\\repo", "C:/work/repo", "\\\\server\\share\\repo", "\\rooted"]) {
		const windows = buildExecRequest(["tool", "$literal;arg"], { cwd: path }, "windows");
		assert.equal(windows.command?.cwd?.absolute, path);
		assert.deepEqual(windows.command?.args, ["$literal;arg"]);
		for (const os of ["linux", "macos", undefined]) {
			assert.equal(buildExecRequest(["tool"], { cwd: path }, os).command?.cwd?.workspaceRelative, path);
		}
	}
	for (const path of ["src\\repo", "C:relative", "src/repo"]) {
		assert.equal(buildExecRequest(["tool"], { cwd: path }, "windows").command?.cwd?.workspaceRelative, path);
	}
	assert.equal(buildExecRequest(["tool"], { cwd: "/work" }, "windows").command?.cwd?.absolute, "/work");
	assert.equal(buildExecRequest(["tool"], {}, "windows").command?.cwd, undefined);
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

test("stopped execution results preserve exit codes without inferring a signal", async () => {
	for (const result of [{ exitCode: 0 }, { exitCode: 23, error: "exit status 23" }, { exitCode: -1, error: "signal: killed" }]) {
		const collected = await collectExec(execChunks(
			{ stdout: new TextEncoder().encode("before stop") },
			{ stderr: new TextEncoder().encode("diagnostic") },
			{ result },
		), {});
		assert.deepEqual(collected, { ...result, signal: null, stdout: "before stop", stderr: "diagnostic" });
	}
});

test("output limits count combined bytes, preserve split UTF-8, and close the reader", async () => {
	const chunks = () => execChunks(
		{ stdout: Uint8Array.from([0xe2, 0x82]) },
		{ stderr: new TextEncoder().encode("err") },
		{ stdout: Uint8Array.from([0xac, 0x21]) },
		{ result: { exitCode: 0 } },
	);
	assert.deepEqual(await collectExec(chunks(), { maxOutputBytes: 7 }), {
		exitCode: 0, signal: null, stdout: "€!", stderr: "err",
	});
	let closed = false;
	async function* tracked() {
		try { yield* chunks(); } finally { closed = true; }
	}
	await assert.rejects(collectExec(tracked(), { maxOutputBytes: 6 }), { name: "ExecutionOutputLimitError" });
	assert.equal(closed, true);
	for (const maxOutputBytes of [-1, 1.5, Infinity, NaN]) {
		await assert.rejects(collectExec(chunks(), { maxOutputBytes }), RangeError);
	}
	assert.equal((await collectExec(execChunks({ result: { exitCode: 0 } }), { maxOutputBytes: 0 })).stdout, "");
	await assert.rejects(collectExec(chunks(), { maxOutputBytes: 0 }), { name: "ExecutionOutputLimitError" });
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
