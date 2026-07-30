import { describe, expect, it } from "vitest";
import { createOfflineCapabilityEvalDrivers } from "../src/evals/capability/mock-mcp-driver.ts";
import { startMockMcpHttpServer } from "../src/evals/capability/mock-mcp-server.ts";
import { runCapabilityEvalSuite } from "../src/evals/capability/runner.ts";
import { parseCapabilityEvalSuite } from "../src/evals/capability/schema.ts";

async function rpc(url: string, id: number, method: string, params: unknown = {}): Promise<Record<string, unknown>> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
	});
	return (await response.json()) as Record<string, unknown>;
}

describe("capability eval mock MCP", () => {
	it("serves paginated tools and structured tool results over HTTP", async () => {
		const server = await startMockMcpHttpServer();
		try {
			const first = await rpc(server.url, 1, "tools/list");
			const second = await rpc(server.url, 2, "tools/list", { cursor: "page-2" });
			const echo = await rpc(server.url, 3, "tools/call", { name: "echo", arguments: { text: "ok" } });
			const failure = await rpc(server.url, 4, "tools/call", { name: "fail", arguments: {} });

			expect(first.result).toEqual(expect.objectContaining({ nextCursor: "page-2" }));
			expect(second.result).toEqual(
				expect.objectContaining({ tools: expect.arrayContaining([expect.objectContaining({ name: "fail" })]) }),
			);
			expect(echo.result).toEqual(expect.objectContaining({ structuredContent: { echo: "ok" }, isError: false }));
			expect(failure.result).toEqual(expect.objectContaining({ isError: true }));
		} finally {
			await server.close();
		}
		expect(server.journal.map((event) => event.event)).toEqual([
			"server.started",
			"request.received",
			"request.received",
			"request.received",
			"request.received",
			"server.stopped",
		]);
	});

	it("runs deterministic stdio and HTTP probes through the offline layer", async () => {
		const suite = parseCapabilityEvalSuite({
			version: 1,
			name: "mock-mcp",
			scenarios: [
				{
					version: 1,
					id: "stdio",
					layer: "offline",
					task: "probe",
					driver: { id: "mock-mcp-stdio" },
					verifiers: [
						{ type: "output", operator: "equals", expected: "stdio MCP probe completed" },
						{ type: "trace_order", expected: ["mcp:initialized", "mcp:tools_page_2", "mcp:error_returned"] },
						{ type: "lifecycle_order", expected: ["server.started", "server.stopped"] },
						{ type: "metric", metric: "orphanProcesses", operator: "equals", expected: 0 },
					],
				},
				{
					version: 1,
					id: "http",
					layer: "offline",
					task: "probe",
					driver: { id: "mock-mcp-http" },
					verifiers: [
						{ type: "output", operator: "equals", expected: "HTTP MCP probe completed" },
						{ type: "trace_order", expected: ["mcp:initialized", "mcp:tools_page_2", "mcp:echo_called"] },
					],
				},
			],
		});
		const report = await runCapabilityEvalSuite(suite, {
			drivers: createOfflineCapabilityEvalDrivers(),
			layers: ["offline"],
		});

		expect(report.passed).toBe(true);
		expect(report.scenarios.map((scenario) => scenario.status)).toEqual(["passed", "passed"]);
	});
});
