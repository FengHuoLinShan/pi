import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type CompletionJsonValue,
	type CompletionVerifier,
	composeCompletionVerifiers,
	verifyCompletionContract,
} from "../completion/index.ts";
import type { AgentHarness } from "../harness/agent-harness.ts";
import type { AgentHarnessEvent } from "../harness/types.ts";
import { AgentHarnessError } from "../harness/types.ts";
import type { AgentRunTermination, AgentRunUsage } from "../types.ts";
import {
	type ExecuteVerifiedRunOptions,
	VERIFIED_RUN_REPORT_VERSION,
	VERIFIED_RUN_SPEC_VERSION,
	type VerifiedRunFailure,
	type VerifiedRunReference,
	type VerifiedRunReport,
	type VerifiedRunSpec,
	type VerifiedRunVerificationContext,
} from "./types.ts";

interface ObservedRun {
	usage: AgentRunUsage;
	termination?: AgentRunTermination;
}

function emptyUsage(): AgentRunUsage {
	return { steps: 0, modelCalls: 0, toolCalls: 0, modelTokens: 0, cost: 0, elapsedMs: 0 };
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function normalizeJsonValue(value: unknown, label: string, seen = new WeakSet<object>()): CompletionJsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`${label} must contain finite numbers`);
		return value;
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) throw new Error(`${label} must not be circular`);
		seen.add(value);
		const result: CompletionJsonValue[] = [];
		for (let index = 0; index < value.length; index++) {
			if (!(index in value)) throw new Error(`${label} must not contain sparse arrays`);
			result.push(normalizeJsonValue(value[index], label, seen));
		}
		seen.delete(value);
		return result;
	}
	if (isPlainObject(value)) {
		if (seen.has(value)) throw new Error(`${label} must not be circular`);
		if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(`${label} must not contain symbol keys`);
		seen.add(value);
		const result = Object.create(null) as { [key: string]: CompletionJsonValue };
		for (const key of Object.keys(value).sort(compareStrings)) {
			if (value[key] === undefined) throw new Error(`${label} must be JSON serializable`);
			result[key] = normalizeJsonValue(value[key], label, seen);
		}
		seen.delete(value);
		return result;
	}
	throw new Error(`${label} must be JSON serializable`);
}

function normalizeJsonObject(
	value: { [key: string]: CompletionJsonValue },
	label: string,
): { [key: string]: CompletionJsonValue } {
	if (!isPlainObject(value)) throw new Error(`${label} must be a JSON object`);
	return normalizeJsonValue(value, label) as { [key: string]: CompletionJsonValue };
}

function normalizeReferences(
	references: readonly VerifiedRunReference[] | undefined,
	label: string,
): VerifiedRunReference[] {
	const ids = new Set<string>();
	const normalized = (references ?? []).map((reference) => {
		if (!isPlainObject(reference) || typeof reference.id !== "string" || reference.id.trim() === "") {
			throw new Error(`${label} id must not be empty`);
		}
		if (typeof reference.kind !== "string" || reference.kind.trim() === "") {
			throw new Error(`${label} ${reference.id} kind must not be empty`);
		}
		if (reference.reference !== undefined && typeof reference.reference !== "string") {
			throw new Error(`${label} ${reference.id} reference must be a string`);
		}
		if (reference.revision !== undefined && typeof reference.revision !== "string") {
			throw new Error(`${label} ${reference.id} revision must be a string`);
		}
		if (ids.has(reference.id)) throw new Error(`Duplicate ${label} id: ${reference.id}`);
		ids.add(reference.id);
		return {
			id: reference.id,
			kind: reference.kind,
			...(reference.reference === undefined ? {} : { reference: reference.reference }),
			...(reference.revision === undefined ? {} : { revision: reference.revision }),
			...(reference.metadata === undefined
				? {}
				: { metadata: normalizeJsonObject(reference.metadata, `${label} ${reference.id} metadata`) }),
		};
	});
	return normalized.sort((left, right) => compareStrings(left.id, right.id));
}

