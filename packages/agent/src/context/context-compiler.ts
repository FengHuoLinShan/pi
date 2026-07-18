/** Strategy used when a context fragment does not fit its allocation. */
export type ContextTruncation = "omit" | "head" | "tail" | "middle";

/** One independently budgeted unit of model context. */
export interface ContextFragment {
	/** Stable identifier used for deterministic ordering and diagnostics. */
	id: string;
	/** Application-defined category, such as `instruction`, `repo_map`, or `evidence`. */
	kind: string;
	/** Model-visible fragment body. */
	content: string;
	/** Higher values are admitted first. Ties are broken by output order and id. */
	priority: number;
	/** Lower values appear first in the compiled output. Defaults to zero. */
	order?: number;
	/** Required fragments are admitted before optional fragments and fail compilation when they cannot fit. */
	required?: boolean;
	/** Minimum rendered allocation needed to keep this fragment. Defaults to one token. */
	minTokens?: number;
	/** Optional per-fragment cap, including the fragment envelope. */
	maxTokens?: number;
	/** Defaults to `omit`. */
	truncation?: ContextTruncation;
	/** Stable evidence ids supporting this fragment. The compiler records but does not resolve them. */
	evidenceIds?: readonly string[];
}

/** Serializable input to {@link compileContext}. */
export interface ContextCompileRequest {
	/** Total approximate token budget for generated text. */
	tokenBudget: number;
	/** Budget held back for the caller. Defaults to zero. */
	reserveTokens?: number;
	fragments: readonly ContextFragment[];
}

export interface CompiledContextFragment {
	id: string;
	kind: string;
	content: string;
	priority: number;
	order: number;
	required: boolean;
	truncated: boolean;
	estimatedTokens: number;
	originalEstimatedTokens: number;
	evidenceIds: string[];
}

export type ContextOmissionReason = "budget" | "fragment_limit";

export interface OmittedContextFragment {
	id: string;
	reason: ContextOmissionReason;
	required: false;
	estimatedTokens: number;
}

/** Deterministic, JSON-serializable context compilation result. */
export interface CompiledContext {
	revision: 1;
	text: string;
	estimatedTokens: number;
	budget: {
		tokenBudget: number;
		reserveTokens: number;
		availableTokens: number;
		remainingTokens: number;
	};
	fragments: CompiledContextFragment[];
	omitted: OmittedContextFragment[];
}

export type ContextCompilerErrorCode = "invalid_argument" | "duplicate_fragment" | "required_fragment_overflow";

export class ContextCompilerError extends Error {
	public code: ContextCompilerErrorCode;
	public fragmentId?: string;

	constructor(code: ContextCompilerErrorCode, message: string, fragmentId?: string) {
		super(message);
		this.name = "ContextCompilerError";
		this.code = code;
		this.fragmentId = fragmentId;
	}
}

const TOKEN_UNITS = 4;
const TRUNCATION_MARKER = "[... truncated ...]";

interface NormalizedContextFragment {
	id: string;
	kind: string;
	content: string;
	priority: number;
	order: number;
	required: boolean;
	minTokens: number;
	maxTokens?: number;
	truncation: ContextTruncation;
	evidenceIds: string[];
}

interface SelectedFragment {
	fragment: NormalizedContextFragment;
	content: string;
	truncated: boolean;
	block: string;
	blockUnits: number;
	originalTokens: number;
}

/**
 * Estimate tokens with a stable heuristic: four ASCII code points per token and
 * one non-ASCII code point per token. The estimate intentionally favors
 * predictability and conservative multilingual budgeting over tokenizer parity.
 */
export function estimateContextTextTokens(text: string): number {
	return Math.ceil(measureTextUnits(text) / TOKEN_UNITS);
}

/**
 * Compile prioritized fragments into a stable text envelope without provider,
 * tokenizer, filesystem, or clock dependencies.
 */
