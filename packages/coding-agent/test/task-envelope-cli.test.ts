import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tsxImport = import.meta.resolve("tsx");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createWorkspace(): { root: string; projectDir: string; agentDir: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-task-envelope-cli-"));
	tempDirs.push(root);
	const projectDir = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	return { root, projectDir, agentDir };
}

async function runCli(
	args: string[],
	workspace: ReturnType<typeof createWorkspace>,
	stdin?: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
	return await new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, ["--import", tsxImport, cliPath, ...args], {
			cwd: workspace.projectDir,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: workspace.agentDir,
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});

		if (!child.stdout || !child.stderr) {
			reject(new Error("CLI stdout and stderr pipes were not created"));
			return;
		}
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolvePromise({ stdout, stderr, code });
		});
		if (stdin !== undefined) {
			if (!child.stdin) {
				reject(new Error("CLI stdin pipe was not created"));
				return;
			}
			child.stdin.end(stdin);
		}
	});
}

function createProbeExtension(root: string): { extensionPath: string; markerPath: string } {
	const markerPath = join(root, "extension-loaded");
	const extensionPath = join(root, "probe-extension.ts");
	writeFileSync(
		extensionPath,
		[
			'import { writeFileSync } from "node:fs";',
			"export default function probeExtension() {",
			`\twriteFileSync(${JSON.stringify(markerPath)}, "loaded");`,
			"}",
		].join("\n"),
		"utf8",
	);
	return { extensionPath, markerPath };
}

describe("task envelope CLI early exits", () => {
	it("returns version successfully without reading a nonexistent envelope", async () => {
		const workspace = createWorkspace();
		const missingEnvelope = join(workspace.root, "missing-envelope.json");
		const result = await runCli(["--version", "--task-envelope", missingEnvelope], workspace);

		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
		expect(result.stderr).toBe("");
	});

	it("returns base help without reading the envelope or initializing an extension", async () => {
		const workspace = createWorkspace();
		const missingEnvelope = join(workspace.root, "missing-envelope.json");
		const { extensionPath, markerPath } = createProbeExtension(workspace.root);
		const result = await runCli(
			["--help", "--task-envelope", missingEnvelope, "--extension", extensionPath],
			workspace,
		);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Usage:");
		expect(result.stderr).not.toContain(missingEnvelope);
		expect(existsSync(markerPath)).toBe(false);
	});

	it("rejects piped stdin before reading the envelope", async () => {
		const workspace = createWorkspace();
		const missingEnvelope = join(workspace.root, "missing-envelope.json");
		const result = await runCli(["-p", "--task-envelope", missingEnvelope], workspace, "x");

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--task-envelope cannot be combined with piped stdin");
		expect(result.stderr).not.toContain(missingEnvelope);
	});

	it("rejects conflicting arguments before reading the envelope or initializing an extension", async () => {
		const workspace = createWorkspace();
		const missingEnvelope = join(workspace.root, "missing-envelope.json");
		const { extensionPath, markerPath } = createProbeExtension(workspace.root);
		const result = await runCli(
			["--task-envelope", missingEnvelope, "--extension", extensionPath, "conflicting prompt"],
			workspace,
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--task-envelope cannot be combined with positional prompts");
		expect(result.stderr).not.toContain(missingEnvelope);
		expect(existsSync(markerPath)).toBe(false);
	});

	it("rejects external resource overrides before reading the envelope", async () => {
		const workspace = createWorkspace();
		const missingEnvelope = join(workspace.root, "missing-envelope.json");
		const result = await runCli(
			["--task-envelope", missingEnvelope, "--system-prompt", "external override"],
			workspace,
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--task-envelope cannot be combined with external resource");
		expect(result.stderr).not.toContain(missingEnvelope);
	});
});
