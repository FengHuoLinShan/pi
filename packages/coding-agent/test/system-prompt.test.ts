import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});

		test("instructs models to resolve pi docs and examples under absolute base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
			);
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	test("uses the compact skill-loading instruction in on-demand mode", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["read", "capability"],
			toolSnippets: { capability: "Search capabilities" },
			skillLoading: "on-demand",
			skills: [
				{
					name: "secret-skill-name",
					description: "A large catalog entry",
					filePath: "/tmp/secret-skill-name/SKILL.md",
					baseDir: "/tmp/secret-skill-name",
					sourceInfo: {
						path: "/tmp/secret-skill-name/SKILL.md",
						source: "test",
						scope: "temporary",
						origin: "top-level",
					},
					disableModelInvocation: false,
				},
			],
			cwd: process.cwd(),
		});

		expect(prompt).toContain("Specialized skills are available on demand");
		expect(prompt).not.toContain("secret-skill-name");
	});

	describe("prompt guidelines", () => {
		test("steers shell discovery toward bounded built-in search and precise reads", () => {
			const bashTool = createBashToolDefinition(process.cwd());
			const prompt = buildSystemPrompt({
				selectedTools: ["bash"],
				toolSnippets: { bash: bashTool.promptSnippet ?? "Execute bash commands" },
				promptGuidelines: bashTool.promptGuidelines,
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(bashTool.description).toContain("last 200 lines");
			expect(prompt).toContain("otherwise keep shell discovery to paths or line-number-only matches");
			expect(prompt).toContain("Do not use shell rg/grep context flags or pipelines as a bulk file reader");
			expect(prompt).toContain("use read with exact non-overlapping ranges");
		});

		test("steers grep toward narrow context-free discovery before precise reads", () => {
			const grepTool = createGrepToolDefinition(process.cwd());
			const prompt = buildSystemPrompt({
				selectedTools: ["grep"],
				toolSnippets: { grep: grepTool.promptSnippet ?? "Search file contents" },
				promptGuidelines: grepTool.promptGuidelines,
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(grepTool.description).toContain("200 output lines");
			expect(prompt).toContain("Start grep searches with context=0 and a narrow limit");
			expect(prompt).toContain("then use read for exact source ranges");
		});

		test("includes read reuse guidance to avoid duplicate unchanged ranges", () => {
			const readTool = createReadToolDefinition(process.cwd());
			const prompt = buildSystemPrompt({
				selectedTools: ["read"],
				toolSnippets: { read: readTool.promptSnippet ?? "Read file contents" },
				promptGuidelines: readTool.promptGuidelines,
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Reuse unchanged file content already returned in the current turn");
			expect(prompt).toContain("do not repeat the same path and range");
			expect(prompt).toContain("do not retry the same or a narrower covered range");
			expect(prompt).toContain("request only the missing non-overlapping range");
		});

		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});
});
