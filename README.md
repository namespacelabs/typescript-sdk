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

const text = await devbox.fs.read("/var/log/app.log");
const bytes = await devbox.fs.read("/var/log/app.log", {
	format: "bytes",
	offset: 1024,
	length: 64 * 1024,
});
const stream = await devbox.fs.read("/data/output.bin", { format: "stream" });
for await (const chunk of stream) process.stdout.write(chunk);

// PTY sessions are explicit and separate from shell execution.
const terminal = await devbox.terminal.open({ columns: 120, rows: 40 });
terminal.onData((data) => process.stdout.write(data));
terminal.write("pwd\n");

terminal.close();
client.close();
```

### Asynchronous execution

`devbox.executions.start()` and `devbox.executions.startShell()` return an execution handle as soon as the
agent accepts the command, without waiting for it to exit. Unlike foreground
`exec()`/`shell()`, these commands continue when the client disconnects.

```typescript
const client = createDevboxClient({ connectionTimeoutMs: 90_000 });
const devbox = await client.devboxes.get("my-devbox");
const execution = await devbox.executions.start(["bash", "-lc", "sleep 3; echo done"], {
	cwd: "/tmp",
	env: { CI: "true" },
	timeoutMs: 10_000,
});
const id = execution.id; // Save this together with the devbox ID.
client.close();

const otherClient = createDevboxClient();
const sameDevbox = await otherClient.devboxes.get(devbox.id);
const reattached = await sameDevbox.executions.get(id);
const status = await reattached.status(); // running | completed | missing
const result = await reattached.wait({ timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 });
console.log(result.exitCode, result.stdout, result.stderr, result.error);

// Discover retained commands, including commands started by other clients:
const executions = await sameDevbox.executions.list();
for (const entry of executions) console.log(entry.id, await entry.status());

// Alternatively, consume retained and live bytes without collecting output:
for await (const chunk of reattached.logs({ timeoutMs: 30_000 })) {
	process.stdout.write(chunk.stdout);
	process.stderr.write(chunk.stderr);
	if (chunk.result) console.log("exit", chunk.result.exitCode, chunk.result.error);
}
otherClient.close();
```

- `executions.startShell(script, options)` uses the devbox's configured shell, with an
  optional `shell` override. Start options support `cwd`, `env`, and initial
  `stdin` (string or bytes), just like foreground execution. Output callbacks
  `onStdout` and `onStderr` belong on `wait()`, not on the start call.
- Only `completed` status has an exit code and completion time. An exit code
  of zero in agent metadata does not imply completion. Nonzero exits and
  command-start failures resolve normally with `exitCode` and optional `error`.
- `executions.get()` rejects with `ExecutionNotFoundError` for an absent ID;
  an existing handle's `status()` returns `missing` if it is no longer retained.
  `stop()`, `logs()`, and `wait()` reject with `ExecutionNotFoundError` for missing executions.
  Transport/authentication failures reject, never masquerade as `missing`.
- `executions.list()` returns handles for all command executions retained by the
  current agent, running and completed, sorted by start time. Boot operations are
  excluded. There is no pagination or durable history. A listed execution may be
  evicted before its status or logs are read. Connection failures reject rather
  than returning an empty list.
- Each `wait()`/`logs()` call has its own reader, including concurrent calls.
  Every reader replays from the beginning of retained output, then follows live
  output until a final result. Repeated waits invoke callbacks again; nothing
  is cached in the handle. Streams do not automatically reconnect. There is no
  cursor, so reopening after a failure may duplicate output: exactly-once
  delivery across reconnects is not guaranteed. Decode UTF-8 incrementally when
  consuming byte chunks, since a character can span chunks.
- `wait()` captures at most 10 MiB of combined stdout/stderr by default. Set a
  finite, non-negative integer `maxOutputBytes` to change the limit. Exceeding
  it rejects with `ExecutionOutputLimitError`; use `logs()` for large output.
  Streaming does not collect output and applies transport backpressure.
- Client `connectionTimeoutMs` bounds connection establishment. Start-call
  `timeoutMs` covers connection acquisition plus the start RPC, not command
  runtime. `wait()`/`logs()` `timeoutMs` starts after connection acquisition;
  their signal also cancels acquisition. `status()`, `executions.get()`, and
  `executions.list()`, as well as `stop()`, use one operation timeout including acquisition. Start
  options never carry over to later reads. Read timeouts reject with `DevboxTimeoutError`.
- Aborting, timing out, breaking iteration, exceeding the output limit, or
  closing a client only stops reading an asynchronous execution. **None of
  these operations kills the remote command.** If StartExec fails after being
  sent, the command may already exist. The SDK never retries it automatically;
  blindly retrying may launch a duplicate.
- Execution IDs are agent-local, and log retention is not indefinite. Do not
  rely on IDs or output surviving VM replacement. Looking up an execution is
  connection-backed and may activate a stopped devbox, but cannot restore an
  execution lost with its previous agent.

To terminate an execution, `stop()` defaults to graceful termination:

```ts
await execution.stop(); // Send SIGTERM; equivalent to { mode: "graceful" }.
// If needed, a separate request escalates to SIGKILL:
await execution.stop({ mode: "force", timeoutMs: 5_000 });
const result = await execution.wait({ timeoutMs: 10_000 });
```

`stop()` acknowledges the request, not completion; `status()`, `logs()`, or `wait()`
provide the final result. Graceful stop allows cleanup and never escalates
automatically. Forced stop sends SIGKILL without cleanup. Repeating the same or
weaker mode, or stopping an already completed execution, is a no-op. Cleanup can
exit successfully or with its own nonzero code. Signal termination reports exit
code `-1` and agent error detail; `ExecResult.signal` remains `null` because the
protocol does not provide a structured signal field.

Stop targets the original process group only until its leader exits; detached or
surviving descendants are not managed. Canceling or timing out the stop RPC does
not undo a request already accepted by the agent. The SDK does not retry it
automatically. Agents without `StopExec` reject with `ConnectError` code
`Unimplemented`; there is no shell-based fallback. Arbitrary signals, incremental
stdin, and stdin-close still require backend changes.

Run the opt-in integration tests against an authenticated Linux devbox with
`bash`, `cat`, `head`, `ps`, and `sleep` installed (no devbox is created or deleted):

```sh
SDK_TEST_DEVBOX=my-devbox npm run test:devbox
```

### Checkout configuration

For direct creation (without a blueprint), omit `versionControl` and `repository`
to inherit the tenant's default repository configuration. Pass `versionControl`
to explicitly configure checkout; an empty object disables checkout entirely.

To create a scratch devbox without checking out any repository:

```typescript
const scratch = await client.devboxes.create({
	name: "scratch",
	imageName: "builtin:base",
	versionControl: {},
});

