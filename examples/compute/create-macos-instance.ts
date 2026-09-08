import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { createComputeClient } from "@namespacelabs/sdk/api/compute";

async function main() {
	const client = createComputeClient();

	const instance = await client.compute.createInstance({
		shape: {
			os: "macos",
			machineArch: "arm64",
			virtualCpu: 6,
			memoryMegabytes: 14 * 1024,
			selectors: [{ name: "macos.version", value: "26.x" }],
		},
		documentedPurpose: "TypeScript SDK example: macOS instance",
		deadline: timestampFromDate(new Date(Date.now() + 30 * 60 * 1000)),
	});

	const instanceId = instance.metadata!.instanceId;
	console.log("Instance ID:", instanceId);
	console.log("Instance URL:", instance.instanceUrl);
	console.log("The instance expires in 30 minutes.");
	console.log(`To destroy it sooner: nsc destroy ${instanceId}`);

	console.log("Waiting for macOS to boot...");
	await client.compute.waitInstanceSync({ instanceId }, { timeoutMs: 10 * 60 * 1000 });
	console.log("macOS instance is ready.");

	// Without a target container, commands run directly in the macOS guest.
	const result = await client.command.runCommandSync({
		instanceId,
		command: { command: ["uname", "-a"] },
	}, { timeoutMs: 30_000 });
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	process.exitCode = result.exitCode;
}

main().catch((error) => {
	console.error("macOS instance example failed:", error);
	process.exitCode = 1;
});
