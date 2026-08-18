/**
 * Connect interceptors for authentication and other concerns
 */

import type { Interceptor } from "@connectrpc/connect";
import { cachingTokenSource, TOKEN_MIN_VALIDITY_MS, type TokenSourceInput } from "../auth/caching.js";

/**
 * Create an interceptor that adds bearer token authentication.
 *
 * Every request asks the source for a token with a minimum remaining
 * validity (defaults to the SDK-wide TOKEN_MIN_VALIDITY_MS), which must be
 * enough for the token to work; there is no refresh-and-retry on
 * authentication failures. Caching and reuse are the source's
 * responsibility. The source is wrapped with `cachingTokenSource`, so
 * tokens are reused while valid and concurrent issuance is single-flighted
 * — passing an already-caching source is a no-op.
 */
export function bearerAuthInterceptor(
	source: TokenSourceInput,
	minDuration: number = TOKEN_MIN_VALIDITY_MS
): Interceptor {
	const tokens = cachingTokenSource(source);
	return (next) => async (req) => {
		req.header.set("Authorization", `Bearer ${await tokens.issueToken(minDuration)}`);
		return await next(req);
	};
}
