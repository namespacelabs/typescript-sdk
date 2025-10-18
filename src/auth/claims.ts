/**
 * JWT token claims extraction and validation
 */

import { TokenClaims } from "./types.js";

/**
 * Extract claims from a JWT token without verification
 * Note: This does not validate the token signature, only parses the payload
 */
export function extractClaims(token: string): TokenClaims | null {
	try {
		// Remove token prefix if present
		const cleanToken = stripTokenPrefix(token);

		// JWT format: header.payload.signature
		const parts = cleanToken.split(".");
		if (parts.length !== 3) {
			return null;
		}

		// Decode the payload (second part)
		const payload = parts[1];
		const decoded = Buffer.from(payload, "base64url").toString("utf8");
		const claims = JSON.parse(decoded) as TokenClaims;

		return claims;
	} catch (error) {
		return null;
	}
}

/**
 * Strip known token prefixes
 */
function stripTokenPrefix(token: string): string {
	const prefixes = ["st_", "nsct_", "nscw_", "oidc_", "cognito_"];

	for (const prefix of prefixes) {
		if (token.startsWith(prefix)) {
			return token.substring(prefix.length);
		}
	}

	return token;
}

/**
 * Check if a token is expired (with optional buffer)
 */
export function isTokenExpired(
	claims: TokenClaims,
	bufferMs: number = 60000
): boolean {
	if (!claims.exp) {
		return false; // No expiration means never expires
	}

	const expirationMs = claims.exp * 1000;
	const nowMs = Date.now();

	return nowMs + bufferMs >= expirationMs;
}

/**
 * Get the tenant ID from token claims
 */
export function getTenantId(token: string): string | null {
	const claims = extractClaims(token);
	return claims?.tenant_id || null;
}

/**
 * Get token expiration time in milliseconds
 */
export function getTokenExpiration(token: string): number | null {
	const claims = extractClaims(token);
	if (!claims?.exp) {
		return null;
	}
	return claims.exp * 1000;
}
