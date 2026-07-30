import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CapabilityEvalJournal } from "./journal.ts";
import { redactCapabilityEvalText, redactCapabilityEvalValue } from "./redaction.ts";
import type {
	CapabilityEvalAttemptPolicy,
	CapabilityEvalBudgets,
	CapabilityEvalLayer,
	CapabilityEvalScenario,
	CapabilityEvalSuite,
	CapabilityEvalVerifier,
} from "./schema.ts";

export interface CapabilityEvalMetrics {
	wallTimeMs: number;
	modelRequests: number;
	toolCalls: number;
	totalTokens: number;
	orphanProcesses: number;
}

export interface CapabilityEvalDriverResult {
	status: "completed" | "failed" | "aborted";
	output: string;
	metrics?: Partial<CapabilityEvalMetrics>;
	trace?: string[];
	lifecycle?: string[];
	artifacts?: Record<string, string>;
	details?: unknown;
	error?: string;
}

export interface CapabilityEvalAttemptContext {
	suiteName: string;
	scenario: CapabilityEvalScenario;
	attempt: number;
	cwd: string;
	signal: AbortSignal;
	journal: CapabilityEvalJournal;
}

export interface CapabilityEvalDriver {
	runAttempt(context: CapabilityEvalAttemptContext): Promise<CapabilityEvalDriverResult>;
	cleanupAttempt?(context: CapabilityEvalAttemptContext): Promise<void>;
}

export interface CapabilityEvalVerifierContext {
	scenario: CapabilityEvalScenario;
	attempt: number;
	result: CapabilityEvalDriverResult & { metrics: CapabilityEvalMetrics };
	config?: Record<string, unknown>;
}

export interface CapabilityEvalCustomVerifierResult {
	passed: boolean;
	message?: string;
	expected?: unknown;
	actual?: unknown;
}

export type CapabilityEvalCustomVerifier = (
	context: CapabilityEvalVerifierContext,
) => CapabilityEvalCustomVerifierResult | Promise<CapabilityEvalCustomVerifierResult>;

export interface CapabilityEvalAssertionResult {
	name: string;
	passed: boolean;
	expected?: unknown;
	actual?: unknown;
	message?: string;
}

export interface CapabilityEvalAttemptResult {
	attempt: number;
	passed: boolean;
	status: CapabilityEvalDriverResult["status"];
	output: string;
	metrics: CapabilityEvalMetrics;
	trace: string[];
	lifecycle: string[];
	artifacts: Record<string, string>;
	assertions: CapabilityEvalAssertionResult[];
	details?: unknown;
	error?: string;
}

export interface CapabilityEvalScenarioResult {
	id: string;
	description?: string;
	layer: CapabilityEvalLayer;
	driver: string;
	status: "passed" | "failed" | "skipped";
	passed: boolean;
	passingAttempts: number;
	requiredPassingAttempts: number;
	attempts: CapabilityEvalAttemptResult[];
}

export interface CapabilityEvalReport {
	version: 1;
	suiteName: string;
	generatedAt: string;
	passed: boolean;
	passRate: number;
	enabledLayers: CapabilityEvalLayer[];
	runtime: {
		node: string;
		platform: NodeJS.Platform;
		arch: string;
	};
	scenarios: CapabilityEvalScenarioResult[];
	journalDigest: string;
}

export interface RunCapabilityEvalSuiteOptions {
	cwd?: string;
	drivers: Record<string, CapabilityEvalDriver>;
	verifiers?: Record<string, CapabilityEvalCustomVerifier>;
	layers?: CapabilityEvalLayer[];
	allowLive?: boolean;
	journalPath?: string;
	secretValues?: string[];
}

const defaultBudgets: Required<CapabilityEvalBudgets> = {
	maxWallTimeMs: 120_000,
	maxModelRequests: 12,
	maxToolCalls: 24,
	maxTotalTokens: 80_000,
};

const defaultAttempts: CapabilityEvalAttemptPolicy = { count: 1, minimumPassing: 1 };

