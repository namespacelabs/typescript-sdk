import type { Client as RpcClient } from "@connectrpc/connect";
import {
	DevBoxService,
	OptimizeImageResponseChunk_Status,
} from "../proto/namespace/private/devbox/devbox_pb.js";
import { ConnectionManager } from "./connection.js";
import {
	DEFAULT_SITE,
	blueprint,
	blueprintOrder,
	blueprintSpec,
	cursorFromBytes,
	cursorToBytes,
	date,
	devboxInfo,
	devboxOrder,
	ephemeralFilter,
	image,
	imageMetadata,
	imageSelector,
	macosImageSelectors,
	optionalDuration,
	positiveBigInt,
	toProtoAccessMode,
	toProtoMachineSize,
	toProtoNetworkPolicy,
	toProtoShape,
} from "./conversion.js";
import { ImageOptimizationError, IncompleteResponseError } from "./errors.js";
import { DevboxHandle, type DevboxController } from "./devbox.js";
import type {
	Blueprint,
	BlueprintDefinition,
	BlueprintResource,
	CreateDevboxInput,
	Devbox,
	DevboxInfo,
	DevboxResource,
	Image,
	ImageInspection,
	ImageResource,
	ImageSelector,
	ListBlueprintsOptions,
	ListDevboxesOptions,
	ListImagesOptions,
	OperationOptions,
	OptimizeImageOptions,
	Page,
	RegisterImageInput,
	UpdateDevboxInput,
} from "./models.js";

type DevboxRpcClient = RpcClient<typeof DevBoxService>;

class DevboxResources implements DevboxController, DevboxResource {
	constructor(
		private readonly rpc: DevboxRpcClient,
		private readonly connections: ConnectionManager,
		private readonly blueprints: BlueprintResources,
	) {}

	async create(input: CreateDevboxInput, options: OperationOptions = {}): Promise<Devbox> {
		if (input.blueprint) validateBlueprintCreateInput(input);
		if (input.image !== undefined && input.imageName !== undefined) {
			throw new TypeError('create options "image" and "imageName" cannot be used together');
		}
		if (input.os === "macos" && input.image !== undefined) {
			throw new TypeError('create option "image" cannot be used with os "macos"');
		}
		if (input.os === "macos" && input.imageName !== undefined) {
			throw new TypeError('create option "imageName" cannot be used with os "macos"');
		}
		if (input.os !== "macos" && input.macosVersion !== undefined) {
			throw new TypeError('create option "macosVersion" requires os "macos"');
		}
		if (input.os !== "macos" && input.xcodeVersion !== undefined) {
			throw new TypeError('create option "xcodeVersion" requires os "macos"');
		}
		const shouldStart = input.start ?? true;
		const response = input.blueprint
			? await this.createFromBlueprint(input, shouldStart, options)
			: await this.rpc.create({
				name: input.name,
				...(input.imageName !== undefined
					? { imageName: input.imageName }
					: imageFields(input.image)),
				// Linux sizes resolve server-side; macOS has no server-side
				// named-size resolution, so the shape is resolved client-side.
				...(input.os === "macos"
					? { instanceShape: toProtoShape(
						input.size ?? "m",
						"macos",
						macosImageSelectors(input.macosVersion, input.xcodeVersion),
					) }
					: { machineSize: toProtoMachineSize(input.size) }),
				site: input.site ?? DEFAULT_SITE,
				volumeSizeGb: positiveBigInt(input.volumeSizeGB, "volumeSizeGB"),
				repository: input.repository ?? "",
				environment: Object.entries(input.environment ?? {}).map(([name, value]) => ({ name, value })),
				documentedPurpose: input.purpose ?? "",
				accessMode: toProtoAccessMode(input.access),
				ephemeral: ephemeralValue(input.ephemeral),
				privileged: input.privileged,
				features: input.features ? { enabled: input.features } : undefined,
				networkPolicy: toProtoNetworkPolicy(input.networkPolicy),
				activate: shouldStart,
			}, options);

		const proto = required(response.devbox, "create devbox response");
		return this.handle(devboxInfo(proto, response.instanceId, shouldStart ? "running" : "stopped"));
	}

