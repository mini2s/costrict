import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "fs"
import { promises as fs } from "fs"
import * as path from "path"

import { LOG_LEVEL_RANK, type LogRecord } from "./types"

export const OFFLINE_MAX_BYTES = 50 * 1024 * 1024
export const OFFLINE_MAX_AGE_MS = 24 * 60 * 60 * 1000
/**
 * 本地分片保留时长（小时）。
 * 契约允许服务端接受「接收时刻前 3 天」内的日志，因此默认与 3 天对齐，
 * 否则跨周末断网的数据会在还能被服务端接受时就被本地淘汰。
 * 上限 72：更久的日志必然超出服务端时间窗口，只会被 4xx 拒绝。
 */
export const DEFAULT_OFFLINE_RETENTION_HOURS = 72
export const MAX_OFFLINE_RETENTION_HOURS = 72
export const MIN_OFFLINE_RETENTION_HOURS = 1

const SHARD_SUFFIX = ".ndjson"
const META_FILE = "meta.json"
/** 上报回执（对账账本）：每成功确认一个分片追加一行；不参与 diagnostics 的轮空。 */
const RECEIPT_FILE = "uploaded.log"
const RECEIPT_ROTATED_FILE = "uploaded.log.1"
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024

export interface LogShard {
	path: string
	records: LogRecord[]
	bytes: number
	createdAt: number
	lowestRank: number
}

/** 写前落盘产生的分片句柄（用于发送成功后删除）。 */
export interface SealedShard {
	path: string
	records: number
	/** 分片内第一条记录的 event_id，用于写入上报回执 */
	firstEventId?: string
}

export interface LogOfflineStoreOptions {
	dir: string
	maxBytes?: number
	/** 分片保留时长；不传时用 OFFLINE_MAX_AGE_MS（24h） */
	maxAgeMs?: number
	now?: () => number
	/** 每次追加后 fsync；默认 false（足够抵御进程/宿主崩溃，开启后可抵御整机断电） */
	fsync?: boolean
	/** 淘汰分片时的回调（用于输出可读日志，避免静默丢数据） */
	onDrop?: (info: { shards: number; records: number; reason: "expired" | "over-capacity" }) => void
}

export interface OfflineStoreStats {
	bytes: number
	records: number
	dropped: number
	/** 累计被服务端确认（200 且分片已删除）的条数 */
	confirmed: number
}

export class LogOfflineStore {
	private dropped = 0
	private confirmed = 0
	private receiptBytes = -1
	private metaLoaded = false
	private bytes = 0
	private recordCount = 0
	private currentShard?: { path: string; bytes: number; records: number; firstEventId?: string }
	private durable = 0
	private writeFailures = 0

	constructor(private readonly options: LogOfflineStoreOptions) {}

	public get dir(): string {
		return this.options.dir
	}

	/**
	 * 写前落盘：同步追加到「当前分片」。返回前数据已交给内核（进程崩溃不丢）；
	 * 开启 fsync 后同时落盘（整机断电不丢）。
	 */
	public appendSync(records: LogRecord[]): void {
		if (records.length === 0) {
			return
		}
		try {
			mkdirSync(this.dir, { recursive: true })
			if (!this.currentShard) {
				this.currentShard = {
					path: path.join(
						this.dir,
						`${this.now()}-${Math.random().toString(16).slice(2, 10)}${SHARD_SUFFIX}`,
					),
					bytes: 0,
					records: 0,
					firstEventId: records[0]?.event_id,
				}
			}
			const body = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
			const size = Buffer.byteLength(body, "utf8")

			if (this.options.fsync) {
				const fd = openSync(this.currentShard.path, "a")
				try {
					writeSync(fd, body)
					fsyncSync(fd)
				} finally {
					closeSync(fd)
				}
			} else {
				appendFileSync(this.currentShard.path, body, "utf8")
			}

			this.currentShard.bytes += size
			this.currentShard.records += records.length
			this.bytes += size
			this.recordCount += records.length
			this.durable += records.length
		} catch {
			// 落盘失败不能影响主链路，但必须计数以便暴露
			this.writeFailures += records.length
		}
	}

	/**
	 * 封口当前分片：下一次 append 会另开新文件。
	 * 返回刚封口的分片句柄，调用方在全部发送成功后才应删除它。
	 */
	public sealCurrent(): SealedShard | undefined {
		const current = this.currentShard
		this.currentShard = undefined
		return current
			? { path: current.path, records: current.records, firstEventId: current.firstEventId }
			: undefined
	}

