/**
 * Vault API client
 */

import { createClient, type Transport } from "@connectrpc/connect";
import type { TokenSource } from "../../auth/types.js";
import { createRegionTransport } from "../clients.js";

import { VaultService } from "../../proto/namespace/cloud/vault/v1beta/vault_connect.js";

/**
 * Vault API client
 */
export interface VaultClient {
	vault: ReturnType<typeof createClient<typeof VaultService>>;
}

/**
 * Options for creating a vault client
 */
export interface VaultClientOpts {
	/** Token source for authentication */
	tokenSource: TokenSource;
	/** Region (defaults to 'us') */
	region?: string;
	/** Custom transport (if provided, region and tokenSource are ignored) */
	transport?: Transport;
}

/**
 * Create a vault client
 */
export function createVaultClient(opts: VaultClientOpts): VaultClient {
	const transport = opts.transport || createRegionTransport(
		opts.region || "us",
		{ tokenSource: opts.tokenSource }
	);

	return {
		vault: createClient(VaultService, transport),
	};
}
