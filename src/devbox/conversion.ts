import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { durationFromMs, timestampDate, type Duration, type Timestamp } from "@bufbuild/protobuf/wkt";
import { InstanceShapeSchema } from "../proto/namespace/cloud/compute/v1beta/compute_pb.js";
import {
	AccessMode as ProtoAccessMode,
	BlueprintSpec_OpSchema,
	BlueprintSpecSchema,
	DevboxTemplateSpecSchema,
	Image_Flag,
	ListRequest_EphemeralFilter,
	ListRequest_OrderBy,
	ListTemplatesRequest_OrderBy,
	NetworkPolicySpecSchema,
	type BlueprintSpec,
	type DevBox as ProtoDevbox,
	type DevboxTemplate as ProtoBlueprint,
	type DevboxTemplateSpec,
	type Image as ProtoImage,
	type NetworkPolicySpec,
} from "../proto/namespace/private/devbox/devbox_pb.js";
import type {
	AccessMode,
	Blueprint,
	BlueprintDefinition,
	BlueprintOperation,
	DevboxInfo,
	Image,
	ImageMetadata,
	ImageSelector,
	InstanceShape,
	InstanceSelector,
	MachineSize,
	NetworkPolicy,
} from "./models.js";

export const DEFAULT_SITE = "iad";

/**
 * Shapes for the machine sizes known to this SDK release. Only used where the
 * protocol requires a concrete instance shape (update, blueprints); devbox
 * creation sends the size name and lets the backend resolve it.
 */
const machineShapes: Record<"s" | "m" | "l" | "xl", InstanceShape> = {
	s: { vCPUs: 4, memoryMB: 8 * 1024, architecture: "amd64", os: "linux" },
	m: { vCPUs: 8, memoryMB: 16 * 1024, architecture: "amd64", os: "linux" },
	l: { vCPUs: 16, memoryMB: 32 * 1024, architecture: "amd64", os: "linux" },
	xl: { vCPUs: 32, memoryMB: 64 * 1024, architecture: "amd64", os: "linux" },
};

/**
 * macOS machine sizes. macOS devboxes run on Apple Silicon; the protocol has
 * no server-side named-size resolution for macOS, so these shapes are resolved
 * client-side (mirroring the CLI's shape table).
 */
const macosMachineShapes: Record<"m" | "l", InstanceShape> = {
	m: { vCPUs: 6, memoryMB: 14 * 1024, architecture: "arm64", os: "macos" },
	l: { vCPUs: 12, memoryMB: 28 * 1024, architecture: "arm64", os: "macos" },
};

export function cursorToBytes(cursor?: string): Uint8Array {
	return cursor ? Buffer.from(cursor, "base64url") : new Uint8Array();
}

export function cursorFromBytes(cursor: Uint8Array): string | undefined {
	return cursor.length > 0 ? Buffer.from(cursor).toString("base64url") : undefined;
}

export function toProtoAccessMode(access?: AccessMode): ProtoAccessMode {
	switch (access) {
		case "private": return ProtoAccessMode.USER_PRIVATE;
		case "workspace": return ProtoAccessMode.TENANT_WIDE;
		// Unspecified means "server decides": the tenant default for devbox
		// creation, and "keep the template's mode" for blueprint overrides.
		default: return ProtoAccessMode.ACCESS_MODE_UNSPECIFIED;
	}
}

function fromProtoAccessMode(access: ProtoAccessMode): AccessMode | undefined {
	switch (access) {
		case ProtoAccessMode.USER_PRIVATE: return "private";
		case ProtoAccessMode.TENANT_WIDE: return "workspace";
		default: return undefined;
	}
}

/**
 * Named sizes are resolved server-side: the service maps the size name to a
 * canonical instance shape, so the SDK does not need to stay in sync with
 * shape definitions and the backend can add sizes without an SDK release.
 */
export function toProtoMachineSize(size?: MachineSize): string {
	return size ?? "";
}

export function toProtoShape(
	size?: MachineSize,
	os?: string,
	selectors: InstanceSelector[] = [],
): MessageInitShape<typeof InstanceShapeSchema> | undefined {
	if (!size) return undefined;
	const table: Record<string, InstanceShape | undefined> = os === "macos" ? macosMachineShapes : machineShapes;
	const shape = table[size];
	if (!shape) {
		throw new TypeError(
			`machine size "${size}" is not known to this SDK version for ${os ?? "linux"}; ` +
				`supported sizes: ${Object.keys(table).join(", ")}`,
		);
	}
	return {
		virtualCpu: shape.vCPUs,
		memoryMegabytes: shape.memoryMB,
		machineArch: shape.architecture ?? "",
		os: shape.os ?? "",
		...(selectors.length > 0 ? { selectors } : {}),
	};
}

