/**
 * Destroy a test instance
 */

import { loadDefaults } from "../src/auth/index.js";
import { createComputeClient } from "../src/api/compute/index.js";

const instanceId = process.argv[2];

if (!instanceId) {
	console.error("Usage: tsx test/destroy-instance.ts <instance-id>");
	process.exit(1);
}

async function main() {
	const tokenSource = await loadDefaults();
	const computeClient = createComputeClient({
		region: "us",
		tokenSource,
	});

	console.log(`Destroying instance ${instanceId}...`);
	await computeClient.compute.destroyInstance({
		instanceId,
		reason: "SDK test cleanup",
	});

	console.log("Instance destroyed successfully!");
}

main().catch((error) => {
	console.error("Failed to destroy instance:", error);
	process.exit(1);
});