	async get(ref: string, options: OperationOptions = {}): Promise<Devbox> {
		const response = await this.rpc.fetch({
			idOrName: ref,
			returnActivatedInstance: true,
		}, options);
		return this.handle(devboxInfo(
			required(response.devbox, "get devbox response"),
			response.instanceId,
			response.instanceId ? "running" : "stopped",
		));
	}

	async list(options: ListDevboxesOptions = {}): Promise<Page<Devbox>> {
		const response = await this.rpc.list({
			paginationCursor: cursorToBytes(options.cursor),
			maxEntries: positiveBigInt(options.limit, "limit"),
			orderBy: devboxOrder(options.orderBy),
			matchEphemeral: ephemeralFilter(options.ephemeral),
		}, options);
		return {
			items: response.devboxes.map((entry) => this.handle(devboxInfo(entry))),
			nextCursor: cursorFromBytes(response.paginationCursor),
		};
	}

	iterate(options: Omit<ListDevboxesOptions, "cursor"> = {}): AsyncIterableIterator<Devbox> {
		return paginate((cursor) => this.list({ ...options, cursor }));
	}

	async start(ref: string, options?: OperationOptions): Promise<Devbox>;
	async start(ref: DevboxHandle, options?: OperationOptions): Promise<DevboxInfo>;
	async start(ref: string | DevboxHandle, options: OperationOptions = {}): Promise<Devbox | DevboxInfo> {
		if (typeof ref === "string") {
			const handle = await this.get(ref, options);
			await handle.start(options);
			return handle;
		}
		this.connections.invalidate(ref.id);
		const response = await this.rpc.activate({
			idOrName: ref.id,
			waitForReadiness: true,
		}, options);
		return devboxInfo(
			required(response.devbox, "start devbox response"),
			response.instanceId,
			"running",
		);
	}

	async stop(ref: string, options?: OperationOptions): Promise<Devbox>;
	async stop(ref: DevboxHandle, options?: OperationOptions): Promise<DevboxInfo>;
	async stop(ref: string | DevboxHandle, options: OperationOptions = {}): Promise<Devbox | DevboxInfo> {
		if (typeof ref === "string") {
			const handle = await this.get(ref, options);
			await handle.stop(options);
			return handle;
		}
		const response = await this.rpc.stop({ name: ref.name }, options);
		this.connections.invalidate(ref.id);
		return devboxInfo(required(response.devbox, "stop devbox response"), undefined, "stopped");
	}

	async delete(ref: string, options?: OperationOptions): Promise<void>;
	async delete(ref: DevboxHandle, options?: OperationOptions): Promise<void>;
	async delete(ref: string | DevboxHandle, options: OperationOptions = {}): Promise<void> {
		const handle = typeof ref === "string" ? await this.get(ref, options) : ref;
		await this.rpc.expire({ name: handle.name }, options);
		this.connections.invalidate(handle.id);
	}

	async refresh(devbox: DevboxHandle, options: OperationOptions = {}): Promise<DevboxInfo> {
		const response = await this.rpc.fetch({
			id: devbox.id,
			returnActivatedInstance: true,
		}, options);
		return devboxInfo(
			required(response.devbox, "refresh devbox response"),
			response.instanceId,
			response.instanceId ? "running" : "stopped",
		);
	}

	async update(
		devbox: DevboxHandle,
		input: UpdateDevboxInput,
		options: OperationOptions = {},
	): Promise<DevboxInfo> {
		const response = await this.rpc.update({
			name: devbox.name,
			// Resize within the devbox's current OS (linux/macOS sizes differ).
			instanceShape: toProtoShape(input.size, devbox.info.shape?.os),
			volumeSizeGb: positiveBigInt(input.volumeSizeGB, "volumeSizeGB"),
			busyEnsureMinimumDuration: optionalDuration(input.busyTimeoutMs),
			privileged: input.privileged,
			networkPolicy: toProtoNetworkPolicy(input.networkPolicy),
		}, options);
		return devboxInfo(
			required(response.devbox, "update devbox response"),
			devbox.info.instanceId,
			devbox.info.state,
		);
	}

