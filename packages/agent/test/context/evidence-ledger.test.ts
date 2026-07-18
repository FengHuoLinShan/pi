import { describe, expect, it } from "vitest";
import { createEvidenceCitation, EvidenceLedger, type EvidenceRecord } from "../../src/context/evidence-ledger.ts";

const record: EvidenceRecord = {
	id: "worker-loop",
	source: { kind: "file", id: "src/worker.ts" },
	location: { lineStart: 20, lineEnd: 35, symbol: "run" },
	hash: { algorithm: "sha256", value: "abc123" },
	claim: "The worker drains one job at a time.",
	toolCall: {
		id: "call-read-1",
		name: "read",
		argumentsHash: { algorithm: "sha256", value: "args1" },
		resultHash: { algorithm: "sha256", value: "result1" },
	},
	observedAt: 1_000,
};

describe("evidence ledger", () => {
	it("round-trips versioned evidence and produces stable citations", () => {
		const ledger = new EvidenceLedger();
		ledger.append(record);
		ledger.append(record);

		const snapshot = ledger.snapshot();
		const restored = new EvidenceLedger(JSON.parse(JSON.stringify(snapshot)));
		expect(restored.snapshot()).toEqual(snapshot);
		expect(restored.list()).toHaveLength(1);

		const citation = restored.citation("worker-loop");
		expect(citation).toEqual(createEvidenceCitation(record));
		expect(citation.text).toContain("E:worker-loop");
		expect(citation.text).toContain("file:src/worker.ts");
		expect(citation.text).toContain("sha256:abc123");
		expect(citation.text).toContain("via read#call-read-1");
	});

	it("detects fresh, stale, and unavailable evidence from caller-supplied current hashes", () => {
		const ledger = new EvidenceLedger({
			revision: 1,
			records: [
				record,
				{
					...record,
					id: "queue-loop",
					source: { kind: "file", id: "src/queue.ts" },
					location: { symbol: "Queue" },
				},
				{
					...record,
					id: "missing",
					source: { kind: "file", id: "src/missing.ts" },
					location: undefined,
				},
			],
		});

		expect(
			ledger.checkFreshness([
				{ source: record.source, location: record.location, hash: record.hash },
				{
					source: { kind: "file", id: "src/queue.ts" },
					location: { symbol: "Queue" },
					hash: { algorithm: "sha256", value: "changed" },
				},
			]),
		).toEqual([
			expect.objectContaining({ evidenceId: "missing", status: "missing" }),
			expect.objectContaining({ evidenceId: "queue-loop", status: "stale" }),
			expect.objectContaining({ evidenceId: "worker-loop", status: "fresh" }),
		]);
	});

	it("rejects conflicting ids and malformed locations", () => {
		const ledger = new EvidenceLedger();
		ledger.append(record);
		expect(() => ledger.append({ ...record, claim: "Different claim" })).toThrow(
			"Evidence id already exists with different contents",
		);
		expect(() =>
			ledger.append({
				...record,
				id: "bad-lines",
				location: { lineStart: 10, lineEnd: 2 },
			}),
		).toThrow("Evidence end line must be at or after its start line");
	});
});
