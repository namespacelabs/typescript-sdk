/**
 * IAM API client
 */

import { createClient, type Transport } from "@connectrpc/connect";
import type { TokenSource } from "../../auth/types.js";
import { createGlobalTransport } from "../clients.js";

import { TenantService } from "../../proto/namespace/cloud/iam/v1beta/tenants_connect.js";
import { TokenService } from "../../proto/namespace/cloud/iam/v1beta/tokens_connect.js";

/**
 * IAM API client with tenant and token services
 */
export interface IAMClient {
	tenants: ReturnType<typeof createClient<typeof TenantService>>;
	tokens: ReturnType<typeof createClient<typeof TokenService>>;
}

/**
 * Options for creating an IAM client
 */
export interface IAMClientOpts {
	/** Token source for authentication */
	tokenSource: TokenSource;
	/** Custom transport (if provided, tokenSource is ignored) */
	transport?: Transport;
}

/**
 * Create an IAM client with tenant and token services
 */
export function createIAMClient(opts: IAMClientOpts): IAMClient {
	const transport = opts.transport || createGlobalTransport({
		tokenSource: opts.tokenSource,
	});

	return {
		tenants: createClient(TenantService, transport),
		tokens: createClient(TokenService, transport),
	};
}
