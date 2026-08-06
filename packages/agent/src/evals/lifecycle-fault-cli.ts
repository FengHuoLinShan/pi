#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	createCoreRuntimeLifecycleFaultScenario,
	type RuntimeLifecycleFaultLabReport,
	runRuntimeLifecycleFaultLab,
} from "./lifecycle-fault-lab.ts";

interface CliOptions {
	reportPath: string;
}

function parseArgs(args: string[]): CliOptions {
	let reportPath = ".artifacts/agent-lifecycle-fault-lab.json";
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--report") {
			reportPath = args[++index] ?? reportPath;
		} else {
			throw new Error(`Unknown lifecycle fault lab argument: ${argument}`);
		}
	}
	return { reportPath };
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function printSummary(report: RuntimeLifecycleFaultLabReport, reportPath: string): void {
	const passed = report.cases.filter((entry) => entry.passed).length;
	process.stdout.write(
		`Lifecycle fault lab: ${passed}/${report.cases.length} fault cases passed; report=${reportPath}\n`,
	);
	if (report.firstFailure) {
		const { fault, violations } = report.firstFailure;
		process.stdout.write(
			`FAIL step=${fault.stepIndex} event=${fault.eventType} phase=${fault.phase}: ${
				violations.join("; ") || "fault was not observed"
			}\n`,
		);
	}
}

export async function runRuntimeLifecycleFaultLabCli(args: string[]): Promise<number> {
	const options = parseArgs(args);
	const reportPath = resolve(options.reportPath);
	const report = await runRuntimeLifecycleFaultLab(createCoreRuntimeLifecycleFaultScenario());
	await writeJson(reportPath, report);
	printSummary(report, reportPath);
	return report.passed ? 0 : 1;
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPath === import.meta.url) {
	runRuntimeLifecycleFaultLabCli(process.argv.slice(2)).then(
		(exitCode) => {
			process.exitCode = exitCode;
		},
		(error) => {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		},
	);
}
