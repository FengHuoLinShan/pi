#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createBrowserJsonlCapabilityDriver } from "./browser-driver.ts";
import { type CapabilityEvalCommandSpec, createJsonlCommandCapabilityDriver } from "./jsonl-command-driver.ts";
import { createOfflineCapabilityEvalDrivers } from "./mock-mcp-driver.ts";
import type { CapabilityEvalDriver, CapabilityEvalReport } from "./runner.ts";
import { runCapabilityEvalSuite } from "./runner.ts";
import { type CapabilityEvalLayer, type CapabilityEvalSuite, parseCapabilityEvalSuite } from "./schema.ts";

interface CapabilityEvalCliOptions {
	suitePath: string;
	reportPath: string;
	driverConfigPath?: string;
	journalPath?: string;
	layers?: CapabilityEvalLayer[];
	allowLive: boolean;
	secretEnvironmentNames: string[];
	scenarioIds: string[];
}

interface DriverConfigEntry {
	kind: "jsonl-command" | "browser-jsonl-command";
	spec: CapabilityEvalCommandSpec;
}

const sensitiveEnvironmentNamePattern = /(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLayer(value: string | undefined): CapabilityEvalLayer {
	if (value === "offline" || value === "browser" || value === "live") return value;
	throw new Error(`Invalid capability eval layer: ${value ?? "missing"}`);
}

function parseArgs(args: string[]): CapabilityEvalCliOptions {
	let suitePath: string | undefined;
	let reportPath = ".artifacts/capability-evals.json";
	let driverConfigPath: string | undefined;
	let journalPath: string | undefined;
	let layers: CapabilityEvalLayer[] | undefined;
	let allowLive = false;
	const secretEnvironmentNames: string[] = [];
	const scenarioIds: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--suite") suitePath = args[++index];
		else if (argument === "--report") reportPath = args[++index] ?? reportPath;
		else if (argument === "--drivers") driverConfigPath = args[++index];
		else if (argument === "--journal") journalPath = args[++index];
		else if (argument === "--layer") {
			layers ??= [];
			layers.push(parseLayer(args[++index]));
		} else if (argument === "--allow-live") allowLive = true;
		else if (argument === "--scenario") {
			const id = args[++index];
			if (!id) throw new Error("--scenario requires a scenario id");
			scenarioIds.push(id);
		} else if (argument === "--secret-env") {
			const name = args[++index];
			if (!name) throw new Error("--secret-env requires an environment variable name");
			secretEnvironmentNames.push(name);
		} else throw new Error(`Unknown capability eval argument: ${argument}`);
	}
	if (!suitePath) throw new Error("Capability eval requires --suite <path>");
	return {
		suitePath,
		reportPath,
		driverConfigPath,
		journalPath,
		layers,
		allowLive,
		secretEnvironmentNames,
		scenarioIds,
	};
}

export function selectCapabilityEvalScenarios(
	suite: CapabilityEvalSuite,
	scenarioIds: readonly string[],
): CapabilityEvalSuite {
	if (scenarioIds.length === 0) return suite;
	const selectedIds = new Set(scenarioIds);
	const availableIds = new Set(suite.scenarios.map((scenario) => scenario.id));
	const missingIds = [...selectedIds].filter((id) => !availableIds.has(id));
	if (missingIds.length > 0) throw new Error(`Unknown capability eval scenario: ${missingIds.join(", ")}`);
	return { ...suite, scenarios: suite.scenarios.filter((scenario) => selectedIds.has(scenario.id)) };
}

function parseStringArray(value: unknown, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		throw new Error(`Driver ${field} must be an array of strings`);
	}
	return value;
}

function parseStringRecord(value: unknown, field: string): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || !Object.values(value).every((item) => typeof item === "string")) {
		throw new Error(`Driver ${field} must be an object of strings`);
	}
	return value as Record<string, string>;
}

function parseCommandSpec(value: unknown, id: string): CapabilityEvalCommandSpec {
	if (!isRecord(value) || typeof value.command !== "string" || value.command.length === 0) {
		throw new Error(`Driver ${id} requires spec.command`);
	}
	if (value.cwd !== undefined && typeof value.cwd !== "string")
		throw new Error(`Driver ${id} spec.cwd must be string`);
	if (value.inheritEnvironment !== undefined && typeof value.inheritEnvironment !== "boolean") {
		throw new Error(`Driver ${id} spec.inheritEnvironment must be boolean`);
	}
	if (
		value.maxOutputBytes !== undefined &&
		(!Number.isInteger(value.maxOutputBytes) || Number(value.maxOutputBytes) < 1)
	) {
		throw new Error(`Driver ${id} spec.maxOutputBytes must be a positive integer`);
	}
	return {
		command: value.command,
		args: parseStringArray(value.args, `${id} spec.args`),
		cwd: value.cwd as string | undefined,
		environment: parseStringRecord(value.environment, `${id} spec.environment`),
		inheritEnvironment: value.inheritEnvironment as boolean | undefined,
		collectArtifacts: parseStringArray(value.collectArtifacts, `${id} spec.collectArtifacts`),
		maxOutputBytes: value.maxOutputBytes as number | undefined,
	};
}