function mergeBudgets(suite: CapabilityEvalSuite, scenario: CapabilityEvalScenario): Required<CapabilityEvalBudgets> {
	return {
		maxWallTimeMs:
			scenario.budgets?.maxWallTimeMs ?? suite.defaults?.budgets?.maxWallTimeMs ?? defaultBudgets.maxWallTimeMs,
		maxModelRequests:
			scenario.budgets?.maxModelRequests ??
			suite.defaults?.budgets?.maxModelRequests ??
			defaultBudgets.maxModelRequests,
		maxToolCalls:
			scenario.budgets?.maxToolCalls ?? suite.defaults?.budgets?.maxToolCalls ?? defaultBudgets.maxToolCalls,
		maxTotalTokens:
			scenario.budgets?.maxTotalTokens ?? suite.defaults?.budgets?.maxTotalTokens ?? defaultBudgets.maxTotalTokens,
	};
}

function resolveAttempts(suite: CapabilityEvalSuite, scenario: CapabilityEvalScenario): CapabilityEvalAttemptPolicy {
	return scenario.attempts ?? suite.defaults?.attempts ?? defaultAttempts;
}

function includesOrdered(
	actual: readonly string[],
	expected: readonly string[],
): { passed: boolean; missing?: string } {
	let index = 0;
	for (const item of expected) {
		while (index < actual.length && actual[index] !== item) index++;
		if (index >= actual.length) return { passed: false, missing: item };
		index++;
	}
	return { passed: true };
}

function evaluateMetric(actual: number, verifier: Extract<CapabilityEvalVerifier, { type: "metric" }>): boolean {
	if (verifier.operator === "equals") return actual === verifier.expected;
	if (verifier.operator === "lte") return actual <= verifier.expected;
	return actual >= verifier.expected;
}

