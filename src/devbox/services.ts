import { create } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import {
	CreateServiceRequestSchema,
	CreateServiceRequest_InitialState,
	Port_Owner,
	PortSpec_Kind,
	Service_Owner,
	ServiceProcess_Status,
	ServiceSpec_RestartPolicy,
	ServiceSpec_StartPolicy,
	StopServiceRequestSchema,
	StopServiceRequest_Mode,
	type Port as ProtoPort,
	type Service as ProtoService,
	type ServiceProcess as ProtoServiceProcess,
} from "../proto/namespace/private/devbox/wire/wire_pb.js";
import { operationDeadline, withDeadline } from "./connection.js";
import type { AgentConnection, ConnectionManager } from "./connection.js";
import {
	DevboxTimeoutError,
	ExecutionNotFoundError,
	IncompleteResponseError,
	ServiceLogsNotFoundError,
	ServiceNotFoundError,
} from "./errors.js";
import type {
	CreateServiceInput,
	ExecutionLogChunk,
	OperationOptions,
	Service,
	ServicePort,
	ServiceProcess,
	ServiceResource,
	StopServiceOptions,
} from "./models.js";

export class ServiceResources implements ServiceResource {
	constructor(
		private readonly devboxId: string,
		private readonly connections: ConnectionManager,
	) {}

	async create(input: CreateServiceInput, options: OperationOptions = {}): Promise<Service> {
		validateCreateInput(input);

		const request = create(CreateServiceRequestSchema, {
			spec: {
				name: input.name,
				description: input.description ?? "",
				command: {
					command: input.command,
					args: input.args ? [...input.args] : [],
					cwd: cwd(input.cwd),
					additionalEnvironment: Object.entries(input.environment ?? {}).map(([name, value]) => ({
						name,
						...(typeof value === "string" ? { value } : { fromSecretId: value.secretId }),
					})),
				},
				startPolicy: startPolicy(input.startPolicy),
				restartPolicy: restartPolicy(input.restartPolicy),
				preventIdleShutdown: input.preventIdleShutdown ?? false,
			},
			initialState: initialState(input.start),
		});

		return this.withAgent(options, async (agent, callOptions) => {
			const response = await agent.createService(request, callOptions);
			return service(required(response.service, "create service response"), response.process);
		});
	}

	async get(ref: string, options: OperationOptions = {}): Promise<Service> {
		validateRef(ref);

		return this.withAgent(options, async (agent, callOptions) => {
			return resolveService(await listServices(agent, callOptions), ref);
		});
	}

	async list(options: OperationOptions = {}): Promise<Service[]> {
		return this.withAgent(options, listServices);
	}

	async start(ref: string, options: OperationOptions = {}): Promise<ServiceProcess> {
		validateRef(ref);

		return this.withAgent(options, async (agent, callOptions) => {
			try {
				const response = await agent.startService(ref, callOptions);
				return serviceProcess(required(response.process, "start service response"));
			} catch (error) {
				throw serviceOperationError(error, ref);
			}
		});
	}

	async stop(ref: string, options: StopServiceOptions = {}): Promise<ServiceProcess | undefined> {
		validateRef(ref);

		if (options.mode !== undefined && options.mode !== "graceful" && options.mode !== "force") {
			throw new TypeError('service stop mode must be "graceful" or "force"');
		}

		const request = create(StopServiceRequestSchema, {
			idOrName: ref,
			mode: options.mode === "force" ? StopServiceRequest_Mode.FORCE : StopServiceRequest_Mode.GRACEFUL,
		});

		return this.withAgent(options, async (agent, callOptions) => {
			try {
				const response = await agent.stopService(request, callOptions);
				return response.process ? serviceProcess(response.process) : undefined;
			} catch (error) {
				throw serviceOperationError(error, ref);
			}
		});
	}

	async delete(ref: string, options: OperationOptions = {}): Promise<void> {
		validateRef(ref);

		await this.withAgent(options, async (agent, callOptions) => {
			try {
				await agent.deleteService(ref, callOptions);
			} catch (error) {
				throw serviceOperationError(error, ref);
			}
		});
	}

	async *logs(ref: string, options: OperationOptions = {}): AsyncIterableIterator<ExecutionLogChunk> {
		validateRef(ref);
		operationDeadline(options);

		// Match execution logs: connection acquisition has its own client-wide budget.
		const agent = await this.connections.getAgent(this.devboxId, { signal: options.signal });
		const deadline = operationDeadline(options);

		try {
			const selected = resolveService(await listServices(agent, callOptions(options, deadline)), ref);
			const actions = await agent.listLogActions(callOptions(options, deadline));
			let execId: string | undefined;

			for (let index = actions.length - 1; index >= 0; index--) {
				const action = actions[index];
				if (action?.serviceId === selected.id) {
					execId = action.id;
					break;
				}
			}

			if (!execId) {
				throw new ServiceLogsNotFoundError(selected.id);
			}

			try {
				yield* agent.executionLogs(execId, callOptions(options, deadline));
			} catch (error) {
				if (error instanceof ExecutionNotFoundError) {
					throw new ServiceLogsNotFoundError(selected.id);
				}
				throw error;
			}
		} catch (error) {
			if (
				error instanceof ConnectError &&
				error.code === Code.DeadlineExceeded &&
				deadline !== undefined &&
				Date.now() >= deadline
			) {
				throw serviceTimeout(options.timeoutMs);
			}
			throw error;
		}
	}

