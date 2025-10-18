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
import { createRegionTransport, createGlobalTransport } from "../src/api/clients.js";
import type { TokenSource } from "../src/auth/types.js";
import { Timestamp } from "@bufbuild/protobuf";

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
		deadline: Timestamp.now(),
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
	const { CreateInstanceRequest } = await import("../src/proto/namespace/cloud/compute/v1beta/compute_pb.js");
	const { TenantService } = await import("../src/proto/namespace/cloud/iam/v1beta/tenants_connect.js");

	// Should be able to create instances
	const request = new CreateInstanceRequest({
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
	testTransports,
	testProtoImports,
};
