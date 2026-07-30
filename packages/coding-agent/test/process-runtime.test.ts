import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.ts";
import { LocalProcessRuntime, type ProcessRuntimeOutputStream } from "../src/core/process-runtime.ts";

const temporaryDirectories: string[] = [];

async function createWorkingDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-process-runtime-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("LocalProcessRuntime", () => {
	it("normalizes stdin, separated output streams, and exit state", async () => {
		const cwd = await createWorkingDirectory();
		const output: Array<{ stream: ProcessRuntimeOutputStream; text: string }> = [];
		const handle = new LocalProcessRuntime().start({
			command: process.execPath,
			args: [
				"-e",
				[
					'let input = "";',
					'process.stdin.setEncoding("utf8");',
					'process.stdin.on("data", (chunk) => { input += chunk; });',
					'process.stdin.on("end", () => {',
					'  process.stdout.write("out:" + input);',
					'  process.stderr.write("err");',
					"});",
				].join("\n"),
			],
			cwd,
			stdin: "payload",
			onOutput: (stream, chunk) => output.push({ stream, text: chunk.toString() }),
		});

		await expect(handle.wait()).resolves.toMatchObject({
			exitCode: 0,
			reason: "exited",
		});
		expect(
			output
				.filter((item) => item.stream === "stdout")
				.map((item) => item.text)
				.join(""),
		).toBe("out:payload");
		expect(
			output
				.filter((item) => item.stream === "stderr")
				.map((item) => item.text)
				.join(""),
		).toBe("err");
		expect(handle.pid).toBeTypeOf("number");
	});

	it("owns timeout and abort termination for every caller", async () => {
		const cwd = await createWorkingDirectory();
		const runtime = new LocalProcessRuntime();
		const timed = runtime.start({
			command: process.execPath,
			args: ["-e", "setInterval(() => {}, 1000)"],
			cwd,
			timeoutMs: 25,
		});
		await expect(timed.wait()).resolves.toMatchObject({ exitCode: null, reason: "timed-out" });

		const controller = new AbortController();
		const aborted = runtime.start({
			command: process.execPath,
			args: ["-e", "setInterval(() => {}, 1000)"],
			cwd,
			signal: controller.signal,
		});
		controller.abort();
		await expect(aborted.wait()).resolves.toMatchObject({ exitCode: null, reason: "aborted" });
	});

	it("rejects timeout values that Node would clamp to an immediate timer", async () => {
		const cwd = await createWorkingDirectory();
		expect(() =>
			new LocalProcessRuntime().start({
				command: process.execPath,
				args: ["-e", ""],
				cwd,
				timeoutMs: 2_147_483_648,
			}),
		).toThrow("no greater than 2147483647");
	});

	it("powers extension command execution with the same cancellation path", async () => {
		const cwd = await createWorkingDirectory();
		const controller = new AbortController();
		const resultPromise = execCommand(
			process.execPath,
			["-e", 'process.stdout.write("started"); setInterval(() => {}, 1000)'],
			cwd,
			{ signal: controller.signal },
		);
		setTimeout(() => controller.abort(), 25);

		await expect(resultPromise).resolves.toMatchObject({
			code: 0,
			killed: true,
		});
	});
});
