import * as crypto from "crypto"
import { promises as fs } from "fs"
import * as path from "path"

import { classifyFailure, isCollectionDisabled } from "./logErrorPolicy"
import { LogBuffer, splitIntoBatches, type LogBatch } from "./logBuffer"
import { DiagnosticsFile, describeError } from "./logDiagnostics"
import { LogEndpointResolver, type DiscoveryEvent, type LogEndpoint } from "./logEndpointResolver"
import type { LogTransport } from "./logMockTransport"
import type { UploadResult } from "./logUploader"
import {
	LogOfflineStore,
	DEFAULT_OFFLINE_RETENTION_HOURS,
	MAX_OFFLINE_RETENTION_HOURS,
	MIN_OFFLINE_RETENTION_HOURS,
} from "./logOfflineStore"
import { LogRetryPolicy } from "./logRetryPolicy"
import { LogUploader } from "./logUploader"
import { MAX_MESSAGE_BYTES, MAX_ATTRIBUTE_COUNT, MAX_ATTRIBUTE_VALUE_BYTES, validateRecord } from "./logValidator"
import {
	LOG_LEVELS,
	type ClientType,
	type LogLevel,
	type LogRecord,
	type LogServiceStats,
	type WebviewLogRecord,
} from "./types"

const ATTRIBUTE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,47}$/
const MAX_SPLIT_DEPTH = 2
const DEFAULT_FLUSH_INTERVAL_MS = 5_000
/** 账号 / 权限类失败后的静默期（非永久停止，到期后允许再试）。 */
const PAUSE_RETRY_MS = 5 * 60_000
/** 离线缓存的定期淘汰间隔。 */
const PRUNE_INTERVAL_MS = 10 * 60_000
/** 相同原因下的发现失败日志节流间隔（尝试本身不节流，仍按 tick 重试）。 */
const DISCOVERY_FAILURE_LOG_INTERVAL_MS = 60_000
/**
 * 取 token 的超时。没有它，凭据获取卡住会让 sendBatch 永远进不到 transport，
 * 整条上报链路静默停摆（虚拟机实测卡死 16~36 分钟，见诊断日志）。
 */
const TOKEN_TIMEOUT_MS = 5_000
/**
 * 单轮 tick 的最长允许时长。tick 用 flushing 闩锁防止重入，一旦某个 await 长时间
 * 不返回，闩锁会一直为 true，后续所有 tick 直接 return——不封口、不重试、不打日志。
 * 超过该时长强制释放闩锁并记录告警。
 */
const TICK_TIMEOUT_MS = 90_000
/** 相同原因的「跳过上报」日志节流间隔。 */
const SKIP_LOG_INTERVAL_MS = 60_000
/** 心跳统计行间隔：即使持续失败，也必须能从日志看出服务还活着。 */
const STATS_LOG_INTERVAL_MS = 5 * 60_000

/** 本地替代传输使用的占位 endpoint（不参与发现，也不会发出 HTTP）。 */
const LOCAL_MOCK_ENDPOINT: LogEndpoint = {
	enabled: true,
	url: "local-outbox",
	fallbackUrls: [],
	protocol: "local-mock",
	expiresAt: Number.MAX_SAFE_INTEGER,
}

