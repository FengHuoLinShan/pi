import { type CapabilityEvalCommandSpec, createJsonlCommandCapabilityDriver } from "./jsonl-command-driver.ts";
import type { CapabilityEvalAttemptContext, CapabilityEvalDriver, CapabilityEvalDriverResult } from "./runner.ts";
import { type CapabilityWebFixtureHandle, startCapabilityWebFixture } from "./web-fixture.ts";

interface ActiveBrowserAttempt {
	commandDriver: CapabilityEvalDriver;
	fixture: CapabilityWebFixtureHandle;
}

function attemptKey(context: CapabilityEvalAttemptContext): string {
	return `${context.suiteName}:${context.scenario.id}:${context.attempt}`;
}

function replaceFixtureUrl(value: string, fixtureUrl: string): string {
	return value.split("{{fixtureUrl}}").join(fixtureUrl);
}

function withFixtureUrl(spec: CapabilityEvalCommandSpec, fixtureUrl: string): CapabilityEvalCommandSpec {
	return {
		...spec,
		command: replaceFixtureUrl(spec.command, fixtureUrl),
		args: spec.args?.map((argument) => replaceFixtureUrl(argument, fixtureUrl)),
		cwd: spec.cwd ? replaceFixtureUrl(spec.cwd, fixtureUrl) : undefined,
		environment: spec.environment
			? Object.fromEntries(
					Object.entries(spec.environment).map(([key, value]) => [key, replaceFixtureUrl(value, fixtureUrl)]),
				)
			: undefined,
	};
}

/** Wrap a Pi JSON-mode command with an isolated local web fixture and state artifact. */
export function createBrowserJsonlCapabilityDriver(spec: CapabilityEvalCommandSpec): CapabilityEvalDriver {
	const activeAttempts = new Map<string, ActiveBrowserAttempt>();
	return {
		async runAttempt(context): Promise<CapabilityEvalDriverResult> {
			const fixture = await startCapabilityWebFixture();
			context.journal.write({
				scenario: context.scenario.id,
				attempt: context.attempt,
				event: "browser_fixture.started",
				data: { origin: fixture.url },
			});
			const commandDriver = createJsonlCommandCapabilityDriver(withFixtureUrl(spec, fixture.url));
			const key = attemptKey(context);
			activeAttempts.set(key, { commandDriver, fixture });
			let result: CapabilityEvalDriverResult;
			try {
				result = await commandDriver.runAttempt(context);
				await commandDriver.cleanupAttempt?.(context);
			} finally {
				await fixture.close();
				activeAttempts.delete(key);
				context.journal.write({
					scenario: context.scenario.id,
					attempt: context.attempt,
					event: "browser_fixture.stopped",
				});
			}
			return {
				...result,
				lifecycle: ["fixture.started", ...(result.lifecycle ?? []), "fixture.stopped"],
				trace: [
					...(result.trace ?? []),
					...fixture.journal.map((event) => `fixture:${event.event}${event.path ? `:${event.path}` : ""}`),
				],
				artifacts: {
					...(result.artifacts ?? {}),
					"fixture-state.json": JSON.stringify(fixture.state(), null, 2),
					"fixture-journal.json": JSON.stringify(fixture.journal, null, 2),
				},
			};
		},
		async cleanupAttempt(context): Promise<void> {
			const active = activeAttempts.get(attemptKey(context));
			if (!active) return;
			try {
				await active.commandDriver.cleanupAttempt?.(context);
			} finally {
				await active.fixture.close();
				activeAttempts.delete(attemptKey(context));
			}
		},
	};
}