	/** 发送成功、且分片内没有「因内存上限被丢弃」的记录时调用。 */
	public async removeSealed(shard: SealedShard, requestId?: string): Promise<void> {
		try {
			await fs.unlink(shard.path)
			this.recordCount = Math.max(0, this.recordCount - shard.records)
		} catch {
			// 已被删除
		}
		await this.writeReceipt({
			path: shard.path,
			records: shard.records,
			firstEventId: shard.firstEventId,
			requestId,
		})
	}

	/**
	 * 上报回执：把「某个分片已被服务端确认」写成一行 append-only 的记录，
	 * 使「落盘 = 盘上分片 + 已确认 + 淘汰」这条对账等式可随时自证。
	 */
	private async writeReceipt(entry: {
		path: string
		records: number
		firstEventId?: string
		requestId?: string
		bytes?: number
	}): Promise<void> {
		this.confirmed += entry.records
		try {
			const filePath = path.join(this.dir, RECEIPT_FILE)
			if (this.receiptBytes < 0) {
				this.receiptBytes = await fs
					.stat(filePath)
					.then((stat) => stat.size)
					.catch(() => 0)
			}
			if (this.receiptBytes > MAX_RECEIPT_BYTES) {
				// 只保留一代历史，防止账本无限增长
				await fs.rename(filePath, path.join(this.dir, RECEIPT_ROTATED_FILE)).catch(() => undefined)
				this.receiptBytes = 0
			}
			const line = `${new Date(this.now()).toISOString()} shard=${path.basename(entry.path)} records=${entry.records}${entry.bytes !== undefined ? ` bytes=${entry.bytes}` : ""}${entry.firstEventId ? ` first_event=${entry.firstEventId}` : ""}${entry.requestId ? ` request_id=${entry.requestId}` : ""}\n`
			await fs.appendFile(filePath, line, "utf8")
			this.receiptBytes += Buffer.byteLength(line, "utf8")
		} catch {
			// 回执写失败不影响主链路（确认计数已在内存中累加）
		}
	}

	public get durability(): { durable: number; writeFailures: number } {
		return { durable: this.durable, writeFailures: this.writeFailures }
	}

	public async save(records: LogRecord[]): Promise<LogShard | undefined> {
		if (records.length === 0) {
			return undefined
		}
		await fs.mkdir(this.dir, { recursive: true })

		const now = this.now()
		const filePath = path.join(this.dir, `${now}-${Math.random().toString(16).slice(2, 10)}${SHARD_SUFFIX}`)
		const body = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
		await fs.writeFile(filePath, body, "utf8")

		const shard: LogShard = {
			path: filePath,
			records,
			bytes: Buffer.byteLength(body, "utf8"),
			createdAt: now,
			lowestRank: lowestRankOf(records),
		}
		this.bytes += shard.bytes
		this.recordCount += records.length
		return shard
	}

	/**
	 * 列出分片。默认**跳过本进程正在追加的未封口分片**——其记录仍在内存缓冲里，
	 * 若被补发路径抢先发送会造成重复上报。进程重启后它不再是 current，自然会被纳入恢复。
	 */
	public async list(options: { includeCurrent?: boolean } = {}): Promise<LogShard[]> {
		await fs.mkdir(this.dir, { recursive: true })
		const entries = await fs.readdir(this.dir)
		const shards: LogShard[] = []
		let bytes = 0
		let records = 0

		for (const entry of entries.sort()) {
			if (!entry.endsWith(SHARD_SUFFIX)) {
				continue
			}
			const filePath = path.join(this.dir, entry)
			if (!options.includeCurrent && this.currentShard && filePath === this.currentShard.path) {
				continue
			}
			try {
				const body = await fs.readFile(filePath, "utf8")
				const parsed = parseShard(body)
				if (parsed.length === 0) {
					await fs.unlink(filePath).catch(() => undefined)
					continue
				}
				const shard: LogShard = {
					path: filePath,
					records: parsed,
					bytes: Buffer.byteLength(body, "utf8"),
					createdAt: Number(entry.split("-")[0]) || 0,
					lowestRank: lowestRankOf(parsed),
				}
				shards.push(shard)
				bytes += shard.bytes
				records += parsed.length
			} catch {
				// 忽略不可读分片
			}
		}

		this.bytes = bytes
		this.recordCount = records
		return shards
	}

