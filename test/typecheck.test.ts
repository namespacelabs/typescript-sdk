/**
 * TypeScript type checking tests
 *
 * This file ensures that the SDK types work correctly and provides
 * good type inference and checking. Run with: npm run test:typecheck
 */

import { loadDefaults, loadUserToken, loadWorkloadToken, fromBearerToken } from "../src/auth/index.js";
import { createComputeClient } from "../src/api/compute/index.js";
import { createIAMClient } from "../src/api/iam/index.js";
import { createBuildsClient } from "../src/api/builds/index.js";
import { createStorageClient } from "../src/api/storage/index.js";
import { createRegistryClient } from "../src/api/registry/index.js";
import { createVaultClient } from "../src/api/vault/index.js";
import { createDevboxClient, type Devbox } from "../src/devbox/index.js";
import * as devboxPublicApi from "../src/devbox/index.js";
import * as sdkPublicApi from "../src/index.js";
import { createRegionTransport, createGlobalTransport } from "../src/api/clients.js";
import type { TokenSource } from "../src/auth/types.js";
import { create } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";

// Test: Authentication token loading
async function testAuthTokenLoading() {
	// Should return TokenSource
	const defaults: TokenSource = await loadDefaults();
	const userToken: TokenSource = await loadUserToken();
	const workloadToken: TokenSource = await loadWorkloadToken();
	const bearerToken: TokenSource = fromBearerToken("test-token");

	// Should have issueToken method
	const token1: string = await defaults.issueToken(5 * 60 * 1000);
	const token2: string = await userToken.issueToken(5 * 60 * 1000, true);
}

// Test: Compute client types
async function testComputeClient() {
	const tokenSource = fromBearerToken("test");

	// Should accept region and tokenSource
	const client = createComputeClient({
		region: "us",
		tokenSource,
	});

	// Should have all compute services
	const compute = client.compute;
	const storage = client.storage;
	const usage = client.usage;
	const observability = client.observability;
	const management = client.management;

	// Should accept proper request types
	const createResponse = await compute.createInstance({
		shape: {
			virtualCpu: 2,
			memoryMegabytes: 4096,
			machineArch: "amd64",
		},
		documentedPurpose: "test",
		deadline: timestampNow(),
		containers: [{
			name: "test",
			imageRef: "nginx",
		}],
	});

	// Response should have proper types
	const instanceId: string | undefined = createResponse.metadata?.instanceId;
	const instanceUrl: string = createResponse.instanceUrl;
}

// Test: IAM client types
async function testIAMClient() {
	const tokenSource = fromBearerToken("test");

	// Should only require tokenSource (no region)
	const client = createIAMClient({ tokenSource });

	// Should have tenant and token services
	const tenants = client.tenants;
	const tokens = client.tokens;

	// Should accept proper request types
	const tenantsResponse = await tenants.listTenants({});
	const tokensResponse = await tokens.issueTenantToken({
		tenantId: "test-tenant",
	});
}

// Test: Registry client types
async function testRegistryClient() {
	const tokenSource = fromBearerToken("test");

	// Should only require tokenSource (no region - global API)
	const client = createRegistryClient({ tokenSource });

	// Should have registry service
	const registry = client.registry;

	// Should accept proper request types
	const response = await registry.listRepositories({});
}

// Test: Builds client types
async function testBuildsClient() {
	const tokenSource = fromBearerToken("test");

	// Should accept region and tokenSource
	const client = createBuildsClient({
		region: "us",
		tokenSource,
	});

	// Should have builder service
	const builder = client.builder;

	// Should accept proper request types
	const response = await builder.listBuilds({
		maxEntries: 10n,
	});
}

// Test: Storage client types
async function testStorageClient() {
	const tokenSource = fromBearerToken("test");

	// Should accept region and tokenSource
	const client = createStorageClient({
		region: "us",
		tokenSource,
	});

	// Should have artifacts service
	const artifacts = client.artifacts;
}

// Test: Vault client types
async function testVaultClient() {
	const tokenSource = fromBearerToken("test");

	// Should accept region and tokenSource
	const client = createVaultClient({
		region: "us",
		tokenSource,
	});

	// Should have vault service
	const vault = client.vault;
}