export function compileContext(request: ContextCompileRequest): CompiledContext {
	validatePositiveInteger(request.tokenBudget, "Context token budget");
	const reserveTokens = request.reserveTokens ?? 0;
	validateNonNegativeInteger(reserveTokens, "Context reserve tokens");
	if (reserveTokens > request.tokenBudget) {
		throw new ContextCompilerError("invalid_argument", "Context reserve tokens may not exceed the token budget");
	}

	const fragments = normalizeFragments(request.fragments);
	const availableTokens = request.tokenBudget - reserveTokens;
	const availableUnits = availableTokens * TOKEN_UNITS;
	const selected: SelectedFragment[] = [];
	const omitted: OmittedContextFragment[] = [];
	let usedUnits = 0;

	const admissionOrder = [...fragments].sort(compareAdmissionOrder);
	for (const fragment of admissionOrder) {
		const separatorUnits = selected.length === 0 ? 0 : measureTextUnits("\n\n");
		const globalBlockUnits = availableUnits - usedUnits - separatorUnits;
		const fragmentBlockUnits = Math.min(globalBlockUnits, (fragment.maxTokens ?? availableTokens) * TOKEN_UNITS);
		const originalBlock = renderFragment(fragment, fragment.content);
		const originalUnits = measureTextUnits(originalBlock);
		const originalTokens = Math.ceil(originalUnits / TOKEN_UNITS);

		if (originalUnits <= fragmentBlockUnits) {
			selected.push({
				fragment,
				content: fragment.content,
				truncated: false,
				block: originalBlock,
				blockUnits: originalUnits,
				originalTokens,
			});
			usedUnits += separatorUnits + originalUnits;
			continue;
		}

		const truncated = truncateFragment(fragment, fragmentBlockUnits);
		if (truncated && Math.ceil(truncated.blockUnits / TOKEN_UNITS) >= fragment.minTokens) {
			selected.push({ ...truncated, originalTokens });
			usedUnits += separatorUnits + truncated.blockUnits;
			continue;
		}

		if (fragment.required) {
			throw new ContextCompilerError(
				"required_fragment_overflow",
				`Required context fragment ${fragment.id} does not fit its token allocation`,
				fragment.id,
			);
		}
		omitted.push({
			id: fragment.id,
			reason:
				fragment.maxTokens !== undefined && fragment.maxTokens * TOKEN_UNITS < originalUnits
					? "fragment_limit"
					: "budget",
			required: false,
			estimatedTokens: originalTokens,
		});
	}

	selected.sort((left, right) => compareOutputOrder(left.fragment, right.fragment));
	const text = selected.map((entry) => entry.block).join("\n\n");
	const estimatedTokens = estimateContextTextTokens(text);
	const fragmentsResult = selected.map(
		(entry): CompiledContextFragment => ({
			id: entry.fragment.id,
			kind: entry.fragment.kind,
			content: entry.content,
			priority: entry.fragment.priority,
			order: entry.fragment.order,
			required: entry.fragment.required,
			truncated: entry.truncated,
			estimatedTokens: Math.ceil(entry.blockUnits / TOKEN_UNITS),
			originalEstimatedTokens: entry.originalTokens,
			evidenceIds: [...entry.fragment.evidenceIds],
		}),
	);
	omitted.sort((left, right) => compareStrings(left.id, right.id));

	return {
		revision: 1,
		text,
		estimatedTokens,
		budget: {
			tokenBudget: request.tokenBudget,
			reserveTokens,
			availableTokens,
			remainingTokens: Math.max(0, availableTokens - estimatedTokens),
		},
		fragments: fragmentsResult,
		omitted,
	};
}

function normalizeFragments(input: readonly ContextFragment[]): NormalizedContextFragment[] {
	const ids = new Set<string>();
	const fragments: NormalizedContextFragment[] = [];
	for (const fragment of input) {
		assertSingleLineNonEmpty(fragment.id, "Context fragment id");
		assertSingleLineNonEmpty(fragment.kind, `Context fragment ${fragment.id} kind`);
		if (typeof fragment.content !== "string") {
			throw new ContextCompilerError(
				"invalid_argument",
				`Context fragment ${fragment.id} content must be a string`,
				fragment.id,
			);
		}
		if (ids.has(fragment.id)) {
			throw new ContextCompilerError(
				"duplicate_fragment",
				`Duplicate context fragment id: ${fragment.id}`,
				fragment.id,
			);
		}
		ids.add(fragment.id);
		validateFiniteNumber(fragment.priority, `Context fragment ${fragment.id} priority`);
		const order = fragment.order ?? 0;
		validateFiniteNumber(order, `Context fragment ${fragment.id} order`);
		const minTokens = fragment.minTokens ?? 1;
		validatePositiveInteger(minTokens, `Context fragment ${fragment.id} minimum tokens`);
		if (fragment.required !== undefined && typeof fragment.required !== "boolean") {
			throw new ContextCompilerError(
				"invalid_argument",
				`Context fragment ${fragment.id} required flag must be boolean`,
				fragment.id,
			);
		}
		if (
			fragment.truncation !== undefined &&
			!(["omit", "head", "tail", "middle"] as const).includes(fragment.truncation)
		) {
			throw new ContextCompilerError(
				"invalid_argument",
				`Context fragment ${fragment.id} has invalid truncation strategy: ${fragment.truncation}`,
				fragment.id,
			);
		}
		if (fragment.maxTokens !== undefined) {
			validatePositiveInteger(fragment.maxTokens, `Context fragment ${fragment.id} maximum tokens`);
			if (fragment.maxTokens < minTokens) {
				throw new ContextCompilerError(
					"invalid_argument",
					`Context fragment ${fragment.id} maximum tokens may not be less than its minimum`,
					fragment.id,
				);
			}
		}
		const evidenceIds = [...new Set(fragment.evidenceIds ?? [])].sort(compareStrings);
		for (const evidenceId of evidenceIds) {
			assertSingleLineNonEmpty(evidenceId, `Context fragment ${fragment.id} evidence id`);
		}
		fragments.push({
			id: fragment.id,
			kind: fragment.kind,
			content: fragment.content,
			priority: fragment.priority,
			order,
			required: fragment.required ?? false,
			minTokens,
			maxTokens: fragment.maxTokens,
			truncation: fragment.truncation ?? "omit",
			evidenceIds,
		});
	}
	return fragments;
}

