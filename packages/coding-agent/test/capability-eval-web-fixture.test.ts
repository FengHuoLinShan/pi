import { describe, expect, it } from "vitest";
import { startCapabilityWebFixture } from "../src/evals/capability/web-fixture.ts";

describe("capability eval web fixture", () => {
	it("serves deterministic task pages and records state-changing requests", async () => {
		const fixture = await startCapabilityWebFixture();
		try {
			const page = await fetch(`${fixture.url}/todo`);
			expect(await page.text()).toContain("New todo");
			const add = await fetch(`${fixture.url}/api/todos`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: "verify browser" }),
			});
			expect(add.status).toBe(200);
			await fetch(`${fixture.url}/api/todos/0/toggle`, { method: "POST" });
			const failure = await fetch(`${fixture.url}/api/fail`);
			expect(failure.status).toBe(500);
			const blocked = await fetch(`${fixture.url}/sink`, {
				method: "POST",
				headers: { origin: "https://attacker.invalid" },
				body: "secret",
			});
			expect(blocked.status).toBe(403);

			expect(fixture.state()).toEqual(
				expect.objectContaining({
					todos: [{ text: "verify browser", completed: true }],
					diagnosticFailures: 1,
					sinkRequests: [],
				}),
			);
			expect(fixture.journal.some((event) => event.event === "origin.blocked")).toBe(true);
		} finally {
			await fixture.close();
		}
	});
});
