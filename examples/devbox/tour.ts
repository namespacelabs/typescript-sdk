/**
 * A tour of the Devbox SDK that exercises every public method.
 *
 * Run with:
 *
 *   npx tsx examples/devbox/tour.ts
 *
 * Authentication defaults to the workload token when running inside a
 * Namespace workload, falling back to your local user token (`nsc login`).
 *
 * Image optimization bakes the image on every optimized site and can take
 * several minutes; it is skipped unless RUN_OPTIMIZE=1 is set.
 *
 * All resources created by this script are named uniquely and deleted at
 * the end, even on failure.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevboxClient } from "@namespacelabs/sdk";

const runId = Date.now().toString(36);
const imageName = `tour-image-${runId}`;
const blueprintName = `tour-blueprint-${runId}`;
const devboxName = `tour-devbox-${runId}`;

async function main() {
	// Defaults to workload permissions, falling back to the user token.
	// Pass { tokenSource: loadUserToken } (from "@namespacelabs/sdk/auth")
	// to pick one explicitly.
	const client = createDevboxClient();

	const localDir = await mkdtemp(join(tmpdir(), "devbox-tour-"));
	let devboxCreated = false;
	let blueprintCreated = false;
	let imageRegistered = false;

	try {
		// ── Images ──────────────────────────────────────────────────────

		const image = await client.images.register({
			name: imageName,
			ref: "node:22",
			description: "Devbox SDK tour image",
		});
		imageRegistered = true;
		console.log("registered image:", image.name, image.repository);

		// get() accepts a name, an id, or a digest selector.
		const imageByName = await client.images.get({ name: imageName });
		console.log("image by name:", imageByName.id);

		const imagePage = await client.images.list({ includeBuiltin: true });
		console.log(`images.list: ${imagePage.items.length} images (first page)`);

		let imageCount = 0;
		for await (const _ of client.images.iterate()) imageCount++;
		console.log(`images.iterate: ${imageCount} images (all pages)`);

		// inspect() resolves the image and reports its config and where it
		// has been optimized.
		const inspection = await client.images.inspect({ name: imageName });
		console.log("image user:", inspection.user, "optimized sites:", inspection.optimizedSites);

		if (process.env.RUN_OPTIMIZE === "1") {
			// Bakes the image for fast devbox starts. Slow: several minutes.
			await client.images.optimize({ name: imageName }, {
				onProgress: (status) => console.log("optimize:", status),
			});
			console.log("image optimized");
		}

		// ── Blueprints ──────────────────────────────────────────────────

		const blueprint = await client.blueprints.create(blueprintName, {
			image: "node:22",
			size: "s",
			description: "Devbox SDK tour blueprint",
			environment: { TOUR: "1" },
			// Ephemeral devboxes are expired shortly after stopping; give
			// them enough retention to survive the stop/start cycles below.
			ephemeral: { stoppedRetentionMs: 10 * 60_000 },
		});
		blueprintCreated = true;
		console.log("created blueprint:", blueprint.name, "version:", blueprint.version);

		const fetchedBlueprint = await client.blueprints.get(blueprintName);
		console.log("blueprint image:", fetchedBlueprint.definition.image);

		const blueprintPage = await client.blueprints.list();
		console.log(`blueprints.list: ${blueprintPage.items.length} blueprints (first page)`);

		let blueprintCount = 0;
		for await (const _ of client.blueprints.iterate()) blueprintCount++;
		console.log(`blueprints.iterate: ${blueprintCount} blueprints (all pages)`);

		// update() replaces the definition wholesale (last-write-wins).
		const updatedBlueprint = await client.blueprints.update(blueprintName, {
			...fetchedBlueprint.definition,
			environment: { ...fetchedBlueprint.definition.environment, TOUR_UPDATED: "1" },
		});
		console.log("updated blueprint version:", updatedBlueprint.version);

		// ── Devboxes ────────────────────────────────────────────────────

		const devbox = await client.devboxes.create({
			name: devboxName,
			blueprint: blueprintName,
		});
		devboxCreated = true;
		console.log("created devbox:", devbox.id, "state:", devbox.info.state);

		// get() resolves runtime state; list() intentionally does not
		// (listed devboxes report state "unknown" — it is cheap).
		const fetched = await client.devboxes.get(devbox.id);
		console.log("devboxes.get:", fetched.id, "state:", fetched.info.state);

		const devboxPage = await client.devboxes.list({ limit: 10 });
		console.log(`devboxes.list: ${devboxPage.items.length} devboxes (first page)`);

		let devboxCount = 0;
		for await (const _ of client.devboxes.iterate()) devboxCount++;
		console.log(`devboxes.iterate: ${devboxCount} devboxes (all pages)`);

		// refresh() re-resolves runtime state in place on the handle.
		await devbox.refresh();
		console.log("refreshed state:", devbox.info.state);

		// ── Commands ────────────────────────────────────────────────────

		// Structured argv: arguments pass literally, nothing is
		// shell-expanded. env and stdin travel structurally too.
		const version = await devbox.exec(["node", "--version"]);
		console.log("node:", version.stdout.trim());

		const stdinResult = await devbox.exec(["cat"], { stdin: "piped through stdin" });
		console.log("stdin roundtrip:", stdinResult.stdout);

		// Shell syntax with cwd/env, streaming output as it arrives.
		const shellResult = await devbox.shell('echo "in $PWD as $TOUR_VAR"', {
			cwd: "/tmp",
			env: { TOUR_VAR: "tour" },
			onStdout: (data) => process.stdout.write(`stream> ${data}`),
		});
		console.log("shell exit code:", shellResult.exitCode);

		// Non-zero exits report the code plus the agent's failure detail.
		const failed = await devbox.exec(["sh", "-c", "exit 3"]);
		console.log("failed exec:", failed.exitCode, failed.error);

		// ── Filesystem ──────────────────────────────────────────────────

		const remoteDir = "/tmp/tour";
		await devbox.fs.mkdir(`${remoteDir}/nested`, { recursive: true });

		await devbox.fs.writeFile(`${remoteDir}/greeting.txt`, "hello from the tour\n");
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

		// ── Lifecycle ───────────────────────────────────────────────────

		// Lifecycle methods exist both on the handle and on the resource
		// (client.devboxes.start/stop/delete take a ref).
		await devbox.stop();
		console.log("stopped:", devbox.info.state);

		// update() adjusts the devbox configuration; size is an open string
		// resolved by the backend.
		await devbox.update({ size: "m" });
		console.log("updated size to m");

		await devbox.start();
		console.log("started:", devbox.info.state);

		const sizeCheck = await devbox.exec(["nproc"]);
		console.log("cpus after resize:", sizeCheck.stdout.trim());

		// The same lifecycle transitions, driven from the resource by ref.
		await client.devboxes.stop(devbox.id);
		await client.devboxes.start(devbox.id);
		await devbox.refresh();
		console.log("resource-level stop/start done, state:", devbox.info.state);

		// ── Cleanup ─────────────────────────────────────────────────────

		await devbox.delete();
		devboxCreated = false;
		console.log("deleted devbox");

		await client.blueprints.delete(blueprintName);
		blueprintCreated = false;
		console.log("deleted blueprint");

		await client.images.delete({ name: imageName });
		imageRegistered = false;
		console.log("deleted image");
	} finally {
		// Best-effort cleanup on failure.
		if (devboxCreated) await client.devboxes.delete(devboxName).catch(() => {});
		if (blueprintCreated) await client.blueprints.delete(blueprintName).catch(() => {});
		if (imageRegistered) await client.images.delete({ name: imageName }).catch(() => {});
		await rm(localDir, { recursive: true, force: true });
		client.close();
	}
}

main().catch((error) => {
	console.error("tour failed:", error);
	process.exit(1);
});