function normalizeSpec(spec: VerifiedRunSpec): VerifiedRunSpec {
	if (!spec || spec.version !== VERIFIED_RUN_SPEC_VERSION) {
		throw new Error(`Verified run spec version must be ${VERIFIED_RUN_SPEC_VERSION}`);
	}
	if (typeof spec.id !== "string" || spec.id.trim() === "") throw new Error("Verified run id must not be empty");
	if (typeof spec.prompt !== "string" || spec.prompt.trim() === "") {
		throw new Error(`Verified run ${spec.id} prompt must not be empty`);
	}
	if (!spec.completionContract) throw new Error(`Verified run ${spec.id} requires a completion contract`);
	return {
		version: VERIFIED_RUN_SPEC_VERSION,
		id: spec.id,
		prompt: spec.prompt,
		completionContract: structuredClone(spec.completionContract),
		artifactRefs: normalizeReferences(spec.artifactRefs, "artifact reference"),
		evidenceRefs: normalizeReferences(spec.evidenceRefs, "evidence reference"),
		...(spec.metadata === undefined
			? {}
			: { metadata: normalizeJsonObject(spec.metadata, `Verified run ${spec.id} metadata`) }),
	};
}

function cloneReferences(references: readonly VerifiedRunReference[]): VerifiedRunReference[] {
	return references.map((reference) => structuredClone(reference));
}

function observeEvent(observed: ObservedRun, event: AgentHarnessEvent): void {
	switch (event.type) {
		case "turn_start":
			observed.usage.steps++;
			break;
		case "tool_execution_start":
			observed.usage.toolCalls++;
			break;
		case "message_end":
			if (event.message.role === "assistant") {
				observed.usage.modelCalls++;
				observed.usage.modelTokens += event.message.usage.totalTokens;
				observed.usage.cost += event.message.usage.cost.total;
			}
			break;
		case "agent_termination":
			observed.termination = structuredClone(event.termination);
			observed.usage = { ...event.usage };
			break;
	}
}

function normalizeFailure(stage: VerifiedRunFailure["stage"], error: unknown): VerifiedRunFailure {
	try {
		if (error instanceof AgentHarnessError) {
			return { stage, name: error.name, message: error.message, code: error.code };
		}
		if (error instanceof Error) return { stage, name: error.name || "Error", message: error.message || error.name };
		return { stage, name: "Error", message: String(error) };
	} catch {
		return { stage, name: "Error", message: "Unknown verified run failure" };
	}
}

function createBaseReport(spec: VerifiedRunSpec, usage: AgentRunUsage): Omit<VerifiedRunReport, "status"> {
	return {
		version: VERIFIED_RUN_REPORT_VERSION,
		runId: spec.id,
		usage: { ...usage },
		artifactRefs: cloneReferences(spec.artifactRefs ?? []),
		evidenceRefs: cloneReferences(spec.evidenceRefs ?? []),
	};
}

function isolateVerifiers<TContext>(
	verifiers: readonly CompletionVerifier<VerifiedRunVerificationContext<TContext>>[],
	createContext: () => VerifiedRunVerificationContext<TContext>,
): CompletionVerifier<VerifiedRunVerificationContext<TContext>>[] {
	return verifiers.map((verifier) => ({
		id: verifier.id,
		verify: ({ contract, condition }, signal) =>
			verifier.verify(
				{
					contract: structuredClone(contract),
					condition: structuredClone(condition),
					context: createContext(),
				},
				signal,
			),
	}));
}

