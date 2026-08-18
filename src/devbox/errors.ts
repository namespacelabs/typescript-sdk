/**
 * Typed errors thrown by the Devbox client.
 *
 * RPC failures surface as `ConnectError` from `@connectrpc/connect`; the types
 * below cover SDK-level failures (timeouts, gateway handshakes, incomplete
 * responses, and image optimization).
 */

/** Base class for all Devbox SDK errors. */
export class DevboxError extends Error {
	constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}

/** An operation exceeded its `timeoutMs` budget. */
export class DevboxTimeoutError extends DevboxError {
	constructor(message: string, readonly timeoutMs?: number) {
		super(message);
	}
}

/** The devbox gateway rejected the connection with an HTTP error. */
export class DevboxGatewayError extends DevboxError {
	constructor(readonly statusCode: number) {
		super(`devbox gateway returned HTTP ${statusCode}`);
	}
}

/** A response from the service was missing required fields. */
export class IncompleteResponseError extends DevboxError {
	constructor(context: string) {
		super(`${context} was incomplete`);
	}
}

/** Image optimization failed or ended before completing. */
export class ImageOptimizationError extends DevboxError {}
