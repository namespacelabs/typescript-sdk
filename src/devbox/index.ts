import { createClient, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { cachingTokenSource, type TokenSourceInput } from "../auth/caching.js";
import { loadDefaults } from "../auth/token.js";
import { bearerAuthInterceptor } from "../api/interceptors.js";
import { DevBoxService } from "../proto/namespace/private/devbox/devbox_pb.js";
import { ConnectionManager } from "./connection.js";
import type { BlueprintResource, DevboxResource, ImageResource } from "./models.js";
import { createResources } from "./resources.js";

export * from "./errors.js";
export * from "./models.js";

export interface DevboxClientOptions {
	/**
	 * Source of API tokens, used for RPCs and for authenticating SSH gateway
	 * connections. Accepts a TokenSource or a provider function for one —
	 * e.g. `loadUserToken` — which the client invokes and awaits internally
	 * on first use. The
	 * client wraps it with an in-memory cache that reuses tokens while valid
	 * and single-flights concurrent issuance.
	 *
	 * Defaults to `loadDefaults`: the workload token when running in a
	 * Namespace workload (`NSC_TOKEN_FILE` or `/var/run/nsc/token.json`),
	 * falling back to the local user token.
	 */
	tokenSource?: TokenSourceInput;

	/**
	 * Fully configured Connect transport for DevBoxService RPCs.
	 *
	 * When set, it is used as-is: `baseUrl` is ignored and the client does
	 * NOT attach authentication to RPCs — include your own interceptor (see
	 * `bearerAuthInterceptor`) in the transport. `tokenSource` is still
	 * required for SSH gateway authentication.
	 */
	transport?: Transport;

	/**
	 * Base URL for the default transport. Only used when `transport` is not
	 * set. Defaults to `NSC_DEVBOX_ENDPOINT` or the iad regional endpoint.
	 * Note the API endpoint is independent of where devboxes are created;
	 * that is controlled per-request by `site` (default "iad").
	 */
	baseUrl?: string;

	connectionTimeoutMs?: number;
}

export interface DevboxClient {
	devboxes: DevboxResource;
	blueprints: BlueprintResource;
	images: ImageResource;
	close(): void;
}

export function createDevboxClient(options: DevboxClientOptions = {}): DevboxClient {
	const tokenSource = cachingTokenSource(options.tokenSource ?? loadDefaults);
	const transport = options.transport ?? createConnectTransport({
		httpVersion: "1.1",
		baseUrl: options.baseUrl ?? process.env.NSC_DEVBOX_ENDPOINT ?? "https://private-api.iad.namespaceapis.com",
		useBinaryFormat: false,
		interceptors: [bearerAuthInterceptor(tokenSource)],
	});
	const rpc = createClient(DevBoxService, transport);
	const connections = new ConnectionManager(rpc, tokenSource, options.connectionTimeoutMs ?? 90_000);
	const resources = createResources(rpc, connections);

	return {
		...resources,
		close: () => connections.close(),
	};
}
