/**
 * A tour of the Devbox SDK against a Windows devbox.
 *
 * Run with:
 *
 *   npm run build
 *   npx tsx examples/devbox/windows-tour.ts
 *
 * Authentication defaults to the workload token when running inside a
 * Namespace workload, falling back to your local user token (`nsc login`).
 *
 * Your workspace must have Windows devboxes enabled. Provisioning can take
 * a few minutes. Windows devboxes boot a Namespace-managed amd64 image and
 * are ephemeral: stopping one destroys its disk, not just its processes.
 *
 * This tour covers creation, commands, services, filesystem, terminal, and
 * deletion. Shell helpers use PowerShell by default. Display, blueprints,
 * and resize are outside this early-access slice.
 *
 * The devbox created by this script is named uniquely and deleted at the
 * end, even on failure.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevboxClient } from "@namespacelabs/sdk";

const runId = Date.now().toString(36);
const devboxName = `tour-windows-${runId}`;
const serviceName = `tour-windows-service-${runId}`;

async function main() {
	const client = createDevboxClient();

	const localDir = await mkdtemp(join(tmpdir(), "devbox-windows-tour-"));
	let devboxCreated = false;

	try {
		// ── Create ──────────────────────────────────────────────────────

		const devbox = await client.devboxes.create({
			name: devboxName,
			os: "windows",
			size: "m", // Default: "m" (8 vCPUs, 16 GB).
			ephemeral: true, // Required for Windows.
			versionControl: {}, // Disable repository checkout.
		});
		devboxCreated = true;
		console.log("created devbox:", devbox.id, "state:", devbox.info.state);
		console.log("shape:", devbox.info.shape);

		const fetched = await client.devboxes.get(devbox.id);
		console.log("devboxes.get:", fetched.id, "state:", fetched.info.state);

		// ── Commands ────────────────────────────────────────────────────

		const version = await devbox.exec(["cmd.exe", "/d", "/c", "ver"]);
		console.log("Windows version:", version.stdout.trim());

		const whoami = await devbox.exec(["whoami.exe"]);
		console.log("whoami:", whoami.stdout.trim());

		const stdinResult = await devbox.shell("[Console]::Write([Console]::In.ReadToEnd())", {
			stdin: "piped through stdin",
		});
		console.log("stdin roundtrip:", stdinResult.stdout);

		const shellResult = await devbox.shell('Write-Output "in $PWD as $env:TOUR_VAR"', {
			cwd: "C:\\Windows\\Temp",
			env: { TOUR_VAR: "windows-tour" },
			onStdout: (data) => process.stdout.write(`stream> ${data}`),
		});
		console.log("shell exit code:", shellResult.exitCode);

		const failed = await devbox.exec(["cmd.exe", "/d", "/c", "exit 3"]); // Expected failure.
		console.log("failed exec:", failed.exitCode, failed.error);

		const execution = await devbox.executions.startShell('Write-Output "detached shell"; Start-Sleep -Seconds 1');
		console.log("started execution:", execution.id);
		const completed = await execution.wait();
		console.log("detached shell:", completed.stdout.trim(), "exit code:", completed.exitCode);

		// ── Services ────────────────────────────────────────────────────

		const service = await devbox.services.create({
			name: serviceName,
			command: "powershell.exe",
			args: [
				"-NoLogo", "-NoProfile", "-NonInteractive",
				"-Command", 'Write-Output "$env:TOUR_SERVICE in $PWD"; Start-Sleep -Seconds 1',
			],
			cwd: "C:\\Windows\\Temp",
			environment: { TOUR_SERVICE: "service-ready" },
		});
		console.log("created service:", service.id, "state:", service.process?.state);

		const fetchedService = await devbox.services.get(serviceName);
		console.log("services.get:", fetchedService.id);

		const listedServices = await devbox.services.list();
		console.log(`services.list: ${listedServices.length} services`);

		for await (const chunk of devbox.services.logs(service.id)) {
			process.stdout.write(chunk.stdout);
			process.stderr.write(chunk.stderr);
		}

		await devbox.services.delete(service.id);
		console.log("deleted service");

		// ── Filesystem ──────────────────────────────────────────────────

		const remoteDir = `C:\\Windows\\Temp\\windows-tour-${runId}`;
		await devbox.fs.mkdir(`${remoteDir}\\nested`, { recursive: true });

		await devbox.fs.writeFile(`${remoteDir}\\greeting.txt`, "hello from the Windows tour\n");
		const contents = await devbox.fs.read(`${remoteDir}\\greeting.txt`);
		console.log("read:", contents.trim());

		const stream = await devbox.fs.read(`${remoteDir}\\greeting.txt`, { format: "stream" });
		process.stdout.write("stream: ");
		for await (const chunk of stream) {
			process.stdout.write(chunk);
		}

		console.log("exists:", await devbox.fs.exists(`${remoteDir}\\greeting.txt`));

		await devbox.fs.copy(`${remoteDir}\\greeting.txt`, `${remoteDir}\\copy.txt`);
		await devbox.fs.rename(`${remoteDir}\\copy.txt`, `${remoteDir}\\renamed.txt`);

		const localFile = join(localDir, "upload.txt");
		await writeFile(localFile, "uploaded from the local machine\n");
		await devbox.fs.upload(localFile, `${remoteDir}\\uploaded.txt`);

		const downloaded = join(localDir, "downloaded.txt");
		await devbox.fs.download(`${remoteDir}\\uploaded.txt`, downloaded);
		console.log("download roundtrip:", (await readFile(downloaded, "utf8")).trim());

		const entries = await devbox.fs.readdir(remoteDir);
		console.log("readdir:", entries.map((entry) => `${entry.name} (${entry.type})`).join(", "));

		await devbox.fs.remove(remoteDir, { recursive: true });
		console.log("removed:", !(await devbox.fs.exists(remoteDir)));

		// ── Terminal ────────────────────────────────────────────────────

		const terminal = await devbox.terminal.open({ columns: 120, rows: 40 });
		const output: Buffer[] = [];
		const unsubscribe = terminal.onData((data) => output.push(Buffer.from(data)));
		terminal.onExit((exitCode, signal) => console.log("terminal exited:", exitCode, signal));
		terminal.onError((error) => console.error("terminal error:", error));
		terminal.resize(100, 30);
		terminal.write("echo terminal-says-hi\r");
		terminal.write("exit\r");
		const { exitCode } = await terminal.wait();
		unsubscribe();
		terminal.close();
		console.log(
			"terminal exit code:", exitCode,
			"- saw echo:", Buffer.concat(output).toString().includes("terminal-says-hi"),
		);

		// ── Display ─────────────────────────────────────────────────────

		console.log("display: not yet available for Windows");

		// ── Lifecycle ───────────────────────────────────────────────────

		console.log("stop/start: skipped because stopped ephemeral devboxes can expire immediately");

		// ── Cleanup ─────────────────────────────────────────────────────

		await devbox.delete();
		devboxCreated = false;
		console.log("deleted devbox");
	} finally {
		if (devboxCreated) {
			await client.devboxes.delete(devboxName).catch(() => {});
		}
		await rm(localDir, { recursive: true, force: true });
		client.close();
	}
}

main().catch((error) => {
	console.error("Windows tour failed:", error);
	process.exit(1);
});