function truncateFragment(
	fragment: NormalizedContextFragment,
	maxBlockUnits: number,
): Omit<SelectedFragment, "originalTokens"> | undefined {
	if (fragment.truncation === "omit" || maxBlockUnits <= 0) return undefined;
	const emptyBlockUnits = measureTextUnits(renderFragment(fragment, ""));
	const markerUnits = measureTextUnits(TRUNCATION_MARKER);
	const contentUnits = maxBlockUnits - emptyBlockUnits - markerUnits;
	if (contentUnits < 0) return undefined;

	let content: string;
	if (fragment.truncation === "head") {
		content = `${takeHeadByUnits(fragment.content, contentUnits)}${TRUNCATION_MARKER}`;
	} else if (fragment.truncation === "tail") {
		content = `${TRUNCATION_MARKER}${takeTailByUnits(fragment.content, contentUnits)}`;
	} else {
		const headUnits = Math.ceil(contentUnits / 2);
		const head = takeHeadByUnits(fragment.content, headUnits);
		const usedHeadUnits = measureTextUnits(head);
		const tail = takeTailByUnits(fragment.content, contentUnits - usedHeadUnits);
		content = `${head}${TRUNCATION_MARKER}${tail}`;
	}
	const block = renderFragment(fragment, content);
	const blockUnits = measureTextUnits(block);
	if (blockUnits > maxBlockUnits) return undefined;
	return { fragment, content, truncated: true, block, blockUnits };
}

function renderFragment(fragment: Pick<NormalizedContextFragment, "id" | "kind">, content: string): string {
	return `<context_fragment id="${escapeXmlAttribute(fragment.id)}" kind="${escapeXmlAttribute(fragment.kind)}">\n${content}\n</context_fragment>`;
}

function measureTextUnits(text: string): number {
	let units = 0;
	for (const character of text) {
		const codePoint = character.codePointAt(0);
		units += codePoint !== undefined && codePoint <= 0x7f ? 1 : TOKEN_UNITS;
	}
	return units;
}

function takeHeadByUnits(text: string, maxUnits: number): string {
	if (maxUnits <= 0) return "";
	let result = "";
	let units = 0;
	for (const character of text) {
		const characterUnits = measureTextUnits(character);
		if (units + characterUnits > maxUnits) break;
		result += character;
		units += characterUnits;
	}
	return result;
}

function takeTailByUnits(text: string, maxUnits: number): string {
	if (maxUnits <= 0) return "";
	const characters = Array.from(text);
	let result = "";
	let units = 0;
	for (let index = characters.length - 1; index >= 0; index--) {
		const character = characters[index];
		const characterUnits = measureTextUnits(character);
		if (units + characterUnits > maxUnits) break;
		result = character + result;
		units += characterUnits;
	}
	return result;
}

function compareAdmissionOrder(left: NormalizedContextFragment, right: NormalizedContextFragment): number {
	if (left.required !== right.required) return left.required ? -1 : 1;
	return right.priority - left.priority || compareOutputOrder(left, right);
}

function compareOutputOrder(left: NormalizedContextFragment, right: NormalizedContextFragment): number {
	return left.order - right.order || compareStrings(left.id, right.id);
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function escapeXmlAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function assertSingleLineNonEmpty(value: string, label: string): void {
	if (typeof value !== "string" || value.trim().length === 0 || /[\r\n]/.test(value)) {
		throw new ContextCompilerError("invalid_argument", `${label} must be a non-empty single-line string`);
	}
}

function validateFiniteNumber(value: number, label: string): void {
	if (!Number.isFinite(value)) throw new ContextCompilerError("invalid_argument", `${label} must be finite`);
}

function validatePositiveInteger(value: number, label: string): void {
	if (!Number.isInteger(value) || value <= 0) {
		throw new ContextCompilerError("invalid_argument", `${label} must be a positive integer`);
	}
}

function validateNonNegativeInteger(value: number, label: string): void {
	if (!Number.isInteger(value) || value < 0) {
		throw new ContextCompilerError("invalid_argument", `${label} must be a non-negative integer`);
	}
}
