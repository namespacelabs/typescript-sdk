/**
 * Builds API client
 */

import { createClient, type Transport } from "@connectrpc/connect";
import type { TokenSource } from "../../auth/types.js";
import { createRegionTransport } from "../clients.js";

import { BuilderService } from "../../proto/namespace/cloud/builder/v1beta/builder_connect.js";

/**
 * Builds API client
 */
export interface BuildsClient {
	builder: ReturnType<typeof createClient<typeof BuilderService>>;
}

/**
 * Options for creating a builds client
 */
export interface BuildsClientOpts {
	/** Token source for authentication */
	tokenSource: TokenSource;
	/** Region (defaults to 'us') */
	region?: string;
	/** Custom transport (if provided, region and tokenSource are ignored) */
	transport?: Transport;
}

/**
 * Create a builds client
 */
export function createBuildsClient(opts: BuildsClientOpts): BuildsClient {
	const transport = opts.transport || createRegionTransport(
		opts.region || "us",
		{ tokenSource: opts.tokenSource }
	);

	return {
		builder: createClient(BuilderService, transport),
	};
}
