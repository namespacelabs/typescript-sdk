import assert from "node:assert/strict";
import test from "node:test";
import { create } from "@bufbuild/protobuf";
import type { AgentConnection, ConnectionManager } from "../src/devbox/connection.js";
import { DevboxHandle, type DevboxController } from "../src/devbox/devbox.js";
import { ExposedPortNotFoundError } from "../src/devbox/errors.js";
import type { DevboxInfo, ExposedPortResource } from "../src/devbox/models.js";
import {
	Port_Owner,
	PortSchema,
	PortSpec_Kind,
	type CreatePortRequest,
	type ListPortsRequest,
} from "../src/proto/namespace/private/devbox/wire/wire_pb.js";

test("exposed port creation sends HTTP ingress and returns its URL", async () => {
	let request: CreatePortRequest | undefined;
	const exposedPorts = resources({
		createPort: async (input: CreatePortRequest) => {
			request = input;
			return { port: protoPort({ id: "port-web", number: 3000 }) };
		},
	});

	const created = await exposedPorts.create({ number: 3000 });

	assert.deepEqual({
		name: request?.spec?.name,
		number: request?.spec?.number,
		kind: request?.spec?.kind,
	}, {
		name: "",
		number: 3000,
		kind: PortSpec_Kind.HTTP_INGRESS,
	});
	assert.deepEqual(created, {
		id: "port-web",
		name: undefined,
		number: 3000,
		url: "https://dbxdevbox-test-p3000.devbox.so/",
		owner: "user",
	});
});

test("exposed port lookup supports ID, name, and unnamed port number", async () => {
	let request: ListPortsRequest | undefined;
	const exposedPorts = resources({
		listPorts: async (input: ListPortsRequest) => {
			request = input;
			return {
				ports: [
					{ port: protoPort({ id: "port-unnamed", number: 3000 }) },
					{ port: protoPort({
						id: "port-api",
						name: "api",
						number: 4000,
						owner: Port_Owner.NAMESPACE,
					}) },
				],
			};
		},
	});

	const listed = await exposedPorts.list();
	assert.deepEqual(request?.kinds, [PortSpec_Kind.HTTP_INGRESS]);
	assert.equal(listed[0]?.name, undefined);
	assert.equal(listed[1]?.owner, "namespace");
	assert.equal((await exposedPorts.get({ id: "port-api" })).number, 4000);
	assert.equal((await exposedPorts.get({ name: "api" })).id, "port-api");
	assert.equal((await exposedPorts.get({ number: 3000 })).id, "port-unnamed");
});

test("exposed port deletion resolves selectors to agent port IDs", async () => {
	let deletedId: string | undefined;
	const exposedPorts = resources({
		listPorts: async () => ({
			ports: [{ port: protoPort({ id: "port-web", name: "web", number: 3000 }) }],
		}),
		deletePort: async (id: string) => {
			deletedId = id;
		},
	});

	await exposedPorts.delete({ number: 3000 });
	assert.equal(deletedId, "port-web");
	await assert.rejects(exposedPorts.get({ name: "missing" }), ExposedPortNotFoundError);
});

test("exposed port inputs reject invalid numbers and ambiguous selectors", async () => {
	const exposedPorts = resources({});

	await assert.rejects(exposedPorts.create({ number: 0 }), RangeError);
	await assert.rejects(exposedPorts.get({ id: "port-web", number: 3000 } as never), TypeError);
});

function resources(agent: Record<string, unknown>): ExposedPortResource {
	const connections = {
		getAgent: async () => agent as unknown as AgentConnection,
	} as unknown as ConnectionManager;
	const info: DevboxInfo = {
		id: "devbox-test",
		name: "test",
		labels: {},
		state: "running",
		image: "test",
		ephemeral: false,
	};
	return new DevboxHandle(info, connections, {} as DevboxController).exposedPorts;
}

function protoPort(options: {
	id?: string;
	name?: string;
	number?: number;
	owner?: Port_Owner;
} = {}) {
	return create(PortSchema, {
		id: options.id ?? "port-test",
		spec: {
			name: options.name ?? "",
			number: options.number ?? 3000,
			kind: PortSpec_Kind.HTTP_INGRESS,
		},
		owner: options.owner ?? Port_Owner.USER,
	});
}
