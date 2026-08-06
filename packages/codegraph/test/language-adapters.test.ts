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
	it("extracts Python declarations, calls, and inheritance with workspace-relative imports", () => {
		const files: SourceLanguageFile[] = [
			{ path: "pkg/base.py", content: "class Base:\n    pass\n" },
			{
				path: "pkg/consumer.py",
				content: "from .base import Base\n\nclass Child(Base):\n    async def run(self):\n        return Base()\n",
			},
		];
		const extraction = extract("pkg/consumer.py", { files });

		expect(extraction.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "function",
					name: "run",
					attributes: expect.objectContaining({ qualifiedName: "Child.run" }),
				}),
				expect.objectContaining({
					id: "file:pkg/consumer.py",
					attributes: expect.objectContaining({ adapter: "python-hybrid", precision: "hybrid" }),
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
		expect(extraction.edges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "extends", to: "symbol:pkg/base.py:class:Base" }),
				expect.objectContaining({
					kind: "calls",
					from: "symbol:pkg/consumer.py:function:Child.run",
					to: "symbol:pkg/base.py:class:Base",
				}),
			]),
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

	it("does not resolve unbound Python qualifiers or unimported bases across files", () => {
		const files: SourceLanguageFile[] = [
			{
				path: "unrelated.py",
				content: "class Base:\n    def run(self):\n        pass\n",
			},
			{
				path: "consumer.py",
				content: "class Child(Base):\n    def use(self, value):\n        value.run()\n",
			},
		];
		const extraction = extract("consumer.py", { files });

		expect(extraction.edges.some((edge) => edge.kind === "extends" || edge.kind === "calls")).toBe(false);
	});

	it("resolves Python self calls within the declaring class without treating nested declarations as calls", () => {
		const files: SourceLanguageFile[] = [
			{
				path: "worker.py",
				content: [
					"class Worker:",
					"    def run(self):",
					"        def nested():",
					"            return 1",
					"        return self.finish()",
					"",
					"    def finish(self):",
					"        return 2",
				].join("\n"),
			},
		];
		const extraction = extract("worker.py", { files });
		const calls = extraction.edges.filter((edge) => edge.kind === "calls");

		expect(calls).toEqual([
			expect.objectContaining({
				from: "symbol:worker.py:function:Worker.run",
				to: "symbol:worker.py:function:Worker.finish",
			}),
		]);
	});

	it("does not resolve imported Python functions through shadowing parameters", () => {
		const files: SourceLanguageFile[] = [
			{ path: "helpers.py", content: "def helper():\n    return 1\n" },
			{
				path: "consumer.py",
				content: "from helpers import helper\n\ndef run(helper):\n    return helper()\n",
			},
		];
		const extraction = extract("consumer.py", { files });

		expect(extraction.edges.some((edge) => edge.kind === "calls")).toBe(false);
	});

	it("does not resolve imported Python functions after module-level rebinding", () => {
		const files: SourceLanguageFile[] = [
			{ path: "helpers.py", content: "def helper():\n    return 1\n" },
			{
				path: "consumer.py",
				content: ["from helpers import helper", "helper = lambda: 2", "", "def run():", "    return helper()"].join(
					"\n",
				),
			},
		];
		const extraction = extract("consumer.py", { files });

		expect(extraction.edges.some((edge) => edge.kind === "calls")).toBe(false);
	});

	it("keeps escaped triple quotes inside Python strings", () => {
		const files: SourceLanguageFile[] = [
			{
				path: "strings.py",
				content: [
					String.raw`value = """text \"""`,
					"class Hidden:",
					"    pass",
					'"""',
					"class Visible:",
					"    pass",
				].join("\n"),
			},
		];
		const extraction = extract("strings.py", { files });
		const names = extraction.nodes.map((node) => node.name);

		expect(names).toContain("Visible");
		expect(names).not.toContain("Hidden");
	});

	it("extracts Go declarations and statically resolves package calls", () => {
		const files: SourceLanguageFile[] = [
			{
				path: "cmd/main.go",
				content: 'package main\n\nimport "example.com/project/internal/lib"\n\nfunc main() { lib.Two() }\n',
			},
			{ path: "internal/lib/one.go", content: "package lib\n\ntype One struct{}\n" },
			{ path: "internal/lib/two.go", content: "package lib\n\nfunc Two() {}\n" },
		];
		const project = { files, goModulePath: parseGoModulePath("module example.com/project\n\ngo 1.24\n") };
		const extraction = extract("cmd/main.go", project);

		expect(extraction.nodes).toContainEqual(expect.objectContaining({ kind: "function", name: "main" }));
		expect(extraction.edges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "imports", to: "file:internal/lib/one.go" }),
				expect.objectContaining({ kind: "imports", to: "file:internal/lib/two.go" }),
				expect.objectContaining({
					kind: "calls",
					from: "symbol:cmd/main.go:function:main",
					to: "symbol:internal/lib/two.go:function:Two",
				}),
			]),
		);
	});

	it("uses the declared Go package name for default imports", () => {
		const files: SourceLanguageFile[] = [
			{
				path: "cmd/main.go",
				content: 'package main\n\nimport "example.com/project/internal/client"\n\nfunc main() { api.Run() }\n',
			},
			{ path: "internal/client/client.go", content: "package api\n\nfunc Run() {}\n" },
		];
		const project = { files, goModulePath: "example.com/project" };
		const extraction = extract("cmd/main.go", project);

		expect(extraction.edges).toContainEqual(
			expect.objectContaining({
				kind: "calls",
				to: "symbol:internal/client/client.go:function:Run",
			}),
		);
	});

	it("does not infer Go calls from strings or parameter-shadowed package functions", () => {
		const files: SourceLanguageFile[] = [
			{ path: "helper.go", content: "package main\n\nfunc Helper() {}\n" },
			{
				path: "main.go",
				content: [
					"package main",
					"",
					"func Use(Helper func()) {",
					'    text := "Helper()"',
					"    Helper()",
					"    _ = text",
					"}",
					"",
					"func TextOnly() {",
					'    _ = "Helper()"',
					"}",
				].join("\n"),
			},
		];
		const extraction = extract("main.go", { files });

		expect(extraction.edges.some((edge) => edge.kind === "calls")).toBe(false);
	});

	it("does not resolve production Go calls to test-only declarations", () => {
		const files: SourceLanguageFile[] = [
			{ path: "worker.go", content: "package worker\n\nfunc Run() { TestOnly() }\n" },
			{ path: "worker_test.go", content: "package worker\n\nfunc TestOnly() {}\n" },
		];
		const extraction = extract("worker.go", { files });

		expect(extraction.edges.some((edge) => edge.kind === "calls")).toBe(false);
	});

	it("links Go methods to their statically declared receiver type", () => {
		const files: SourceLanguageFile[] = [
			{
				path: "worker.go",
				content: "package worker\n\ntype Worker struct{}\n\nfunc (w Worker) Run() {}\n",
			},
		];
		const extraction = extract("worker.go", { files });

		expect(extraction.nodes).toContainEqual(
			expect.objectContaining({
				id: "symbol:worker.go:method:Worker.Run",
				attributes: expect.objectContaining({ qualifiedName: "Worker.Run" }),
			}),
		);
		expect(extraction.edges).toContainEqual(
			expect.objectContaining({
				kind: "defined_on",
				from: "symbol:worker.go:method:Worker.Run",
				to: "symbol:worker.go:type:Worker",
			}),
		);
	});

	it("does not extract Go declarations from multiline raw strings", () => {
		const files: SourceLanguageFile[] = [
			{
				path: "main.go",
				content: [
					"package main",
					"const text = `",
					'import "example.com/project/internal/lib"',
					"func Hidden() {}",
					"`",
					"func Visible() {}",
				].join("\n"),
			},
			{ path: "internal/lib/lib.go", content: "package lib\n" },
		];
		const extraction = extract("main.go", { files, goModulePath: "example.com/project" });
		const names = extraction.nodes.map((node) => node.name);

		expect(names).toContain("Visible");
		expect(names).not.toContain("Hidden");
		expect(extraction.edges).toEqual([]);
	});

	it("does not let Go rune literals or local declarations corrupt package scope", () => {
		const files: SourceLanguageFile[] = [
			{ path: "helper.go", content: "package main\n\nfunc Helper() {}\n" },
			{
				path: "main.go",
				content: [
					"package main",
					"",
					"func First() {",
					"    type Local struct{}",
					"    _ = '{'",
					"}",
					"",
					"func Second() { Helper() }",
				].join("\n"),
			},
		];
		const extraction = extract("main.go", { files });

		expect(extraction.nodes.some((node) => node.name === "Local")).toBe(false);
		expect(extraction.nodes).toContainEqual(expect.objectContaining({ name: "Second", kind: "function" }));
		expect(extraction.edges).toContainEqual(
			expect.objectContaining({
				kind: "calls",
				from: "symbol:main.go:function:Second",
				to: "symbol:helper.go:function:Helper",
			}),
		);
	});

	it("restores Go package calls after leaving a shadowing block", () => {
		const files: SourceLanguageFile[] = [
			{ path: "helper.go", content: "package main\n\nfunc Helper() {}\n" },
			{
				path: "main.go",
				content: [
					"package main",
					"func Call() {",
					"    if true {",
					"        Helper := func() {}",
					"        Helper()",
					"    }",
					"    Helper()",
					"}",
				].join("\n"),
			},
		];
		const extraction = extract("main.go", { files });
		const calls = extraction.edges.filter((edge) => edge.kind === "calls");

		expect(calls).toEqual([
			expect.objectContaining({
				from: "symbol:main.go:function:Call",
				to: "symbol:helper.go:function:Helper",
			}),
		]);
	});

	it("extracts Rust declarations and resolves explicit crate calls", () => {
		const files: SourceLanguageFile[] = [
			{
				path: "src/lib.rs",
				content: "pub mod engine;\nuse crate::engine::Engine;\n\npub fn start() -> Engine { Engine::new() }\n",
			},
			{
				path: "src/engine.rs",
				content: [
					"pub trait Runnable {}",
					"pub struct Engine {}",
					"impl Runnable for Engine {}",
					"impl Engine {",
					"    pub fn new() -> Engine { Engine {} }",
					"}",
				].join("\n"),
			},
		];
		const extraction = extract("src/lib.rs", { files });

		expect(extraction.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "module", name: "engine" }),
				expect.objectContaining({ kind: "function", name: "start" }),
			]),
		);
		expect(extraction.edges.filter((edge) => edge.kind === "imports")).toHaveLength(2);
		expect(extraction.edges).toContainEqual(
			expect.objectContaining({
				kind: "calls",
				from: "symbol:src/lib.rs:function:start",
				to: "symbol:src/engine.rs:method:Engine.new",
			}),
		);

		const engine = extract("src/engine.rs", { files });
		expect(engine.edges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "implements",
					from: "symbol:src/engine.rs:struct:Engine",
					to: "symbol:src/engine.rs:trait:Runnable",
				}),
				expect.objectContaining({
					kind: "defined_on",
					from: "symbol:src/engine.rs:method:Engine.new",
					to: "symbol:src/engine.rs:struct:Engine",
				}),
			]),
		);
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

	it("does not infer Rust relationships from strings or unimported declarations", () => {
		const files: SourceLanguageFile[] = [
			{ path: "trait.rs", content: "pub trait Runnable {}\npub fn helper() {}\n" },
			{
				path: "lib.rs",
				content: [
					"pub struct Engine {}",
					"impl Runnable for Engine {}",
					"pub fn helper() {}",
					"pub fn start() {",
					'    let text = "helper()";',
					"    stringify!(helper());",
					"    let _ = text;",
					"}",
					"pub fn use_shadow(helper: fn()) { helper(); }",
				].join("\n"),
			},
		];
		const extraction = extract("lib.rs", { files });

		expect(extraction.edges.some((edge) => edge.kind === "implements" || edge.kind === "calls")).toBe(false);
	});

	it("resolves Rust associated calls only for a locally evidenced type", () => {
		const files: SourceLanguageFile[] = [
			{
				path: "lib.rs",
				content: [
					"pub struct Engine {}",
					"impl Engine {",
					"    pub fn new() -> Engine { Engine {} }",
					"}",
					"pub fn start() { Engine::new(); }",
				].join("\n"),
			},
		];
		const extraction = extract("lib.rs", { files });

		expect(extraction.edges).toContainEqual(
			expect.objectContaining({
				kind: "calls",
				from: "symbol:lib.rs:function:start",
				to: "symbol:lib.rs:method:Engine.new",
			}),
		);
	});

	it("does not infer Rust calls from macro definitions or nested function declarations", () => {
		const files: SourceLanguageFile[] = [
			{
				path: "lib.rs",
				content: [
					"pub fn helper() {}",
					"pub fn outer() {",
					"    macro_rules! deferred { () => { helper() } }",
					"    fn helper() {}",
					"}",
				].join("\n"),
			},
		];
		const extraction = extract("lib.rs", { files });

		expect(extraction.edges.some((edge) => edge.kind === "calls")).toBe(false);
	});

	it("keeps Rust impl and function scope stable across char literals and next-line braces", () => {
		const files: SourceLanguageFile[] = [
			{
				path: "lib.rs",
				content: [
					"pub struct Engine {}",
					"impl Engine",
					"{",
					"    pub fn run() {",
					"        let _ = '{';",
					"    }",
					"}",
					"pub fn after() {}",
				].join("\n"),
			},
		];
		const extraction = extract("lib.rs", { files });

		expect(extraction.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "symbol:lib.rs:method:Engine.run" }),
				expect.objectContaining({ id: "symbol:lib.rs:function:after" }),
			]),
		);
		expect(extraction.edges).toContainEqual(
			expect.objectContaining({
				kind: "defined_on",
				from: "symbol:lib.rs:method:Engine.run",
				to: "symbol:lib.rs:struct:Engine",
			}),
		);
	});

	it("restores Rust package calls after leaving a shadowing block", () => {
		const files: SourceLanguageFile[] = [
			{
				path: "lib.rs",
				content: [
					"pub fn helper() {}",
					"pub fn outer() {",
					"    {",
					"        let helper = || {};",
					"        helper();",
					"    }",
					"    helper();",
					"}",
				].join("\n"),
			},
		];
		const extraction = extract("lib.rs", { files });
		const calls = extraction.edges.filter((edge) => edge.kind === "calls");

		expect(calls).toEqual([
			expect.objectContaining({
				from: "symbol:lib.rs:function:outer",
				to: "symbol:lib.rs:function:helper",
			}),
		]);
	});

	it("represents cross-file Rust trait implementations through an owned implementation node", () => {
		const files: SourceLanguageFile[] = [
			{ path: "src/lib.rs", content: "pub mod engine;\npub mod traits;\npub mod impls;\n" },
			{ path: "src/engine.rs", content: "pub struct Engine {}\n" },
			{ path: "src/traits.rs", content: "pub trait Runnable {}\n" },
			{
				path: "src/impls.rs",
				content: ["use crate::engine::Engine;", "use crate::traits::Runnable;", "impl Runnable for Engine {}"].join(
					"\n",
				),
			},
		];
		const extraction = extract("src/impls.rs", { files });
		const implementation = extraction.nodes.find((node) => node.kind === "implementation");

		expect(implementation).toBeDefined();
		expect(extraction.edges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "defined_on",
					from: implementation!.id,
					to: "symbol:src/engine.rs:struct:Engine",
				}),
				expect.objectContaining({
					kind: "implements",
					from: implementation!.id,
					to: "symbol:src/traits.rs:trait:Runnable",
				}),
			]),
		);
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
