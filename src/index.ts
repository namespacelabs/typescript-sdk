/**
 * Namespace TypeScript SDK
 *
 * This SDK provides TypeScript/JavaScript bindings for Namespace Cloud APIs
 * with authentication, client management, and type-safe API calls.
 */

// Re-export authentication module
export * from "./auth/index.js";

// Re-export API module
export * from "./api/index.js";

// Note: Proto types are available via '@namespacelabs/sdk/proto' import
// They are not re-exported from the main module to avoid naming conflicts
