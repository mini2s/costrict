#!/usr/bin/env node
/* eslint-disable no-undef */
/*
 * 校验客户端日志上报的落盘结果是否符合《待上线的新版本日志采集API.md》客户端字段契约。
 *
 * 用法：
 *   node scripts/verify-log-reporting.mjs
 *   node scripts/verify-log-reporting.mjs --file tmp/mock-telemetry.ndjson
 *   node scripts/verify-log-reporting.mjs --file ~/.costrict/logs/outbox/xxx.ndjson
 *
 * 退出码：0 = 全部合规；1 = 存在不合规记录或文件为空。
 */
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const argv = process.argv.slice(2)
const readArg = (name, fallback) => {
	const index = argv.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`))
	if (index === -1) return fallback
	const hit = argv[index]
	const eq = hit.indexOf("=")
	if (eq !== -1) return hit.slice(eq + 1)
	const next = argv[index + 1]
	return next && !next.startsWith("--") ? next : "true"
}

const file = resolve(process.cwd(), readArg("file", "tmp/mock-telemetry.ndjson"))

const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"]
const CLIENT_TYPES = ["cs-cloud", "vscode-plugin", "jetbrains-plugin", "cli-csc", "cli-codex"]
const RESERVED_FIELDS = [
	"_time",
	"_msg",
	"_stream",
	"_stream_id",
	"universal_id",
	"subject_id",
	"tenant_id",
	"identity_issuer",
]
const ATTRIBUTE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,47}$/
const MAX_MESSAGE_BYTES = 32 * 1024
const MAX_RECORD_BYTES = 64 * 1024
const MAX_ATTRIBUTE_COUNT = 24
const MAX_ATTRIBUTE_VALUE_BYTES = 1024
const PAST_WINDOW_MS = 3 * 24 * 60 * 60 * 1000
const FUTURE_WINDOW_MS = 5 * 60 * 1000

if (!existsSync(file)) {
	console.error(`✗ 文件不存在：${file}`)
	console.error("  先跑 node scripts/mock-telemetry-server.mjs --port 8788，再触发一次日志。")
	process.exit(1)
}

const raw = readFileSync(file, "utf8")
const lines = raw.split("\n").filter((line) => line.trim().length > 0)
if (lines.length === 0) {
	console.error(`✗ 文件为空：${file}`)
	console.error("  说明扩展宿主从未成功上报过 —— 请按验证流程排查。")
	process.exit(1)
}

const now = Date.now()
const levelCounts = new Map()
const clientTypeCounts = new Map()
const operationCounts = new Map()
let failures = 0
let warnings = 0

const report = (index, problems, notes) => {
	const tag = problems.length > 0 ? "✗ FAIL" : notes.length > 0 ? "! WARN" : "✓ ok  "
	console.log(`${tag} #${index + 1}`)
	for (const problem of problems) console.log(`         ✗ ${problem}`)
	for (const note of notes) console.log(`         ! ${note}`)
	if (problems.length > 0) failures++
	else if (notes.length > 0) warnings++
}

console.log(`校验文件：${file}`)
console.log(`记录条数：${lines.length}`)
console.log("")

lines.forEach((line, index) => {
	const problems = []
	const notes = []
	let record

	try {
		record = JSON.parse(line)
	} catch (error) {
		report(index, [`不是合法 JSON：${error.message}`], [])
		return
	}

	if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) problems.push("单条超过 64 KiB")
	if (typeof record.timestamp !== "string" || Number.isNaN(Date.parse(record.timestamp))) {
		problems.push("timestamp 缺失或不是合法时间")
	} else {
		const drift = Date.parse(record.timestamp) - now
		if (drift > FUTURE_WINDOW_MS) problems.push("timestamp 超出允许的未来 5 分钟")
		else if (drift < -PAST_WINDOW_MS) notes.push("timestamp 早于 3 天（离线补发的旧事件属正常）")
	}
	if (typeof record.message !== "string" || record.message.length === 0) {
		problems.push("message 缺失或为空")
	} else if (Buffer.byteLength(record.message, "utf8") > MAX_MESSAGE_BYTES) {
		problems.push("message 超过 32 KiB")
	}
	if (!LEVELS.includes(record.level)) problems.push(`level 非法：${JSON.stringify(record.level)}`)
	if (!CLIENT_TYPES.includes(record.client_type)) {
		problems.push(`client_type 不在日志契约枚举内：${JSON.stringify(record.client_type)}`)
	}
	if (record.event_id !== undefined && typeof record.event_id !== "string") problems.push("event_id 不是字符串")
	if (record.workspace_id !== undefined) {
		if (typeof record.workspace_id !== "string") problems.push("workspace_id 不是字符串")
		else if (/[/\\: ]/.test(record.workspace_id)) problems.push("workspace_id 疑似泄露本地路径")
	}

	for (const field of RESERVED_FIELDS) {
		if (field in record) problems.push(`出现禁止字段：${field}`)
	}
	for (const key of Object.keys(record)) {
		if (key.startsWith("_")) problems.push(`出现下划线开头字段：${key}`)
	}

	if (record.attributes !== undefined) {
		const entries = Object.entries(record.attributes)
		if (entries.length > MAX_ATTRIBUTE_COUNT) problems.push("attributes 超过 24 对")
		for (const [key, value] of entries) {
			if (!ATTRIBUTE_KEY_PATTERN.test(key)) problems.push(`attributes 键不合法：${key}`)
			if (typeof value !== "string") problems.push(`attributes 值不是字符串：${key}`)
			else if (Buffer.byteLength(value, "utf8") > MAX_ATTRIBUTE_VALUE_BYTES) {
				problems.push(`attributes 值超过 1 KiB：${key}`)
			}
		}
	}

	levelCounts.set(record.level, (levelCounts.get(record.level) ?? 0) + 1)
	clientTypeCounts.set(record.client_type, (clientTypeCounts.get(record.client_type) ?? 0) + 1)
	const operation = record.attributes?.operation ?? "(none)"
	operationCounts.set(operation, (operationCounts.get(operation) ?? 0) + 1)

	report(index, problems, notes)
})

const summarize = (title, counts) => {
	const parts = [...counts.entries()].map(([key, value]) => `${key}=${value}`)
	console.log(`${title} ${parts.join("  ")}`)
}

console.log("")
summarize("level 分布      ：", levelCounts)
summarize("client_type 分布：", clientTypeCounts)
summarize("operation 分布  ：", operationCounts)
console.log("")

if (failures > 0) {
	console.log(`结果：✗ ${failures} 条不合规，${warnings} 条告警`)
	process.exit(1)
}
console.log(`结果：✓ ${lines.length} 条全部合规${warnings > 0 ? `（${warnings} 条告警）` : ""}`)
