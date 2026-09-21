import assert from "node:assert/strict";
import test from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { fromBearerToken, loadDefaults } from "../src/auth/index.js";
import { bearerAuthInterceptor } from "../src/api/interceptors.js";
import {
	createDevboxClient,
	DevboxGatewayError,
	DevboxTimeoutError,
	ExecutionNotFoundError,
	ExecutionOutputLimitError,
	type DevboxExecution,
} from "../src/devbox/index.js";

const ref = process.env.SDK_TEST_DEVBOX;

test("real devbox asynchronous execution", { skip: !ref, timeout: 120_000 }, async (t) => {
	const client = createDevboxClient();
	t.after(() => client.close());
	const devbox = await client.devboxes.get(ref!);

	await t.test("start returns running, concurrent readers receive live and replayed output", async () => {
		const execution = await devbox.executions.start(["bash", "-lc", "printf early; printf problem >&2; sleep 3; printf late; printf end >&2; exit 7"], {
			cwd: "/tmp", timeoutMs: 10_000,
		});
		assert.ok(execution.id);
		const running = await execution.status();
		assert.equal(running.state, "running");
		assert.equal("exitCode" in running, false);
		let observedLive = false;
		const live = readLogs(execution, async () => {
			assert.equal((await execution.status()).state, "running");
			observedLive = true;
		});
		const waiting = execution.wait({ timeoutMs: 10_000 });
		const [streamed, waited] = await Promise.all([live, waiting]);
		assert.equal(observedLive, true);
		assert.deepEqual(streamed, { stdout: "earlylate", stderr: "problemend", exitCode: 7 });
		assert.equal(waited.stdout, streamed.stdout);
		assert.equal(waited.stderr, streamed.stderr);
		assert.equal(waited.exitCode, 7);
		assert.ok(waited.error);
		const completed = await execution.status();
		assert.equal(completed.state, "completed");
		assert.ok(completed.state === "completed" && completed.completedAt instanceof Date);
		assert.ok(completed.state === "completed" && completed.exitCode === 7);
		assert.deepEqual(await readLogs(execution), streamed);
		let stdout = "";
		let stderr = "";
		assert.deepEqual(await execution.wait({
			onStdout: (data) => { stdout += Buffer.from(data).toString(); },
			onStderr: (data) => { stderr += Buffer.from(data).toString(); },
		}), waited);
		assert.equal(stdout, "earlylate");
		assert.equal(stderr, "problemend");
		await assert.rejects(execution.status({ timeoutMs: 0 }), DevboxTimeoutError);
		await assert.rejects(devbox.executions.start(["true"], { cwd: "/tmp", timeoutMs: 0 }), DevboxTimeoutError);
	});

	await t.test("a new client reattaches after the originating client closes", async () => {
		const origin = createDevboxClient();
		let id: string;
		try {
			const box = await origin.devboxes.get(ref!);
			id = (await box.executions.startShell("sleep 3; printf attached", { cwd: "/tmp", timeoutMs: 2_000 })).id;
		} finally {
			origin.close();
		}
		const other = createDevboxClient();
		try {
			const box = await other.devboxes.get(ref!);
			const execution = await box.executions.get(id);
			assert.equal(execution.id, id);
			assert.deepEqual(await execution.wait({ timeoutMs: 10_000 }), {
				exitCode: 0, signal: null, stdout: "attached", stderr: "",
			});
		} finally {
			other.close();
		}
	});

	await t.test("a separate client lists retained running and completed executions as usable handles", async () => {
		const completed = await devbox.executions.startShell("printf retained; printf error >&2; exit 4", { cwd: "/tmp" });
		await completed.wait();
		const running = await devbox.executions.startShell("sleep 3; printf listed", { cwd: "/tmp" });
		const other = createDevboxClient();
		try {
			const box = await other.devboxes.get(ref!);
			const executions = await box.executions.list({ timeoutMs: 10_000 });
			const retained = executions.find((execution) => execution.id === completed.id);
			const live = executions.find((execution) => execution.id === running.id);
			assert.ok(retained);
			assert.ok(live);
			assert.ok(executions.indexOf(retained) < executions.indexOf(live));
			assert.equal((await retained.status()).state, "completed");
			assert.equal((await live.status()).state, "running");
			assert.deepEqual(await readLogs(retained), { stdout: "retained", stderr: "error", exitCode: 4 });
			assert.equal((await live.wait({ timeoutMs: 10_000 })).stdout, "listed");
			assert.ok((await box.executions.list()).some((execution) => execution.id === running.id));
			await assert.rejects(box.executions.list({ timeoutMs: 0 }), DevboxTimeoutError);
			await assert.rejects(box.executions.list({ signal: AbortSignal.abort() }));
		} finally {
			other.close();
		}
	});

	await t.test("wait abort, read timeout, and breaking a stream do not terminate the command", async () => {
		const execution = await devbox.executions.startShell("printf alive; sleep 3; printf done", { cwd: "/tmp" });
		const controller = new AbortController();
		const unaffected = execution.wait({ timeoutMs: 10_000 });
		await assert.rejects(execution.wait({
			signal: controller.signal,
			onStdout: () => controller.abort(),
		}), (error: unknown) => error instanceof ConnectError && error.code === Code.Canceled);
		assert.equal((await execution.status()).state, "running");
		await assert.rejects(execution.wait({ timeoutMs: 0 }), DevboxTimeoutError);
		await assert.rejects(execution.wait({ timeoutMs: 50 }), DevboxTimeoutError);
		for await (const chunk of execution.logs()) {
			assert.equal(Buffer.from(chunk.stdout).toString(), "alive");
			break;
		}
		const logController = new AbortController();
		await assert.rejects(async () => {
			for await (const _chunk of execution.logs({ signal: logController.signal })) logController.abort();
		}, (error: unknown) => error instanceof ConnectError && error.code === Code.Canceled);
		assert.equal((await execution.status()).state, "running");
		const reattached = await devbox.executions.get(execution.id);
		assert.equal((await reattached.wait()).stdout, "alivedone");
		assert.equal((await unaffected).stdout, "alivedone");
	});

	await t.test("argv, cwd, environment, stdin, shell selection, and execution errors", async () => {
		const execution = await devbox.executions.start(["printf", "%s", "$(false); space ' quote"], { cwd: "/tmp" });
		assert.equal((await execution.wait()).stdout, "$(false); space ' quote");
		const shell = await devbox.executions.startShell('printf "%s|%s|" "$PWD" "$SDK_VALUE"; cat', {
			shell: "/bin/bash", cwd: "/tmp", env: { SDK_VALUE: "a b;$x" }, stdin: "input\n",
		});
		assert.equal((await shell.wait()).stdout, "/tmp|a b;$x|input\n");
		const binary = await devbox.executions.start(["cat"], { cwd: "/tmp", stdin: new TextEncoder().encode("bytes") });
		assert.equal((await binary.wait()).stdout, "bytes");
		const missingCommand = await devbox.executions.start(["/does-not-exist-sdk-test"], { cwd: "/tmp" });
		const failure = await missingCommand.wait();
		assert.notEqual(failure.exitCode, 0);
		assert.ok(failure.error);
		assert.equal((await missingCommand.status()).state, "completed");
	});

	await t.test("bounded collection can be replaced with non-collecting log consumption", async () => {
		const execution = await devbox.executions.startShell("head -c 11000000 /dev/zero; printf err >&2", { cwd: "/tmp" });
		await assert.rejects(execution.wait(), ExecutionOutputLimitError);
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let exitCode: number | undefined;
		for await (const chunk of execution.logs({ timeoutMs: 10_000 })) {
			stdoutBytes += chunk.stdout.length;
			stderrBytes += chunk.stderr.length;
			if (chunk.result) exitCode = chunk.result.exitCode;
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		assert.equal(stdoutBytes, 11_000_000);
		assert.equal(stderrBytes, 3);
		assert.equal(exitCode, 0);
	});

	await t.test("missing IDs differ from actual gateway connection failures", async () => {
		await assert.rejects(devbox.executions.get("sdk-nonexistent-execution"), ExecutionNotFoundError);
		const tokens = await loadDefaults();
		// Authenticate the control plane normally, but deliberately fail the gateway handshake.
		const denied = createDevboxClient({
			transport: createConnectTransport({
				httpVersion: "1.1",
				baseUrl: process.env.NSC_DEVBOX_ENDPOINT ?? "https://private-api.iad.namespaceapis.com",
				interceptors: [bearerAuthInterceptor(tokens)],
			}),
			tokenSource: fromBearerToken("invalid-gateway-token"),
		});
		try {
			const box = await denied.devboxes.get(ref!);
			await assert.rejects(box.executions.list(), (error: unknown) => {
				assert.ok(error instanceof DevboxGatewayError);
				assert.ok(error.statusCode === 401 || error.statusCode === 403);
				return true;
			});
			await assert.rejects(box.executions.get("sdk-nonexistent-execution"), (error: unknown) => {
				assert.ok(error instanceof DevboxGatewayError);
				assert.ok(error.statusCode === 401 || error.statusCode === 403);
				assert.equal(error instanceof ExecutionNotFoundError, false);
				return true;
			});
		} finally {
			denied.close();
		}
	});

	await t.test("foreground execution remains compatible", async () => {
		assert.deepEqual(await devbox.exec(["cat"], { cwd: "/tmp", stdin: "foreground" }), {
			exitCode: 0, signal: null, stdout: "foreground", stderr: "",
		});
		const result = await devbox.shell("printf out; printf err >&2; exit 9", { cwd: "/tmp" });
		assert.equal(result.exitCode, 9);
		assert.equal(result.stdout, "out");
		assert.equal(result.stderr, "err");
		assert.ok(result.error);
	});
});

async function readLogs(execution: DevboxExecution, onFirstOutput?: () => Promise<void>) {
	let stdout = "";
	let stderr = "";
	let exitCode: number | undefined;
	for await (const chunk of execution.logs({ timeoutMs: 10_000 })) {
		stdout += Buffer.from(chunk.stdout).toString();
		stderr += Buffer.from(chunk.stderr).toString();
		if (onFirstOutput && (chunk.stdout.length || chunk.stderr.length)) {
			await onFirstOutput();
			onFirstOutput = undefined;
		}
		if (chunk.result) exitCode = chunk.result.exitCode;
	}
	return { stdout, stderr, exitCode };
}