// Test: Devbox client and operational handle types
async function testDevboxClient() {
	const client = createDevboxClient({ tokenSource: fromBearerToken("test") });
	// Token sources may be passed as provider functions, invoked and awaited internally.
	createDevboxClient({ tokenSource: loadUserToken }).close();
	// Works without arguments: defaults to loadDefaults (workload
	// token, falling back to the user token), resolved lazily on first use.
	createDevboxClient().close();
	const blueprint = await client.blueprints.create("typescript", {
		image: "node:22",
		size: "m",
		environment: { NODE_ENV: "development" },
	});
	const directDevbox = await client.devboxes.create({
		name: "direct-sdk-test",
		image: "node:22",
		size: "s",
		labels: { environment: "test", team: "sdk" },
	});
	const labels: Record<string, string> = directDevbox.info.labels;
	await client.devboxes.create({
		name: "named-image-sdk-test",
		imageName: "builtin:agents",
	});
	await client.devboxes.create({ name: "scratch-sdk-test", versionControl: {} });
	await client.devboxes.create({ name: "repository-sdk-test", repository: "https://github.com/namespacelabs/typescript-sdk" });
	await client.devboxes.create({
		name: "checkout-sdk-test",
		versionControl: { gitRepository: "https://github.com/namespacelabs/typescript-sdk", ref: "main" },
	});
	const devbox: Devbox = await client.devboxes.create({
		name: "sdk-test",
		blueprint: blueprint.name,
	});

	const execResult = await devbox.exec(["node", "--version"], {
		cwd: "/workspace",
		env: { CI: "true" },
	});
	const shellResult = await devbox.shell(`printf '%s\\n' "$HOME"`);
	const executions: devboxPublicApi.DevboxExecutions = devbox.executions;
	const execution: devboxPublicApi.DevboxExecution = await executions.start(["cat"], {
		cwd: "/tmp", env: { CI: "true" }, stdin: new Uint8Array([65]), timeoutMs: 5_000,
	});
	const shellExecution: sdkPublicApi.DevboxExecution = await devbox.executions.startShell("echo hello", { shell: "/bin/bash" });
	const reattached = await devbox.executions.get(execution.id);
	const stopOptions: devboxPublicApi.ExecutionStopOptions = {
		mode: "graceful", timeoutMs: 5_000, signal: new AbortController().signal,
	};
	const stopped: void = await reattached.stop(stopOptions);
	const forceOptions: sdkPublicApi.ExecutionStopOptions = { mode: "force" };
	await reattached.stop(forceOptions);
	await execution.stop();
	await execution.stop({});
	const defaultStopOptions: devboxPublicApi.ExecutionStopOptions = { timeoutMs: 5_000 };
	await execution.stop(defaultStopOptions);
	// @ts-expect-error Arbitrary signals are not supported.
	await execution.stop({ mode: "SIGINT" });
	const listed: sdkPublicApi.DevboxExecution[] = await devbox.executions.list({
		timeoutMs: 5_000, signal: new AbortController().signal,
	});
	for (const entry of listed) {
		const entryStatus: devboxPublicApi.ExecutionStatus = await entry.status();
		const entryResult: devboxPublicApi.ExecResult = await entry.wait();
	}
	const status: devboxPublicApi.ExecutionStatus = await reattached.status();
	if (status.state === "completed") {
		const exitCode: number = status.exitCode;
		const completedAt: Date = status.completedAt;
	} else {
		// @ts-expect-error Only completed executions have an exit code.
		status.exitCode;
	}
	const waited: devboxPublicApi.ExecResult = await reattached.wait({
		timeoutMs: 10_000, maxOutputBytes: 1024, signal: new AbortController().signal,
		onStdout: (data: Uint8Array) => data.byteLength,
		onStderr: (data: Uint8Array) => data.byteLength,
	});
	for await (const chunk of shellExecution.logs()) {
		const output: Uint8Array = chunk.stdout;
		const errorOutput: Uint8Array = chunk.stderr;
		const code: number | undefined = chunk.result?.exitCode;
	}
	// @ts-expect-error Output callbacks belong to wait, not the start RPC.
	await devbox.executions.start(["true"], { onStdout: () => {} });
	// @ts-expect-error Asynchronous execution is grouped under executions.
	devbox.startExec;
	// @ts-expect-error Asynchronous shell execution is grouped under executions.
	devbox.startShell;
	// @ts-expect-error Execution lookup is grouped under executions.
	devbox.getExecution;
	// @ts-expect-error Forced termination uses stop({ mode: "force" }).
	execution.kill();
	// @ts-expect-error There is no incremental stdin RPC.
	execution.write("hello");
	const terminal = await devbox.terminal.open({ columns: 120, rows: 40 });
	terminal.write("pwd\n");
	terminal.resize(160, 50);
	const removeDataListener = terminal.onData((data) => data.byteLength);
	removeDataListener();
	terminal.close();

	const screenshot = await devbox.display.screenshot({ timeoutMs: 30_000 });
	const png: Uint8Array = screenshot.png;
	const dimensions: number = screenshot.width * screenshot.height;
	await devbox.display.click(100, 200);
	await devbox.display.click(100, 200, { button: "right" });

	await devbox.fs.upload("./package.json", "/workspace/package.json");
	await devbox.fs.download("/workspace/result.json", "./result.json");
	await devbox.fs.copy("/workspace/result.json", "/workspace/result-copy.json");
	await devbox.fs.writeFile("/workspace/message.txt", "hello");
	const contents: Uint8Array = await devbox.fs.readFile("/workspace/message.txt");
	const text: string = await devbox.fs.read("/workspace/message.txt");
	const bytes: Uint8Array = await devbox.fs.read("/workspace/message.txt", {
		format: "bytes",
		offset: 10,
		length: 100,
	});
	const stream: ReadableStream<Uint8Array> = await devbox.fs.read("/workspace/message.txt", {
		format: "stream",
		offset: 10,
	});
	// @ts-expect-error A dynamic format has no single return type overload.
	await devbox.fs.read("/workspace/message.txt", { format: "json" });

	const images = await client.images.list({ includeBuiltin: true });
	const image = await client.images.register({ ref: "node:22", name: "node-22" });
	const inspection = await client.images.inspect(image.ref);
	await client.images.optimize(image.name);
	await client.images.optimize(image.name, { site: "custom-site" });

	// @ts-expect-error Blueprint creation does not accept inline image overrides.
	client.devboxes.create({ name: "invalid", blueprint: "typescript", image: "node:22" });
	// @ts-expect-error Blueprint creation does not accept named image overrides.
	client.devboxes.create({ name: "invalid", blueprint: "typescript", imageName: "builtin:agents" });
	// @ts-expect-error image and imageName are mutually exclusive.
	client.devboxes.create({ name: "invalid", image: "node:22", imageName: "builtin:agents" });
	// @ts-expect-error Blueprint creation does not accept inline size overrides.
	client.devboxes.create({ name: "invalid", blueprint: "typescript", size: "s" });
	// @ts-expect-error repository and versionControl are mutually exclusive.
	client.devboxes.create({ name: "invalid", repository: "https://github.com/namespacelabs/typescript-sdk", versionControl: {} });
	// @ts-expect-error Even an empty repository cannot be combined with versionControl.
	client.devboxes.create({ name: "invalid", repository: "", versionControl: {} });
	// @ts-expect-error A populated versionControl cannot be combined with repository either.
	client.devboxes.create({ name: "invalid", repository: "https://github.com/namespacelabs/typescript-sdk", versionControl: { gitRepository: "https://github.com/namespacelabs/typescript-sdk" } });
	// @ts-expect-error Blueprint creation does not accept checkout overrides.
	client.devboxes.create({ name: "invalid", blueprint: "typescript", versionControl: {} });
	// Machine sizes are open strings so the backend can add names; unknown
	// names typecheck for creation and are rejected server-side.
	client.devboxes.create({ name: "future-size", image: "node:22", size: "xxl" });
	// @ts-expect-error Product APIs expose blueprints, not templates.
	client.templates;
	// @ts-expect-error Generated services are internal implementation details.
	devboxPublicApi.DevBoxService;
	// @ts-expect-error Generated schemas are not re-exported by the root SDK.
	sdkPublicApi.CreateRequestSchema;
	client.close();
}

