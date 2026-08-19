/**
 * Devbox desktop access, built on the generic VNC client in
 * `@namespacelabs/sdk/vnc`.
 *
 * Devboxes with a desktop (macOS devboxes) expose a VNC service through the
 * instance ingress. This module resolves the VNC endpoint and credentials
 * from the regional Compute API, authenticates the gateway websocket, and
 * translates VNC errors into their devbox equivalents.
 */
import { Code, ConnectError, createClient, type Client as RpcClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { bearerAuthInterceptor } from "../api/interceptors.js";
import type { TokenSource } from "../auth/types.js";
import {
	ComputeService,
	type GetVNCConfigResponse,
} from "../proto/namespace/cloud/compute/v1beta/compute_pb.js";
import { openVnc, VncEndpointError, VncTimeoutError, type VncClient } from "../vnc/index.js";
import { DevboxDesktopUnavailableError, DevboxGatewayError, DevboxTimeoutError } from "./errors.js";
import type { ClickOptions, OperationOptions, Screenshot } from "./models.js";

export type ComputeClient = RpcClient<typeof ComputeService>;

/**
 * Derive the regional Compute API endpoint from an instance's ingress domain
 * (`GetVNCConfig` must be answered by the region that runs the instance).
 */
export function computeApiBaseUrl(ingressDomain: string): string {
	const shortRegion = ingressDomain.replace(/\.nscluster\.cloud$/, "");
	if (shortRegion !== ingressDomain) return `https://${shortRegion}.compute.namespaceapis.com`;
	return `https://api.${ingressDomain}`;
}

export function createComputeClient(tokenSource: TokenSource, baseUrl: string): ComputeClient {
	return createClient(ComputeService, createConnectTransport({
		httpVersion: "1.1",
		baseUrl,
		interceptors: [bearerAuthInterceptor(tokenSource)],
	}));
}

/**
 * Fetch the VNC endpoint and credentials for an instance. The server answers
 * `FailedPrecondition` when the instance has no VNC service; translate that
 * into the typed `DevboxDesktopUnavailableError`.
 */
export async function fetchVncConfig(
	client: ComputeClient,
	instanceId: string,
	options: OperationOptions,
): Promise<GetVNCConfigResponse> {
	try {
		return await client.getVNCConfig({ instanceId }, {
			signal: options.signal,
			timeoutMs: options.timeoutMs,
		});
	} catch (error) {
		if (error instanceof ConnectError && error.code === Code.FailedPrecondition) {
			throw new DevboxDesktopUnavailableError(`devbox does not expose a desktop: ${error.rawMessage}`);
		}
		throw error;
	}
}

export interface OpenDesktopOptions {
	instanceId: string;
	/** VNC websocket endpoint from `GetVNCConfig`. */
	endpoint: string;
	username: string;
	password: string;
	/** Gateway bearer token, sent as `x-nsc-ingress-auth`. */
	token: string;
	signal: AbortSignal;
	timeoutMs: number;
}

/** Open a VNC session to an instance desktop through the devbox gateway. */
export async function openDesktop(options: OpenDesktopOptions): Promise<DesktopConnection> {
	try {
		const client = await openVnc({
			endpoint: options.endpoint,
			username: options.username,
			password: options.password,
			headers: { "x-nsc-ingress-auth": `Bearer ${options.token}` },
			signal: options.signal,
			timeoutMs: options.timeoutMs,
		});
		return new DesktopConnection(options.instanceId, client);
	} catch (error) {
		throw translateVncError(error);
	}
}

/**
 * An established VNC session to a devbox desktop: a `VncClient` that reports
 * devbox error types.
 */
export class DesktopConnection {
	constructor(
		readonly instanceId: string,
		private readonly client: VncClient,
	) {}

	get width(): number {
		return this.client.width;
	}

	get height(): number {
		return this.client.height;
	}

	get desktopName(): string {
		return this.client.desktopName;
	}

	close(): void {
		this.client.close();
	}

	onClose(listener: () => void): void {
		this.client.onClose(listener);
	}

	/** Capture the full framebuffer and encode it as a PNG. */
	async screenshot(options: OperationOptions = {}): Promise<Screenshot> {
		try {
			return await this.client.screenshot(options);
		} catch (error) {
			throw translateVncError(error);
		}
	}

	/** Click at framebuffer coordinates: move, press, release. */
	async click(x: number, y: number, options: ClickOptions = {}): Promise<void> {
		try {
			await this.client.click(x, y, options);
		} catch (error) {
			throw translateVncError(error);
		}
	}

	/** Type text: a key press and release per character. */
	async type(text: string, options: OperationOptions = {}): Promise<void> {
		try {
			await this.client.type(text, options);
		} catch (error) {
			throw translateVncError(error);
		}
	}
}

/** Map generic VNC errors to their devbox equivalents. */
function translateVncError(error: unknown): unknown {
	if (error instanceof VncTimeoutError) return new DevboxTimeoutError(error.message, error.timeoutMs);
	if (error instanceof VncEndpointError) return new DevboxGatewayError(error.statusCode);
	return error;
}
