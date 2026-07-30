import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getRemoteTokenPath } from "../config.ts";

const REMOTE_TOKEN_BYTES = 32;

export function loadOrCreateRemoteToken(): string {
	const tokenPath = getRemoteTokenPath();
	if (existsSync(tokenPath)) {
		const token = readFileSync(tokenPath, "utf8").trim();
		if (token.length < REMOTE_TOKEN_BYTES) {
			throw new Error(`Remote token at ${tokenPath} is invalid`);
		}
		return token;
	}

	mkdirSync(dirname(tokenPath), { recursive: true });
	const token = randomBytes(REMOTE_TOKEN_BYTES).toString("base64url");
	writeFileSync(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
	return token;
}
