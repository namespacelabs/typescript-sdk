/**
 * Token loading and management
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { TokenSource, TokenJson, CachedToken } from "./types.js";
import {
	extractClaims,
	isTokenExpired,
	getTenantId,
	getTokenExpiration,
} from "./claims.js";

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
 */
export async function loadWorkloadToken(): Promise<TokenSource> {
	const tokenPath =
		process.env.NSC_TOKEN_FILE || "/var/run/nsc/token.json";
	return await loadFromFile(tokenPath);
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
	private bearerToken?: string;
	private sessionToken?: string;
	private cacheDir?: string;
	private cachePath?: string;

	constructor(
		bearerToken?: string,
		sessionToken?: string,
		cacheDir?: string
	) {
		this.bearerToken = bearerToken;
		this.sessionToken = sessionToken;
		this.cacheDir = cacheDir;

		if (cacheDir) {
			this.cachePath = path.join(cacheDir, "token.cache");
		}
	}

	async issueToken(minDuration: number, force: boolean = false): Promise<string> {
		// If we have a bearer token (no session token), return it directly
		if (this.bearerToken && !this.sessionToken) {
			return this.bearerToken;
		}

		// If we have a session token, try to get a cached or fresh bearer token
		if (this.sessionToken) {
			return await this.issueFromSession(minDuration, force);
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

		// Get tenant ID from session token
		const sessionTenantId = getTenantId(this.sessionToken);

		// Try to load cached token if not forcing refresh
		if (!force && this.cachePath) {
			const cached = await this.loadCachedToken();
			if (
				cached &&
				cached.tenantId === sessionTenantId &&
				!this.isCachedTokenExpired(cached, minDuration)
			) {
				return cached.token;
			}
		}

		// Issue new token from session
		// In a real implementation, this would call the IAM service
		// For now, we'll throw an error indicating this needs to be implemented
		throw new Error(
			"Session token refresh not yet implemented - requires IAM service integration"
		);
	}

	private async loadCachedToken(): Promise<CachedToken | null> {
		if (!this.cachePath) {
			return null;
		}

		try {
			const content = await fs.readFile(this.cachePath, "utf8");
			return JSON.parse(content) as CachedToken;
		} catch {
			return null;
		}
	}

	private async saveCachedToken(token: string, expiration: number): Promise<void> {
		if (!this.cachePath) {
			return;
		}

		const tenantId = getTenantId(token);
		const cached: CachedToken = {
			token,
			expiration,
			tenantId: tenantId || undefined,
		};

		try {
			await fs.writeFile(
				this.cachePath,
				JSON.stringify(cached),
				{ mode: 0o600 }
			);
		} catch (error) {
			// Ignore cache write errors
		}
	}

	private isCachedTokenExpired(
		cached: CachedToken,
		minDuration: number
	): boolean {
		const nowMs = Date.now();
		const requiredValidUntil = nowMs + minDuration;
		return cached.expiration <= requiredValidUntil;
	}
}
