# Namespace TypeScript SDK

TypeScript/JavaScript SDK for Namespace Cloud APIs, providing authentication, client management, and type-safe API access.

## Features

- **Modular Authentication**: Multiple token loading strategies (user tokens, workload tokens, environment-based)
- **Token Management**: Automatic token caching and refresh
- **Type Safety**: Full TypeScript support with generated types
- **Dual Module Support**: Works with both ESM and CommonJS
- **Flexible Client Creation**: Support for both bearer tokens and TokenSource instances

## Installation

```bash
npm install @namespacelabs/sdk @connectrpc/connect @connectrpc/connect-node @bufbuild/protobuf
```

## Quick Start

### Basic Authentication

```typescript
import { loadUserToken } from "@namespacelabs/sdk/auth";
import { createRegionTransport, createClient } from "@namespacelabs/sdk/api";

// Load token from user configuration
const tokenSource = await loadUserToken();

// Create transport with token source
const transport = createRegionTransport("us", { tokenSource });

// Use with your service clients...
```

### Using Bearer Tokens

```typescript
import { bearerAuthInterceptor } from "@namespacelabs/sdk/api";

const transport = createRegionTransport("us", {
	token: "your-bearer-token",
});
```

## Authentication

The SDK provides multiple ways to load authentication tokens, following patterns from the Go SDK:

### Token Loading Functions

#### `loadDefaults()`

Automatically detects and loads the appropriate token based on context:

1. Checks `NSC_TOKEN_FILE` environment variable
2. Tries `/var/run/nsc/token.json` (workload token)
3. Falls back to user token from config directory

```typescript
import { loadDefaults } from "@namespacelabs/sdk/auth";

const tokenSource = await loadDefaults();
const token = await tokenSource.issueToken(5 * 60 * 1000); // 5 minutes
```

#### `loadUserToken()`

Loads token from user's local configuration:

- **macOS**: `~/Library/Application Support/ns/token.json`
- **Linux**: `~/.config/ns/token.json`
- **Windows**: `%APPDATA%/ns/token.json`

```typescript
import { loadUserToken } from "@namespacelabs/sdk/auth";

const tokenSource = await loadUserToken();
```

#### `loadWorkloadToken()`

Loads token from workload environment:

- Checks `NSC_TOKEN_FILE` environment variable
- Falls back to `/var/run/nsc/token.json`

```typescript
import { loadWorkloadToken } from "@namespacelabs/sdk/auth";

const tokenSource = await loadWorkloadToken();
```

#### `fromBearerToken(token)`

Creates a TokenSource from a bearer token string:

```typescript
import { fromBearerToken } from "@namespacelabs/sdk/auth";

const tokenSource = fromBearerToken("nsct_...");
```

### Token Source Interface

All token loading functions return a `TokenSource` that implements:

```typescript
interface TokenSource {
	issueToken(minDuration: number, force?: boolean): Promise<string>;
}
```

- `minDuration`: Minimum duration (in milliseconds) the token should be valid
- `force`: Force token refresh even if cached token is valid

### Token Caching

The SDK automatically caches tokens to minimize token refresh requests:

- Cached tokens are stored in `token.cache` next to the source token file
- Cache is validated against tenant ID and expiration time
- Cache files are created with secure permissions (0600)

### Token Claims

Extract and validate JWT token claims:

```typescript
import { extractClaims, isTokenExpired, getTenantId } from "@namespacelabs/sdk/auth";

const claims = extractClaims(token);
console.log(claims.tenant_id);

const expired = isTokenExpired(claims);
const tenantId = getTenantId(token);
```

## API Clients

The SDK provides high-level client factories for each Namespace Cloud API:

### Available APIs

- **Compute** (`@namespacelabs/sdk/api/compute`) - Instance management, regional
- **IAM** (`@namespacelabs/sdk/api/iam`) - Tenant and token management, global
- **Builds** (`@namespacelabs/sdk/api/builds`) - Container image builds, regional
- **Storage** (`@namespacelabs/sdk/api/storage`) - Artifact storage, regional
- **Registry** (`@namespacelabs/sdk/api/registry`) - Container registry, global
- **Vault** (`@namespacelabs/sdk/api/vault`) - Secrets management, regional

### Using API Clients

Each API provides a client factory function:

```typescript
import { loadUserToken } from "@namespacelabs/sdk/auth";
import { createComputeClient } from "@namespacelabs/sdk/api/compute";
import { createIAMClient } from "@namespacelabs/sdk/api/iam";

const tokenSource = await loadUserToken();

// Create a compute client for US region
const computeClient = createComputeClient({
	region: "us",
	tokenSource,
});

// Use the client
const instances = await computeClient.compute.listInstances({
	tenantId: "your-tenant-id",
});

// Create an IAM client (global)
const iamClient = createIAMClient({ tokenSource });

// Use the IAM client
const tenants = await iamClient.tenants.listTenants({});
```

