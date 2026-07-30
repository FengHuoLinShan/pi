#!/usr/bin/env node

const safeCommands = new Set([
	"check",
	"click",
	"close",
	"dblclick",
	"dialog-accept",
	"dialog-dismiss",
	"fill",
	"find",
	"go-back",
	"go-forward",
	"goto",
	"hover",
	"keydown",
	"keyup",
	"open",
	"press",
	"reload",
	"select",
	"snapshot",
	"tab-close",
	"tab-list",
	"tab-new",
	"tab-select",
	"type",
	"uncheck",
]);
const shellMetacharacters = /[\n\r;&|`$<>{}()\\*?\[\]]/u;

function unquote(value) {
	if (
		value.length >= 2 &&
		((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
	) {
		return value.slice(1, -1);
	}
	return value;
}

export default function (pi) {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return undefined;
		const command = typeof event.input.command === "string" ? event.input.command.trim() : "";
		if (shellMetacharacters.test(command)) {
			return { block: true, reason: "Eval browser guard blocked shell syntax" };
		}
		const tokens = command.split(/\s+/u);
		if (tokens[0] !== "playwright-cli" || !safeCommands.has(tokens[1])) {
			return { block: true, reason: "Eval browser guard only permits safe playwright-cli commands" };
		}
		if (tokens.slice(2).some((token) => token.startsWith("--"))) {
			return { block: true, reason: "Eval browser guard blocks playwright-cli options" };
		}
		if (tokens[1] === "open" || tokens[1] === "goto" || tokens[1] === "tab-new") {
			const url = tokens[2] ? unquote(tokens[2]) : undefined;
			const origin = process.env.PI_EVAL_FIXTURE_ORIGIN;
			if (url && (!origin || (url !== origin && !url.startsWith(`${origin}/`)))) {
				return { block: true, reason: "Eval browser guard blocks navigation outside the fixture origin" };
			}
		}
		return undefined;
	});
}
