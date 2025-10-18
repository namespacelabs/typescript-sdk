/**
 * Storage API client
 */

import { createClient, type Transport } from "@connectrpc/connect";
import type { TokenSource } from "../../auth/types.js";
import { createRegionTransport } from "../clients.js";

import { ArtifactsService } from "../../proto/namespace/cloud/storage/v1beta/artifact_connect.js";

/**
 * Storage API client
 */
export interface StorageClient {
	artifacts: ReturnType<typeof createClient<typeof ArtifactsService>>;
}

/**
 * Options for creating a storage client
 */
export interface StorageClientOpts {
	/** Token source for authentication */
	tokenSource: TokenSource;
	/** Region (defaults to 'us') */
	region?: string;
	/** Custom transport (if provided, region and tokenSource are ignored) */
	transport?: Transport;
}

/**
 * Create a storage client
 */
export function createStorageClient(opts: StorageClientOpts): StorageClient {
	const transport = opts.transport || createRegionTransport(
		opts.region || "us",
		{ tokenSource: opts.tokenSource }
	);

	return {
		artifacts: createClient(ArtifactsService, transport),
	};
}