	private async withAgent<T>(
		options: OperationOptions,
		operation: (agent: AgentConnection, options: OperationOptions) => Promise<T>,
	): Promise<T> {
		const deadline = operationDeadline(options);

		if (options.timeoutMs === 0) {
			throw serviceTimeout(options.timeoutMs);
		}

		const agent = await this.connections.getAgent(this.devboxId, withDeadline(options, deadline));

		try {
			return await operation(agent, callOptions(options, deadline));
		} catch (error) {
			if (
				error instanceof ConnectError &&
				error.code === Code.DeadlineExceeded &&
				deadline !== undefined &&
				Date.now() >= deadline
			) {
				throw serviceTimeout(options.timeoutMs);
			}
			throw error;
		}
	}
}

async function listServices(agent: AgentConnection, options: OperationOptions): Promise<Service[]> {
	const response = await agent.listServices(options);

	return response.services.map((entry) => {
		return service(required(entry.service, "list services response"), entry.process);
	});
}

function resolveService(services: Service[], ref: string): Service {
	const byId = services.find((candidate) => candidate.id === ref);
	if (byId) {
		return byId;
	}

	const byName = services.find((candidate) => candidate.owner === "user" && candidate.name === ref);
	if (byName) {
		return byName;
	}

	throw new ServiceNotFoundError(ref);
}

function service(proto: ProtoService, process?: ProtoServiceProcess): Service {
	if (!proto.id || !proto.spec || !proto.spec.command || !proto.spec.name || !proto.spec.command.command) {
		throw new IncompleteResponseError("devbox service response");
	}

	const command = proto.spec.command;

	if (command.cwd?.absolute && command.cwd.workspaceRelative) {
		throw new IncompleteResponseError("devbox service response");
	}

	return {
		id: proto.id,
		name: proto.spec.name,
		command: command.command,
		args: [...command.args],
		cwd: command.cwd?.absolute || command.cwd?.workspaceRelative || undefined,
		environment: Object.fromEntries(
			command.additionalEnvironment.map((entry) => [
				entry.name,
				entry.fromSecretId ? { secretId: entry.fromSecretId } : entry.value,
			]),
		),
		description: proto.spec.description || undefined,
		startPolicy: fromStartPolicy(proto.spec.startPolicy),
		restartPolicy: fromRestartPolicy(proto.spec.restartPolicy),
		preventIdleShutdown: proto.spec.preventIdleShutdown,
		stopped: proto.stopped,
		owner: serviceOwner(proto.owner),
		ports: proto.ports.map(servicePort),
		process: process ? serviceProcess(process) : undefined,
	};
}

function serviceProcess(proto: ProtoServiceProcess): ServiceProcess {
	return {
		state: processState(proto.status),
		pid: proto.pid || undefined,
		startedAt: proto.startedAt ? timestampDate(proto.startedAt) : undefined,
		restartCount: proto.restarts,
		lastExit: proto.lastExit ? {
			exitCode: proto.lastExit.code,
			error: proto.lastExit.message || undefined,
			exitedAt: proto.lastExit.exitedAt ? timestampDate(proto.lastExit.exitedAt) : undefined,
		} : undefined,
	};
}

function servicePort(proto: ProtoPort): ServicePort {
	if (!proto.id || !proto.spec || proto.spec.number === 0) {
		throw new IncompleteResponseError("devbox service port response");
	}

	return {
		id: proto.id,
		name: proto.spec.name || undefined,
		number: proto.spec.number,
		kind: portKind(proto.spec.kind),
		owner: portOwner(proto.owner),
	};
}

function cwd(value?: string) {
	if (value === undefined) {
		return undefined;
	}

	return value.startsWith("/") ? { absolute: value } : { workspaceRelative: value };
}

function initialState(value?: boolean): CreateServiceRequest_InitialState {
	if (value === undefined) {
		return CreateServiceRequest_InitialState.UNSPECIFIED;
	}

	return value ? CreateServiceRequest_InitialState.STARTED : CreateServiceRequest_InitialState.STOPPED;
}

