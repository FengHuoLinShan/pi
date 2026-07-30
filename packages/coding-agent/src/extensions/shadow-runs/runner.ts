import { join } from "node:path";
import {
	COMPLETION_CONTRACT_VERSION,
	type CompletionContract,
	type CompletionVerifier,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../config.ts";
import type { SessionStats } from "../../core/agent-session.ts";
import { execCommand } from "../../core/exec.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import { ModelRuntime } from "../../core/model-runtime.ts";
import { DefaultResourceLoader } from "../../core/resource-loader.ts";
import { createAgentSession } from "../../core/sdk.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import type { ShadowRunContext, ShadowRunVerificationContext } from "../../core/shadow-runs.ts";
import type { WorkspaceOverlay } from "../../core/workspace-overlay.ts";
import type {
	ShadowRunsBudgetConfig,
	ShadowRunsCandidateConfig,
	ShadowRunsCheckConfig,
	ShadowRunsConfig,
} from "./config.ts";

const MAX_EVIDENCE_OUTPUT_BYTES = 16 * 1024;

export interface ShadowAgentOutput {
	response: string;
	model: { provider: string; id: string };
	thinkingLevel: ThinkingLevel;
	usage: {
		assistantTurns: number;
		toolCalls: number;
		tokens: number;
		cost: number;
	};
	warnings: string[];
}

export interface ShadowCandidateRunnerOptions {
	objective: string;
	model: Model<Api>;
	baseThinkingLevel: ThinkingLevel;
	budget: ShadowRunsBudgetConfig;
}

export interface RunShadowCandidateAgentOptions extends ShadowCandidateRunnerOptions {
	modelRuntime: ModelRuntime;
	agentDir: string;
}

export type ShadowCandidateRunner = (
	context: ShadowRunContext<ShadowRunsCandidateConfig>,
	options: ShadowCandidateRunnerOptions,
) => Promise<ShadowAgentOutput>;

export interface ShadowCandidateRunnerFactoryOptions {
	model: Model<Api>;
	modelRegistry: ModelRegistry;
	baseThinkingLevel: ThinkingLevel;
}

export type ShadowCandidateRunnerFactory = (options: ShadowCandidateRunnerFactoryOptions) => ShadowCandidateRunner;

function truncateUtf8Tail(value: string, maximumBytes: number): string {
	const content = Buffer.from(value);
	if (content.byteLength <= maximumBytes) return value;
	return `[truncated to last ${maximumBytes} bytes]\n${content.subarray(content.byteLength - maximumBytes).toString("utf8")}`;
}

function commandReference(check: ShadowRunsCheckConfig): string {
	return [check.command, ...check.args].map((part) => JSON.stringify(part)).join(" ");
}

export function createShadowCompletionContract(
	objective: string,
	checks: readonly ShadowRunsCheckConfig[],
): CompletionContract {
	return {
		version: COMPLETION_CONTRACT_VERSION,
		id: "shadow-runs",
		objective,
		conditions: checks.map((check) => ({
			id: check.id,
			description: `Command must pass: ${commandReference(check)}`,
			verifierIds: [check.id],
		})),
	};
}

export function createShadowCommandVerifiers(
	checks: readonly ShadowRunsCheckConfig[],
): CompletionVerifier<ShadowRunVerificationContext<ShadowRunsCandidateConfig, ShadowAgentOutput>>[] {
	return checks.map((check) => ({
		id: check.id,
		verify: async ({ context }, signal) => {
			const result = await execCommand(check.command, check.args, context.overlay.getWorkingDirectory(), {
				signal,
				timeout: check.timeoutMs,
			});
			const passed = result.code === 0 && !result.killed;
			return {
				status: signal.aborted ? ("blocked" as const) : passed ? ("pass" as const) : ("fail" as const),
				summary: signal.aborted
					? `${check.id} aborted`
					: passed
						? `${check.id} passed`
						: `${check.id} failed with exit code ${result.code}${result.killed ? " after termination" : ""}`,
				evidence: [
					{
						id: `${check.id}-command`,
						kind: "command",
						summary: commandReference(check),
						data: {
							code: result.code,
							killed: result.killed,
							stdout: truncateUtf8Tail(result.stdout, MAX_EVIDENCE_OUTPUT_BYTES),
							stderr: truncateUtf8Tail(result.stderr, MAX_EVIDENCE_OUTPUT_BYTES),
						},
					},
				],
			};
		},
	}));
}

async function initializeCandidateGit(overlay: WorkspaceOverlay, signal: AbortSignal): Promise<string | undefined> {
	const cwd = overlay.getWorkingDirectory();
	const existing = await execCommand("git", ["rev-parse", "--git-dir"], cwd, { signal, timeout: 5_000 });
	if (existing.code === 0 && !existing.killed) return undefined;
	const commands = [
		["init", "--quiet"],
		["add", "--all", "--force"],
		[
			"-c",
			"user.name=Pi Shadow Runs",
			"-c",
			"user.email=pi-shadow-runs@localhost",
			"commit",
			"--quiet",
			"--allow-empty",
			"--no-gpg-sign",
			"-m",
			"Shadow run baseline",
		],
	];
	for (const args of commands) {
		const result = await execCommand("git", args, cwd, { signal, timeout: 120_000 });
		if (signal.aborted) throw new Error(`Shadow run Git setup was aborted for ${overlay.getId()}`);
		if (result.code !== 0 || result.killed) {
			return result.stderr.trim() || `git ${args[0]} failed`;
		}
	}
	return undefined;
}

function buildCandidateSystemPrompt(candidate: ShadowRunsCandidateConfig): string {
	return `## Shadow run candidate

You are candidate "${candidate.id}" in an explicitly requested comparative implementation run.

Strategy:
${candidate.instructions}

Implement the user's objective completely. Built-in file, search, and bash tools target an isolated workspace overlay. The original workspace is unchanged until the user reviews and explicitly applies one candidate. Git metadata inside the overlay is independent and excluded from the resulting PatchSet.

This is a review boundary, not an OS sandbox. Do not access or mutate the original workspace through absolute paths, parent-directory traversal, host-side processes, or external tools. Do not merely propose a plan: make the change, inspect the result, and end with a concise implementation and verification summary.`;
}

function getLastAssistantMessage(messages: readonly unknown[]): AssistantMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (typeof message === "object" && message !== null && "role" in message && message.role === "assistant") {
			return message as AssistantMessage;
		}
	}
	return undefined;
}

