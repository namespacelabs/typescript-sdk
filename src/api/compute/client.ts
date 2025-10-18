/**
 * Compute API client
 */

import { createClient, type Transport } from "@connectrpc/connect";
import type { TokenSource } from "../../auth/types.js";
import { createRegionTransport } from "../clients.js";

import { ComputeService } from "../../proto/namespace/cloud/compute/v1beta/compute_connect.js";
import { StorageService } from "../../proto/namespace/cloud/compute/v1beta/storage_connect.js";
import { UsageService } from "../../proto/namespace/cloud/compute/v1beta/usage_connect.js";
import { ObservabilityService } from "../../proto/namespace/cloud/compute/v1beta/observability_connect.js";
import { ManagementService } from "../../proto/namespace/cloud/compute/v1beta/management_connect.js";

/**
 * Compute API client with all compute-related services
 */
export interface ComputeClient {
	compute: ReturnType<typeof createClient<typeof ComputeService>>;
	storage: ReturnType<typeof createClient<typeof StorageService>>;
	usage: ReturnType<typeof createClient<typeof UsageService>>;
	observability: ReturnType<typeof createClient<typeof ObservabilityService>>;
	management: ReturnType<typeof createClient<typeof ManagementService>>;
}

/**
 * Options for creating a compute client
 */
export interface ComputeClientOpts {
	/** Token source for authentication */
	tokenSource: TokenSource;
	/** Region (defaults to 'us') */
	region?: string;
	/** Custom transport (if provided, region and tokenSource are ignored) */
	transport?: Transport;
}

/**
 * Create a compute client with all compute-related services
 */
export function createComputeClient(opts: ComputeClientOpts): ComputeClient {
	const transport = opts.transport || createRegionTransport(
		opts.region || "us",
		{ tokenSource: opts.tokenSource }
	);

	return {
		compute: createClient(ComputeService, transport),
		storage: createClient(StorageService, transport),
		usage: createClient(UsageService, transport),
		observability: createClient(ObservabilityService, transport),
		management: createClient(ManagementService, transport),
	};
}
