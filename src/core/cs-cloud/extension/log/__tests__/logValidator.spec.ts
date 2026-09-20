import { MAX_ATTRIBUTE_COUNT, validateRecord } from "../logValidator"
import type { LogRecord } from "../types"

const NOW = Date.parse("2025-09-18T10:00:00.000Z")

const buildRecord = (overrides: Partial<LogRecord> = {}): LogRecord => ({
	timestamp: new Date(NOW).toISOString(),
	message: "hello",
	level: "info",
	device_id: "device-1",
	client_type: "vscode-plugin",
	client_version: "1.0.0",
	event_id: "event-1",
	...overrides,
})

describe("logValidator", () => {
	it("accepts a well-formed record", () => {
		expect(validateRecord(buildRecord(), NOW)).toEqual({ ok: true })
	})

	it("rejects empty message", () => {
		expect(validateRecord(buildRecord({ message: "" }), NOW)).toEqual({ ok: false, reason: "message_empty" })
	})

	it("rejects message over 32 KiB", () => {
		const result = validateRecord(buildRecord({ message: "a".repeat(32 * 1024 + 1) }), NOW)
		expect(result).toEqual({ ok: false, reason: "message_too_long" })
	})

	it("rejects unknown level", () => {
		const result = validateRecord(buildRecord({ level: "verbose" as LogRecord["level"] }), NOW)
		expect(result).toEqual({ ok: false, reason: "invalid_level" })
	})

	it("rejects unknown client_type", () => {
		const result = validateRecord(buildRecord({ client_type: "vscode" as LogRecord["client_type"] }), NOW)
		expect(result).toEqual({ ok: false, reason: "invalid_client_type" })
	})

	it("rejects timestamps outside the -3d/+5min window", () => {
		const tooOld = new Date(NOW - 4 * 24 * 60 * 60 * 1000).toISOString()
		const tooNew = new Date(NOW + 10 * 60 * 1000).toISOString()
		expect(validateRecord(buildRecord({ timestamp: tooOld }), NOW)).toEqual({
			ok: false,
			reason: "timestamp_out_of_range",
		})
		expect(validateRecord(buildRecord({ timestamp: tooNew }), NOW)).toEqual({
			ok: false,
			reason: "timestamp_out_of_range",
		})
	})

	it("rejects reserved fields", () => {
		const record = buildRecord() as LogRecord & Record<string, unknown>
		record.universal_id = "user-1"
		expect(validateRecord(record, NOW)).toEqual({ ok: false, reason: "reserved_field" })
	})

	it("rejects invalid attribute keys and values", () => {
		expect(validateRecord(buildRecord({ attributes: { "Bad-Key": "1" } }), NOW)).toEqual({
			ok: false,
			reason: "invalid_attribute",
		})
		expect(validateRecord(buildRecord({ attributes: { ok_key: "a".repeat(1025) } }), NOW)).toEqual({
			ok: false,
			reason: "invalid_attribute",
		})
	})

	it("rejects too many attributes", () => {
		const attributes: Record<string, string> = {}
		for (let index = 0; index <= MAX_ATTRIBUTE_COUNT; index++) {
			attributes[`key_${index}`] = "v"
		}
		expect(validateRecord(buildRecord({ attributes }), NOW)).toEqual({ ok: false, reason: "invalid_attribute" })
	})
})
