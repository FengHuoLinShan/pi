import { describe, expect, it } from "vitest";
import {
	extractSourceLanguageFile,
	parseGoModulePath,
	type SourceLanguageFile,
	type SourceLanguageProject,
} from "../src/language-adapters.ts";

function extract(path: string, project: SourceLanguageProject) {
	const file = project.files.find((candidate) => candidate.path === path);
	if (!file) throw new Error(`Missing test file: ${path}`);
	const extraction = extractSourceLanguageFile(file, project);
	if (!extraction) throw new Error(`Missing adapter for test file: ${path}`);
	return extraction;
}

describe("source language adapters", () => {
	it("extracts Python declarations and resolves workspace-relative imports", () => {
		const files: SourceLanguageFile[] = [
			{ path: "pkg/base.py", content: "class Base:\n    pass\n" },
			{
				path: "pkg/consumer.py",
				content: "from .base import Base\n\nasync def run():\n    return Base()\n",
			},
		];
		const extraction = extract("pkg/consumer.py", { files });

		expect(extraction.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "function", name: "run" }),
				expect.objectContaining({
					id: "file:pkg/consumer.py",
					attributes: expect.objectContaining({ adapter: "python-structural", precision: "structural" }),
				}),
			]),
		);
		expect(extraction.edges).toContainEqual(
			expect.objectContaining({
				kind: "imports",
				from: "file:pkg/consumer.py",
				to: "file:pkg/base.py",
				attributes: expect.objectContaining({ confidence: 1 }),
			}),
		);
	});

	it("links Python package imports to statically present submodules", () => {
		const files: SourceLanguageFile[] = [
			{ path: "pkg/__init__.py", content: "" },
			{ path: "pkg/sibling.py", content: "VALUE = 1\n" },
			{ path: "consumer.py", content: "from pkg import sibling\n" },
		];
		const extraction = extract("consumer.py", { files });

		expect(extraction.edges.map((edge) => edge.to)).toEqual(["file:pkg/__init__.py", "file:pkg/sibling.py"]);
	});

	it("extracts Go declarations and links workspace package imports to every package file", () => {
		const files: SourceLanguageFile[] = [
			{
				path: "cmd/main.go",
				content: 'package main\n\nimport "example.com/project/internal/lib"\n\nfunc main() {}\n',
			},
			{ path: "internal/lib/one.go", content: "package lib\n\ntype One struct{}\n" },
			{ path: "internal/lib/two.go", content: "package lib\n\nfunc Two() {}\n" },
		];
		const project = { files, goModulePath: parseGoModulePath("module example.com/project\n\ngo 1.24\n") };
		const extraction = extract("cmd/main.go", project);

		expect(extraction.nodes).toContainEqual(expect.objectContaining({ kind: "function", name: "main" }));
		expect(extraction.edges.map((edge) => edge.to)).toEqual(["file:internal/lib/one.go", "file:internal/lib/two.go"]);
	});

	it("does not extract Go declarations from multiline raw strings", () => {
		const files: SourceLanguageFile[] = [
			{
				path: "main.go",
				content: ["package main", "const text = `", "func Hidden() {}", "`", "func Visible() {}"].join("\n"),
			},
		];
		const extraction = extract("main.go", { files });
		const names = extraction.nodes.map((node) => node.name);

		expect(names).toContain("Visible");
		expect(names).not.toContain("Hidden");
	});

	it("extracts Rust declarations and resolves explicit crate modules without inferring calls", () => {
		const files: SourceLanguageFile[] = [
			{
				path: "src/lib.rs",
				content: "pub mod engine;\nuse crate::engine::Engine;\n\npub fn start() -> Engine { Engine {} }\n",
			},
			{ path: "src/engine.rs", content: "pub struct Engine {}\n" },
		];
		const extraction = extract("src/lib.rs", { files });

		expect(extraction.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "module", name: "engine" }),
				expect.objectContaining({ kind: "function", name: "start" }),
			]),
		);
		expect(extraction.edges).toHaveLength(2);
		expect(extraction.edges.every((edge) => edge.to === "file:src/engine.rs")).toBe(true);
		expect(extraction.edges.some((edge) => edge.kind === "calls")).toBe(false);
	});

	it("resolves crate imports from nested Rust modules in root-level crates", () => {
		const files: SourceLanguageFile[] = [
			{ path: "lib.rs", content: "pub mod engine;\npub mod nested;\n" },
			{ path: "engine.rs", content: "pub struct Engine {}\n" },
			{ path: "nested/mod.rs", content: "pub mod consumer;\n" },
			{
				path: "nested/consumer.rs",
				content: "use crate::engine::Engine;\n\npub fn create() -> Engine { Engine {} }\n",
			},
		];
		const extraction = extract("nested/consumer.rs", { files });

		expect(extraction.edges).toContainEqual(expect.objectContaining({ to: "file:engine.rs" }));
	});

	it("does not extract Rust declarations hidden in comments after lifetimes or inside raw strings", () => {
		const files: SourceLanguageFile[] = [
			{
				path: "lib.rs",
				content: [
					"pub struct Marker<'a>;",
					"/*",
					"pub fn hidden_in_comment() {}",
					"*/",
					'pub const TEXT: &str = r#"',
					"pub fn hidden_in_raw_string() {}",
					'"#;',
					'pub const C_TEXT: &core::ffi::CStr = cr#"',
					"pub fn hidden_in_c_raw_string() {}",
					'"#;',
					'pub const CONTINUED: &str = "prefix\\',
					"pub fn hidden_in_continued_string() {}",
					'";',
					"pub fn visible() {}",
				].join("\n"),
			},
		];
		const extraction = extract("lib.rs", { files });
		const names = extraction.nodes.map((node) => node.name);

		expect(names).toContain("visible");
		expect(names).not.toContain("hidden_in_comment");
		expect(names).not.toContain("hidden_in_raw_string");
		expect(names).not.toContain("hidden_in_c_raw_string");
		expect(names).not.toContain("hidden_in_continued_string");
	});

	it("keeps unresolved external imports explicit and low confidence", () => {
		const files: SourceLanguageFile[] = [{ path: "app.py", content: "import third_party\n" }];
		const extraction = extract("app.py", { files });

		expect(extraction.edges).toEqual([
			expect.objectContaining({
				to: "external:python:third_party",
				attributes: expect.objectContaining({ confidence: 0, precision: "structural" }),
			}),
		]);
	});
});
