/**
 * In-memory caching wrapper around a TokenSource.
 */

import { extractClaims } from "./claims.js";
import type { TokenSource } from "./types.js";

/**
 * Minimum remaining validity the SDK requires from tokens it attaches to
 * requests. Used consistently across RPC, gateway, and SSH authentication.
 */
export const TOKEN_MIN_VALIDITY_MS = 5 * 60 * 1_000;

/**
 * Constructs a TokenSource. Called lazily, at most once (retried only if it
 * throws), the first time a token is needed — e.g. `loadUserToken`.
 */
export type TokenSourceProvider = () => TokenSource | Promise<TokenSource>;

/**
 * Anything the SDK accepts as a source of tokens: a ready TokenSource or a
 * provider constructing one (awaited internally on first use).
 */
export type TokenSourceInput = TokenSource | TokenSourceProvider;

/**
 * Wrap a TokenSource — or a provider constructing one — with an in-memory
 * cache.
 *
 * - Providers are invoked lazily on first issuance, awaited, and resolved at
 *   most once; a provider that throws is retried on the next issuance.
 * - Reuses the last issued token while it satisfies the requested minimum
 *   validity (based on the token's `exp` claim; tokens without an expiration
 *   are treated as always valid).
 * - Single-flights concurrent issuance so parallel requests share one
 *   underlying `issueToken` call.
 * - `issueToken(minDuration, true)` bypasses the cache and forces a refresh.
 *
 * The wrapper implements TokenSource itself, so it can be passed anywhere a
 * TokenSource is accepted.
 */
export function cachingTokenSource(source: TokenSourceInput): TokenSource {
	if (source instanceof CachingTokenSource) return source;
	return new CachingTokenSource(source);
}

class CachingTokenSource implements TokenSource {
	private cached?: { token: string; expiresAtMs?: number };
	private inflight?: { minDuration: number; promise: Promise<string> };
	private source?: Promise<TokenSource>;

	constructor(private readonly input: TokenSourceInput) {}

	private async resolveSource(): Promise<TokenSource> {
		if (typeof this.input !== "function") return this.input;
		if (!this.source) this.source = Promise.resolve(this.input());
		try {
			return await this.source;
		} catch (error) {
			this.source = undefined;
			throw error;
		}
	}

	async issueToken(minDuration: number, force = false): Promise<string> {
		if (!force) {
			const token = this.cachedToken(minDuration);
			if (token !== undefined) return token;
			if (this.inflight && this.inflight.minDuration >= minDuration) return this.inflight.promise;
		}
		const promise = this.refresh(minDuration, force);
		const record = { minDuration, promise };
		this.inflight = record;
		try {
			return await promise;
		} finally {
			if (this.inflight === record) this.inflight = undefined;
		}
	}

	private cachedToken(minDuration: number): string | undefined {
		if (!this.cached) return undefined;
		if (this.cached.expiresAtMs === undefined) return this.cached.token;
		return this.cached.expiresAtMs > Date.now() + minDuration ? this.cached.token : undefined;
	}

	private async refresh(minDuration: number, force: boolean): Promise<string> {
		const source = await this.resolveSource();
		const token = await source.issueToken(minDuration, force);
		const claims = extractClaims(token);
		this.cached = { token, expiresAtMs: claims?.exp !== undefined ? claims.exp * 1000 : undefined };
		return token;
	}
}
