/**
 * Connect interceptors for authentication and other concerns
 */

import type { Interceptor } from "@connectrpc/connect";
import type { TokenSource } from "../auth/types.js";

/**
 * Create an interceptor that adds bearer token authentication
 * The token is fetched fresh for each request with a 5-minute minimum duration
 */
export function bearerAuthInterceptor(
	source: TokenSource,
	minDuration: number = 5 * 60 * 1000
): Interceptor {
	return (next) => async (req) => {
		const token = await source.issueToken(minDuration);
		req.header.set("Authorization", `Bearer ${token}`);
		return await next(req);
	};
}