// Test: Standalone VNC library
async function testVncLibrary() {
	const { openVnc, VncClient, VncError, VncTimeoutError, VncEndpointError } = await import("../src/vnc/index.js");

	const vnc = await openVnc({
		endpoint: "wss://vnc.example.com",
		username: "user",
		password: "secret",
		headers: { Authorization: "Bearer token" },
		timeoutMs: 30_000,
	});
	const client: InstanceType<typeof VncClient> = vnc;
	const screenshot = await client.screenshot({ timeoutMs: 10_000 });
	const png: Uint8Array = screenshot.png;
	const dimensions: number = screenshot.width * screenshot.height;
	const name: string = client.desktopName;
	await client.click(10, 20, { button: "middle" });
	client.close();

	// Errors form a hierarchy rooted at VncError.
	const timeout: InstanceType<typeof VncError> = new VncTimeoutError("timed out", 1000);
	const endpoint: InstanceType<typeof VncError> = new VncEndpointError(502);
}

// Test: Transport creation
async function testTransports() {
	const tokenSource = fromBearerToken("test");

	// Regional transport should require region
	const regionalTransport = createRegionTransport("us", { tokenSource });

	// Global transport should not require region
	const globalTransport = createGlobalTransport({ tokenSource });

	// Should accept custom baseUrl
	const customRegional = createRegionTransport("us", {
		tokenSource,
		baseUrl: "https://custom.example.com",
	});

	const customGlobal = createGlobalTransport({
		tokenSource,
		baseUrl: "https://custom.example.com",
	});
}

// Test: Proto imports
async function testProtoImports() {
	// Should be able to import proto types directly
	const { CreateInstanceRequestSchema } = await import("../src/proto/namespace/cloud/compute/v1beta/compute_pb.js");
	const { TenantService } = await import("../src/proto/namespace/cloud/iam/v1beta/tenants_pb.js");

	// Should be able to create instances using create()
	const request = create(CreateInstanceRequestSchema, {
		shape: {
			virtualCpu: 2,
			memoryMegabytes: 4096,
		},
	});
}

// Export for visibility (these won't actually run)
export {
	testAuthTokenLoading,
	testComputeClient,
	testIAMClient,
	testRegistryClient,
	testBuildsClient,
	testStorageClient,
	testVaultClient,
	testDevboxClient,
	testVncLibrary,
	testTransports,
	testProtoImports,
};
