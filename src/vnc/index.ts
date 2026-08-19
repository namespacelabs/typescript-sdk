/**
 * Minimal VNC (RFB 3.8) client over websockets.
 *
 * Speaks just enough RFB to capture raw-encoded framebuffer screenshots and
 * inject pointer events: version and security handshake with Apple Remote
 * Desktop authentication (security type 30) or no security, raw encoding
 * only, and client-side PNG encoding — no native dependencies.
 *
 * This module has no Namespace-specific behavior; `devbox.desktop` builds on
 * it. Import as `@namespacelabs/sdk/vnc`.
 */
export {
	openVnc,
	VncClient,
	type ClickOptions,
	type OpenVncOptions,
	type OperationOptions,
	type PointerButton,
	type Screenshot,
} from "./client.js";
export { VncEndpointError, VncError, VncTimeoutError } from "./errors.js";
