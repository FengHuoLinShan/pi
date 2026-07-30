const REDACTED = "[REDACTED]";

const sensitiveKeyPattern =
	/^(?:authorization|cookie|set-cookie|password|passwd|secret|client_secret|api[-_]?key|access[-_]?token|refresh[-_]?token|credential)$/i;
const sensitiveSuffixPattern = /(?:_api_key|_access_token|_refresh_token|_password|_secret)$/i;
const bearerPattern = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu;
const assignmentPattern = /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))=([^\s,;]+)/gu;
const commonKeyPattern = /\b(?:sk|sess|key)-[A-Za-z0-9_-]{12,}\b/gu;

export interface CapabilityEvalRedactionOptions {
	secretValues?: readonly string[];
}

function redactText(text: string, secretValues: readonly string[]): string {
	let redacted = text
		.replace(bearerPattern, `Bearer ${REDACTED}`)
		.replace(assignmentPattern, (_match, name: string) => `${name}=${REDACTED}`)
		.replace(commonKeyPattern, REDACTED);
	for (const secret of secretValues) {
		if (secret.length < 4) continue;
		redacted = redacted.split(secret).join(REDACTED);
	}
	return redacted;
}

function redact(value: unknown, secretValues: readonly string[], seen: WeakMap<object, unknown>): unknown {
	if (typeof value === "string") return redactText(value, secretValues);
	if (value === null || typeof value === "number" || typeof value === "boolean" || value === undefined) return value;
	if (typeof value === "bigint") return `${value}n`;
	if (typeof value === "function") return "[function]";
	if (typeof value === "symbol") return String(value);
	if (Array.isArray(value)) {
		const existing = seen.get(value);
		if (existing) return existing;
		const output: unknown[] = [];
		seen.set(value, output);
		for (const item of value) output.push(redact(item, secretValues, seen));
		return output;
	}
	if (typeof value === "object") {
		const existing = seen.get(value);
		if (existing) return existing;
		const output: Record<string, unknown> = {};
		seen.set(value, output);
		for (const [key, child] of Object.entries(value)) {
			output[key] =
				sensitiveKeyPattern.test(key) || sensitiveSuffixPattern.test(key)
					? REDACTED
					: redact(child, secretValues, seen);
		}
		return output;
	}
	return String(value);
}

/** Redact common credential shapes and caller-supplied exact secret values. */
export function redactCapabilityEvalValue(value: unknown, options: CapabilityEvalRedactionOptions = {}): unknown {
	return redact(value, options.secretValues ?? [], new WeakMap());
}

export function redactCapabilityEvalText(value: string, options: CapabilityEvalRedactionOptions = {}): string {
	return redactText(value, options.secretValues ?? []);
}