/** Execute one Harness turn, then explicitly verify its completion contract. */
export async function executeVerifiedRun<TContext>(
	harness: AgentHarness,
	spec: VerifiedRunSpec,
	options: ExecuteVerifiedRunOptions<TContext>,
): Promise<VerifiedRunReport> {
	const normalizedSpec = normalizeSpec(spec);
	const verifiers = composeCompletionVerifiers(options.verifiers);
	const signal = options.signal;
	if (signal?.aborted) return { ...createBaseReport(normalizedSpec, emptyUsage()), status: "interrupted" };

	const observed: ObservedRun = { usage: emptyUsage() };
	const startedAt = performance.now();
	const unsubscribe = harness.subscribe((event) => observeEvent(observed, event));
	const abortHarness = () => harness.requestAbort();
	signal?.addEventListener("abort", abortHarness, { once: true });
	let finalMessage: AssistantMessage;
	try {
		finalMessage = await harness.prompt(normalizedSpec.prompt);
	} catch (error) {
		observed.usage.elapsedMs = Math.max(observed.usage.elapsedMs, performance.now() - startedAt);
		return {
			...createBaseReport(normalizedSpec, observed.usage),
			status: signal?.aborted ? "interrupted" : "failed",
			failure: normalizeFailure("harness", error),
		};
	} finally {
		signal?.removeEventListener("abort", abortHarness);
		unsubscribe();
	}

	observed.usage.elapsedMs = Math.max(observed.usage.elapsedMs, performance.now() - startedAt);
	const base = {
		...createBaseReport(normalizedSpec, observed.usage),
		finalMessage: structuredClone(finalMessage),
	};
	if (signal?.aborted || finalMessage.stopReason === "aborted") {
		return { ...base, status: "interrupted", termination: observed.termination };
	}
	if (observed.termination) return { ...base, status: "blocked", termination: observed.termination };
	if (finalMessage.stopReason === "error") {
		return {
			...base,
			status: "failed",
			failure: {
				stage: "harness",
				name: "ProviderError",
				message: finalMessage.errorMessage || "Provider request failed",
			},
		};
	}

	const createVerificationContext = (): VerifiedRunVerificationContext<TContext> => ({
		context: options.context,
		spec: structuredClone(normalizedSpec),
		finalMessage: structuredClone(base.finalMessage),
		usage: { ...base.usage },
		artifactRefs: cloneReferences(base.artifactRefs),
		evidenceRefs: cloneReferences(base.evidenceRefs),
	});
	try {
		const completion = await verifyCompletionContract(
			normalizedSpec.completionContract,
			isolateVerifiers(verifiers, createVerificationContext),
			{ context: createVerificationContext(), signal },
		);
		const status = signal?.aborted
			? "interrupted"
			: completion.status === "pass"
				? "passed"
				: completion.status === "blocked"
					? "blocked"
					: "failed";
		return { ...base, status, completion };
	} catch (error) {
		return {
			...base,
			status: signal?.aborted ? "interrupted" : "failed",
			failure: normalizeFailure("completion", error),
		};
	}
}

function toCanonicalJson(value: unknown, seen = new WeakSet<object>()): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Verified run report contains a non-finite number");
		return value;
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) throw new Error("Verified run report must not be circular");
		seen.add(value);
		const result: unknown[] = [];
		for (let index = 0; index < value.length; index++) {
			if (!(index in value)) throw new Error("Verified run report must not contain sparse arrays");
			result.push(toCanonicalJson(value[index], seen));
		}
		seen.delete(value);
		return result;
	}
	if (isPlainObject(value)) {
		if (seen.has(value)) throw new Error("Verified run report must not be circular");
		if (Object.getOwnPropertySymbols(value).length > 0) {
			throw new Error("Verified run report must not contain symbol keys");
		}
		seen.add(value);
		const result = Object.create(null) as Record<string, unknown>;
		for (const key of Object.keys(value).sort(compareStrings)) {
			if (value[key] !== undefined) result[key] = toCanonicalJson(value[key], seen);
		}
		seen.delete(value);
		return result;
	}
	throw new Error("Verified run report is not JSON serializable");
}

/** Stable JSON serialization for a verified-run report. */
export function serializeVerifiedRunReport(report: VerifiedRunReport): string {
	return JSON.stringify(toCanonicalJson(report));
}