### Creating Transports

The SDK provides transport creation utilities for different API endpoints:

#### Regional Transport

For regional APIs (Compute, Builds, Storage, Vault):

```typescript
import { createRegionTransport } from "@namespacelabs/sdk/api";

// With token source
const transport = createRegionTransport("us", {
	tokenSource: await loadUserToken(),
});

// With custom base URL
const transport = createRegionTransport("us", {
	tokenSource,
	baseUrl: "https://custom.api.endpoint.com",
});
```

#### Global Transport

For global APIs (IAM, Registry):

```typescript
import { createGlobalTransport } from "@namespacelabs/sdk/api";

const transport = createGlobalTransport({
	tokenSource: await loadUserToken(),
});
```

### Interceptors

The SDK provides an interceptor for adding authentication to requests:

#### `bearerAuthInterceptor(tokenSource, minDuration?)`

Dynamically fetches tokens for each request from a TokenSource:

```typescript
import { bearerAuthInterceptor } from "@namespacelabs/sdk/api";
import { loadUserToken } from "@namespacelabs/sdk/auth";
import { createConnectTransport } from "@connectrpc/connect-node";

const tokenSource = await loadUserToken();

const transport = createConnectTransport({
	baseUrl: "https://api.example.com",
	interceptors: [
		bearerAuthInterceptor(tokenSource, 5 * 60 * 1000), // 5 minutes
	],
});
```

The interceptor automatically refreshes tokens as needed based on the `minDuration` parameter (default: 5 minutes).

## Project Structure

```
typescript-sdk/
├── src/
│   ├── auth/              # Authentication module
│   │   ├── types.ts       # Core types and interfaces
│   │   ├── claims.ts      # JWT claims extraction
│   │   ├── token.ts       # Token loading and management
│   │   └── index.ts       # Module exports
│   ├── api/               # API client module
│   │   ├── clients.ts     # Transport creation utilities
│   │   ├── interceptors.ts # Auth interceptors
│   │   └── index.ts       # Module exports
│   └── index.ts           # Main SDK export
├── dist/                  # Compiled output (CJS, ESM, types)
├── examples/              # Example usage
├── package.json
├── tsconfig.json
└── README.md
```

## Module Exports

The SDK provides multiple export paths:

- `@namespacelabs/sdk` - Main entry point (re-exports auth and api)
- `@namespacelabs/sdk/auth` - Authentication module only
- `@namespacelabs/sdk/api` - API client utilities only

Each export path supports both ESM and CommonJS:

```typescript
// ESM
import { loadUserToken } from "@namespacelabs/sdk/auth";

// CommonJS
const { loadUserToken } = require("@namespacelabs/sdk/auth");
```

## Environment Variables

- `NSC_TOKEN_FILE` - Override default token file location
- `XDG_CONFIG_HOME` - Linux config directory (defaults to `~/.config`)
- `APPDATA` - Windows config directory

## Error Handling

The SDK provides specific error types:

```typescript
import { NotLoggedInError } from "@namespacelabs/sdk/auth";

try {
	const tokenSource = await loadUserToken();
} catch (error) {
	if (error instanceof NotLoggedInError) {
		console.error("Please run `nsc login` first");
	}
}
```

## TypeScript Support

The SDK is written in TypeScript and provides full type definitions:

```typescript
import type { TokenSource, TokenClaims, CachedToken } from "@namespacelabs/sdk/auth";
import type { CreateRegionTransportOpts, CreateClientOpts } from "@namespacelabs/sdk/api";
```

## Development

### Building

```bash
npm run build
```

This generates:
- CommonJS output in `dist/cjs/`
- ES Module output in `dist/esm/`
- Type declarations in `dist/types/`

### Clean

```bash
npm run clean
```

## Comparison with Go SDK

This TypeScript SDK follows similar patterns to the Go `integrations/auth` package:

| Go SDK | TypeScript SDK |
|--------|----------------|
| `auth.LoadDefaults()` | `loadDefaults()` |
| `auth.LoadUserToken()` | `loadUserToken()` |
| `auth.LoadWorkloadToken()` | `loadWorkloadToken()` |
| `api.TokenSource` | `TokenSource` interface |
| `auth.ExtractClaims()` | `extractClaims()` |
| Bearer token via gRPC metadata | Bearer token via HTTP Authorization header |

## License

Apache-2.0

## Contributing

Contributions are welcome! Please open issues or pull requests on GitHub.

## Links

- [GitHub Repository](https://github.com/namespacelabs/typescript-sdk)
- [Namespace Documentation](https://namespace.so/docs)
- [NPM Package](https://www.npmjs.com/package/@namespacelabs/sdk)
