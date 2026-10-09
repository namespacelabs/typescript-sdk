import assert from "node:assert/strict";
import test from "node:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import type { AgentConnection, ConnectionManager } from "../src/devbox/connection.js";
import {
	DevboxTimeoutError,
	ExecutionNotFoundError,
	IncompleteResponseError,
	ServiceLogsNotFoundError,
	ServiceNotFoundError,
} from "../src/devbox/errors.js";
import { ServiceResources } from "../src/devbox/services.js";
import {
	CreateServiceRequest_InitialState,
	Port_Owner,
	PortSchema,
	PortSpec_Kind,
	ServiceSchema,
	Service_Owner,
	ServiceProcessSchema,
	ServiceProcess_Status,
	ServiceSpec_RestartPolicy,
	ServiceSpec_StartPolicy,
	StopServiceRequest_Mode,
	type CreateServiceRequest,
} from "../src/proto/namespace/private/devbox/wire/wire_pb.js";

test("service creation preserves declarative inputs and all three initial states", async () => {
	const requests: CreateServiceRequest[] = [];
	const returned = protoService({
		id: "service-web",
		name: "web",
		owner: Service_Owner.USER,
		stopped: true,
	});
	const process = create(ServiceProcessSchema, {
		status: ServiceProcess_Status.STOPPED,
		restarts: 2,
		lastExit: {
			code: 0,
			message: "",
			exitedAt: timestampFromDate(new Date("2026-10-09T10:00:00Z")),
		},
	});
	const services = resources({
		createService: async (request: CreateServiceRequest) => {
			requests.push(request);
			return { service: returned, process };
		},
	});

	const created = await services.create({
		name: "web",
		command: "node",
		args: ["server.js", "--port", "3000"],
		cwd: "apps/web",
		environment: {
			EMPTY: "",
			NODE_ENV: "production",
			API_TOKEN: { secretId: "sec_api" },
		},
		description: "Web server",
		start: false,
		startPolicy: "manual",
		restartPolicy: "always",
		preventIdleShutdown: true,
	});
	await services.create({ name: "default", command: "true" });
	await services.create({ name: "started", command: "true", start: true });

	assert.deepEqual(requests.map((request) => request.initialState), [
		CreateServiceRequest_InitialState.STOPPED,
		CreateServiceRequest_InitialState.UNSPECIFIED,
		CreateServiceRequest_InitialState.STARTED,
	]);
	assert.equal(requests[0]?.spec?.command?.command, "node");
	assert.deepEqual(requests[0]?.spec?.command?.args, ["server.js", "--port", "3000"]);
	assert.equal(requests[0]?.spec?.command?.cwd?.absolute, "");
	assert.equal(requests[0]?.spec?.command?.cwd?.workspaceRelative, "apps/web");
	assert.deepEqual(
		requests[0]?.spec?.command?.additionalEnvironment.map(({ name, value, fromSecretId }) => ({
			name,
			value,
			fromSecretId,
		})),
		[
			{ name: "EMPTY", value: "", fromSecretId: "" },
			{ name: "NODE_ENV", value: "production", fromSecretId: "" },
			{ name: "API_TOKEN", value: "", fromSecretId: "sec_api" },
		],
	);
	assert.equal(requests[0]?.spec?.startPolicy, ServiceSpec_StartPolicy.MANUAL);
	assert.equal(requests[0]?.spec?.restartPolicy, ServiceSpec_RestartPolicy.ALWAYS);
	assert.equal(requests[0]?.spec?.preventIdleShutdown, true);
	assert.equal(requests[1]?.spec?.startPolicy, ServiceSpec_StartPolicy.UNSPECIFIED);
	assert.equal(requests[1]?.spec?.restartPolicy, ServiceSpec_RestartPolicy.UNSPECIFIED);
	assert.equal(created.id, "service-web");
	assert.equal(created.stopped, true);
	assert.deepEqual(created.process?.lastExit, {
		exitCode: 0,
		error: undefined,
		exitedAt: new Date("2026-10-09T10:00:00Z"),
	});
});

