#!/usr/bin/env node

const task = process.argv[2] ?? "missing task";
const secret = process.env.CAPABILITY_EVAL_FIXTURE_SECRET ?? "missing-secret";

process.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
process.stdout.write(`${JSON.stringify({ type: "tool_execution_start", toolCallId: "fixture-1", toolName: "fixture", args: { task } })}\n`);
process.stdout.write(`${JSON.stringify({ type: "tool_execution_end", toolCallId: "fixture-1", toolName: "fixture", result: { ok: true }, isError: false })}\n`);
process.stdout.write(`${JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: `completed ${task}; token=${secret}` }],
    usage: { totalTokens: 42 },
  },
})}\n`);
process.stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