function startPolicy(value?: CreateServiceInput["startPolicy"]): ServiceSpec_StartPolicy {
	switch (value) {
		case undefined:
			return ServiceSpec_StartPolicy.UNSPECIFIED;
		case "on-boot":
			return ServiceSpec_StartPolicy.ON_BOOT;
		case "manual":
			return ServiceSpec_StartPolicy.MANUAL;
		default:
			throw new TypeError(`unsupported service start policy: ${String(value)}`);
	}
}

function restartPolicy(value?: CreateServiceInput["restartPolicy"]): ServiceSpec_RestartPolicy {
	switch (value) {
		case undefined:
			return ServiceSpec_RestartPolicy.UNSPECIFIED;
		case "never":
			return ServiceSpec_RestartPolicy.NEVER;
		case "on-failure":
			return ServiceSpec_RestartPolicy.ON_FAILURE;
		case "always":
			return ServiceSpec_RestartPolicy.ALWAYS;
		default:
			throw new TypeError(`unsupported service restart policy: ${String(value)}`);
	}
}

function fromStartPolicy(value: ServiceSpec_StartPolicy): Service["startPolicy"] {
	switch (value) {
		case ServiceSpec_StartPolicy.UNSPECIFIED:
		case ServiceSpec_StartPolicy.ON_BOOT:
			return "on-boot";
		case ServiceSpec_StartPolicy.MANUAL:
			return "manual";
		case ServiceSpec_StartPolicy.ON_HTTP_INGRESS:
			return "on-http-ingress";
		default:
			return "unknown";
	}
}

function fromRestartPolicy(value: ServiceSpec_RestartPolicy): Service["restartPolicy"] {
	switch (value) {
		case ServiceSpec_RestartPolicy.UNSPECIFIED:
		case ServiceSpec_RestartPolicy.ON_FAILURE:
			return "on-failure";
		case ServiceSpec_RestartPolicy.NEVER:
			return "never";
		case ServiceSpec_RestartPolicy.ALWAYS:
			return "always";
		default:
			return "unknown";
	}
}

function serviceOwner(value: Service_Owner): Service["owner"] {
	switch (value) {
		case Service_Owner.USER:
			return "user";
		case Service_Owner.NAMESPACE:
			return "namespace";
		default:
			return "unknown";
	}
}

function portKind(value: PortSpec_Kind): ServicePort["kind"] {
	switch (value) {
		case PortSpec_Kind.PORT_FORWARD:
			return "port-forward";
		case PortSpec_Kind.HTTP_INGRESS:
			return "http-ingress";
		default:
			return "unknown";
	}
}

function portOwner(value: Port_Owner): ServicePort["owner"] {
	switch (value) {
		case Port_Owner.USER:
			return "user";
		case Port_Owner.NAMESPACE:
			return "namespace";
		default:
			return "unknown";
	}
}

function processState(value: ServiceProcess_Status): ServiceProcess["state"] {
	switch (value) {
		case ServiceProcess_Status.STARTING:
			return "starting";
		case ServiceProcess_Status.RUNNING:
			return "running";
		case ServiceProcess_Status.STOPPING:
			return "stopping";
		case ServiceProcess_Status.STOPPED:
			return "stopped";
		case ServiceProcess_Status.FAILED:
			return "failed";
		case ServiceProcess_Status.RESTARTING:
			return "restarting";
		default:
			return "unknown";
	}
}

function validateCreateInput(input: CreateServiceInput): void {
	if (!input.name.trim()) {
		throw new TypeError("service name must not be empty");
	}
	if (!input.command.trim()) {
		throw new TypeError("service command must not be empty");
	}

	for (const [name, value] of Object.entries(input.environment ?? {})) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
			throw new TypeError(`invalid environment variable name: ${name}`);
		}
		if (typeof value !== "string" && !value.secretId) {
			throw new TypeError(`service environment secret for ${name} must not be empty`);
		}
	}

	startPolicy(input.startPolicy);
	restartPolicy(input.restartPolicy);
}

function validateRef(ref: string): void {
	if (!ref) {
		throw new TypeError("service id or name must not be empty");
	}
}

function serviceOperationError(error: unknown, ref: string): unknown {
	if (error instanceof ConnectError && error.code === Code.NotFound) {
		return new ServiceNotFoundError(ref);
	}

	return error;
}

function callOptions(options: OperationOptions, deadline: number | undefined): OperationOptions {
	const scoped = withDeadline(options, deadline);

	if (scoped.timeoutMs === 0) {
		throw serviceTimeout(options.timeoutMs);
	}

	return scoped;
}

function serviceTimeout(timeoutMs?: number): DevboxTimeoutError {
	return new DevboxTimeoutError(
		timeoutMs === undefined
			? "devbox service operation timed out"
			: `devbox service operation timed out after ${timeoutMs}ms`,
		timeoutMs,
	);
}

function required<T>(value: T | undefined, context: string): T {
	if (value === undefined) {
		throw new IncompleteResponseError(context);
	}

	return value;
}
