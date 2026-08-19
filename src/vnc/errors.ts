/**
 * Typed errors thrown by the VNC client.
 *
 * Protocol violations (unsupported versions, encodings, or malformed
 * messages) surface as plain `Error`s; the types below cover failures callers
 * commonly branch on.
 */

/** Base class for all VNC client errors. */
export class VncError extends Error {
	constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}

/** An operation exceeded its `timeoutMs` budget. */
export class VncTimeoutError extends VncError {
	constructor(message: string, readonly timeoutMs?: number) {
		super(message);
	}
}

/** The endpoint rejected the websocket upgrade with an HTTP error. */
export class VncEndpointError extends VncError {
	constructor(readonly statusCode: number) {
		super(`VNC endpoint returned HTTP ${statusCode}`);
	}
}
