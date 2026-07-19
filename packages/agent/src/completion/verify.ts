import {
	COMPLETION_CONTRACT_VERSION,
	COMPLETION_REPORT_VERSION,
	type CompletionCondition,
	type CompletionConditionMode,
	type CompletionConditionReport,
	type CompletionContract,
	CompletionContractError,
	type CompletionErrorDetails,
	type CompletionEvidence,
	type CompletionJsonValue,
	type CompletionReport,
	type CompletionStatus,
	type CompletionStatusCounts,
	type CompletionVerifier,
	type CompletionVerifierOutcome,
	type CompletionVerifierReport,
	type VerifyCompletionContractOptions,
} from "./types.ts";

const aborted = Symbol("completion verification aborted");

/** Combine independently supplied verifier groups while rejecting ambiguous ids. */
export function composeCompletionVerifiers<TContext>(
	...groups: ReadonlyArray<Iterable<CompletionVerifier<TContext>>>
): CompletionVerifier<TContext>[] {
	const registry = createVerifierRegistry(groups.flatMap((group) => [...group]));
	return [...registry.values()].sort((left, right) => compareStrings(left.id, right.id));
}

/** Explicitly execute a completion contract. This function starts no background work or retry loop. */
export async function verifyCompletionContract<TContext>(
	contract: CompletionContract,
	verifiers: Iterable<CompletionVerifier<TContext>>,
	options: VerifyCompletionContractOptions<TContext>,
): Promise<CompletionReport> {
	const normalizedContract = normalizeContract(contract);
	const registry = createVerifierRegistry(verifiers);
	if (options.errorMode !== undefined && options.errorMode !== "isolate" && options.errorMode !== "throw") {
		throw new CompletionContractError(
			"invalid_options",
			`Completion verifier error mode is invalid: ${String(options.errorMode)}`,
		);
	}
	const signal = options.signal ?? new AbortController().signal;
	const errorMode = options.errorMode ?? "isolate";
	const conditions: CompletionConditionReport[] = [];

	for (const condition of normalizedContract.conditions) {
		const reports: CompletionVerifierReport[] = [];
		for (const verifierId of condition.verifierIds) {
			if (signal.aborted) {
				reports.push(createAbortedReport(verifierId));
				continue;
			}

			const verifier = registry.get(verifierId);
			if (!verifier) {
				reports.push({
					verifierId,
					status: "error",
					summary: `Verifier is not registered: ${verifierId}`,
					error: { name: "MissingCompletionVerifier", message: `Verifier is not registered: ${verifierId}` },
				});
				continue;
			}

			try {
				const result = await waitForVerifier(
					Promise.resolve(
						verifier.verify({ contract: normalizedContract, condition, context: options.context }, signal),
					),
					signal,
				);
				if (result === aborted) reports.push(createAbortedReport(verifierId));
				else reports.push({ verifierId, ...normalizeOutcome(result, verifierId) });
			} catch (error) {
				if (signal.aborted) {
					reports.push(createAbortedReport(verifierId));
				} else if (errorMode === "throw") {
					throw error;
				} else {
					const details = normalizeError(error);
					reports.push({
						verifierId,
						status: "error",
						summary: `Verifier ${verifierId} failed: ${details.message}`,
						error: details,
					});
				}
			}
		}

		const mode = condition.mode ?? "all";
		conditions.push({
			conditionId: condition.id,
			description: condition.description,
			required: condition.required ?? true,
			mode,
			status: aggregateConditionStatus(mode, reports),
			verifiers: reports,
		});
	}

	const summary = {
		required: countStatuses(conditions.filter((condition) => condition.required)),
		optional: countStatuses(conditions.filter((condition) => !condition.required)),
	};
	return {
		version: COMPLETION_REPORT_VERSION,
		contract: normalizedContract,
		status: aggregateContractStatus(conditions),
		summary,
		conditions,
	};
}

/** Canonical JSON serialization with recursively sorted object keys. */
export function serializeCompletionReport(report: CompletionReport): string {
	return JSON.stringify(toJsonValue(report, "Completion report"));
}

function normalizeContract(contract: CompletionContract): CompletionContract {
	if (!isPlainObject(contract) || contract.version !== COMPLETION_CONTRACT_VERSION) {
		throw new CompletionContractError(
			"invalid_contract",
			`Completion contract version must be ${COMPLETION_CONTRACT_VERSION}`,
		);
	}
	assertNonEmpty(contract.id, "Completion contract id", "invalid_contract");
	assertNonEmpty(contract.objective, "Completion contract objective", "invalid_contract");
	if (!Array.isArray(contract.conditions) || contract.conditions.length === 0) {
		throw new CompletionContractError("invalid_contract", "Completion contract requires at least one condition");
	}

	const conditionIds = new Set<string>();
	const conditions = contract.conditions.map((condition) => {
		const normalized = normalizeCondition(condition);
		if (conditionIds.has(normalized.id)) {
			throw new CompletionContractError("invalid_contract", `Duplicate completion condition id: ${normalized.id}`);
		}
		conditionIds.add(normalized.id);
		return normalized;
	});

	if (contract.metadata !== undefined && !isPlainObject(contract.metadata)) {
		throw new CompletionContractError("invalid_contract", "Completion contract metadata must be a JSON object");
	}
	return {
		version: COMPLETION_CONTRACT_VERSION,
		id: contract.id,
		objective: contract.objective,
		conditions,
		...(contract.metadata === undefined
			? {}
			: {
					metadata: toJsonValue(
						contract.metadata,
						"Completion contract metadata",
						new WeakSet<object>(),
						"invalid_contract",
					) as {
						[key: string]: CompletionJsonValue;
					},
				}),
	};
}

