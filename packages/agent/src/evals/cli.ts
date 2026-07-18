#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentHarnessEvalReport } from "./runner.ts";
import { createAgentHarnessEvalBaseline, parseAgentHarnessEvalBaseline, runAgentHarnessEvalSuite } from "./runner.ts";
import { parseAgentHarnessEvalSuite } from "./schema.ts";

interface CliOptions {
	suitePath: string;
	baselinePath?: string;
	reportPath: string;
	updateBaseline: boolean;
}

function parseArgs(args: string[]): CliOptions {
	let suitePath: string | undefined;
	let baselinePath: string | undefined;
	let reportPath = ".artifacts/agent-harness-evals.json";
	let updateBaseline = false;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--suite") suitePath = args[++index];
		else if (argument === "--baseline") baselinePath = args[++index];
		else if (argument === "--report") reportPath = args[++index] ?? reportPath;
		else if (argument === "--update-baseline") updateBaseline = true;
		else throw new Error(`Unknown eval argument: ${argument}`);
	}
	if (!suitePath) throw new Error("AgentHarness eval requires --suite <path>");
	if (updateBaseline && !baselinePath) throw new Error("--update-baseline requires --baseline <path>");
	return { suitePath, baselinePath, reportPath, updateBaseline };
}

async function readJson(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function printSummary(report: AgentHarnessEvalReport, reportPath: string): void {
	const passed = report.scenarios.filter((scenario) => scenario.passed).length;
	process.stdout.write(`AgentHarness eval: ${passed}/${report.scenarios.length} passed; report=${reportPath}\n`);
	for (const scenario of report.scenarios) {
		process.stdout.write(`${scenario.passed ? "PASS" : "FAIL"} ${scenario.id}\n`);
		for (const assertion of scenario.assertions.filter((candidate) => !candidate.passed)) {
			process.stdout.write(`  ${assertion.name}: ${assertion.message ?? "assertion failed"}\n`);
		}
	}
	for (const violation of report.baselineComparison?.violations ?? []) {
		process.stdout.write(`GATE ${violation}\n`);
	}
}

export async function runAgentHarnessEvalCli(args: string[]): Promise<number> {
	const options = parseArgs(args);
	const suitePath = resolve(options.suitePath);
	const reportPath = resolve(options.reportPath);
	const baselinePath = options.baselinePath ? resolve(options.baselinePath) : undefined;
	const suite = parseAgentHarnessEvalSuite(await readJson(suitePath));
	const baseline =
		baselinePath && !options.updateBaseline ? parseAgentHarnessEvalBaseline(await readJson(baselinePath)) : undefined;
	const report = await runAgentHarnessEvalSuite(suite, { cwd: dirname(suitePath), baseline });
	if (options.updateBaseline && baselinePath) {
		await writeJson(baselinePath, createAgentHarnessEvalBaseline(report));
	}
	await writeJson(reportPath, report);
	printSummary(report, reportPath);
	return report.passed ? 0 : 1;
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPath === import.meta.url) {
	runAgentHarnessEvalCli(process.argv.slice(2)).then(
		(exitCode) => {
			process.exitCode = exitCode;
		},
		(error) => {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		},
	);
}