const checkout = await client.devboxes.create({
	name: "checkout",
	versionControl: {
		gitRepository: "https://github.com/namespacelabs/typescript-sdk",
		ref: "main", // Optional branch, tag, or commit SHA; defaults to the default branch.
	},
});
```

The existing top-level `repository` option remains supported. Setting it to a
repository URL checks out that repository; an empty string inherits defaults
and does **not** disable checkout. `repository` and `versionControl` cannot be
combined, even when either is empty. Neither can be used with a blueprint.
Invalid combinations are rejected by TypeScript and throw `TypeError` before
any RPC.

`upload()` and `download()` transfer one file. `copy()` operates inside the
devbox and accepts `{ recursive: true }` for directories. `read()` returns
UTF-8 text by default; pass `format: "bytes"` for a `Uint8Array` or
`format: "stream"` for a `ReadableStream`. Its `offset` and `length` options
are byte-based. The existing `readFile()` returns the complete file as a
`Uint8Array`. All operations accept `AbortSignal` and timeout options.

Devboxes with a graphical display — macOS devboxes — expose screen access through `devbox.display`, backed by VNC. Methods reject with `DevboxDisplayUnavailableError` when the devbox has no display (for example, Linux devboxes):

```typescript
import { writeFile } from "node:fs/promises";
import { DevboxDisplayUnavailableError } from "@namespacelabs/sdk";

const macos = await client.devboxes.create({
	name: "my-mac",
	os: "macos",
	size: "m",
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

### Creating a macOS Instance

The [macOS instance example](examples/compute/create-macos-instance.ts) uses the Compute API to create a macOS Tahoe instance on Apple Silicon with 6 vCPUs and 14 GiB RAM, waits for it to be ready, and runs `uname -a` in the guest. It prints stdout and stderr and exits with the command's exit code.

Run it from a checkout of this repository with Node.js 22:

```bash
npm ci
npm run build
nsc login
npx tsx examples/compute/create-macos-instance.ts
```

`createComputeClient()` defaults to the US region and loads authentication lazily using `loadDefaults()`: a workload token inside Namespace, or your local user token from `nsc login`. You can also set `NSC_TOKEN_FILE` to a token file. Your workspace must have macOS capacity available.

The example creates a real, billable instance in the US region and leaves it running for inspection. It prints the instance URL and an `nsc destroy <instance-id>` command; a 30-minute deadline limits its lifetime even if the script fails while waiting. To select another macOS version, change the `macos.version` shape selector using the [available selectors](https://namespace.so/docs/architecture/compute/macos#available-selectors).

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