/** 给任意 Promise 加超时；超时抛出带 label 的错误，调用方据此记录可读原因。 */
const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label}超时（${timeoutMs}ms）`)), timeoutMs)
				timer.unref?.()
			}),
		])
	} finally {
		if (timer) {
			clearTimeout(timer)
		}
	}
}

/** 保留期按小时收敛到 [1, 72]：契约只接受接收时刻前 3 天内的日志，更久无意义。 */
const resolveRetentionHours = (hours: number | undefined): number => {
	if (typeof hours !== "number" || !Number.isFinite(hours)) {
		return DEFAULT_OFFLINE_RETENTION_HOURS
	}
	return Math.min(MAX_OFFLINE_RETENTION_HOURS, Math.max(MIN_OFFLINE_RETENTION_HOURS, Math.floor(hours)))
}

export interface CsCloudLogServiceOptions {
	/** endpoint 发现基址（costrict 后端），例如 https://zgsm.sangfor.com 或本地 mock */
	baseUrl: string
	getAccessToken: () => Promise<string | null>
	deviceId: string
	clientType: ClientType
	clientVersion: string
	/** 离线缓存目录；不提供则退化为纯内存队列 */
	storageDir?: string
	/**
	 * 上报动作；不提供时走 HTTP（发现接口 + NDJSON 上传）。
	 * 后端未就绪时可传入 createFileTransport(dir)，改为本地落盘且完全不发 HTTP。
	 */
	transport?: LogTransport
	getWorkspaceDirectory?: () => string | undefined
	outputChannel?: { appendLine: (line: string) => void }
	/** 采集开关变化时回调（宿主据此把 logs.enabled 下发给 Webview）。 */
	onConfigChange?: (config: { enabled: boolean }) => void
	fetchImpl?: typeof fetch
	now?: () => number
	random?: () => number
	flushIntervalMs?: number
	/** 账号 / 权限类失败后的静默期，默认 5 分钟 */
	pauseRetryMs?: number
	/** 取 token 的超时，默认 5 秒 */
	tokenTimeoutMs?: number
	/** 单轮 tick 的看门狗超时，默认 90 秒 */
	tickTimeoutMs?: number
	/** 心跳统计行间隔，默认 5 分钟 */
	statsLogIntervalMs?: number
	/**
	 * 本地分片保留时长（小时），默认 72（契约允许服务端接受 3 天内的日志）。
	 * 超出保留时长的分片会被淘汰且**不会再上报**（淘汰时会打一行日志）。
	 */
	offlineMaxAgeHours?: number
	/** 写前落盘时是否 fsync；默认 false（进程/宿主崩溃不丢，整机断电需开启） */
	fsync?: boolean
	debug?: boolean
}

export class CsCloudLogService {
	private readonly buffer: LogBuffer
	private readonly resolver: LogEndpointResolver
	private readonly uploader: LogUploader
	private readonly transport: LogTransport
	private readonly retry: LogRetryPolicy
	private readonly offline?: LogOfflineStore
	/** 带超时的凭据获取（运行时注入，避免任何一条等待无限期挂起）。 */
	private readonly getTokenWithTimeout: () => Promise<string | null>
	/** 走本地替代传输时跳过 endpoint 发现，全程不发 HTTP。 */
	private readonly useDiscovery: boolean
	private readonly stats: LogServiceStats = {
		received: 0,
		dropped: 0,
		sent: 0,
		failed: 0,
		queued: 0,
		cached: 0,
		persisted: 0,
		writeFailures: 0,
		confirmed: 0,
		skipped: 0,
		tickTimeouts: 0,
	}
	private lastReportedEnabled?: boolean
	private lastLoggedUploadUrl?: string
	private discoveryConsecutiveFailures = 0
	private discoveryFailureKey?: string
	private discoveryFailureLoggedAt = 0
	private readonly diagnostics?: DiagnosticsFile

	private workspaceId: string | undefined
	private workspaceIdResolved = false
	private timer?: ReturnType<typeof setInterval>
	/** 认证 / 权限类失败后的静默期，到期后允许再试，避免永久卡死。 */
	private pausedUntil = 0
	private lastPruneAt = 0
	private readonly pauseRetryMs: number
	private disposed = false
	private nextAttemptAt = 0
	private attempt = 0
	private flushing = false
	/** 当前 tick 的开始时刻 + 代次，配合看门狗判断闩锁是否卡死。 */
	private tickStartedAt = 0
	private tickSeq = 0
	private tickTimeouts = 0
	/** 「跳过上报」日志的相同原因节流。 */
	private skipReasonKey?: string
	private skipLoggedAt = 0
	private lastStatsLoggedAt = 0
	/** 最近一次成功上报的服务端 X-Request-ID，用于写分片回执。 */
	private lastRequestId?: string

	constructor(private readonly options: CsCloudLogServiceOptions) {
		this.buffer = new LogBuffer({ now: options.now, flushIntervalMs: options.flushIntervalMs })
		this.pauseRetryMs = options.pauseRetryMs ?? PAUSE_RETRY_MS
		this.retry = new LogRetryPolicy({ random: options.random })
		this.uploader = new LogUploader({ fetchImpl: options.fetchImpl })
		this.useDiscovery = !options.transport
		this.transport = options.transport ?? ((url, payload, token) => this.uploader.upload(url, payload, token))
		// 凭据获取统一加超时：它是 transport 之前唯一的外部调用，卡住会让整条链路静默停摆。
		const tokenTimeoutMs = options.tokenTimeoutMs ?? TOKEN_TIMEOUT_MS
		const getTokenWithTimeout = (): Promise<string | null> =>
			withTimeout(options.getAccessToken(), tokenTimeoutMs, "获取 access token")
		this.getTokenWithTimeout = getTokenWithTimeout
		this.resolver = new LogEndpointResolver({
			baseUrl: options.baseUrl,
			// 超时异常交给发现接口自身的失败分支处理，保留可读原因
			getAccessToken: getTokenWithTimeout,
			fetchImpl: options.fetchImpl,
			now: options.now,
			random: options.random,
			cache: options.storageDir ? createFileCacheStore(options.storageDir) : undefined,
			onDiscovery: (event) => this.reportDiscovery(event),
		})
		const retentionHours = resolveRetentionHours(options.offlineMaxAgeHours)
		this.offline = options.storageDir
			? new LogOfflineStore({
					dir: options.storageDir,
					now: options.now,
					fsync: options.fsync,
					maxAgeMs: retentionHours * 60 * 60 * 1000,
					onDrop: (info) =>
						this.writeOutput(
							`淘汰本地分片 ${info.shards} 个 / ${info.records} 条（原因=${info.reason === "expired" ? `超过保留时长 ${retentionHours}h` : "超过容量上限"}），这些日志不会再上报`,
						),
				})
			: undefined
		this.diagnostics = options.storageDir
			? new DiagnosticsFile(path.join(options.storageDir, "diagnostics.log"))
			: undefined
	}

	public start(): void {
		if (this.timer || this.disposed) {
			return
		}
		this.writeOutput(
			`日志上报启动 logBaseUrl=${this.options.baseUrl} transport=${this.useDiscovery ? "http" : "local-mock"} cacheDir=${this.options.storageDir ?? "(仅内存，不落盘)"}${this.diagnostics ? ` diagnostics=${path.join(this.options.storageDir as string, "diagnostics.log")}` : ""}`,
		)
		void this.offline?.prune()
		void this.reportPendingShards()
		const interval = this.options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
		this.timer = setInterval(() => {
			void this.tick()
		}, interval)
		this.timer.unref?.()
		// 立即跑一轮：让发现接口结果（含 logBaseUrl → data.logs.url）马上出现在输出通道
		void this.tick()
	}

	/** 启动时报告待补发分片数，让「落盘了但没上报」这件事一眼可见。 */
	private async reportPendingShards(): Promise<void> {
		if (!this.offline) {
			return
		}
		try {
			const shards = await this.offline.list()
			if (shards.length === 0) {
				this.writeOutput("启动补发：没有未确认的分片")
				return
			}
			const records = shards.reduce((sum, shard) => sum + shard.records.length, 0)
			this.writeOutput(`启动补发：发现 ${shards.length} 个未确认分片，共 ${records} 条，将按时间顺序重发`)
		} catch {
			// 统计失败不影响主链路
		}
	}

	/**
	 * 主动上报：立即把内存缓冲与本地分片尽量送出去，返回最新统计。
	 * 供命令面板 / 人工触发使用，成功后可在 uploaded.log 中逐分片核对。
	 */
	public async flushNow(timeoutMs = 20_000): Promise<LogServiceStats> {
		await this.flush({ timeoutMs })
		return this.getStats()
	}

	/** 宿主侧自采：cs-cloud 启动失败、代理请求失败等（不进输出通道，避免与调试日志重复）。 */
	public log(level: LogLevel, message: string, attributes?: Record<string, unknown>): void {
		if (this.disposed) {
			return
		}

		const record: LogRecord = {
			timestamp: new Date(this.now()).toISOString(),
			message: truncateUtf8(String(message ?? ""), MAX_MESSAGE_BYTES),
			level,
			device_id: this.options.deviceId,
			client_type: this.options.clientType,
			client_version: this.options.clientVersion,
			event_id: crypto.randomUUID(),
		}

		const workspaceId = this.resolveWorkspaceId()
		if (workspaceId) {
			record.workspace_id = workspaceId
		}

		const normalized = normalizeAttributes(attributes)
		if (normalized) {
			record.attributes = normalized
		}

		const validation = validateRecord(record, this.now())
		if (!validation.ok) {
			this.stats.dropped++
			return
		}

		this.stats.received++
		this.offline?.appendSync([record])
		this.buffer.push(record)
		this.stats.queued = this.buffer.size
	}

	/** 接收 Webview 侧通过 csLog 消息提交的记录。 */
	public ingest(raw: unknown): void {
		if (this.disposed) {
			return
		}
		if (!raw || typeof raw !== "object") {
			this.stats.dropped++
			return
		}

		const input = raw as WebviewLogRecord
		const record = this.buildRecord(input)
		const validation = validateRecord(record, this.now())
		if (!validation.ok) {
			this.stats.dropped++
			this.writeOutput(`dropped record (${validation.reason})`)
			return
		}

		this.stats.received++
		this.offline?.appendSync([record])
		this.buffer.push(record)
		this.stats.queued = this.buffer.size
		this.writeOutput(`${record.level} ${record.message}`)
	}

	public async flush(options: { timeoutMs?: number } = {}): Promise<void> {
		const deadline = this.now() + (options.timeoutMs ?? 5_000)
		const bufferDrained = this.buffer.size > 0 ? await this.drainBuffer() : true
		while (bufferDrained && this.now() < deadline) {
			const sent = await this.flushOffline(1)
			if (!sent) {
				break
			}
		}
		await this.refreshStats()
	}

	public async getStats(): Promise<LogServiceStats> {
		await this.refreshStats()
		return { ...this.stats, queued: this.buffer.size }
	}

	public dispose(): void {
		this.disposed = true
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = undefined
		}
	}

	/** 退出前尽力把缓冲区与离线缓存发出去，然后停表。 */
	public async shutdown(timeoutMs = 5_000): Promise<void> {
		try {
			await this.flush({ timeoutMs })
		} catch {
			// 退出路径不抛错
		} finally {
			this.dispose()
		}
	}

	private async tick(): Promise<void> {
		if (this.disposed) {
			return
		}
		if (this.flushing) {
			const elapsed = this.now() - this.tickStartedAt
			if (elapsed < (this.options.tickTimeoutMs ?? TICK_TIMEOUT_MS)) {
				return
			}
			// 闩锁卡死：必须强制释放，否则封口 / 重试 / 日志全部停摆且完全无输出
			this.tickTimeouts++
			this.flushing = false
			this.writeOutput(
				`警告：上一轮 tick 已卡住 ${Math.round(elapsed / 1000)}s（第 ${this.tickTimeouts} 次），强制释放闩锁继续；卡死期间封口与上报均停摆`,
			)
		}

		const now = this.now()
		if (this.retry.isCoolingDown(now) || now < this.nextAttemptAt) {
			this.logHeartbeat(now)
			return
		}

		const seq = ++this.tickSeq
		this.flushing = true
		this.tickStartedAt = now
		try {
			// 即使处于暂停也要刷新发现配置，否则服务端重新开启采集后无法恢复
			const endpoint = await this.resolveEndpoint()
			if (endpoint) {
				this.reportCollectionEnabled(endpoint.enabled)
			}

			const paused = this.now() < this.pausedUntil
			if (!paused && (!endpoint || endpoint.enabled)) {
				let bufferDrained = true
				if (this.buffer.shouldFlush(this.now())) {
					bufferDrained = await this.drainBuffer()
				}
				// 本轮已发生失败（或刚进入静默期）时不再补发缓存，避免同一轮重复打服务端
				if (bufferDrained && this.now() >= this.pausedUntil) {
					await this.flushOffline(1)
				}
			} else if (paused) {
				this.noteSkip("静默期内暂停上报（账号 / 权限类失败）")
			}

			await this.pruneOffline(now)
			await this.refreshStats()
			this.logHeartbeat(this.now())
		} catch (error) {
			// 单个异常绝不能让整轮 tick 变成未处理的 rejection 而静默退出
			this.writeThrottled(`本轮 tick 异常（已忽略并继续下一轮）：${describeError(error)}`)
		} finally {
			// 只有仍是本轮时才释放闩锁：被看门狗释放后，旧轮次不得误放新一轮的闩锁
			if (this.tickSeq === seq) {
				this.flushing = false
			}
		}
	}

	/** 心跳统计行：即使一直失败，周期性出现也说明服务没卡死。 */
	private logHeartbeat(now: number): void {
		const interval = this.options.statsLogIntervalMs ?? STATS_LOG_INTERVAL_MS
		if (now - this.lastStatsLoggedAt < interval) {
			return
		}
		this.lastStatsLoggedAt = now
		this.writeOutput(
			`stats received=${this.stats.received} sent=${this.stats.sent} confirmed=${this.stats.confirmed} queued=${this.buffer.size} cached=${this.stats.cached} dropped=${this.stats.dropped} skipped=${this.stats.skipped} failed=${this.stats.failed} tickTimeouts=${this.stats.tickTimeouts}${this.stats.lastErrorDetail ? ` lastError=${this.stats.lastErrorDetail}` : ""}`,
		)
	}

	/**
	 * 记录一次「没有上报」的原因。相同原因 60s 内只记一行，避免刷屏；
	 * 没有它，无 token / 无地址等前置条件不满足时流程会完全静默。
	 */
	private noteSkip(reason: string): void {
		this.stats.skipped++
		this.writeThrottled(`跳过上报：${reason}`)
	}

	/**
	 * 相同内容 60s 内只输出一行。
	 * `key` 用于节流判定（应稳定，如 code + status），`line` 是实际输出内容
	 * （可含每次都变的 request_id / message，不会被误判成新原因而刷屏）。
	 */
	private writeThrottled(line: string, key = line): void {
		const now = this.now()
		if (key === this.skipReasonKey && now - this.skipLoggedAt < SKIP_LOG_INTERVAL_MS) {
			return
		}
		this.skipReasonKey = key
		this.skipLoggedAt = now
		this.writeOutput(line)
	}

	/**
	 * 把失败响应里契约 §3.6 规定的字段拼成完整的一行，供人与排障使用。
	 * 只留 `code` 会让 `TOKEN_SIGNATURE_INVALID` 这种错误完全无法定位。
	 */
	private describeFailure(result: UploadResult): string {
		const parts: string[] = []
		if (result.status !== undefined) {
			parts.push(`HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ""}`)
		}
		if (result.code) {
			parts.push(`code=${result.code}`)
		}
		if (result.message) {
			parts.push(`message=${result.message}`)
		}
		if (result.networkError) {
			parts.push(`network=${result.networkError}`)
		}
		if (result.detailsLine !== undefined || result.detailsField) {
			parts.push(`details=${result.detailsField ?? "?"}@${result.detailsLine ?? "?"}`)
		}
		if (result.requestId) {
			parts.push(`request_id=${result.requestId}`)
		}
		if (result.retryAfterSec !== undefined) {
			parts.push(`retry_after=${result.retryAfterSec}s`)
		}
		if (result.bodySnippet) {
			parts.push(`body=${result.bodySnippet.replace(/\s+/g, " ").trim()}`)
		}
		return parts.length > 0 ? parts.join(" ") : "无响应内容"
	}

	/** 稳定的一行摘要，用于命令面板弹窗（每次都变的部分放在末尾）。 */
	private summarizeFailure(result: UploadResult): string {
		const head = [result.status !== undefined ? `HTTP ${result.status}` : undefined, result.code]
			.filter(Boolean)
			.join(" ")
		const detail = result.message ?? result.networkError ?? result.bodySnippet?.slice(0, 120) ?? "无详细信息"
		const rid = result.requestId ? `（request_id=${result.requestId}）` : ""
		return `${head || "发送失败"}: ${detail}${rid}`
	}

	/** 离线缓存按「过期优先 → 低级别优先」定期淘汰，避免长会话突破容量上限。 */
	private async pruneOffline(now: number): Promise<void> {
		if (!this.offline || now - this.lastPruneAt < PRUNE_INTERVAL_MS) {
			return
		}
		this.lastPruneAt = now
		await this.offline.prune()
	}

	/** 返回是否全部批次都成功送出；有失败时调用方不再补发缓存，避免同一轮重复打服务端。 */
	private async drainBuffer(): Promise<boolean> {
		const records = this.buffer.takeAll()
		if (records.length === 0) {
			return true
		}
		// 封口当前分片：数据已在写前落盘，只有全部发送成功后才删除；
		// 崩溃时该分片仍在盘上，下次启动由补发路径送达。
		const sealed = this.offline?.sealCurrent()
		const { batches, dropped } = splitIntoBatches(records)
		this.stats.dropped += dropped
		let allSent = true
		for (const batch of batches) {
			const sent = await this.sendBatch(batch, 0)
			if (!sent) {
				allSent = false
			}
		}
		this.stats.queued = this.buffer.size

		if (allSent && sealed && sealed.records === records.length) {
			await this.offline?.removeSealed(sealed, this.lastRequestId)
		}
		return allSent
	}

	private async sendBatch(batch: LogBatch, depth: number): Promise<boolean> {
		const endpoint = await this.resolveEndpoint()
		if (!endpoint) {
			this.noteSkip("没有可用的上报地址（发现接口未返回 data.logs.url，且无有效缓存）")
			this.accountUnpersisted(batch.records)
			return false
		}
		if (!endpoint.enabled) {
			// 服务端已关闭采集：停采停报，缓存交由本地容量/过期策略淘汰
			this.reportCollectionEnabled(false)
			this.noteSkip("服务端已关闭日志采集（logs.enabled=false）")
			this.accountUnpersisted(batch.records)
			return false
		}
		this.reportCollectionEnabled(true)

		const token = await this.safeToken()
		if (!token) {
			this.accountUnpersisted(batch.records)
			return false
		}

		const result = await this.transport(endpoint.url, batch, token)
		if (result.ok) {
			this.stats.sent += batch.records.length
			this.attempt = 0
			this.nextAttemptAt = 0
			this.retry.recordSuccess()
			this.lastRequestId = result.requestId
			if (this.lastLoggedUploadUrl !== endpoint.url) {
				this.lastLoggedUploadUrl = endpoint.url
				this.writeOutput(`上报地址=${endpoint.url}`)
			}
			this.writeOutput(
				`batch sent ok n=${batch.records.length} effort=${batch.body.byteLength}${result.requestId ? ` request_id=${result.requestId}` : ""}`,
			)
			return true
		}

		this.stats.failed++
		this.stats.lastError = result.code ?? result.networkError ?? `HTTP ${result.status}`
		this.stats.lastErrorDetail = this.summarizeFailure(result)

		if (this.useDiscovery && (result.status === 404 || result.status === 410 || result.networkError)) {
			await this.resolver.invalidate()
		}

		const classification = classifyFailure(result)
		if (isCollectionDisabled(result.code)) {
			// 服务端声明已关闭采集：让下一次 tick 重新发现，从而拿到 enabled=false
			await this.resolver.invalidate()
			this.reportCollectionEnabled(false)
		}

		switch (classification.action) {
			case "retry": {
				this.accountUnpersisted(batch.records)
				const now = this.now()
				this.retry.recordFailure(now)
				this.nextAttemptAt = now + this.retry.nextDelayMs(this.attempt, result.retryAfterSec)
				this.attempt++
				const detail = this.describeFailure(result)
				this.writeThrottled(
					`retry scheduled attempt=${this.attempt} url=${endpoint.url} ${detail}`,
					`retry|${result.status ?? ""}|${result.code ?? ""}|${result.networkError ?? ""}`,
				)
				return false
			}
			case "split": {
				if (depth >= MAX_SPLIT_DEPTH) {
					this.stats.dropped += batch.records.length
					this.writeOutput(`split exhausted, dropped n=${batch.records.length}`)
					return false
				}
				const size = Math.max(1, Math.floor(batch.records.length / 2))
				const { batches } = splitIntoBatches(batch.records, {
					maxRecords: size,
					maxBytes: Math.max(4096, Math.floor(batch.body.byteLength / 2)),
				})
				this.writeOutput(`payload too large, re-splitting into ${batches.length} batch(es)`)
				let allSent = true
				for (const smaller of batches) {
					const sent = await this.sendBatch(smaller, depth + 1)
					if (!sent) {
						allSent = false
					}
				}
				return allSent
			}
			case "refresh-token": {
				if (depth >= MAX_SPLIT_DEPTH) {
					this.accountUnpersisted(batch.records)
					this.pausedUntil = this.now() + this.pauseRetryMs
					this.writeOutput("token refresh exhausted, pausing uploads")
					return false
				}
				const refreshed = await this.safeToken()
				if (!refreshed || refreshed === token) {
					this.accountUnpersisted(batch.records)
					this.pausedUntil = this.now() + this.pauseRetryMs
					this.writeThrottled(
						`跳过上报：凭据刷新后仍不可用（${this.describeFailure(result)}），静默 ${Math.round(this.pauseRetryMs / 1000)}s 后重试（分片保留）`,
						`refresh-same|${result.status ?? ""}|${result.code ?? ""}`,
					)
					return false
				}
				const retried = await this.transport(endpoint.url, batch, refreshed)
				if (retried.ok) {
					this.stats.sent += batch.records.length
					this.retry.recordSuccess()
					this.lastRequestId = retried.requestId
					this.writeOutput(
						`batch sent ok after token refresh n=${batch.records.length}${retried.requestId ? ` request_id=${retried.requestId}` : ""}`,
					)
					return true
				}
				this.accountUnpersisted(batch.records)
				this.pausedUntil = this.now() + this.pauseRetryMs
				this.writeThrottled(
					`跳过上报：刷新凭据后重发仍失败（${this.describeFailure(retried)}），静默 ${Math.round(this.pauseRetryMs / 1000)}s（分片保留）`,
					`refresh-retry|${retried.status ?? ""}|${retried.code ?? ""}`,
				)
				return false
			}
			case "pause": {
				this.accountUnpersisted(batch.records)
				if (isCollectionDisabled(result.code)) {
					this.reportCollectionEnabled(false)
				} else {
					// 账号 / 权限问题：静默一段时间后允许再试，避免永久卡死
					this.pausedUntil = this.now() + this.pauseRetryMs
				}
				this.writeThrottled(
					`uploads paused url=${endpoint.url} ${this.describeFailure(result)}`,
					`pause|${result.status ?? ""}|${result.code ?? ""}`,
				)
				return false
			}
			default: {
				this.stats.dropped += batch.records.length
				this.writeOutput(`batch dropped ${this.describeFailure(result)}`)
				return false
			}
		}
	}

	private async flushOffline(limit: number): Promise<boolean> {
		if (!this.offline) {
			return false
		}
		const shards = await this.offline.list()
		if (shards.length === 0) {
			return false
		}
		const endpoint = await this.resolveEndpoint()
		if (!endpoint || !endpoint.enabled) {
			this.noteSkip("没有可用的上报地址，保留分片等待下次重试")
			return false
		}
		const token = await this.safeToken()
		if (!token) {
			return false
		}

		let sent = false
		for (const shard of shards.slice(0, limit)) {
			const { batches } = splitIntoBatches(shard.records)
			for (const batch of batches) {
				const result = await this.transport(endpoint.url, batch, token)
				if (!result.ok) {
					const now = this.now()
					const reason = result.code ?? result.networkError ?? `HTTP ${result.status}`
					this.retry.recordFailure(now)
					this.nextAttemptAt = now + this.retry.nextDelayMs(this.attempt, result.retryAfterSec)
					this.attempt++
					this.stats.failed++
					this.stats.lastError = reason
					this.stats.lastErrorDetail = this.summarizeFailure(result)
					// 补发失败必须可见：分片保留、退避后重试，否则整条补发链路静默
					this.writeThrottled(
						`补发失败 shard=${path.basename(shard.path)} n=${shard.records.length} ${this.describeFailure(result)}，分片保留，${Math.round((this.nextAttemptAt - now) / 1000)}s 后重试`,
						`flush|${result.status ?? ""}|${result.code ?? ""}|${result.networkError ?? ""}`,
					)
					return sent
				}
				this.stats.sent += batch.records.length
				this.lastRequestId = result.requestId
				this.retry.recordSuccess()
				sent = true
			}
			await this.offline.remove(shard, this.lastRequestId)
			this.writeOutput(
				`offline shard flushed n=${shard.records.length}${this.lastRequestId ? ` request_id=${this.lastRequestId}` : ""}`,
			)
		}
		return sent
	}

	/** 写前落盘已保证数据在盘上；这里只兜底「没有落盘目录」的退化情况。 */
	private accountUnpersisted(records: LogRecord[]): void {
		if (this.offline) {
			return
		}
		this.stats.dropped += records.length
	}

	private async refreshStats(): Promise<void> {
		if (!this.offline) {
			return
		}
		const stats = await this.offline.getStats()
		this.stats.cached = stats.records
		this.stats.confirmed = stats.confirmed
		this.stats.tickTimeouts = this.tickTimeouts
		const durability = this.offline.durability
		this.stats.persisted = durability.durable
		this.stats.writeFailures = durability.writeFailures
	}

	private buildRecord(input: WebviewLogRecord): LogRecord {
		const message = typeof input.message === "string" ? input.message : ""
		const record: LogRecord = {
			timestamp: toIsoTimestamp(input.timestamp),
			message: truncateUtf8(message, MAX_MESSAGE_BYTES),
			level: toLogLevel(input.level),
			device_id: this.options.deviceId,
			client_type: this.options.clientType,
			client_version: this.options.clientVersion,
			event_id: typeof input.event_id === "string" && input.event_id ? input.event_id : crypto.randomUUID(),
		}

		const workspaceId = this.resolveWorkspaceId()
		if (workspaceId) {
			record.workspace_id = workspaceId
		}

		const attributes = normalizeAttributes(input.attributes)
		if (attributes) {
			record.attributes = attributes
		}

		return record
	}

	private resolveWorkspaceId(): string | undefined {
		if (!this.workspaceIdResolved) {
			this.workspaceIdResolved = true
			const directory = this.options.getWorkspaceDirectory?.()
			this.workspaceId = directory
				? `ws-${crypto.createHash("sha256").update(directory).digest("hex").slice(0, 32)}`
				: undefined
		}
		return this.workspaceId
	}

	private async safeToken(): Promise<string | null> {
		if (!this.useDiscovery) {
			// 本地替代传输不需要凭据
			return "local-mock"
		}
		try {
			const token = await this.getTokenWithTimeout()
			if (!token) {
				this.noteSkip("拿不到 access token，无法上报")
				return null
			}
			return token
		} catch (error) {
			this.noteSkip(`获取 access token 失败：${describeError(error)}`)
			return null
		}
	}

	private async resolveEndpoint(): Promise<LogEndpoint | undefined> {
		if (!this.useDiscovery) {
			return LOCAL_MOCK_ENDPOINT
		}
		return this.resolver.resolve()
	}

	/** 发现接口的诊断日志（只写本地输出，不进入上报数据）。 */
	private reportDiscovery(event: DiscoveryEvent): void {
		if (event.kind === "success") {
			if (this.discoveryConsecutiveFailures > 0) {
				this.writeOutput(`发现接口已恢复（此前连续失败 ${this.discoveryConsecutiveFailures} 次）`)
			}
			this.discoveryConsecutiveFailures = 0
			this.discoveryFailureKey = undefined
			this.discoveryFailureLoggedAt = 0

			this.writeOutput(
				`发现接口成功 base=${event.baseUrl} => data.logs.url=${event.url || "(空)"} enabled=${event.enabled} protocol=${event.protocol} expires_in=${event.expiresInMinutes}min fallback=${event.fallbackUrls?.length ?? 0}`,
			)
			if (event.enabled && !event.url) {
				this.writeOutput("警告：服务端返回 enabled=true 但 data.logs.url 为空，无法上报")
			}
			return
		}

		const reason = event.error ?? `HTTP ${event.status}`
		this.discoveryConsecutiveFailures++
		const key = `${event.status ?? ""}|${reason}`
		const now = this.now()
		// 尝试仍按 tick 进行（网络恢复即可自动恢复），但相同原因 60 秒内只记一次，避免刷屏
		if (
			key === this.discoveryFailureKey &&
			now - this.discoveryFailureLoggedAt < DISCOVERY_FAILURE_LOG_INTERVAL_MS
		) {
			return
		}
		this.discoveryFailureKey = key
		this.discoveryFailureLoggedAt = now

		this.writeOutput(
			`发现接口失败 第${this.discoveryConsecutiveFailures}次 base=${event.baseUrl} url=${event.discoveryUrl} reason=${reason}${event.usingCache ? "（继续使用未过期缓存）" : ""}${event.bodySnippet ? ` body=${event.bodySnippet}` : ""}`,
		)
	}

	/** 只在开关真正变化时回调一次。 */
	private reportCollectionEnabled(enabled: boolean): void {
		if (this.lastReportedEnabled === enabled) {
			return
		}
		this.lastReportedEnabled = enabled
		try {
			this.options.onConfigChange?.({ enabled })
		} catch {
			// 回调失败不影响主链路
		}
	}

	private writeOutput(line: string): void {
		const entry = `[cs-log] ${line}`
		this.options.outputChannel?.appendLine(entry)
		// 输出通道不持久（重启窗口即丢），同时落一份便于事后排查
		this.diagnostics?.append(entry)
	}

	private now(): number {
		return this.options.now?.() ?? Date.now()
	}
}

const toLogLevel = (value: unknown): LogLevel =>
	typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value) ? (value as LogLevel) : "info"

const toIsoTimestamp = (value: unknown): string => {
	if (typeof value === "string") {
		const parsed = Date.parse(value)
		if (!Number.isNaN(parsed)) {
			return new Date(parsed).toISOString()
		}
	}
	return new Date().toISOString()
}

const normalizeAttributes = (value: unknown): Record<string, string> | undefined => {
	if (!value || typeof value !== "object") {
		return undefined
	}

	const attributes: Record<string, string> = {}
	for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
		if (Object.keys(attributes).length >= MAX_ATTRIBUTE_COUNT) {
			break
		}
		const key = rawKey.toLowerCase().replace(/[^a-z0-9_]/g, "_")
		if (!ATTRIBUTE_KEY_PATTERN.test(key) || rawValue === undefined || rawValue === null) {
			continue
		}
		attributes[key] = truncateUtf8(String(rawValue), MAX_ATTRIBUTE_VALUE_BYTES)
	}

	return Object.keys(attributes).length > 0 ? attributes : undefined
}

const truncateUtf8 = (value: string, maxBytes: number): string => {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) {
		return value
	}
	let low = 0
	let high = value.length
	while (low < high) {
		const mid = Math.ceil((low + high) / 2)
		if (Buffer.byteLength(value.slice(0, mid), "utf8") <= maxBytes) {
			low = mid
		} else {
			high = mid - 1
		}
	}
	return value.slice(0, low)
}

/** endpoint 发现的磁盘缓存（expires_in 内复用，重启后仍有效）。 */
const createFileCacheStore = (dir: string) => {
	const file = path.join(dir, "endpoint.json")
	return {
		load: async () => {
			try {
				const body = await fs.readFile(file, "utf8")
				return JSON.parse(body)
			} catch {
				return undefined
			}
		},
		save: async (endpoint: unknown) => {
			try {
				await fs.mkdir(dir, { recursive: true })
				await fs.writeFile(file, JSON.stringify(endpoint), "utf8")
			} catch {
				// 缓存失败不影响主链路
			}
		},
	}
}
