/**
 * Core types for authentication handling
 */

/**
 * TokenSource interface for obtaining authentication tokens
 */
export interface TokenSource {
	/**
	 * Issue a token with the specified minimum duration
	 * @param minDuration Minimum duration the token should be valid for (in milliseconds)
	 * @param force Force token refresh even if cached token is valid
	 */
	issueToken(minDuration: number, force?: boolean): Promise<string>;
}

/**
 * Token JSON structure stored in token files
 */
export interface TokenJson {
	bearer_token: string;
	session_token?: string;
}

/**
 * JWT token claims structure
 */
export interface TokenClaims {
	// Standard JWT claims
	iss?: string; // Issuer
	sub?: string; // Subject
	aud?: string | string[]; // Audience
	exp?: number; // Expiration time (seconds since epoch)
	nbf?: number; // Not before time
	iat?: number; // Issued at time
	jti?: string; // JWT ID

	// Namespace-specific claims
	tenant_id?: string; // Tenant identifier
	actor_id?: string; // User/actor performing action
	instance_id?: string; // Instance identifier
	owner_id?: string; // Owner of the resource
	workload_region?: string; // Workload region
}

/**
 * Cached token structure
 */
export interface CachedToken {
	token: string;
	expiration: number; // Unix timestamp in milliseconds
	tenantId?: string;
}