function normalizeCondition(condition: CompletionCondition): CompletionCondition {
	if (!isPlainObject(condition)) {
		throw new CompletionContractError("invalid_contract", "Completion condition must be an object");
	}
	assertNonEmpty(condition.id, "Completion condition id", "invalid_contract");
	assertNonEmpty(condition.description, `Completion condition ${condition.id} description`, "invalid_contract");
	if (!Array.isArray(condition.verifierIds) || condition.verifierIds.length === 0) {
		throw new CompletionContractError(
			"invalid_contract",
			`Completion condition ${condition.id} requires at least one verifier id`,
		);
	}
	if (condition.mode !== undefined && condition.mode !== "all" && condition.mode !== "any") {
		throw new CompletionContractError(
			"invalid_contract",
			`Completion condition ${condition.id} has invalid mode: ${String(condition.mode)}`,
		);
	}
	if (condition.required !== undefined && typeof condition.required !== "boolean") {
		throw new CompletionContractError(
			"invalid_contract",
			`Completion condition ${condition.id} required must be boolean`,
		);
	}
	const verifierIds = condition.verifierIds.map((verifierId) => {
		assertNonEmpty(verifierId, `Completion condition ${condition.id} verifier id`, "invalid_contract");
		return verifierId;
	});
	if (new Set(verifierIds).size !== verifierIds.length) {
		throw new CompletionContractError(
			"invalid_contract",
			`Completion condition ${condition.id} contains duplicate verifier ids`,
		);
	}
	return {
		id: condition.id,
		description: condition.description,
		verifierIds,
		mode: condition.mode ?? "all",
		required: condition.required ?? true,
	};
}

function createVerifierRegistry<TContext>(
	verifiers: Iterable<CompletionVerifier<TContext>>,
): Map<string, CompletionVerifier<TContext>> {
	const registry = new Map<string, CompletionVerifier<TContext>>();
	for (const verifier of verifiers) {
		if (typeof verifier !== "object" || verifier === null || typeof verifier.verify !== "function") {
			throw new CompletionContractError(
				"invalid_verifier",
				"Completion verifier must define an id and verify function",
			);
		}
		assertNonEmpty(verifier.id, "Completion verifier id", "invalid_verifier");
		if (registry.has(verifier.id)) {
			throw new CompletionContractError("duplicate_verifier", `Duplicate completion verifier id: ${verifier.id}`);
		}
		registry.set(verifier.id, verifier);
	}
	return registry;
}

function normalizeOutcome(outcome: CompletionVerifierOutcome, verifierId: string): CompletionVerifierOutcome {
	if (!isPlainObject(outcome)) {
		throw new CompletionContractError("invalid_verifier", `Verifier ${verifierId} returned a non-object result`);
	}
	if (
		outcome.status !== "pass" &&
		outcome.status !== "fail" &&
		outcome.status !== "blocked" &&
		outcome.status !== "error"
	) {
		throw new CompletionContractError(
			"invalid_verifier",
			`Verifier ${verifierId} returned invalid status: ${String(outcome.status)}`,
		);
	}
	assertNonEmpty(outcome.summary, `Verifier ${verifierId} summary`, "invalid_verifier");
	const evidence = normalizeEvidence(outcome.evidence ?? [], verifierId);
	if (outcome.status === "error") {
		if (!isPlainObject(outcome.error)) {
			throw new CompletionContractError("invalid_verifier", `Verifier ${verifierId} error result requires details`);
		}
		assertNonEmpty(outcome.error.name, `Verifier ${verifierId} error name`, "invalid_verifier");
		assertNonEmpty(outcome.error.message, `Verifier ${verifierId} error message`, "invalid_verifier");
		return {
			status: "error",
			summary: outcome.summary,
			evidence,
			error: { name: outcome.error.name, message: outcome.error.message },
		};
	}
	return { status: outcome.status, summary: outcome.summary, evidence };
}

