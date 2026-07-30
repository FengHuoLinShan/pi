import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type CapabilityEvalRedactionOptions, redactCapabilityEvalValue } from "./redaction.ts";

export interface CapabilityEvalJournalEvent {
	version: 1;
	sequence: number;
	timestamp: string;
	suite: string;
	scenario?: string;
	attempt?: number;
	event: string;
	data?: unknown;
}

export interface CapabilityEvalJournalOptions extends CapabilityEvalRedactionOptions {
	suite: string;
	path?: string;
}

export interface CapabilityEvalJournalWrite {
	scenario?: string;
	attempt?: number;
	event: string;
	data?: unknown;
}

export class CapabilityEvalJournal {
	readonly events: CapabilityEvalJournalEvent[] = [];
	private readonly options: CapabilityEvalJournalOptions;
	private sequence = 0;
	private pendingWrite = Promise.resolve();

	constructor(options: CapabilityEvalJournalOptions) {
		this.options = options;
	}

	write(entry: CapabilityEvalJournalWrite): CapabilityEvalJournalEvent {
		const event: CapabilityEvalJournalEvent = {
			version: 1,
			sequence: ++this.sequence,
			timestamp: new Date().toISOString(),
			suite: this.options.suite,
			...(entry.scenario === undefined ? {} : { scenario: entry.scenario }),
			...(entry.attempt === undefined ? {} : { attempt: entry.attempt }),
			event: entry.event,
			...(entry.data === undefined
				? {}
				: { data: redactCapabilityEvalValue(entry.data, { secretValues: this.options.secretValues }) }),
		};
		this.events.push(event);
		if (this.options.path) {
			const line = `${JSON.stringify(event)}\n`;
			this.pendingWrite = this.pendingWrite.then(async () => {
				await mkdir(dirname(this.options.path as string), { recursive: true });
				await appendFile(this.options.path as string, line, "utf8");
			});
		}
		return event;
	}

	async flush(): Promise<void> {
		await this.pendingWrite;
	}
}

/** Read a lifecycle journal while tolerating an absent trailing newline. */
export async function readCapabilityEvalJournal(path: string): Promise<CapabilityEvalJournalEvent[]> {
	const content = await readFile(path, "utf8");
	return content
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as CapabilityEvalJournalEvent);
}
