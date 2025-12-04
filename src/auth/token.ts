/**
 * Token loading and management
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { Duration } from "@bufbuild/protobuf";
import { TokenSource, TokenJson } from "./types.js";
import { extractClaims, getTenantId } from "./claims.js";
import { UserSessionsService } from "../proto/namespace/private/sessions/users_connect.js";

function getIAMEndpoint(): string {
	return (
		process.env.NSC_IAM_ENDPOINT ||
		process.env.NSC_GLOBAL_ENDPOINT ||
		"https://private-api.global.namespaceapis.com"
	);
}

function getDebugFlags(): Set<string> {
	const val = process.env.NSC_DEBUG;
	if (!val) return new Set();
	return new Set(val.split(",").map((s) => s.trim().toLowerCase()));
}

function isAuthDebugEnabled(): boolean {
	return getDebugFlags().has("auth");
}

function isForceAuthRefreshEnabled(): boolean {
	return getDebugFlags().has("force-auth-refresh");
}

function debug(message: string): void {
	if (isAuthDebugEnabled()) {
		console.error(`[nsc:auth] ${message}`);
	}
}

/**
 * Error thrown when user is not logged in
 */
export class NotLoggedInError extends Error {
	constructor() {
		super("you are not logged in to Namespace; try running `nsc login`");
		this.name = "NotLoggedInError";
	}
}

/**
 * Get the user config directory
 */
function getUserConfigDir(): string {
	const platform = os.platform();

	if (platform === "darwin") {
		return path.join(os.homedir(), "Library/Application Support");
	} else if (platform === "win32") {
		return process.env.APPDATA || path.join(os.homedir(), "AppData/Roaming");
	} else {
		return (
			process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
		);
	}
}

/**
 * Load token from file
 */
async function loadFromFile(tokenPath: string): Promise<LoadedToken> {
	try {
		const content = await fs.readFile(tokenPath, "utf8");
		const tokenJson: TokenJson = JSON.parse(content);

		const dir = path.dirname(tokenPath);

		debug(`Loaded token from ${tokenPath}`);
		if (tokenJson.session_token) {
			debug("Token type: session token (will refresh bearer tokens)");
		} else if (tokenJson.bearer_token) {
			const claims = extractClaims(tokenJson.bearer_token);
			if (claims?.exp) {
				const expiresAt = new Date(claims.exp * 1000);
				const now = new Date();
				if (expiresAt > now) {
					const remainingMs = expiresAt.getTime() - now.getTime();
					const remainingMins = Math.floor(remainingMs / 60000);
					debug(`Token type: bearer token (valid for ${remainingMins} minutes)`);
				} else {
					debug("Token type: bearer token (expired)");
				}
			} else {
				debug("Token type: bearer token (no expiration)");
			}
		}

		return new LoadedToken(
			tokenJson.bearer_token,
			tokenJson.session_token,
			dir
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new NotLoggedInError();
		}
		throw error;
	}
}

/**
 * Load default token based on environment and context
 * Checks in order:
 * 1. NSC_TOKEN_FILE environment variable
 * 2. /var/run/nsc/token.json (workload token)
 * 3. User config directory token
 */
export async function loadDefaults(): Promise<TokenSource> {
	// Check environment variable first
	if (process.env.NSC_TOKEN_FILE) {
		return await loadFromFile(process.env.NSC_TOKEN_FILE);
	}

	// Check workload token location
	const workloadPath = "/var/run/nsc/token.json";
	try {
		await fs.access(workloadPath);
		return await loadFromFile(workloadPath);
	} catch {
		// Fall through to user token
	}

	// Load user token
	return await loadUserToken();
}

/**
 * Load user token from local configuration
 */
export async function loadUserToken(): Promise<TokenSource> {
	const configDir = getUserConfigDir();
	const tokenPath = path.join(configDir, "ns/token.json");
	return await loadFromFile(tokenPath);
}

/**
 * Load workload token from standard location
 * Workload tokens only use bearer tokens directly (no session token refresh)
 */
export async function loadWorkloadToken(): Promise<TokenSource> {
	const tokenPath =
		process.env.NSC_TOKEN_FILE || "/var/run/nsc/token.json";
	const loaded = await loadFromFile(tokenPath);
	if (!loaded.bearerToken) {
		throw new Error("Workload token file does not contain a bearer token");
	}
	return new LoadedToken(loaded.bearerToken, undefined, undefined);
}

