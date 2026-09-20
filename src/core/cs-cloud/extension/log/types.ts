export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal"

export const LOG_LEVELS: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"]

/** 淘汰优先级：数值越小越先被丢弃。 */
export const LOG_LEVEL_RANK: Record<LogLevel, number> = {
	trace: 0,
	debug: 1,
	info: 2,
	warn: 3,
	error: 4,
	fatal: 5,
}

export type ClientType = "cs-cloud" | "vscode-plugin" | "jetbrains-plugin" | "cli-csc" | "cli-codex"

/** Webview 侧提交的原始记录：只带它自己知道的字段，公共字段由宿主补齐。 */
export interface WebviewLogRecord {
	timestamp?: unknown
	level?: unknown
	message?: unknown
	event_id?: unknown
	attributes?: unknown
}

/** 补齐公共字段后的完整记录，一行一 JSON（NDJSON）。 */
export interface LogRecord {
	timestamp: string
	message: string
	level: LogLevel
	device_id?: string
	client_type: ClientType
	client_version?: string
	workspace_id?: string
	event_id?: string
	attributes?: Record<string, string>
}

export interface LogServiceStats {
	received: number
	dropped: number
	sent: number
	failed: number
	queued: number
	/** 本地分片中的条数（写前落盘产生，发送成功后清理） */
	cached: number
	/** 写前落盘成功的累计条数 */
	persisted: number
	/** 落盘失败的累计条数（>0 说明磁盘异常，需要告警） */
	writeFailures: number
	/** 服务端已确认（200 且分片已删除）的累计条数；与 cached / dropped 构成对账等式 */
	confirmed: number
	/** 因本地前置条件不满足（无 token / 无可用地址 / 静默期）而跳过上报的轮次 */
	skipped: number
	/** tick 看门狗强制释放闩锁的次数（>0 说明上报链路曾卡死） */
	tickTimeouts: number
	lastError?: string
	/** 最近一次失败的完整信息（HTTP 状态 + code + message + request_id），供弹窗与心跳展示 */
	lastErrorDetail?: string
}
