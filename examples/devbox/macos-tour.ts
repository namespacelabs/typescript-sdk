/**
 * A tour of the Devbox SDK against a macOS devbox.
 *
 * Run with:
 *
 *   npx tsx examples/devbox/macos-tour.ts
 *
 * Authentication defaults to the workload token when running inside a
 * Namespace workload, falling back to your local user token (`nsc login`).
 *
 * macOS devboxes run on Apple Silicon and boot a Namespace-managed macOS
 * base image; custom images and blueprints are Linux-only, so this tour
 * focuses on the devbox lifecycle, commands, filesystem, and terminal.
 * Provisioning a macOS devbox can take a few minutes.
 *
 * The devbox created by this script is named uniquely and deleted at the
 * end, even on failure.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevboxClient } from "@namespacelabs/sdk";

const runId = Date.now().toString(36);
const devboxName = `tour-macos-${runId}`;

async function main() {
	const client = createDevboxClient();

	const localDir = await mkdtemp(join(tmpdir(), "devbox-macos-tour-"));
	let devboxCreated = false;

	try {
		// ── Create ──────────────────────────────────────────────────────

		// macOS sizes are "m" (6 vCPUs, 14 GB) and "l" (12 vCPUs, 28 GB);
		// "m" is the default. Custom images cannot be combined with macOS.
		const devbox = await client.devboxes.create({ name: devboxName, os: "macos", size: "m" });
		devboxCreated = true;
		console.log("created devbox:", devbox.id, "state:", devbox.info.state);
		console.log("shape:", devbox.info.shape);

		const fetched = await client.devboxes.get(devbox.id);
		console.log("devboxes.get:", fetched.id, "state:", fetched.info.state);

		// ── Commands ────────────────────────────────────────────────────

		const uname = await devbox.exec(["uname", "-sm"]);
		console.log("uname:", uname.stdout.trim());

		const swVers = await devbox.exec(["sw_vers"]);
		console.log("sw_vers:\n" + swVers.stdout.trim());

		const stdinResult = await devbox.exec(["cat"], { stdin: "piped through stdin" });
		console.log("stdin roundtrip:", stdinResult.stdout);

		const shellResult = await devbox.shell('echo "in $PWD as $TOUR_VAR"', {
			cwd: "/tmp",
			env: { TOUR_VAR: "macos-tour" },
			onStdout: (data) => process.stdout.write(`stream> ${data}`),
		});
		console.log("shell exit code:", shellResult.exitCode);

		const failed = await devbox.exec(["sh", "-c", "exit 3"]);
		console.log("failed exec:", failed.exitCode, failed.error);

		// ── Filesystem ──────────────────────────────────────────────────

		const remoteDir = "/tmp/macos-tour";
		await devbox.fs.mkdir(`${remoteDir}/nested`, { recursive: true });

		await devbox.fs.writeFile(`${remoteDir}/greeting.txt`, "hello from the macOS tour\n");
		const contents = await devbox.fs.readFile(`${remoteDir}/greeting.txt`);
		console.log("readFile:", new TextDecoder().decode(contents).trim());

		console.log("exists:", await devbox.fs.exists(`${remoteDir}/greeting.txt`));

		await devbox.fs.copy(`${remoteDir}/greeting.txt`, `${remoteDir}/copy.txt`);
		await devbox.fs.rename(`${remoteDir}/copy.txt`, `${remoteDir}/renamed.txt`);

		const localFile = join(localDir, "upload.txt");
		await writeFile(localFile, "uploaded from the local machine\n");
		await devbox.fs.upload(localFile, `${remoteDir}/uploaded.txt`);

		const downloaded = join(localDir, "downloaded.txt");
		await devbox.fs.download(`${remoteDir}/uploaded.txt`, downloaded);
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
		terminal.write("echo terminal-says-hi\n");
		terminal.write("exit\n");
		const { exitCode } = await terminal.wait();
		unsubscribe();
		terminal.close();
		console.log(
			"terminal exit code:", exitCode,
			"- saw echo:", Buffer.concat(output).toString().includes("terminal-says-hi"),
		);

		// ── Display ─────────────────────────────────────────────────────

		// macOS devboxes expose a graphical display over VNC. Devboxes
		// without one (Linux) reject with DevboxDisplayUnavailableError.
		const screenshot = await devbox.display.screenshot();
		const screenshotFile = join(localDir, "screen.png");
		await writeFile(screenshotFile, screenshot.png);
		console.log(
			"screenshot:", `${screenshot.width}x${screenshot.height}`,
			"desktop:", screenshot.desktopName,
			"->", screenshotFile,
		);

		await devbox.display.click(Math.floor(screenshot.width / 2), Math.floor(screenshot.height / 2));
		console.log("clicked screen center");

		// Keystrokes go to the focused element; newlines send Return.
		await devbox.display.type("hello from the tour\n");
		console.log("typed into the display");

		// ── Lifecycle ───────────────────────────────────────────────────

		await devbox.stop();
		console.log("stopped:", devbox.info.state);

		// Resizes stay within the devbox's OS: macOS supports "m" and "l".
		await devbox.update({ size: "l" });
		console.log("updated size to l");

		await devbox.start();
		console.log("started:", devbox.info.state);

		const sizeCheck = await devbox.exec(["sysctl", "-n", "hw.ncpu"]);
		console.log("cpus after resize:", sizeCheck.stdout.trim());

		// ── Cleanup ─────────────────────────────────────────────────────

		await devbox.delete();
		devboxCreated = false;
		console.log("deleted devbox");
	} finally {
		if (devboxCreated) await client.devboxes.delete(devboxName).catch(() => {});
		await rm(localDir, { recursive: true, force: true });
		client.close();
	}
}

main().catch((error) => {
	console.error("macOS tour failed:", error);
	process.exit(1);
});
