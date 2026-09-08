/**
 * Compute API client
 */

import { createClient, type Transport } from "@connectrpc/connect";
import type { TokenSourceInput } from "../../auth/caching.js";
import { loadDefaults } from "../../auth/token.js";
import { createRegionTransport } from "../clients.js";

import { CommandService } from "../../proto/namespace/cloud/compute/v1beta/command_pb.js";
import { ComputeService } from "../../proto/namespace/cloud/compute/v1beta/compute_pb.js";
import { StorageService } from "../../proto/namespace/cloud/compute/v1beta/storage_pb.js";
import { UsageService } from "../../proto/namespace/cloud/compute/v1beta/usage_pb.js";
import { ObservabilityService } from "../../proto/namespace/cloud/compute/v1beta/observability_pb.js";
import { ManagementService } from "../../proto/namespace/cloud/compute/v1beta/management_pb.js";

/**
 * Compute API client with all compute-related services
 */
export interface ComputeClient {
	compute: ReturnType<typeof createClient<typeof ComputeService>>;
	command: ReturnType<typeof createClient<typeof CommandService>>;
	storage: ReturnType<typeof createClient<typeof StorageService>>;
	usage: ReturnType<typeof createClient<typeof UsageService>>;
	observability: ReturnType<typeof createClient<typeof ObservabilityService>>;
	management: ReturnType<typeof createClient<typeof ManagementService>>;
}

/**
 * Options for creating a compute client
 */
export interface ComputeClientOpts {
	/** Token source for authentication, defaults to loadDefaults on first use. */
	tokenSource?: TokenSourceInput;
	/** Region (defaults to 'us') */
	region?: string;
	/** Custom transport (if provided, region and tokenSource are ignored) */
	transport?: Transport;
}

/**
 * Create a compute client with all compute-related services
 */
export function createComputeClient(opts: ComputeClientOpts = {}): ComputeClient {
	const transport = opts.transport || createRegionTransport(
		opts.region || "us",
		{ tokenSource: opts.tokenSource ?? loadDefaults }
	);

	return {
		compute: createClient(ComputeService, transport),
		command: createClient(CommandService, transport),
		storage: createClient(StorageService, transport),
		usage: createClient(UsageService, transport),
		observability: createClient(ObservabilityService, transport),
		management: createClient(ManagementService, transport),
	};
}
