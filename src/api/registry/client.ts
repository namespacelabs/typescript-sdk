/**
 * Registry API client
 */

import { createClient, type Transport } from "@connectrpc/connect";
import type { TokenSource } from "../../auth/types.js";
import { createGlobalTransport } from "../clients.js";

import { ContainerRegistryService } from "../../proto/namespace/cloud/registry/v1beta/registry_connect.js";

/**
 * Registry API client
 */
export interface RegistryClient {
	registry: ReturnType<typeof createClient<typeof ContainerRegistryService>>;
}

/**
 * Options for creating a registry client
 */
export interface RegistryClientOpts {
	/** Token source for authentication */
	tokenSource: TokenSource;
	/** Custom transport (if provided, tokenSource is ignored) */
	transport?: Transport;
}

/**
 * Create a registry client
 */
export function createRegistryClient(opts: RegistryClientOpts): RegistryClient {
	const transport = opts.transport || createGlobalTransport({
		tokenSource: opts.tokenSource,
	});

	return {
		registry: createClient(ContainerRegistryService, transport),
	};
}