test("service list converts complete snapshots and get resolves ID before user-owned name", async () => {
	const namespace = protoService({
		id: "namespace-service",
		name: "shared",
		owner: Service_Owner.NAMESPACE,
	});
	const user = protoService({
		id: "user-service",
		name: "shared",
		owner: Service_Owner.USER,
		startPolicy: ServiceSpec_StartPolicy.ON_HTTP_INGRESS,
		restartPolicy: ServiceSpec_RestartPolicy.NEVER,
		ports: [{
			id: "port-web",
			spec: { name: "web", number: 3000, kind: PortSpec_Kind.HTTP_INGRESS },
			owner: Port_Owner.USER,
		}],
	});
	const unknown = protoService({
		id: "unknown-service",
		name: "future",
		owner: 99 as Service_Owner,
		startPolicy: 99 as ServiceSpec_StartPolicy,
		restartPolicy: 99 as ServiceSpec_RestartPolicy,
	});
	const listedProcess = create(ServiceProcessSchema, {
		status: ServiceProcess_Status.RUNNING,
		pid: 42,
		startedAt: timestampFromDate(new Date("2026-10-09T11:00:00Z")),
		restarts: 3,
		lastExit: { code: -1, message: "killed" },
	});
	const services = resources({
		listServices: async () => ({
			services: [
				{ service: namespace },
				{ service: user, process: listedProcess },
				{ service: unknown },
			],
		}),
	});

	const list = await services.list();
	assert.equal(list.length, 3);
	assert.deepEqual(list[1], {
		id: "user-service",
		name: "shared",
		command: "node",
		args: ["server.js"],
		cwd: "/workspace",
		environment: { EMPTY: "", TOKEN: { secretId: "sec_token" } },
		description: "test service",
		startPolicy: "on-http-ingress",
		restartPolicy: "never",
		preventIdleShutdown: true,
		stopped: false,
		owner: "user",
		ports: [{
			id: "port-web",
			name: "web",
			number: 3000,
			kind: "http-ingress",
			owner: "user",
		}],
		process: {
			state: "running",
			pid: 42,
			startedAt: new Date("2026-10-09T11:00:00Z"),
			restartCount: 3,
			lastExit: { exitCode: -1, error: "killed", exitedAt: undefined },
		},
	});
	assert.equal((await services.get("shared")).id, "user-service");
	assert.equal((await services.get("namespace-service")).owner, "namespace");
	assert.equal(list[2]?.owner, "unknown");
	assert.equal(list[2]?.startPolicy, "unknown");
	assert.equal(list[2]?.restartPolicy, "unknown");
	await assert.rejects(services.get("missing"), ServiceNotFoundError);
});

test("service lifecycle sends refs directly and keeps launch failures as process state", async () => {
	const calls: Array<[string, unknown]> = [];
	const restarting = create(ServiceProcessSchema, {
		status: ServiceProcess_Status.RESTARTING,
		restarts: 1,
		lastExit: { code: 23, message: "exited" },
	});
	const services = resources({
		startService: async (ref: string) => {
			calls.push(["start", ref]);
			return { process: restarting };
		},
		stopService: async (request: { idOrName: string; mode: StopServiceRequest_Mode }) => {
			calls.push(["stop", { idOrName: request.idOrName, mode: request.mode }]);
			return {};
		},
		deleteService: async (ref: string) => {
			calls.push(["delete", ref]);
		},
	});

	assert.deepEqual(await services.start("web"), {
		state: "restarting",
		pid: undefined,
		startedAt: undefined,
		restartCount: 1,
		lastExit: { exitCode: 23, error: "exited", exitedAt: undefined },
	});
	assert.equal(await services.stop("service-web", { mode: "force" }), undefined);
	await services.delete("service-web");
	assert.deepEqual(calls, [
		["start", "web"],
		["stop", { idOrName: "service-web", mode: StopServiceRequest_Mode.FORCE }],
		["delete", "service-web"],
	]);
});

test("service lifecycle maps only service RPC not-found failures", async () => {
	const services = resources({
		startService: async () => {
			throw new ConnectError("missing", Code.NotFound);
		},
	});
	await assert.rejects(services.start("missing"), ServiceNotFoundError);

	const activationError = new ConnectError("devbox missing", Code.NotFound);
	const unavailable = new ServiceResources("missing-devbox", {
		getAgent: async () => {
			throw activationError;
		},
	} as unknown as ConnectionManager);
	await assert.rejects(unavailable.start("web"), (error) => error === activationError);
});

