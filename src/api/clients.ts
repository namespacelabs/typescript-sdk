/**
 * Client creation utilities
 */

import { createConnectTransport } from "@connectrpc/connect-node";
import { createClient, type Transport } from "@connectrpc/connect";
import type { ServiceType } from "@bufbuild/protobuf";
import type { TokenSource } from "../auth/types.js";
import { bearerAuthInterceptor } from "./interceptors.js";

/**
 * Options for creating a regional transport
 */
export interface CreateRegionTransportOpts {
	/** Token source for dynamic token fetching */
	tokenSource: TokenSource;
	/** Custom base URL (overrides region) */
	baseUrl?: string;
}

/**
 * Options for creating individual service clients
 */
export interface CreateClientOpts {
	/** Token source for dynamic token fetching */
	tokenSource: TokenSource;
	/** Custom transport (if provided, tokenSource is ignored) */
	transport?: Transport;
}

/**
 * Create a Connect transport for regional APIs
 */
export function createRegionTransport(
	region: string,
	opts: CreateRegionTransportOpts
): Transport {
	const baseUrl = opts.baseUrl || `https://${region}.compute.namespaceapis.com`;

	return createConnectTransport({
		httpVersion: "1.1",
		baseUrl,
		useBinaryFormat: false,
		interceptors: [bearerAuthInterceptor(opts.tokenSource)],
	});
}

/**
 * Create a Connect transport for global APIs (IAM, Registry, etc.)
 */
export function createGlobalTransport(opts: {
	tokenSource: TokenSource;
	baseUrl?: string;
}): Transport {
	const baseUrl = opts.baseUrl || "https://global.namespaceapis.com";

	return createConnectTransport({
		httpVersion: "1.1",
		baseUrl,
		useBinaryFormat: false,
		interceptors: [bearerAuthInterceptor(opts.tokenSource)],
	});
}

/**
 * Create a client for any service
 */
export { createClient };