	public async remove(shard: LogShard, requestId?: string): Promise<void> {
		try {
			await fs.unlink(shard.path)
			this.bytes = Math.max(0, this.bytes - shard.bytes)
			this.recordCount = Math.max(0, this.recordCount - shard.records.length)
		} catch {
			// 已被删除
		}
		await this.writeReceipt({
			path: shard.path,
			records: shard.records.length,
			bytes: shard.bytes,
			firstEventId: shard.records[0]?.event_id,
			requestId,
		})
	}

	/** 按「过期优先 → 低级别优先」淘汰，返回本次丢弃条数。 */
	public async prune(): Promise<number> {
		const shards = await this.list({ includeCurrent: true })
		const now = this.now()
		const maxAgeMs = this.options.maxAgeMs ?? OFFLINE_MAX_AGE_MS
		const maxBytes = this.options.maxBytes ?? OFFLINE_MAX_BYTES
		let dropped = 0
		let kept = [...shards]

		const expired = kept.filter((shard) => now - shard.createdAt > maxAgeMs)
		if (expired.length > 0) {
			kept = kept.filter((shard) => !expired.includes(shard))
			for (const shard of expired) {
				await fs.unlink(shard.path).catch(() => undefined)
				dropped += shard.records.length
			}
			this.options.onDrop?.({ shards: expired.length, records: dropped, reason: "expired" })
		}

		let totalBytes = kept.reduce((sum, shard) => sum + shard.bytes, 0)
		kept = kept.sort((a, b) => a.lowestRank - b.lowestRank || a.createdAt - b.createdAt)
		let capacityShards = 0
		let capacityRecords = 0
		while (totalBytes > maxBytes && kept.length > 0) {
			const shard = kept.shift() as LogShard
			await fs.unlink(shard.path).catch(() => undefined)
			totalBytes -= shard.bytes
			dropped += shard.records.length
			capacityShards++
			capacityRecords += shard.records.length
		}
		if (capacityShards > 0) {
			this.options.onDrop?.({ shards: capacityShards, records: capacityRecords, reason: "over-capacity" })
		}

		if (dropped > 0) {
			this.dropped += dropped
			await this.persistMeta()
		}

		this.bytes = totalBytes
		this.recordCount = kept.reduce((sum, shard) => sum + shard.records.length, 0)
		return dropped
	}

	public async getStats(): Promise<OfflineStoreStats> {
		await this.ensureMetaLoaded()
		return { bytes: this.bytes, records: this.recordCount, dropped: this.dropped, confirmed: this.confirmed }
	}

	/** 累计被服务端确认的条数（同步读取，用于统计行）。 */
	public get confirmedRecords(): number {
		return this.confirmed
	}

	private async ensureMetaLoaded(): Promise<void> {
		if (this.metaLoaded) {
			return
		}
		this.metaLoaded = true
		try {
			const body = await fs.readFile(path.join(this.dir, META_FILE), "utf8")
			const parsed = JSON.parse(body) as { dropped?: unknown }
			if (typeof parsed.dropped === "number") {
				this.dropped = parsed.dropped
			}
		} catch {
			this.dropped = 0
		}
	}

	private async persistMeta(): Promise<void> {
		try {
			await fs.mkdir(this.dir, { recursive: true })
			await fs.writeFile(path.join(this.dir, META_FILE), JSON.stringify({ dropped: this.dropped }), "utf8")
		} catch {
			// 统计落盘失败不影响主链路
		}
	}

	private now(): number {
		return this.options.now?.() ?? Date.now()
	}
}

const lowestRankOf = (records: LogRecord[]): number => {
	let rank = Number.MAX_SAFE_INTEGER
	for (const record of records) {
		rank = Math.min(rank, LOG_LEVEL_RANK[record.level] ?? 2)
	}
	return rank === Number.MAX_SAFE_INTEGER ? 2 : rank
}

const parseShard = (body: string): LogRecord[] => {
	const records: LogRecord[] = []
	for (const line of body.split("\n")) {
		const trimmed = line.trim()
		if (!trimmed) {
			continue
		}
		try {
			records.push(JSON.parse(trimmed) as LogRecord)
		} catch {
			// 丢弃损坏行
		}
	}
	return records
}