	private async createFromBlueprint(
		input: CreateDevboxInput,
		activate: boolean,
		options: OperationOptions,
	) {
		const selected = await this.blueprints.get(input.blueprint!, options);
		return this.rpc.createFromTemplate({
			name: input.name,
			templateId: selected.id,
			activate,
			documentedPurpose: input.purpose ?? "",
			overrides: input.site || input.access ? {
				site: input.site ?? "",
				accessMode: toProtoAccessMode(input.access),
			} : undefined,
		}, options);
	}

	private handle(info: DevboxInfo): DevboxHandle {
		return new DevboxHandle(info, this.connections, this);
	}
}

class BlueprintResources implements BlueprintResource {
	constructor(private readonly rpc: DevboxRpcClient) {}

	async create(
		name: string,
		definition: BlueprintDefinition,
		options: OperationOptions = {},
	): Promise<Blueprint> {
		const response = await this.rpc.createTemplate({ spec: blueprintSpec(name, definition) }, options);
		return blueprint(required(response.template, "create blueprint response"));
	}

	async get(name: string, options: OperationOptions = {}): Promise<Blueprint> {
		const response = await this.rpc.fetchTemplate({ name }, options);
		return blueprint(required(response.template, "get blueprint response"));
	}

	async list(options: ListBlueprintsOptions = {}): Promise<Page<Blueprint>> {
		const response = await this.rpc.listTemplates({
			paginationCursor: cursorToBytes(options.cursor),
			maxEntries: positiveBigInt(options.limit, "limit"),
			orderBy: blueprintOrder(options.orderBy),
		}, options);
		return {
			items: response.templates.map(blueprint),
			nextCursor: cursorFromBytes(response.paginationCursor),
		};
	}

	iterate(options: Omit<ListBlueprintsOptions, "cursor"> = {}): AsyncIterableIterator<Blueprint> {
		return paginate((cursor) => this.list({ ...options, cursor }));
	}

	async update(
		name: string,
		definition: BlueprintDefinition,
		options: OperationOptions = {},
	): Promise<Blueprint> {
		const current = await this.get(name, options);
		const response = await this.rpc.updateTemplate({
			id: current.id,
			spec: blueprintSpec(current.name, definition),
		}, options);
		return blueprint(required(response.template, "update blueprint response"));
	}

	async delete(name: string, options: OperationOptions = {}): Promise<void> {
		const current = await this.get(name, options);
		await this.rpc.expireTemplate({ id: current.id }, options);
	}
}

class ImageResources implements ImageResource {
	constructor(private readonly rpc: DevboxRpcClient) {}

	async register(input: RegisterImageInput, options: OperationOptions = {}): Promise<Image> {
		const response = await this.rpc.wireImage({
			imageRef: input.ref,
			name: input.name,
			description: input.description ?? "",
			// Always send a (possibly empty) blueprint spec: the server derives
			// the effective spec from the image when fields are unset.
			metadata: imageMetadata(input.metadata ?? {}),
		}, options);
		return image(required(response.image, "register image response"));
	}

	async get(selector: ImageSelector, options: OperationOptions = {}): Promise<Image> {
		const response = await this.rpc.describeImage(imageSelector(selector), options);
		return image(required(response.image, "get image response"));
	}

	async list(options: ListImagesOptions = {}): Promise<Page<Image>> {
		const response = await this.rpc.listImages({
			pagionationCursor: cursorToBytes(options.cursor),
			includeBuiltin: options.includeBuiltin ?? false,
		}, options);
		return {
			items: response.image.map(image),
			nextCursor: cursorFromBytes(response.paginationCursor),
		};
	}

	iterate(options: Omit<ListImagesOptions, "cursor"> = {}): AsyncIterableIterator<Image> {
		return paginate((cursor) => this.list({ ...options, cursor }));
	}

	async inspect(selector: ImageSelector, options: OperationOptions = {}): Promise<ImageInspection> {
		const response = await this.rpc.inspectImage({
			imageRef: await this.resolveRef(selector, options),
		}, options);
		return {
			user: response.user || undefined,
			environment: response.env,
			optimizedKinds: response.optimizedKinds,
			optimizedSites: response.optimizedSites,
			version: response.version,
			versionCreatedAt: date(response.versionCreatedAt),
		};
	}

