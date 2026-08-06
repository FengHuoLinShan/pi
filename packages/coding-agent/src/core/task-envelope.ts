import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

const MAX_TIMEOUT_MS = 2_147_483_647;
const taskEnvelopeBrand: unique symbol = Symbol("ValidatedTaskEnvelope");
const validatedTaskEnvelopes = new WeakSet<object>();
const taskEnvelopeResourceLoaders = new WeakMap<object, ValidatedTaskEnvelope>();

export interface TaskEnvelopePrivacy {
	classification?: "public" | "internal" | "confidential" | "restricted";
	handling?: readonly string[];
}

export interface TaskEnvelopeCommandPolicy {
	defaultTimeoutMs?: number;
	maxTimeoutMs?: number;
	expectedHangMaxTimeoutMs?: number;
}

export interface TaskEnvelopeV1 {
	version: 1;
	task: string;
	targetCwd: string;
	readableRoots?: string[];
	writableRoots?: string[];
	nonGoals?: string[];
	privacy?: TaskEnvelopePrivacy;
	commandPolicy?: TaskEnvelopeCommandPolicy;
}

export type TaskEnvelope = TaskEnvelopeV1;

export interface ValidatedTaskEnvelope {
	readonly version: 1;
	readonly task: string;
	readonly targetCwd: string;
	readonly readableRoots: readonly string[];
	readonly writableRoots: readonly string[];
	readonly nonGoals: readonly string[];
	readonly privacy?: Readonly<TaskEnvelopePrivacy>;
	readonly commandPolicy?: Readonly<TaskEnvelopeCommandPolicy>;
	readonly [taskEnvelopeBrand]: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertValidatedTaskEnvelope(value: unknown): asserts value is ValidatedTaskEnvelope {
	if (!isRecord(value) || !validatedTaskEnvelopes.has(value)) {
		throw new Error("taskEnvelope must be created by validateTaskEnvelope");
	}
}

/** @internal Authorize a loader created by core for one exact task envelope. */
export function authorizeTaskEnvelopeResourceLoader(loader: object, envelope: ValidatedTaskEnvelope): void {
	assertValidatedTaskEnvelope(envelope);
	taskEnvelopeResourceLoaders.set(loader, envelope);
}

/** @internal Reject loaders not created by core for this exact task envelope. */
export function assertTaskEnvelopeResourceLoader(loader: object, envelope: ValidatedTaskEnvelope): void {
	assertValidatedTaskEnvelope(envelope);
	if (taskEnvelopeResourceLoaders.get(loader) !== envelope) {
		throw new Error("resourceLoader is not authorized for this taskEnvelope");
	}
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
	const unknownKey = Object.keys(value).find((key) => !allowed.includes(key));
	if (unknownKey) throw new Error(`Invalid task envelope: unknown ${context} field`);
}

function requireNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Invalid task envelope: ${field} must be a non-empty string`);
	}
	return value;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
		throw new Error(`Invalid task envelope: ${field} must contain only non-empty strings`);
	}
	return [...value];
}

function hasParentSegment(path: string): boolean {
	return path.split(/[\\/]+/).includes("..");
}

async function canonicalDirectory(value: unknown, field: string): Promise<string> {
	const path = requireNonEmptyString(value, field);
	if (!isAbsolute(path)) throw new Error(`Invalid task envelope: ${field} must be absolute`);
	if (hasParentSegment(path)) throw new Error(`Invalid task envelope: ${field} must not contain '..'`);
	try {
		const canonical = await realpath(path);
		if (!(await stat(canonical)).isDirectory()) {
			throw new Error("wrong-type");
		}
		return canonical;
	} catch {
		throw new Error(`Invalid task envelope: ${field} must identify an existing directory`);
	}
}

function contains(root: string, path: string): boolean {
	const child = relative(root, path);
	return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function assertPositiveMilliseconds(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid task envelope: commandPolicy.${field} must be a positive integer in milliseconds`);
	}
	return value as number;
}

