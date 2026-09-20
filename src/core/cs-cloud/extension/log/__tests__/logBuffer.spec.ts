import { LogBuffer, splitIntoBatches, BATCH_MAX_RECORDS, FLUSH_MAX_RECORDS } from "../logBuffer"
import { GZIP_THRESHOLD_BYTES } from "../logSerializer"
import type { LogRecord } from "../types"

let counter = 0
const buildRecord = (overrides: Partial<LogRecord> = {}): LogRecord => {
	counter++
	return {
		timestamp: "2025-09-18T10:00:00.000Z",
		message: `message ${counter}`,
		level: "info",
		client_type: "vscode-plugin",
		event_id: `event-${counter}`,
		...overrides,
	}
}

describe("splitIntoBatches", () => {
	it("serializes records as NDJSON and keeps them in order", () => {
		const records = [buildRecord({ message: "first" }), buildRecord({ message: "second" })]
		const { batches } = splitIntoBatches(records)

		expect(batches).toHaveLength(1)
		const lines = batches[0].body.toString("utf8").trim().split("\n")
		expect(lines).toHaveLength(2)
		expect(JSON.parse(lines[0]).message).toBe("first")
		expect(JSON.parse(lines[1]).message).toBe("second")
	})

	it("does not gzip small batches", () => {
		const { batches } = splitIntoBatches([buildRecord()])
		expect(batches[0].encoding).toBeUndefined()
	})

	it("gzips large batches", () => {
		const records = Array.from({ length: 200 }, () => buildRecord({ message: "x".repeat(200) }))
		const { batches } = splitIntoBatches(records)
		expect(batches.every((batch) => batch.encoding === "gzip")).toBe(true)
		expect(batches[0].body.byteLength).toBeGreaterThan(0)
	})

	it("splits by row count", () => {
		const records = Array.from({ length: BATCH_MAX_RECORDS + 3 }, () => buildRecord())
		const { batches } = splitIntoBatches(records)
		expect(batches).toHaveLength(2)
		expect(batches[0].records).toHaveLength(BATCH_MAX_RECORDS)
		expect(batches[1].records).toHaveLength(3)
	})

	it("splits by byte budget", () => {
		const records = Array.from({ length: 10 }, () => buildRecord({ message: "y".repeat(300) }))
		const { batches } = splitIntoBatches(records, { maxBytes: 1000 })
		expect(batches.length).toBeGreaterThan(1)
		for (const batch of batches) {
			expect(batch.records.length).toBeLessThan(records.length)
		}
	})

	it("drops single records above 64 KiB", () => {
		const { batches, dropped } = splitIntoBatches([
			buildRecord({ message: "z".repeat(64 * 1024 + 10) }),
			buildRecord(),
		])
		expect(dropped).toBe(1)
		expect(batches[0].records).toHaveLength(1)
	})
})

describe("LogBuffer", () => {
	it("flushes at 100 records", () => {
		const buffer = new LogBuffer()
		for (let index = 0; index < FLUSH_MAX_RECORDS; index++) {
			buffer.push(buildRecord())
		}
		expect(buffer.shouldFlush(Date.now())).toBe(true)
	})

	it("flushes after the interval when non-empty", () => {
		let now = 1_000_000
		const buffer = new LogBuffer({ now: () => now, flushIntervalMs: 5_000 })
		buffer.push(buildRecord())
		expect(buffer.shouldFlush(now)).toBe(false)
		now += 5_000
		expect(buffer.shouldFlush(now)).toBe(true)
	})

	it("does not flush when empty", () => {
		const buffer = new LogBuffer()
		expect(buffer.shouldFlush(Date.now() + 60_000)).toBe(false)
	})

	it("drops the oldest record when the queue is full", () => {
		const buffer = new LogBuffer({ maxRecords: 2 })
		buffer.push(buildRecord({ message: "one" }))
		buffer.push(buildRecord({ message: "two" }))
		buffer.push(buildRecord({ message: "three" }))
		const taken = buffer.takeAll()
		expect(taken.map((record) => record.message)).toEqual(["two", "three"])
	})

	it("uses a 256 KiB byte trigger", () => {
		const buffer = new LogBuffer()
		buffer.push(buildRecord({ message: "q".repeat(GZIP_THRESHOLD_BYTES) }))
		expect(buffer.pendingBytes).toBeGreaterThan(GZIP_THRESHOLD_BYTES)
		expect(buffer.shouldFlush(Date.now())).toBe(false)
	})
})