function resolveJsonPointer(value: unknown, pointer: string): { found: boolean; value?: unknown } {
	if (pointer === "") return { found: true, value };
	let current = value;
	for (const encodedSegment of pointer.slice(1).split("/")) {
		const segment = encodedSegment.replace(/~1/gu, "/").replace(/~0/gu, "~");
		if (Array.isArray(current)) {
			if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) return { found: false };
			const index = Number(segment);
			if (index >= current.length) return { found: false };
			current = current[index];
			continue;
		}
		if (typeof current !== "object" || current === null || !Object.hasOwn(current, segment)) {
			return { found: false };
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return { found: true, value: current };
}

async function evaluateVerifier(
	verifier: CapabilityEvalVerifier,
	context: CapabilityEvalVerifierContext,
	customVerifiers: Record<string, CapabilityEvalCustomVerifier>,
): Promise<CapabilityEvalAssertionResult> {
	const { result } = context;
	if (verifier.type === "output") {
		const passed =
			verifier.operator === "equals"
				? result.output === verifier.expected
				: verifier.operator === "contains"
					? result.output.includes(verifier.expected)
					: new RegExp(verifier.expected, "u").test(result.output);
		return {
			name: `output.${verifier.operator}`,
			passed,
			expected: verifier.expected,
			actual: result.output,
		};
	}
	if (verifier.type === "trace_order" || verifier.type === "lifecycle_order") {
		const actual = verifier.type === "trace_order" ? (result.trace ?? []) : (result.lifecycle ?? []);
		const comparison = includesOrdered(actual, verifier.expected);
		return {
			name: verifier.type,
			passed: comparison.passed,
			expected: verifier.expected,
			actual,
			...(comparison.missing ? { message: `Missing ordered event ${comparison.missing}` } : {}),
		};
	}
	if (verifier.type === "metric") {
		const actual = result.metrics[verifier.metric];
		return {
			name: `metric.${verifier.metric}.${verifier.operator}`,
			passed: evaluateMetric(actual, verifier),
			expected: verifier.expected,
			actual,
		};
	}
	if (verifier.type === "artifact_exists" || verifier.type === "artifact_contains") {
		const artifact = result.artifacts?.[verifier.path];
		const passed =
			verifier.type === "artifact_exists"
				? artifact !== undefined
				: artifact?.includes(verifier.expected as string) === true;
		return {
			name: `${verifier.type}:${verifier.path}`,
			passed,
			...(verifier.type === "artifact_contains" ? { expected: verifier.expected } : {}),
			actual: artifact,
		};
	}
	if (verifier.type === "artifact_json") {
		const artifact = result.artifacts?.[verifier.path];
		if (artifact === undefined) {
			return {
				name: `artifact_json:${verifier.path}:${verifier.pointer}`,
				passed: false,
				expected: verifier.expected,
				message: "Artifact is missing",
			};
		}
		try {
			const selected = resolveJsonPointer(JSON.parse(artifact), verifier.pointer);
			return {
				name: `artifact_json:${verifier.path}:${verifier.pointer}`,
				passed: selected.found && isDeepStrictEqual(selected.value, verifier.expected),
				expected: verifier.expected,
				actual: selected.value,
				...(selected.found ? {} : { message: "JSON pointer was not found" }),
			};
		} catch (error) {
			return {
				name: `artifact_json:${verifier.path}:${verifier.pointer}`,
				passed: false,
				expected: verifier.expected,
				message: `Artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}
	const customVerifier = customVerifiers[verifier.name];
	if (!customVerifier) {
		return { name: `custom:${verifier.name}`, passed: false, message: "Custom verifier is not registered" };
	}
	try {
		return { name: `custom:${verifier.name}`, ...(await customVerifier({ ...context, config: verifier.config })) };
	} catch (error) {
		return {
			name: `custom:${verifier.name}`,
			passed: false,
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

function budgetAssertions(
	metrics: CapabilityEvalMetrics,
	budgets: Required<CapabilityEvalBudgets>,
): CapabilityEvalAssertionResult[] {
	return [
		{
			name: "budget.maxWallTimeMs",
			passed: metrics.wallTimeMs <= budgets.maxWallTimeMs,
			expected: `<= ${budgets.maxWallTimeMs}`,
			actual: metrics.wallTimeMs,
		},
		{
			name: "budget.maxModelRequests",
			passed: metrics.modelRequests <= budgets.maxModelRequests,
			expected: `<= ${budgets.maxModelRequests}`,
			actual: metrics.modelRequests,
		},
		{
			name: "budget.maxToolCalls",
			passed: metrics.toolCalls <= budgets.maxToolCalls,
			expected: `<= ${budgets.maxToolCalls}`,
			actual: metrics.toolCalls,
		},
		{
			name: "budget.maxTotalTokens",
			passed: metrics.totalTokens <= budgets.maxTotalTokens,
			expected: `<= ${budgets.maxTotalTokens}`,
			actual: metrics.totalTokens,
		},
	];
}

function timeoutError(milliseconds: number): Error {
	return new Error(`Capability eval attempt exceeded ${milliseconds}ms`);
}

async function cleanupAttempt(
	driver: CapabilityEvalDriver,
	context: CapabilityEvalAttemptContext,
	maximumMilliseconds: number,
): Promise<void> {
	if (!driver.cleanupAttempt) return;
	let timeout: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			driver.cleanupAttempt(context),
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(
					() => reject(new Error(`Capability eval cleanup exceeded ${maximumMilliseconds}ms`)),
					maximumMilliseconds,
				);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

async function runAttempt(
	suite: CapabilityEvalSuite,
	scenario: CapabilityEvalScenario,
	attempt: number,
	driver: CapabilityEvalDriver,
	options: RunCapabilityEvalSuiteOptions,
	journal: CapabilityEvalJournal,
): Promise<CapabilityEvalAttemptResult> {
	const budgets = mergeBudgets(suite, scenario);
	const controller = new AbortController();
	const context: CapabilityEvalAttemptContext = {
		suiteName: suite.name,
		scenario,
		attempt,
		cwd: resolve(options.cwd ?? process.cwd()),
		signal: controller.signal,
		journal,
	};
	journal.write({ scenario: scenario.id, attempt, event: "attempt.started", data: { driver: scenario.driver.id } });
	const startedAt = performance.now();
	let timeout: NodeJS.Timeout | undefined;
	let driverResult: CapabilityEvalDriverResult;
	let cleanupError: string | undefined;
	let deadlineExceeded = false;
	let attemptError: string | undefined;
	let settledDriverResult: CapabilityEvalDriverResult | undefined;
	const driverPromise = Promise.resolve()
		.then(() => driver.runAttempt(context))
		.then((result) => {
			settledDriverResult = result;
			return result;
		});
	try {
		const deadline = new Promise<never>((_resolve, reject) => {
			timeout = setTimeout(() => {
				deadlineExceeded = true;
				controller.abort(timeoutError(budgets.maxWallTimeMs));
				reject(timeoutError(budgets.maxWallTimeMs));
			}, budgets.maxWallTimeMs);
		});
		driverResult = await Promise.race([driverPromise, deadline]);
	} catch (error) {
		attemptError = error instanceof Error ? error.message : String(error);
		driverResult = {
			status: controller.signal.aborted ? "aborted" : "failed",
			output: "",
			error: attemptError,
		};
	} finally {
		if (timeout) clearTimeout(timeout);
		controller.abort();
		journal.write({ scenario: scenario.id, attempt, event: "cleanup.started" });
		try {
			const cleanupGraceMs = Math.min(5_000, Math.max(2_500, Math.floor(budgets.maxWallTimeMs / 10)));
			await cleanupAttempt(driver, context, cleanupGraceMs);
			journal.write({ scenario: scenario.id, attempt, event: "cleanup.finished" });
		} catch (error) {
			cleanupError = error instanceof Error ? error.message : String(error);
			journal.write({ scenario: scenario.id, attempt, event: "cleanup.failed", data: { error: cleanupError } });
		}
	}
	if (deadlineExceeded && settledDriverResult) {
		driverResult = {
			...settledDriverResult,
			status: "aborted",
			error: attemptError ?? timeoutError(budgets.maxWallTimeMs).message,
		};
	}

	const wallTimeMs = Math.max(0, performance.now() - startedAt);
	const metrics: CapabilityEvalMetrics = {
		wallTimeMs,
		modelRequests: driverResult.metrics?.modelRequests ?? 0,
		toolCalls: driverResult.metrics?.toolCalls ?? 0,
		totalTokens: driverResult.metrics?.totalTokens ?? 0,
		orphanProcesses: driverResult.metrics?.orphanProcesses ?? 0,
	};
	const normalizedResult = { ...driverResult, metrics };
	const assertions: CapabilityEvalAssertionResult[] = [
		{
			name: "driver.completed",
			passed: driverResult.status === "completed",
			expected: "completed",
			actual: driverResult.status,
			...(driverResult.error ? { message: driverResult.error } : {}),
		},
		...budgetAssertions(metrics, budgets),
	];
	for (const verifier of scenario.verifiers) {
		assertions.push(
			await evaluateVerifier(verifier, { scenario, attempt, result: normalizedResult }, options.verifiers ?? {}),
		);
	}
	if (cleanupError) assertions.push({ name: "cleanup", passed: false, actual: cleanupError });
	const passed = assertions.every((assertion) => assertion.passed);
	journal.write({ scenario: scenario.id, attempt, event: "attempt.finished", data: { passed, metrics } });
	const redactionOptions = { secretValues: options.secretValues };
	return {
		attempt,
		passed,
		status: driverResult.status,
		output: redactCapabilityEvalText(driverResult.output, redactionOptions),
		metrics,
		trace: (driverResult.trace ?? []).map((entry) => redactCapabilityEvalText(entry, redactionOptions)),
		lifecycle: (driverResult.lifecycle ?? []).map((entry) => redactCapabilityEvalText(entry, redactionOptions)),
		artifacts: Object.fromEntries(
			Object.entries(driverResult.artifacts ?? {}).map(([path, value]) => [
				path,
				redactCapabilityEvalText(value, redactionOptions),
			]),
		),
		assertions: redactCapabilityEvalValue(assertions, redactionOptions) as CapabilityEvalAssertionResult[],
		...(driverResult.details === undefined
			? {}
			: { details: redactCapabilityEvalValue(driverResult.details, redactionOptions) }),
		...(driverResult.error === undefined
			? {}
			: { error: redactCapabilityEvalText(driverResult.error, redactionOptions) }),
	};
}

function journalDigest(journal: CapabilityEvalJournal): string {
	const stableEvents = journal.events.map(({ timestamp: _timestamp, ...event }) => event);
	return createHash("sha256").update(JSON.stringify(stableEvents)).digest("hex");
}

/** Run capability scenarios sequentially so lifecycle and process-leak evidence stays attributable. */
export async function runCapabilityEvalSuite(
	suite: CapabilityEvalSuite,
	options: RunCapabilityEvalSuiteOptions,
): Promise<CapabilityEvalReport> {
	const enabledLayers = options.layers ?? ["offline", "browser", "live"];
	if (
		enabledLayers.includes("live") &&
		!options.allowLive &&
		suite.scenarios.some((scenario) => scenario.layer === "live")
	) {
		throw new Error("Live capability evals require allowLive: true");
	}
	if (options.journalPath) await mkdir(resolve(options.journalPath, ".."), { recursive: true });
	const journal = new CapabilityEvalJournal({
		suite: suite.name,
		path: options.journalPath,
		secretValues: options.secretValues,
	});
	journal.write({ event: "suite.started", data: { enabledLayers } });
	const scenarios: CapabilityEvalScenarioResult[] = [];
	for (const scenario of suite.scenarios) {
		const policy = resolveAttempts(suite, scenario);
		if (!enabledLayers.includes(scenario.layer)) {
			scenarios.push({
				id: scenario.id,
				description: scenario.description,
				layer: scenario.layer,
				driver: scenario.driver.id,
				status: "skipped",
				passed: true,
				passingAttempts: 0,
				requiredPassingAttempts: policy.minimumPassing,
				attempts: [],
			});
			journal.write({ scenario: scenario.id, event: "scenario.skipped", data: { layer: scenario.layer } });
			continue;
		}
		const driver = options.drivers[scenario.driver.id];
		if (!driver) {
			scenarios.push({
				id: scenario.id,
				description: scenario.description,
				layer: scenario.layer,
				driver: scenario.driver.id,
				status: "failed",
				passed: false,
				passingAttempts: 0,
				requiredPassingAttempts: policy.minimumPassing,
				attempts: [],
			});
			journal.write({
				scenario: scenario.id,
				event: "scenario.missing_driver",
				data: { driver: scenario.driver.id },
			});
			continue;
		}
		journal.write({ scenario: scenario.id, event: "scenario.started" });
		const attempts: CapabilityEvalAttemptResult[] = [];
		for (let attempt = 1; attempt <= policy.count; attempt++) {
			attempts.push(await runAttempt(suite, scenario, attempt, driver, options, journal));
		}
		const passingAttempts = attempts.filter((attempt) => attempt.passed).length;
		const passed = passingAttempts >= policy.minimumPassing;
		scenarios.push({
			id: scenario.id,
			description: scenario.description,
			layer: scenario.layer,
			driver: scenario.driver.id,
			status: passed ? "passed" : "failed",
			passed,
			passingAttempts,
			requiredPassingAttempts: policy.minimumPassing,
			attempts,
		});
		journal.write({ scenario: scenario.id, event: "scenario.finished", data: { passed, passingAttempts } });
	}
	const evaluated = scenarios.filter((scenario) => scenario.status !== "skipped");
	const passing = evaluated.filter((scenario) => scenario.passed).length;
	const passRate = evaluated.length === 0 ? 0 : passing / evaluated.length;
	const passed = evaluated.length > 0 && evaluated.every((scenario) => scenario.passed);
	journal.write({ event: "suite.finished", data: { passed, passRate } });
	await journal.flush();
	return {
		version: 1,
		suiteName: suite.name,
		generatedAt: new Date().toISOString(),
		passed,
		passRate,
		enabledLayers,
		runtime: { node: process.version, platform: process.platform, arch: process.arch },
		scenarios,
		journalDigest: journalDigest(journal),
	};
}

/** Collect a small text artifact without allowing a scenario to escape its workspace. */
export async function readCapabilityEvalArtifact(cwd: string, relativePath: string): Promise<string> {
	const root = resolve(cwd);
	const path = resolve(root, relativePath);
	if (path !== root && !path.startsWith(`${root}/`))
		throw new Error(`Artifact path escapes eval workspace: ${relativePath}`);
	return readFile(path, "utf8");
}
