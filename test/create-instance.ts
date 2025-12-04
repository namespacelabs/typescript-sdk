/**
 * Test: Create an instance to verify the SDK APIs work
 *
 * This test creates a simple nginx instance and waits for it to be ready.
 */

import { loadDefaults } from "../src/auth/index.js";
import { createComputeClient } from "../src/api/compute/index.js";
import { Timestamp } from "@bufbuild/protobuf";

async function main() {
	console.log("Loading authentication token...");
	const tokenSource = await loadDefaults();

	console.log("Creating compute client...");
	const computeClient = createComputeClient({
		region: "us",
		tokenSource,
	});

	console.log("Creating instance...");
	const createResponse = await computeClient.compute.createInstance({
		shape: {
			virtualCpu: 2,
			memoryMegabytes: 4096,
			machineArch: "amd64",
		},
		documentedPurpose: "SDK test: create-instance",
		deadline: Timestamp.fromDate(new Date(Date.now() + 60 * 60 * 1000)), // 1 hour
		containers: [
			{
				name: "nginx",
				imageRef: "nginx",
				args: [],
				exportPorts: [
					{
						name: "nginx",
						containerPort: 80,
						proto: 0, // TCP
					},
				],
			},
		],
	});

	const instanceId = createResponse.metadata?.instanceId;
	console.log("Instance created successfully!");
	console.log("  - Instance ID:", instanceId);
	console.log("  - Instance URL:", createResponse.instanceUrl);
	console.log();

	// Optional: Wait for instance to be ready (can be slow, so skipping by default)
	const shouldWait = process.env.WAIT_FOR_READY === "true";

	if (shouldWait) {
		console.log("Waiting for instance to be ready...");
		const waitStream = computeClient.compute.waitInstance({
			instanceId,
		});

		// Stream through wait responses
		for await (const waitResponse of waitStream) {
			if (waitResponse.metadata) {
				console.log("Instance is ready!");
				break;
			}
		}
		console.log();
	} else {
		console.log("Skipping wait (set WAIT_FOR_READY=true to wait for instance)");
		console.log();
	}

	console.log("Test completed successfully!");
	console.log();
	console.log("Note: Instance will run until deadline (1 hour) or manually destroyed.");
	console.log(`To destroy: nsc destroy ${instanceId}`);
}

main().catch((error) => {
	console.error("Test failed:", error);
	process.exit(1);
});