function parseDriverConfig(value: unknown): Record<string, DriverConfigEntry> {
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.drivers)) {
		throw new Error("Invalid capability eval driver config");
	}
	const drivers: Record<string, DriverConfigEntry> = {};
	for (const [id, entry] of Object.entries(value.drivers)) {
		if (!isRecord(entry) || (entry.kind !== "jsonl-command" && entry.kind !== "browser-jsonl-command")) {
			throw new Error(`Invalid capability eval driver ${id}`);
		}
		drivers[id] = { kind: entry.kind, spec: parseCommandSpec(entry.spec, id) };
	}
	return drivers;
}

async function readJson(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function printSummary(report: CapabilityEvalReport, reportPath: string): void {
	const evaluated = report.scenarios.filter((scenario) => scenario.status !== "skipped");
	const passed = evaluated.filter((scenario) => scenario.passed).length;
	process.stdout.write(`Capability eval: ${passed}/${evaluated.length} passed; report=${reportPath}\n`);
	for (const scenario of report.scenarios) {
		process.stdout.write(
			`${scenario.status.toUpperCase()} ${scenario.id} (${scenario.passingAttempts}/${scenario.attempts.length})\n`,
		);
		for (const attempt of scenario.attempts) {
			for (const assertion of attempt.assertions.filter((candidate) => !candidate.passed)) {
				process.stdout.write(
					`  attempt ${attempt.attempt} ${assertion.name}: ${assertion.message ?? "assertion failed"}\n`,
				);
			}
		}
	}
}

export function collectCapabilityEvalSecretValues(explicitNames: readonly string[]): string[] {
	const names = new Set([
		...explicitNames,
		...Object.keys(process.env).filter((name) => sensitiveEnvironmentNamePattern.test(name)),
	]);
	return [...names].flatMap((name) => {
		const value = process.env[name];
		return value ? [value] : [];
	});
}

export async function runCapabilityEvalCli(args: string[]): Promise<number> {
	const options = parseArgs(args);
	const suitePath = resolve(options.suitePath);
	const reportPath = resolve(options.reportPath);
	const suite = selectCapabilityEvalScenarios(
		parseCapabilityEvalSuite(await readJson(suitePath)),
		options.scenarioIds,
	);
	const selectedLayers = options.layers ?? ["offline", "browser", "live"];
	const liveSelected =
		selectedLayers.includes("live") && suite.scenarios.some((scenario) => scenario.layer === "live");
	if (liveSelected && (!options.allowLive || process.env.RUN_PI_LIVE_CAPABILITY_EVALS !== "1")) {
		throw new Error("Live capability evals require RUN_PI_LIVE_CAPABILITY_EVALS=1 and --allow-live");
	}
	const drivers: Record<string, CapabilityEvalDriver> = createOfflineCapabilityEvalDrivers();
	if (options.driverConfigPath) {
		const driverEntries = parseDriverConfig(await readJson(resolve(options.driverConfigPath)));
		for (const [id, entry] of Object.entries(driverEntries)) {
			drivers[id] =
				entry.kind === "browser-jsonl-command"
					? createBrowserJsonlCapabilityDriver(entry.spec)
					: createJsonlCommandCapabilityDriver(entry.spec);
		}
	}
	const secretValues = collectCapabilityEvalSecretValues(options.secretEnvironmentNames);
	const report = await runCapabilityEvalSuite(suite, {
		cwd: dirname(suitePath),
		drivers,
		layers: options.layers,
		allowLive: options.allowLive && process.env.RUN_PI_LIVE_CAPABILITY_EVALS === "1",
		journalPath: options.journalPath ? resolve(options.journalPath) : undefined,
		secretValues,
	});
	await writeJson(reportPath, report);
	printSummary(report, reportPath);
	return report.passed ? 0 : 1;
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPath === import.meta.url) {
	runCapabilityEvalCli(process.argv.slice(2)).then(
		(exitCode) => {
			process.exitCode = exitCode;
		},
		(error) => {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		},
	);
}