test("service logs select the newest retained supervised run and release readers on break", async () => {
	let selectedExecId: string | undefined;
	let released = false;
	const services = resources({
		listServices: async () => ({
			services: [{ service: protoService({ id: "service-web", name: "web" }) }],
		}),
		listLogActions: async () => [
			{ id: "exec-old", serviceId: "service-web" },
			{ id: "exec-other", serviceId: "service-other" },
			{ id: "exec-new", serviceId: "service-web" },
		],
		executionLogs: async function* (execId: string) {
			selectedExecId = execId;

			try {
				yield {
					stdout: new TextEncoder().encode("ready\n"),
					stderr: new Uint8Array(),
				};
				yield {
					stdout: new Uint8Array(),
					stderr: new Uint8Array(),
					result: { exitCode: 0 },
				};
			} finally {
				released = true;
			}
		},
	});

	for await (const chunk of services.logs("web")) {
		assert.equal(new TextDecoder().decode(chunk.stdout), "ready\n");
		break;
	}
	assert.equal(selectedExecId, "exec-new");
	assert.equal(released, true);
});

test("service logs distinguish missing services from services without retained logs", async () => {
	const services = resources({
		listServices: async () => ({
			services: [{ service: protoService({ id: "service-web", name: "web" }) }],
		}),
		listLogActions: async () => [],
	});

	await assert.rejects(async () => {
		for await (const _ of services.logs("missing")) {
			// Consume the stream.
		}
	}, ServiceNotFoundError);
	await assert.rejects(async () => {
		for await (const _ of services.logs("web")) {
			// Consume the stream.
		}
	}, ServiceLogsNotFoundError);

	const vanishedLogs = resources({
		listServices: async () => ({
			services: [{ service: protoService({ id: "service-web", name: "web" }) }],
		}),
		listLogActions: async () => [{ id: "exec-removed", serviceId: "service-web" }],
		executionLogs: async function* () {
			throw new ExecutionNotFoundError("exec-removed");
		},
	});
	await assert.rejects(async () => {
		for await (const _ of vanishedLogs.logs("web")) {
			// Consume the stream.
		}
	}, ServiceLogsNotFoundError);
});

test("service validation and malformed responses fail before producing misleading state", async () => {
	let calls = 0;
	const services = resources({
		createService: async () => {
			calls++;
			return {};
		},
		startService: async () => ({ process: undefined }),
	});

	await assert.rejects(services.create({ name: "", command: "true" }), TypeError);
	await assert.rejects(services.create({ name: "bad", command: "" }), TypeError);
	await assert.rejects(services.create({
		name: "bad-env",
		command: "true",
		environment: { "NOT-VALID": "x" },
	}), TypeError);
	await assert.rejects(services.create({
		name: "bad-secret",
		command: "true",
		environment: { TOKEN: { secretId: "" } },
	}), TypeError);
	assert.equal(calls, 0);
	await assert.rejects(services.start("web"), IncompleteResponseError);
	await assert.rejects(services.list({ timeoutMs: 0 }), DevboxTimeoutError);
});

test("agent deletion deadlines are not mislabeled as caller timeouts", async () => {
	const deadline = new ConnectError("service did not stop", Code.DeadlineExceeded);
	const services = resources({
		deleteService: async () => {
			throw deadline;
		},
	});
	await assert.rejects(services.delete("web", { timeoutMs: 60_000 }), (error) => error === deadline);
});

function resources(agent: Record<string, unknown>): ServiceResources {
	return new ServiceResources("devbox-test", {
		getAgent: async () => agent as unknown as AgentConnection,
	} as unknown as ConnectionManager);
}

function protoService(options: {
	id?: string;
	name?: string;
	owner?: Service_Owner;
	stopped?: boolean;
	startPolicy?: ServiceSpec_StartPolicy;
	restartPolicy?: ServiceSpec_RestartPolicy;
	ports?: MessageInitShape<typeof PortSchema>[];
} = {}) {
	return create(ServiceSchema, {
		id: options.id ?? "service-test",
		spec: {
			name: options.name ?? "test",
			description: "test service",
			command: {
				command: "node",
				args: ["server.js"],
				cwd: { absolute: "/workspace" },
				additionalEnvironment: [
					{ name: "EMPTY", value: "" },
					{ name: "TOKEN", fromSecretId: "sec_token" },
				],
			},
			startPolicy: options.startPolicy ?? ServiceSpec_StartPolicy.ON_BOOT,
			restartPolicy: options.restartPolicy ?? ServiceSpec_RestartPolicy.ON_FAILURE,
			preventIdleShutdown: true,
		},
		ports: options.ports ?? [],
		owner: options.owner ?? Service_Owner.USER,
		stopped: options.stopped ?? false,
	});
}