function normalizeEvidence(evidence: CompletionEvidence[], verifierId: string): CompletionEvidence[] {
	if (!Array.isArray(evidence)) {
		throw new CompletionContractError("invalid_verifier", `Verifier ${verifierId} evidence must be an array`);
	}
	const ids = new Set<string>();
	const normalized = evidence.map((item) => {
		if (!isPlainObject(item)) {
			throw new CompletionContractError("invalid_verifier", `Verifier ${verifierId} evidence must contain objects`);
		}
		assertNonEmpty(item.id, `Verifier ${verifierId} evidence id`, "invalid_verifier");
		assertNonEmpty(item.kind, `Verifier ${verifierId} evidence kind`, "invalid_verifier");
		assertNonEmpty(item.summary, `Verifier ${verifierId} evidence summary`, "invalid_verifier");
		if (ids.has(item.id)) {
			throw new CompletionContractError(
				"invalid_verifier",
				`Verifier ${verifierId} returned duplicate evidence id: ${item.id}`,
			);
		}
		ids.add(item.id);
		if (item.reference !== undefined && typeof item.reference !== "string") {
			throw new CompletionContractError(
				"invalid_verifier",
				`Verifier ${verifierId} evidence ${item.id} reference must be a string`,
			);
		}
		return {
			id: item.id,
			kind: item.kind,
			summary: item.summary,
			...(item.reference === undefined ? {} : { reference: item.reference }),
			...(item.data === undefined ? {} : { data: toJsonValue(item.data, `Evidence ${item.id} data`) }),
		};
	});
	return normalized.sort((left, right) => compareStrings(left.id, right.id));
}

function aggregateConditionStatus(
	mode: CompletionConditionMode,
	reports: readonly CompletionVerifierReport[],
): CompletionStatus {
	const statuses = reports.map((report) => report.status);
	if (mode === "any" && statuses.includes("pass")) return "pass";
	if (statuses.includes("error")) return "error";
	if (mode === "all" && statuses.includes("fail")) return "fail";
	if (statuses.includes("blocked")) return "blocked";
	return mode === "all" ? "pass" : "fail";
}

function aggregateContractStatus(conditions: readonly CompletionConditionReport[]): CompletionStatus {
	const statuses = conditions.filter((condition) => condition.required).map((condition) => condition.status);
	if (statuses.includes("error")) return "error";
	if (statuses.includes("fail")) return "fail";
	if (statuses.includes("blocked")) return "blocked";
	return "pass";
}

function countStatuses(conditions: readonly CompletionConditionReport[]): CompletionStatusCounts {
	const counts: CompletionStatusCounts = { total: conditions.length, pass: 0, fail: 0, blocked: 0, error: 0 };
	for (const condition of conditions) counts[condition.status]++;
	return counts;
}

function createAbortedReport(verifierId: string): CompletionVerifierReport {
	return { verifierId, status: "blocked", summary: "Verification aborted", evidence: [] };
}

async function waitForVerifier(
	promise: Promise<CompletionVerifierOutcome>,
	signal: AbortSignal,
): Promise<CompletionVerifierOutcome | typeof aborted> {
	if (signal.aborted) return aborted;
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			cleanup();
			resolve(aborted);
		};
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				cleanup();
				reject(error);
			},
		);
	});
}

function normalizeError(error: unknown): CompletionErrorDetails {
	try {
		if (error instanceof Error) {
			return { name: error.name || "Error", message: error.message || error.name || "Error" };
		}
		return { name: "Error", message: String(error) };
	} catch {
		return { name: "Error", message: "Unknown verifier error" };
	}
}

function toJsonValue(
	value: unknown,
	label: string,
	seen = new WeakSet<object>(),
	code: "invalid_contract" | "invalid_verifier" = "invalid_verifier",
): CompletionJsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new CompletionContractError(code, `${label} must be finite JSON`);
		return value;
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) throw new CompletionContractError(code, `${label} must not be circular`);
		seen.add(value);
		const result: CompletionJsonValue[] = [];
		for (let index = 0; index < value.length; index++) {
			if (!(index in value)) throw new CompletionContractError(code, `${label}[${index}] must not be sparse`);
			result.push(toJsonValue(value[index], `${label}[${index}]`, seen, code));
		}
		seen.delete(value);
		return result;
	}
	if (isPlainObject(value)) {
		if (seen.has(value)) throw new CompletionContractError(code, `${label} must not be circular`);
		if (Object.getOwnPropertySymbols(value).length > 0) {
			throw new CompletionContractError(code, `${label} must not contain symbol keys`);
		}
		seen.add(value);
		const result = Object.create(null) as { [key: string]: CompletionJsonValue };
		for (const key of Object.keys(value).sort(compareStrings)) {
			const item = value[key];
			if (item === undefined) {
				throw new CompletionContractError(code, `${label}.${key} must be JSON serializable`);
			}
			result[key] = toJsonValue(item, `${label}.${key}`, seen, code);
		}
		seen.delete(value);
		return result;
	}
	throw new CompletionContractError(code, `${label} must be JSON serializable`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function assertNonEmpty(
	value: unknown,
	label: string,
	code: "invalid_contract" | "invalid_verifier",
): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new CompletionContractError(code, `${label} must not be empty`);
	}
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