function outputFromSession(
	stats: SessionStats,
	model: Model<Api>,
	thinkingLevel: ThinkingLevel,
	response: string,
	warnings: string[],
): ShadowAgentOutput {
	return {
		response,
		model: { provider: model.provider, id: model.id },
		thinkingLevel,
		usage: {
			assistantTurns: stats.assistantMessages,
			toolCalls: stats.toolCalls,
			tokens: stats.tokens.total,
			cost: stats.cost,
		},
		warnings,
	};
}

export async function runShadowCandidateAgent(
	context: ShadowRunContext<ShadowRunsCandidateConfig>,
	options: RunShadowCandidateAgentOptions,
): Promise<ShadowAgentOutput> {
	if (context.signal.aborted) throw new Error(`Shadow run candidate ${context.candidate.id} was aborted`);
	const gitWarning = await initializeCandidateGit(context.overlay, context.signal);
	const thinkingLevel = context.candidate.config.thinkingLevel ?? options.baseThinkingLevel;
	const settingsManager = SettingsManager.create(context.overlay.getWorkspaceRoot(), options.agentDir, {
		projectTrusted: true,
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: context.overlay.getWorkspaceRoot(),
		agentDir: options.agentDir,
		settingsManager,
		noExtensions: true,
		noPromptTemplates: true,
		noThemes: true,
		appendSystemPrompt: [buildCandidateSystemPrompt(context.candidate.config)],
	});
	await resourceLoader.reload();
	const created = await createAgentSession({
		cwd: context.overlay.getWorkspaceRoot(),
		agentDir: options.agentDir,
		modelRuntime: options.modelRuntime,
		model: options.model,
		thinkingLevel,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(context.overlay.getWorkspaceRoot()),
		workspaceOverlay: context.overlay,
		runBudget: {
			maxModelCalls: options.budget.maxModelCalls,
			maxToolCalls: options.budget.maxToolCalls,
			maxWallTimeMs: options.budget.maxWallTimeMs,
			...(options.budget.maxModelTokens === undefined ? {} : { maxModelTokens: options.budget.maxModelTokens }),
			...(options.budget.maxCost === undefined ? {} : { maxCost: options.budget.maxCost }),
		},
		loopDetection: { maxConsecutiveToolCalls: 4, includeToolResult: true },
	});
	let abortPromise: Promise<void> | undefined;
	let abortStarted = false;
	const abortCandidate = () => {
		if (abortStarted) return;
		abortStarted = true;
		abortPromise = created.session.abort();
	};
	context.signal.addEventListener("abort", abortCandidate, { once: true });
	if (context.signal.aborted) abortCandidate();
	try {
		if (context.signal.aborted) throw new Error(`Shadow run candidate ${context.candidate.id} was aborted`);
		await created.session.prompt(options.objective);
		const assistant = getLastAssistantMessage(created.session.messages);
		if (!assistant) throw new Error(`Shadow run candidate ${context.candidate.id} returned no assistant message`);
		if (assistant.stopReason !== "stop") {
			throw new Error(
				`Shadow run candidate ${context.candidate.id} stopped with ${assistant.stopReason}: ${assistant.errorMessage ?? "no details"}`,
			);
		}
		const response = created.session.getLastAssistantText();
		if (!response) throw new Error(`Shadow run candidate ${context.candidate.id} returned no final response`);
		return outputFromSession(
			created.session.getSessionStats(),
			options.model,
			created.session.thinkingLevel,
			response,
			gitWarning ? [`Git baseline unavailable: ${gitWarning}`] : [],
		);
	} finally {
		context.signal.removeEventListener("abort", abortCandidate);
		if (abortPromise) {
			try {
				await abortPromise;
			} catch {}
		}
		created.session.dispose();
	}
}