function machineSize(shape?: InstanceShape): MachineSize | undefined {
	if (!shape) return undefined;
	const table = shape.os === "macos" ? macosMachineShapes : machineShapes;
	return (Object.entries(table) as [MachineSize, InstanceShape][]).find(([, candidate]) =>
		candidate.vCPUs === shape.vCPUs &&
		candidate.memoryMB === shape.memoryMB &&
		candidate.architecture === shape.architecture &&
		candidate.os === shape.os
	)?.[0];
}

function fromProtoShape(shape: ProtoDevbox["instanceShape"]): InstanceShape | undefined {
	return shape ? {
		vCPUs: shape.virtualCpu,
		memoryMB: shape.memoryMegabytes,
		architecture: shape.machineArch || undefined,
		os: shape.os || undefined,
		selectors: shape.selectors.length > 0
			? shape.selectors.map(({ name, value }) => ({ name, value }))
			: undefined,
	} : undefined;
}

export function toProtoNetworkPolicy(policy?: NetworkPolicy): NetworkPolicySpec | undefined {
	return policy ? create(NetworkPolicySpecSchema, {
		egressDomains: {
			allowed: policy.allowedDomains,
			advisory: policy.advisory ?? false,
		},
	}) : undefined;
}

function fromProtoNetworkPolicy(policy?: NetworkPolicySpec): NetworkPolicy | undefined {
	return policy?.egressDomains ? {
		allowedDomains: policy.egressDomains.allowed,
		advisory: policy.egressDomains.advisory,
	} : undefined;
}

export function date(timestamp?: Timestamp): Date | undefined {
	return timestamp ? timestampDate(timestamp) : undefined;
}

function milliseconds(duration?: Duration): number | undefined {
	if (!duration) return undefined;
	return Number(duration.seconds) * 1_000 + duration.nanos / 1_000_000;
}

export function positiveBigInt(value: number | undefined, field: string): bigint {
	if (value === undefined) return 0n;
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`${field} must be a non-negative safe integer`);
	}
	return BigInt(value);
}

export function optionalDuration(value: number | undefined): Duration | undefined {
	return value === undefined ? undefined : durationFromMs(value);
}

export function devboxInfo(devbox: ProtoDevbox, instanceId?: string, state?: DevboxInfo["state"]): DevboxInfo {
	return {
		id: devbox.id,
		name: devbox.name,
		state: state ?? (instanceId ? "running" : "unknown"),
		instanceId: instanceId || undefined,
		image: devbox.imageRef,
		imageName: devbox.resolvedImage?.name || undefined,
		blueprint: devbox.blueprintRef ? {
			id: devbox.blueprintRef.blueprintId,
			name: devbox.blueprintRef.blueprintName,
		} : undefined,
		size: machineSize(fromProtoShape(devbox.instanceShape)),
		shape: fromProtoShape(devbox.instanceShape),
		site: devbox.site || undefined,
		creator: devbox.creator || undefined,
		createdAt: date(devbox.createdAt),
		lastUsedAt: date(devbox.lastUsedAt),
		workspaceDir: devbox.workspaceDir || undefined,
		defaultDir: devbox.defaultDir || undefined,
		user: devbox.mainUser || devbox.spec?.remoteUser || undefined,
		shell: devbox.spec?.shell || undefined,
		volumeSizeGB: safeNumber(devbox.volumeSizeGb, "devbox volume size"),
		purpose: devbox.documentedPurpose || undefined,
		ephemeral: devbox.ephemeral !== undefined,
	};
}

function operationToProto(operation: BlueprintOperation): BlueprintSpec["onCreate"][number] {
	if ("script" in operation) return create(
		BlueprintSpec_OpSchema,
		{ runScript: { script: operation.script } },
	);
	return create(
		BlueprintSpec_OpSchema,
		{ runCommand: { command: operation.command, args: operation.args ?? [] } },
	);
}

export function blueprintSpec(name: string, definition: BlueprintDefinition): DevboxTemplateSpec {
	if (definition.os !== "macos" && definition.selectors !== undefined) {
		throw new TypeError('blueprint option "selectors" requires os "macos"');
	}
	if (definition.os === "macos" && definition.image !== undefined) {
		throw new TypeError('blueprint option "image" cannot be used with os "macos"');
	}
	const linux = definition.os === "macos"
		? undefined
		: definition.image.includes("@") || definition.image.includes("/") || definition.image.includes(":")
			? { imageRef: definition.image }
			: { imageName: definition.image };
	return create(DevboxTemplateSpecSchema, {
		name,
		instance: {
			shape: toProtoShape(
				definition.size ?? (definition.os === "macos" ? "m" : undefined),
				definition.os,
				definition.selectors,
			),
			linux,
		},
		site: definition.site ?? DEFAULT_SITE,
		description: definition.description ?? "",
		// The server requires blueprints to carry an explicit access mode;
		// default to private, matching the web console's default.
		accessMode: toProtoAccessMode(definition.access ?? "private"),
		environment: Object.entries(definition.environment ?? {}).map(([envName, value]) => ({ name: envName, value })),
		busyEnsureMinimumDuration: optionalDuration(definition.busyTimeoutMs),
		volumeSizeGb: positiveBigInt(definition.volumeSizeGB, "volumeSizeGB"),
		ephemeral: definition.ephemeral ? {
			stoppedRetentionDuration: typeof definition.ephemeral === "object"
				? optionalDuration(definition.ephemeral.stoppedRetentionMs)
				: undefined,
		} : undefined,
		features: definition.features ? { enabled: definition.features } : undefined,
		networkPolicy: toProtoNetworkPolicy(definition.networkPolicy),
	});
}

