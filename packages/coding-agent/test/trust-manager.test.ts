import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasProjectConfig, ProjectTrustStore } from "../src/core/trust-manager.ts";

describe("ProjectTrustStore", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `trust-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("stores decisions per cwd", () => {
		const store = new ProjectTrustStore(agentDir);

		expect(store.get(cwd)).toBeNull();
		store.set(cwd, true);
		expect(store.get(cwd)).toBe(true);
		store.set(cwd, false);
		expect(store.get(cwd)).toBe(false);
		store.set(cwd, null);
		expect(store.get(cwd)).toBeNull();
	});

	it("fails loudly without overwriting malformed trust stores", () => {
		const trustPath = join(agentDir, "trust.json");
		writeFileSync(trustPath, "{not json", "utf-8");
		const store = new ProjectTrustStore(agentDir);

		expect(() => store.get(cwd)).toThrow(/Failed to read trust store/);
		expect(() => store.set(cwd, true)).toThrow(/Failed to read trust store/);
		expect(readFileSync(trustPath, "utf-8")).toBe("{not json");
	});

	it("does not read trust.json while another process holds the trust lock", () => {
		const trustPath = join(agentDir, "trust.json");
		writeFileSync(trustPath, "{partial", "utf-8");
		const release = lockfile.lockSync(agentDir, { realpath: false, lockfilePath: `${trustPath}.lock` });
		const store = new ProjectTrustStore(agentDir);

		try {
			let error: unknown;
			try {
				store.get(cwd);
			} catch (caught) {
				error = caught;
			}

			expect(error).toBeInstanceOf(Error);
			expect((error as { code?: unknown }).code).toBe("ELOCKED");
		} finally {
			release();
		}

		expect(() => store.get(cwd)).toThrow(/Failed to read trust store/);
	});

	it("detects .pi project config directories", () => {
		expect(hasProjectConfig(cwd)).toBe(false);

		mkdirSync(join(cwd, ".pi"), { recursive: true });
		expect(hasProjectConfig(cwd)).toBe(true);
	});
});
