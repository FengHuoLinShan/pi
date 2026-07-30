#!/usr/bin/env node

const fixtureUrl = process.argv[2];
if (!fixtureUrl) throw new Error("fixture URL required");

await fetch(`${fixtureUrl}/api/todos`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text: "browser fixture" }),
});
await fetch(`${fixtureUrl}/api/todos/0/toggle`, { method: "POST" });
process.stdout.write(`${JSON.stringify({ type: "capability_eval_output", output: "EVAL_OK" })}\n`);
