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

Each function returns a `TokenSource` (or a promise of one). Call and await
them to load eagerly, or pass them uncalled wherever a token source is
accepted (e.g. `tokenSource: loadUserToken`) — the SDK invokes and awaits them
internally on first use, in the same style as AWS SDK credential providers.

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

## Devboxes

The Devbox client exposes product-level resources for devboxes, blueprints, and images. A created or fetched devbox is an operational handle: starting it, establishing authenticated connections, and reusing those connections happen automatically.

```typescript
import { createDevboxClient } from "@namespacelabs/sdk";
// Also available from the subpath: "@namespacelabs/sdk/devbox".

// With no options, authentication defaults to the workload token when
// running in a Namespace workload, falling back to the local user token.
const client = createDevboxClient();

// Or pass an explicit token source (invoked and awaited internally
// on first use):
//   createDevboxClient({ tokenSource: loadUserToken })

const blueprint = await client.blueprints.create("typescript", {
	image: "node:22",
	size: "m",
	environment: { NODE_ENV: "development" },
});

const devbox = await client.devboxes.create({
	name: "my-devbox",
	blueprint: blueprint.name,
});

// Structured argv: arguments are passed literally and do not expand in a shell.
const result = await devbox.exec(["node", "--version"]);

// Shell syntax, without allocating a TTY.
await devbox.shell("npm install && npm test", {
	cwd: "/workspace",
});

// Commands run through the devbox agent, which retains each command and its
// output for later inspection (`devbox logs`). Relative `cwd` paths resolve
// against the devbox workspace directory. When `cwd` is omitted, commands run
// in the devbox default directory; if the devbox checks out a repository, that
// directory only exists once the checkout completes, so pass an explicit `cwd`
// when running commands immediately after creation.

await devbox.fs.upload("./package.json", "/workspace/package.json");
await devbox.fs.download("/workspace/results.json", "./results.json");
await devbox.fs.copy("/workspace/results.json", "/workspace/results-copy.json");

// PTY sessions are explicit and separate from shell execution.
const terminal = await devbox.terminal.open({ columns: 120, rows: 40 });
terminal.onData((data) => process.stdout.write(data));
terminal.write("pwd\n");

terminal.close();
client.close();
```

`upload()` and `download()` transfer one file. `copy()` operates inside the devbox and accepts `{ recursive: true }` for directories. All operations accept `AbortSignal` and timeout options.

Devboxes with a graphical display — macOS devboxes — expose screen access through `devbox.display`, backed by VNC. Methods reject with `DevboxDisplayUnavailableError` when the devbox has no display (for example, Linux devboxes):

```typescript
import { writeFile } from "node:fs/promises";
import { DevboxDisplayUnavailableError } from "@namespacelabs/sdk";

const macosBlueprint = await client.blueprints.create("macos", {
	os: "macos",
	size: "m",
	selectors: [
		{ name: "macos.version", value: "26.x" },
		{ name: "image.with", value: "xcode-26" },
	],
});

const macos = await client.devboxes.create({
	name: "my-mac",
	os: "macos",
	size: "m",
	selectors: [
		{ name: "macos.version", value: "26.x" },
		{ name: "image.with", value: "xcode-26" },
	],
	repository: "https://github.com/namespacelabs/typescript-sdk",
});

try {
	const screenshot = await macos.display.screenshot();
	await writeFile("screen.png", screenshot.png);

	// Click at framebuffer coordinates (origin top-left).
	await macos.display.click(100, 200);
	await macos.display.click(100, 200, { button: "right" });
} catch (error) {
	if (error instanceof DevboxDisplayUnavailableError) {
		// This devbox has no display.
	}
	throw error;
}
```

Like other connection-backed operations, using `devbox.display` on a stopped devbox activates it first, and the underlying VNC session is cached and reused across calls.

The VNC client behind `devbox.display` is also available standalone as `@namespacelabs/sdk/vnc` (`openVnc`): a minimal RFB 3.8 client over websockets with Apple Remote Desktop authentication, raw encoding, and PNG screenshots — no native dependencies and no Namespace-specific behavior.

Images can be registered from an existing image reference, listed, inspected, optimized for a site, and deleted:

```typescript
const image = await client.images.register({
	name: "node-22",
	ref: "node:22",
});

// Image optimization defaults to iad when no site is specified.
await client.images.optimize(image.name);
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
- **Devboxes** (`@namespacelabs/sdk/devbox`) - Devboxes, blueprints, and images

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

- `@namespacelabs/sdk` - Main entry point (re-exports auth, API clients, and Devboxes)
- `@namespacelabs/sdk/auth` - Authentication module only
- `@namespacelabs/sdk/api` - API client utilities only
- `@namespacelabs/sdk/devbox` - Devbox product API

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
