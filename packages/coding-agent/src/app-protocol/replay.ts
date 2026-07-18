import { APP_PROTOCOL_ERROR_CODES, type AppEventNotification, type EventsReplayResult } from "./types.ts";
import { ProtocolValidationError, parseAppProtocolEvent } from "./validation.ts";

/**
 * A transport-independent bounded event log. Keep one instance across client
 * connections to support cursor resume after a disconnect.
 */
export class BoundedEventReplay {
	private readonly capacityValue: number;
	private readonly protocolVersion: string;
	private readonly events: AppEventNotification[] = [];
	private lastCursor = 0;

	constructor(capacity: number, protocolVersion: string) {
		if (!Number.isSafeInteger(capacity) || capacity <= 0) {
			throw new Error("Replay capacity must be a positive integer");
		}
		if (protocolVersion.length === 0) throw new Error("Replay protocol version must not be empty");
		this.capacityValue = capacity;
		this.protocolVersion = protocolVersion;
	}

	get capacity(): number {
		return this.capacityValue;
	}

	get earliestCursor(): number {
		return this.events[0]?.params.cursor ?? this.lastCursor;
	}

	get latestCursor(): number {
		return this.lastCursor;
	}

	append(value: unknown, timestamp = new Date()): AppEventNotification {
		if (this.lastCursor === Number.MAX_SAFE_INTEGER) throw new Error("Event cursor exhausted");
		const event = parseAppProtocolEvent(value);
		const cursor = this.lastCursor + 1;
		const notification: AppEventNotification = {
			jsonrpc: "2.0",
			method: event.type,
			params: {
				protocolVersion: this.protocolVersion,
				cursor,
				timestamp: timestamp.toISOString(),
				event: structuredClone(event),
			},
		};
		this.lastCursor = cursor;
		this.events.push(notification);
		if (this.events.length > this.capacityValue) this.events.shift();
		return structuredClone(notification);
	}

	replay(afterCursor: number, limit = this.capacityValue): EventsReplayResult {
		if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
			throw new ProtocolValidationError(
				APP_PROTOCOL_ERROR_CODES.INVALID_PARAMS,
				"afterCursor must be a non-negative integer",
			);
		}
		if (!Number.isSafeInteger(limit) || limit <= 0) {
			throw new ProtocolValidationError(
				APP_PROTOCOL_ERROR_CODES.INVALID_PARAMS,
				"replay limit must be a positive integer",
			);
		}
		if (afterCursor > this.lastCursor) {
			throw new ProtocolValidationError(
				APP_PROTOCOL_ERROR_CODES.INVALID_PARAMS,
				"Replay cursor is ahead of the event log",
				{
					data: { requestedCursor: afterCursor, latestCursor: this.lastCursor },
				},
			);
		}

		const earliestCursor = this.earliestCursor;
		if (this.events.length > 0 && afterCursor < earliestCursor - 1) {
			throw new ProtocolValidationError(
				APP_PROTOCOL_ERROR_CODES.REPLAY_GAP,
				"Replay cursor is no longer available",
				{
					data: {
						requestedCursor: afterCursor,
						earliestCursor,
						latestCursor: this.lastCursor,
						minimumResumeCursor: earliestCursor - 1,
					},
				},
			);
		}

		const available = this.events.filter((event) => event.params.cursor > afterCursor);
		const selected = available.slice(0, limit).map((event) => structuredClone(event));
		const nextCursor = selected.at(-1)?.params.cursor ?? afterCursor;
		return {
			events: selected,
			earliestCursor,
			latestCursor: this.lastCursor,
			nextCursor,
			hasMore: available.length > selected.length,
		};
	}
}