async function createCandidateModelRuntime(
	model: Model<Api>,
	modelRegistry: ModelRegistry,
	agentDir: string,
): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
	});
	const nativeProvider = modelRegistry.getRegisteredNativeProvider(model.provider);
	if (nativeProvider) runtime.registerNativeProvider(nativeProvider);
	const providerConfig = modelRegistry.getRegisteredProviderConfig(model.provider);
	if (providerConfig) runtime.registerProvider(model.provider, providerConfig);
	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	if (auth.apiKey) await runtime.setRuntimeApiKey(model.provider, auth.apiKey);
	await runtime.refresh({ allowNetwork: false });
	return runtime;
}

export const createDefaultShadowCandidateRunner: ShadowCandidateRunnerFactory = ({
	model,
	modelRegistry,
	baseThinkingLevel,
}) => {
	const agentDir = getAgentDir();
	let modelRuntimePromise: Promise<ModelRuntime> | undefined;
	return async (context, options) => {
		modelRuntimePromise ??= createCandidateModelRuntime(model, modelRegistry, agentDir);
		return runShadowCandidateAgent(context, {
			...options,
			model,
			baseThinkingLevel,
			modelRuntime: await modelRuntimePromise,
			agentDir,
		});
	};
};

export function createShadowRunCompletion(config: ShadowRunsConfig, objective: string) {
	return {
		contract: createShadowCompletionContract(objective, config.checks),
		verifiers: createShadowCommandVerifiers(config.checks),
	};
}
