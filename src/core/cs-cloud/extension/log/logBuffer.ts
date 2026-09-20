import { compressIfWorthwhile, serializeNdjson, type SerializedPayload } from "./logSerializer"
import { MAX_RECORD_BYTES, byteLength } from "./logValidator"
import type { LogRecord } from "./types"

/** 触发发送：100 条 / 256 KiB（未压缩）/ 5 秒，任一先到。 */
export const FLUSH_MAX_RECORDS = 100
export const FLUSH_MAX_BYTES = 256 * 1024
export const FLUSH_INTERVAL_MS = 5_000

/**
 * 单批上限：500 行 + 未压缩 1 MiB。
 * 用「未压缩 ≤ 1 MiB」一条规则同时满足传输 ≤1 MiB 与解压 ≤4 MiB（gzip 只会更小）。
 */
export const BATCH_MAX_RECORDS = 500
export const BATCH_MAX_UNCOMPRESSED_BYTES = 1024 * 1024

export const MAX_BUFFER_RECORDS = 2000

export interface LogBatch extends SerializedPayload {
	records: LogRecord[]
}

export class LogBuffer {
	private readonly records: LogRecord[] = []
	private bytes = 0
	private lastFlushAt: number

	constructor(private readonly options: { maxRecords?: number; now?: () => number; flushIntervalMs?: number } = {}) {
		this.lastFlushAt = this.now()
	}

	public push(record: LogRecord): void {
		const max = this.options.maxRecords ?? MAX_BUFFER_RECORDS
		if (this.records.length >= max) {
			this.records.shift()
		}
		this.records.push(record)
		this.bytes += estimateRecordBytes(record)
	}

	public get size(): number {
		return this.records.length
	}

	public get pendingBytes(): number {
		return this.bytes
	}

	public shouldFlush(now: number): boolean {
		if (this.records.length === 0) {
			return false
		}
		if (this.records.length >= FLUSH_MAX_RECORDS) {
			return true
		}
		if (this.bytes >= FLUSH_MAX_BYTES) {
			return true
		}
		return now - this.lastFlushAt >= (this.options.flushIntervalMs ?? FLUSH_INTERVAL_MS)
	}

	public takeAll(): LogRecord[] {
		const taken = this.records.splice(0, this.records.length)
		this.bytes = 0
		this.lastFlushAt = this.now()
		return taken
	}

	public markFlushed(): void {
		this.lastFlushAt = this.now()
	}

	private now(): number {
		return this.options.now?.() ?? Date.now()
	}
}

export const estimateRecordBytes = (record: LogRecord): number => byteLength(JSON.stringify(record)) + 1

export const splitIntoBatches = (
	records: LogRecord[],
	options: { maxRecords?: number; maxBytes?: number } = {},
): { batches: LogBatch[]; dropped: number } => {
	const maxRecords = options.maxRecords ?? BATCH_MAX_RECORDS
	const maxBytes = options.maxBytes ?? BATCH_MAX_UNCOMPRESSED_BYTES

	const batches: LogBatch[] = []
	let current: LogRecord[] = []
	let currentBytes = 0
	let dropped = 0

	const flush = () => {
		if (current.length === 0) {
			return
		}
		batches.push({ records: current, ...compressIfWorthwhile(serializeNdjson(current)) })
		current = []
		currentBytes = 0
	}

	for (const record of records) {
		const size = estimateRecordBytes(record)
		if (size > MAX_RECORD_BYTES) {
			dropped++
			continue
		}
		if (current.length >= maxRecords || (currentBytes + size > maxBytes && current.length > 0)) {
			flush()
		}
		current.push(record)
		currentBytes += size
	}

	flush()
	return { batches, dropped }
}