	async optimize(
		selector: ImageSelector,
		options: OptimizeImageOptions = {},
	): Promise<void> {
		const selected = await this.get(selector, options);
		let completed = false;
		for await (const progress of this.rpc.optimizeImage({
			repository: selected.repository,
			digest: selected.digest,
			site: options.site ?? DEFAULT_SITE,
		}, options)) {
			const status = optimizeStatus(progress.status);
			if (status) options.onProgress?.(status);
			if (progress.status === OptimizeImageResponseChunk_Status.FAILED) {
				throw new ImageOptimizationError(progress.failureMessage || "image optimization failed");
			}
			if (progress.status === OptimizeImageResponseChunk_Status.DONE) completed = true;
		}
		if (!completed) throw new ImageOptimizationError("image optimization ended before completion");
	}

	async delete(selector: ImageSelector, options: OperationOptions = {}): Promise<void> {
		const selected = await this.get(selector, options);
		await this.rpc.expireImage({
			repository: selected.repository,
			digest: selected.digest,
			name: selected.name,
			version: selected.version,
		}, options);
	}

	/** Full image refs pass through; anything else resolves to repository@digest. */
	private async resolveRef(selector: ImageSelector, options: OperationOptions): Promise<string> {
		if (typeof selector === "string" && (selector.includes("/") || selector.includes("@") || selector.includes(":"))) {
			return selector;
		}
		return (await this.get(selector, options)).ref;
	}
}

function imageFields(ref?: string): { imageRef?: string; imageName?: string } {
	if (!ref) return {};
	return ref.includes("/") || ref.includes("@") || ref.includes(":")
		? { imageRef: ref }
		: { imageName: ref };
}

function validateBlueprintCreateInput(input: CreateDevboxInput): void {
	const unsupported = [
		["image", input.image],
		["imageName", input.imageName],
		["macosVersion", input.macosVersion],
		["xcodeVersion", input.xcodeVersion],
		["size", input.size],
		["volumeSizeGB", input.volumeSizeGB],
		["repository", input.repository],
		["environment", input.environment],
		["ephemeral", input.ephemeral],
		["privileged", input.privileged],
		["features", input.features],
		["networkPolicy", input.networkPolicy],
	].find(([, value]) => value !== undefined)?.[0];
	if (unsupported) {
		throw new TypeError(`create option "${unsupported}" cannot be used with a blueprint`);
	}
}

function ephemeralValue(value: CreateDevboxInput["ephemeral"]) {
	if (!value) return undefined;
	return {
		stoppedRetentionDuration: typeof value === "object"
			? optionalDuration(value.stoppedRetentionMs)
			: undefined,
	};
}

function optimizeStatus(status: OptimizeImageResponseChunk_Status): OptimizeImageOptions["onProgress"] extends
	((status: infer Status) => void) | undefined ? Status | undefined : never {
	switch (status) {
		case OptimizeImageResponseChunk_Status.PREPARING: return "preparing";
		case OptimizeImageResponseChunk_Status.STARTING: return "starting";
		case OptimizeImageResponseChunk_Status.BAKING: return "baking";
		default: return undefined;
	}
}

function required<T>(value: T | undefined, context: string): T {
	if (value === undefined) throw new IncompleteResponseError(context);
	return value;
}

async function* paginate<T>(
	fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
): AsyncIterableIterator<T> {
	let cursor: string | undefined;
	do {
		const page = await fetchPage(cursor);
		yield* page.items;
		cursor = page.nextCursor;
	} while (cursor);
}

export function createResources(rpc: DevboxRpcClient, connections: ConnectionManager): {
	devboxes: DevboxResource;
	blueprints: BlueprintResource;
	images: ImageResource;
} {
	const blueprints = new BlueprintResources(rpc);
	return {
		devboxes: new DevboxResources(rpc, connections, blueprints),
		blueprints,
		images: new ImageResources(rpc),
	};
}