/**
 * Create a token source from a bearer token string
 */
export function fromBearerToken(token: string): TokenSource {
	return new LoadedToken(token, undefined, undefined);
}

/**
 * LoadedToken implements TokenSource with caching
 */
class LoadedToken implements TokenSource {
	readonly bearerToken?: string;
	private sessionToken?: string;
	private cacheDir?: string;
	private sessionsClient?: ReturnType<typeof createClient<typeof UserSessionsService>>;

	constructor(
		bearerToken?: string,
		sessionToken?: string,
		cacheDir?: string
	) {
		this.bearerToken = bearerToken;
		this.sessionToken = sessionToken;
		this.cacheDir = cacheDir;
	}

	private getSessionsClient(): ReturnType<typeof createClient<typeof UserSessionsService>> {
		if (!this.sessionsClient) {
			const transport = createConnectTransport({
				httpVersion: "1.1",
				baseUrl: getIAMEndpoint(),
				useBinaryFormat: false,
				interceptors: [
					(next) => async (req) => {
						if (this.sessionToken) {
							req.header.set("Authorization", `Bearer ${this.sessionToken}`);
						}
						return await next(req);
					},
				],
			});
			this.sessionsClient = createClient(UserSessionsService, transport);
		}
		return this.sessionsClient;
	}

	async issueToken(minDuration: number, force: boolean = false): Promise<string> {
		if (this.sessionToken) {
			return await this.issueFromSession(minDuration, force);
		}

		if (this.bearerToken) {
			return this.bearerToken;
		}

		throw new Error("No bearer token or session token available");
	}

	private async issueFromSession(
		minDuration: number,
		force: boolean
	): Promise<string> {
		if (!this.sessionToken) {
			throw new Error("No session token available");
		}

		const issueNewToken = async (durationMs: number): Promise<string> => {
			const client = this.getSessionsClient();
			const durationSeconds = BigInt(Math.floor(durationMs / 1000));
			const res = await client.issueTenantTokenFromSession({
				tokenDuration: new Duration({ seconds: durationSeconds }),
			});
			return res.tenantToken;
		};

		const forceRefresh = force || isForceAuthRefreshEnabled();
		if (forceRefresh) {
			debug("Forcing new token issue");
			const start = Date.now();
			const token = await issueNewToken(minDuration);
			debug(`Issued new bearer token from session (took ${Date.now() - start}ms)`);
			return token;
		}

		const sessionClaims = extractClaims(this.sessionToken);
		if (!sessionClaims) {
			throw new Error("Failed to extract claims from session token");
		}

		if (this.cacheDir) {
			const cachePath = path.join(this.cacheDir, "token.cache");
			try {
				const cacheContents = await fs.readFile(cachePath, "utf8");
				const cacheClaims = extractClaims(cacheContents);

				if (cacheClaims && cacheClaims.tenant_id === sessionClaims.tenant_id) {
					const nowMs = Date.now();
					const expiresAtMs = (cacheClaims.exp || 0) * 1000;
					if (expiresAtMs > nowMs + minDuration) {
						const remainingMins = Math.floor((expiresAtMs - nowMs) / 60000);
						debug(`Using cached bearer token (valid for ${remainingMins} minutes)`);
						return cacheContents;
					}
				}
			} catch {
				// Cache miss or read error, continue to issue new token
			}
		}

		// Request 2x the minimum duration, capped at 1 hour
		let requestDuration = minDuration * 2;
		const oneHourMs = 60 * 60 * 1000;
		if (requestDuration > oneHourMs) {
			requestDuration = oneHourMs;
		}

		debug("Issuing new bearer token from session");
		const start = Date.now();
		const newToken = await issueNewToken(requestDuration);
		const elapsed = Date.now() - start;

		if (this.cacheDir) {
			const cachePath = path.join(this.cacheDir, "token.cache");
			try {
				await fs.writeFile(cachePath, newToken, { mode: 0o600 });
			} catch {
				// Ignore cache write errors
			}
		}

		const newClaims = extractClaims(newToken);
		if (newClaims?.exp) {
			const remainingMins = Math.floor((newClaims.exp * 1000 - Date.now()) / 60000);
			debug(`Issued new bearer token (valid for ${remainingMins} minutes, took ${elapsed}ms)`);
		} else {
			debug(`Issued new bearer token (took ${elapsed}ms)`);
		}

		return newToken;
	}
}