export function imageMetadata(metadata: ImageMetadata): BlueprintSpec {
	return create(BlueprintSpecSchema, {
		remoteUser: metadata.user ?? "",
		shell: metadata.shell ?? "",
		privileged: metadata.privileged ?? false,
		environment: Object.entries(metadata.environment ?? {}).map(([name, value]) => ({ name, value })),
		onCreate: (metadata.onCreate ?? []).map(operationToProto),
		onStartup: (metadata.onStart ?? []).map(operationToProto),
		includeInPath: metadata.includeInPath ?? [],
		workspaceDir: metadata.workspaceDir ?? "",
		sessions: (metadata.sessions ?? []).map((session) => ({
			name: session.name,
			command: session.command,
			emoji: session.emoji ?? "",
		})),
	});
}

export function blueprint(proto: ProtoBlueprint): Blueprint {
	if (!proto.spec) throw new Error("blueprint response did not include a definition");
	const spec = proto.spec;
	const metadata = spec.instance?.linux;
	const image = metadata?.imageRef || metadata?.imageName || "";
	const imageSpec = spec.instance;
	const shape = fromProtoShape(imageSpec?.shape);
	const platform = shape?.os === "macos"
		? { os: "macos" as const, selectors: shape.selectors }
		: { image };
	return {
		id: proto.id,
		name: spec.name,
		version: proto.version,
		createdAt: date(proto.createdAt),
		updatedAt: date(proto.updatedAt),
		definition: {
			...platform,
			size: machineSize(shape),
			site: spec.site,
			description: spec.description || undefined,
			access: fromProtoAccessMode(spec.accessMode),
			environment: Object.fromEntries(spec.environment.filter((entry) => !entry.fromSecretId).map((entry) => [entry.name, entry.value])),
			volumeSizeGB: safeNumber(spec.volumeSizeGb, "blueprint volume size"),
			ephemeral: spec.ephemeral ? {
				stoppedRetentionMs: milliseconds(spec.ephemeral.stoppedRetentionDuration),
			} : false,
			features: spec.features?.enabled,
			networkPolicy: fromProtoNetworkPolicy(spec.networkPolicy),
			busyTimeoutMs: milliseconds(spec.busyEnsureMinimumDuration),
		},
	};
}

export function image(proto: ProtoImage): Image {
	return {
		id: proto.id,
		name: proto.name,
		repository: proto.repository,
		digest: proto.digest,
		originalDigest: proto.originalDigest || undefined,
		ref: proto.repository && proto.digest ? `${proto.repository}@${proto.digest}` : proto.name,
		version: proto.version,
		description: proto.description || undefined,
		createdAt: date(proto.createdAt),
		expiresAt: date(proto.expiresAt),
		managed: proto.flag.includes(Image_Flag.NAMESPACE_MANAGED),
	};
}

export function imageSelector(selector: ImageSelector): {
	id?: string;
	name?: string;
	digest?: string;
	version?: bigint;
} {
	if (typeof selector === "string") {
		const separator = selector.lastIndexOf("@");
		return separator === -1 ? { name: selector } : { digest: selector.slice(separator + 1) };
	}
	return selector;
}

export function devboxOrder(order?: "created" | "last-used"): ListRequest_OrderBy {
	return order === "created" ? ListRequest_OrderBy.CREATED_AT :
		order === "last-used" ? ListRequest_OrderBy.LAST_USED_AT : ListRequest_OrderBy.UNKNOWN;
}

export function ephemeralFilter(ephemeral?: boolean): ListRequest_EphemeralFilter {
	return ephemeral === true ? ListRequest_EphemeralFilter.ONLY_EPHEMERAL :
		ephemeral === false ? ListRequest_EphemeralFilter.ONLY_NON_EPHEMERAL : ListRequest_EphemeralFilter.UNKNOWN;
}

export function blueprintOrder(order?: "created" | "updated"): ListTemplatesRequest_OrderBy {
	return order === "created" ? ListTemplatesRequest_OrderBy.CREATED_AT :
		order === "updated" ? ListTemplatesRequest_OrderBy.UPDATED_AT : ListTemplatesRequest_OrderBy.UNKNOWN;
}

function safeNumber(value: bigint, field: string): number | undefined {
	if (value === 0n) return undefined;
	const result = Number(value);
	if (!Number.isSafeInteger(result)) throw new RangeError(`${field} exceeds Number.MAX_SAFE_INTEGER`);
	return result;
}