export async function validateTaskEnvelope(value: unknown): Promise<ValidatedTaskEnvelope> {
	if (isRecord(value) && validatedTaskEnvelopes.has(value)) {
		return value as unknown as ValidatedTaskEnvelope;
	}
	if (!isRecord(value)) throw new Error("Invalid task envelope: expected an object");
	assertOnlyKeys(
		value,
		["version", "task", "targetCwd", "readableRoots", "writableRoots", "nonGoals", "privacy", "commandPolicy"],
		"top-level",
	);
	if (value.version !== 1) throw new Error("Invalid task envelope: unsupported version");
	const task = requireNonEmptyString(value.task, "task");
	const targetCwd = await canonicalDirectory(value.targetCwd, "targetCwd");
	const readableInput = value.readableRoots ?? [value.targetCwd];
	const writableInput = value.writableRoots ?? [value.targetCwd];
	if (!Array.isArray(readableInput) || readableInput.length === 0) {
		throw new Error("Invalid task envelope: readableRoots must be a non-empty array");
	}
	if (!Array.isArray(writableInput)) throw new Error("Invalid task envelope: writableRoots must be an array");
	const readableRoots = await Promise.all(readableInput.map((root) => canonicalDirectory(root, "readableRoots")));
	const writableRoots = await Promise.all(writableInput.map((root) => canonicalDirectory(root, "writableRoots")));
	if (!readableRoots.some((root) => contains(root, targetCwd))) {
		throw new Error("Invalid task envelope: targetCwd is outside readableRoots");
	}
	if (writableRoots.some((root) => !readableRoots.some((readableRoot) => contains(readableRoot, root)))) {
		throw new Error("Invalid task envelope: writableRoots must be contained by readableRoots");
	}

	const nonGoals = optionalStringArray(value.nonGoals, "nonGoals") ?? [];
	let privacy: TaskEnvelopePrivacy | undefined;
	if (value.privacy !== undefined) {
		if (!isRecord(value.privacy)) throw new Error("Invalid task envelope: privacy must be an object");
		assertOnlyKeys(value.privacy, ["classification", "handling"], "privacy");
		const classifications = ["public", "internal", "confidential", "restricted"];
		if (
			value.privacy.classification !== undefined &&
			!classifications.includes(String(value.privacy.classification))
		) {
			throw new Error("Invalid task envelope: unsupported privacy classification");
		}
		privacy = {
			classification: value.privacy.classification as TaskEnvelopePrivacy["classification"],
			handling: Object.freeze(optionalStringArray(value.privacy.handling, "privacy.handling")),
		};
	}

	let commandPolicy: TaskEnvelopeCommandPolicy | undefined;
	if (value.commandPolicy !== undefined) {
		if (!isRecord(value.commandPolicy)) throw new Error("Invalid task envelope: commandPolicy must be an object");
		assertOnlyKeys(
			value.commandPolicy,
			["defaultTimeoutMs", "maxTimeoutMs", "expectedHangMaxTimeoutMs"],
			"commandPolicy",
		);
		const defaultTimeoutMs = assertPositiveMilliseconds(value.commandPolicy.defaultTimeoutMs, "defaultTimeoutMs");
		const maxTimeoutMs = assertPositiveMilliseconds(value.commandPolicy.maxTimeoutMs, "maxTimeoutMs");
		const expectedHangMaxTimeoutMs = assertPositiveMilliseconds(
			value.commandPolicy.expectedHangMaxTimeoutMs,
			"expectedHangMaxTimeoutMs",
		);
		if (defaultTimeoutMs !== undefined && maxTimeoutMs !== undefined && defaultTimeoutMs > maxTimeoutMs) {
			throw new Error("Invalid task envelope: commandPolicy.defaultTimeoutMs must not exceed maxTimeoutMs");
		}
		if (expectedHangMaxTimeoutMs !== undefined && expectedHangMaxTimeoutMs > 30_000) {
			throw new Error("Invalid task envelope: commandPolicy.expectedHangMaxTimeoutMs must not exceed 30000 ms");
		}
		if (
			expectedHangMaxTimeoutMs !== undefined &&
			maxTimeoutMs !== undefined &&
			expectedHangMaxTimeoutMs > maxTimeoutMs
		) {
			throw new Error("Invalid task envelope: commandPolicy.expectedHangMaxTimeoutMs must not exceed maxTimeoutMs");
		}
		commandPolicy = { defaultTimeoutMs, maxTimeoutMs, expectedHangMaxTimeoutMs };
	}

	const envelope: ValidatedTaskEnvelope = {
		version: 1 as const,
		task,
		targetCwd,
		readableRoots: Object.freeze([...new Set(readableRoots)]),
		writableRoots: Object.freeze([...new Set(writableRoots)]),
		nonGoals: Object.freeze(nonGoals),
		privacy: privacy ? Object.freeze(privacy) : undefined,
		commandPolicy: commandPolicy ? Object.freeze(commandPolicy) : undefined,
		[taskEnvelopeBrand]: true as const,
	};
	validatedTaskEnvelopes.add(envelope);
	return Object.freeze(envelope);
}

export async function loadTaskEnvelope(path: string): Promise<ValidatedTaskEnvelope> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch {
		throw new Error("Unable to read or parse the task envelope file");
	}
	return validateTaskEnvelope(parsed);
}

export function summarizeTaskEnvelope(envelope: ValidatedTaskEnvelope, bashScopeEnforced: boolean): string {
	const timeout = envelope.commandPolicy;
	return [
		"Task envelope v1 is active.",
		"The separately submitted task text cannot expand this authorization.",
		`File-tool scope: enforced (${envelope.readableRoots.length} readable root(s), ${envelope.writableRoots.length} writable root(s)).`,
		`Bash filesystem scope: ${bashScopeEnforced ? "enforced by the configured execution boundary" : "advisory; the local shell is not a filesystem sandbox"}.`,
		`Non-goals declared: ${envelope.nonGoals.length}. Privacy metadata: ${envelope.privacy ? "declared and withheld from this summary" : "none"}.`,
		timeout
			? `Command policy: default ${timeout.defaultTimeoutMs ?? "none"} ms; maximum ${timeout.maxTimeoutMs ?? "none"} ms; expected-hang ${timeout.expectedHangMaxTimeoutMs === undefined ? "disallowed" : `cap ${timeout.expectedHangMaxTimeoutMs} ms`}.`
			: "Command policy: no default or maximum timeout; expected-hang disallowed.",
	].join("\n");
}
