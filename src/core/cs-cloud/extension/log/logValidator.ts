import { LOG_LEVELS, type LogLevel, type LogRecord } from "./types"

export const CLIENT_TYPES = ["cs-cloud", "vscode-plugin", "jetbrains-plugin", "cli-csc", "cli-codex"] as const

export const MAX_MESSAGE_BYTES = 32 * 1024
export const MAX_RECORD_BYTES = 64 * 1024
export const MAX_ATTRIBUTE_COUNT = 24
export const MAX_ATTRIBUTE_VALUE_BYTES = 1024

/** 时间窗口：服务端接收时刻前 3 天至后 5 分钟。 */
export const TIMESTAMP_PAST_MS = 3 * 24 * 60 * 60 * 1000
export const TIMESTAMP_FUTURE_MS = 5 * 60 * 1000

/** 服务端禁止客户端提交的字段（提交即整批 400）。 */
export const RESERVED_FIELDS = [
	"_time",
	"_msg",
	"_stream",
	"_stream_id",
	"universal_id",
	"subject_id",
	"tenant_id",
	"identity_issuer",
] as const

const ATTRIBUTE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,47}$/

export type DropReason =
	| "missing_field"
	| "invalid_level"
	| "invalid_client_type"
	| "message_empty"
	| "message_too_long"
	| "record_too_large"
	| "timestamp_out_of_range"
	| "reserved_field"
	| "invalid_attribute"

export interface ValidationResult {
	ok: boolean
	reason?: DropReason
}

export const byteLength = (value: string): number => Buffer.byteLength(value, "utf8")

export const isLogLevel = (value: unknown): value is LogLevel =>
	typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value)

export const validateRecord = (record: LogRecord, now: number): ValidationResult => {
	if (!record.message) {
		return { ok: false, reason: "message_empty" }
	}
	if (byteLength(record.message) > MAX_MESSAGE_BYTES) {
		return { ok: false, reason: "message_too_long" }
	}
	if (!isLogLevel(record.level)) {
		return { ok: false, reason: "invalid_level" }
	}
	if (!(CLIENT_TYPES as readonly string[]).includes(record.client_type)) {
		return { ok: false, reason: "invalid_client_type" }
	}
	if (!record.timestamp) {
		return { ok: false, reason: "missing_field" }
	}

	const timestamp = Date.parse(record.timestamp)
	if (Number.isNaN(timestamp)) {
		return { ok: false, reason: "missing_field" }
	}
	if (timestamp < now - TIMESTAMP_PAST_MS || timestamp > now + TIMESTAMP_FUTURE_MS) {
		return { ok: false, reason: "timestamp_out_of_range" }
	}

	if (record.attributes) {
		const entries = Object.entries(record.attributes)
		if (entries.length > MAX_ATTRIBUTE_COUNT) {
			return { ok: false, reason: "invalid_attribute" }
		}
		for (const [key, value] of entries) {
			if (!ATTRIBUTE_KEY_PATTERN.test(key) || byteLength(String(value)) > MAX_ATTRIBUTE_VALUE_BYTES) {
				return { ok: false, reason: "invalid_attribute" }
			}
		}
	}

	for (const field of RESERVED_FIELDS) {
		if (field in (record as unknown as Record<string, unknown>)) {
			return { ok: false, reason: "reserved_field" }
		}
	}

	if (byteLength(JSON.stringify(record)) > MAX_RECORD_BYTES) {
		return { ok: false, reason: "record_too_large" }
	}

	return { ok: true }
}
