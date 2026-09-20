import { Package } from "shared/package"
import * as vscode from "vscode"
export interface AssistantUIConfig {
	enabled: boolean
	defaultCli: "csc" | "cs"
	port: number
	autoStartCsCloud: boolean
	baseUrl: string
	webUrl: string
	webviewMode: "static" | "iframe"
	debug: boolean
	/** 客户端日志上报的 endpoint 发现基址；为空时回退到 CostrictAuthConfig.getDefaultApiBaseUrl() */
	logBaseUrl: string
	/** 客户端日志本地缓存目录；为空时使用 globalStorage 下的 logs/ */
	logCacheDir: string
	/** http=真实 HTTP 上报；mock=本地落盘（后端未就绪时使用） */
	logTransport: "http" | "mock"
	/** 写前落盘时是否 fsync（true=整机断电也不丢，代价是每条一次 fsync） */
	logFsync: boolean
	/**
	 * 本地分片保留时长（小时），1~72，默认 72。
	 * 契约允许服务端接受 3 天内的日志，保留期与之对齐才能让断网期间的数据等到恢复后补发。
	 */
	logRetentionHours: number
}

export function getAssistantUIConfig(): AssistantUIConfig {
	const config = vscode.workspace.getConfiguration(`${Package.commandIDPrefix}.assistantUI`)
	return {
		defaultCli: config.get<"csc" | "cs">("defaultCli", "csc"),
		enabled: config.get<boolean>("enabled", true),
		port: config.get<number>("port", 45489),
		autoStartCsCloud: config.get<boolean>("autoStartCsCloud", true),
		baseUrl: config.get<string>("baseUrl", ""),
		webUrl: config.get<string>("webUrl", "http://127.0.0.1:3000"),
		webviewMode: config.get<"static" | "iframe">("webviewMode", "static"),
		debug: config.get<boolean>("debug", false),
		logBaseUrl: config.get<string>("logBaseUrl", ""),
		logCacheDir: config.get<string>("logCacheDir", ""),
		logTransport: config.get<"http" | "mock">("logTransport", "http"),
		logFsync: config.get<boolean>("logFsync", false),
		logRetentionHours: config.get<number>("logRetentionHours", 72),
	}
}
