import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import * as http from "http"
import { EventEmitter } from "events"
// import { spawn } from "child_process"
import which from "which"
import crossSpawn from "cross-spawn"
import * as vscode from "vscode"
import { getAssistantUIConfig } from "./config"

/** cs-cloud 进程归属类型 */
export type CsCloudOwnership = "owned" | "unmanaged"
/** cs-cloud 来源辅助信息 */
export type CsCloudSource = "spawned" | "detected" | "configuredBaseUrl"

/**
 * cs-cloud 服务管理器（简化版）。
 *
 * 发现策略（优先级从高到低）：
 *   Step1: 检查用户配置的 baseUrl → 直接使用
 *   Step2: 检查 $HOME/.costrict/cs-cloud/server_url 文件 → 读取地址
 *   Step3: 检查 $HOME/.costrict/cs-cloud/bin/cs-cloud 二进制 → spawn 启动，等待 server_url
 *   Step4: 通过 csc/cs cloud status 命令检测运行中实例
 *   Step5: 全部失败 → 抛出安装指引错误
 *
 * 文件监听：
 *   - server_url 消失 → 视为 crash，emit crashed 事件
 *   - server_url 变更 → 更新地址，emit urlChanged 事件
 */
export class CsCloudService extends EventEmitter implements vscode.Disposable {
	// ── 公开状态 ──
	state: "idle" | "loading" | "running" | "error" = "idle"
	ownership: CsCloudOwnership = "owned"
	source: CsCloudSource = "spawned"

	lastCrashReason?: string
	startupFailureReason?: string

	// ── 内部状态 ──
	private baseUrl: string | undefined
	private watcher: fs.FSWatcher | undefined
	private operationPromise?: Promise<string>

	constructor(private readonly outputChannel: vscode.OutputChannel) {
		super()
	}

	/** 暴露 baseUrl 供外部使用 */
	get baseUrlValue(): string | undefined {
		return this.baseUrl
	}

	// ═══════════════════════════════════════════════════════════════
	// 日志辅助
	// ═══════════════════════════════════════════════════════════════

	private log(step: number, branch: string, message: string) {
		if (process.env.NODE_ENV !== "development") return
		const prefix = step > 0 ? `[cs-cloud][Step${step}]` : `[cs-cloud]`
		this.outputChannel.appendLine(`${prefix}[${branch}] ${message}`)
	}

	// ═══════════════════════════════════════════════════════════════
	// 路径常量
	// ═══════════════════════════════════════════════════════════════

	private get serverUrlPath(): string {
		return path.join(os.homedir(), ".costrict", "cs-cloud", "server_url")
	}

	private get bundledBinPath(): string {
		const binName = process.platform === "win32" ? "cs-cloud.exe" : "cs-cloud"
		return path.join(os.homedir(), ".costrict", "bin", binName)
	}

	// ═══════════════════════════════════════════════════════════════
	// ensureStarted()
	// ═══════════════════════════════════════════════════════════════

	async ensureStarted(): Promise<string> {
		if (this.operationPromise) {
			this.log(0, "ensureStarted", "已有进行中的操作，复用现有 Promise")
			return this.operationPromise
		}

		if (this.state === "running" && this.baseUrl) {
			this.log(0, "ensureStarted", `已在运行中: ${this.baseUrl}`)
			return this.baseUrl
		}

		this.log(0, "ensureStarted", `当前状态: ${this.state}，开始启动流程`)
		this.state = "loading"
		this.operationPromise = this.doEnsureStarted()

		try {
			const url = await this.operationPromise
			this.state = "running"
			this.lastCrashReason = undefined
			this.startupFailureReason = undefined
			this.startWatching()
			this.log(0, "ensureStarted", `✓ 启动成功 → ${url}`)
			return url
		} catch (err) {
			this.state = "error"
			this.startupFailureReason = err instanceof Error ? err.message : String(err)
			this.log(0, "ensureStarted", `✗ 启动失败: ${this.startupFailureReason}`)
			throw err
		} finally {
			this.operationPromise = undefined
		}
	}

	private async doEnsureStarted(): Promise<string> {
		const config = getAssistantUIConfig()

		// ── Step1: 用户配置的 baseUrl ──
		if (config.baseUrl.trim()) {
			this.log(1, "configuredUrl", `使用配置的 baseUrl: "${config.baseUrl}"`)
			this.baseUrl = trimTrailingSlash(config.baseUrl.trim())
			this.ownership = "unmanaged"
			this.source = "configuredBaseUrl"
			return this.baseUrl
		}
		this.log(1, "configuredUrl", "未配置 baseUrl，跳过")

		// ── Step2: server_url 文件 ──
		const fileUrl = this.readServerUrlFile()
		if (fileUrl) {
			this.log(2, "serverUrlFile", `发现文件: ${this.serverUrlPath}`)
			this.log(2, "serverUrlFile", `地址: ${fileUrl}`)

			const healthUrl = `${fileUrl}/api/v1/runtime/health`
			const healthy = await isHttpReady(healthUrl)
			this.log(2, "serverUrlFile", `health check [${healthUrl}] → ${healthy ? "OK" : "FAIL"}`)

			if (healthy) {
				this.baseUrl = `${fileUrl}/api/v1`
				this.ownership = "unmanaged"
				this.source = "detected"
				this.log(2, "serverUrlFile", "✓ health check 通过，采纳该地址")
				return this.baseUrl
			}
			this.log(2, "serverUrlFile", "地址无效，继续下一步")
		} else {
			this.log(2, "serverUrlFile", `文件不存在: ${this.serverUrlPath}`)
		}

		// ── Step3: 内置二进制 ──
		const hasBin = fs.existsSync(this.bundledBinPath)
		this.log(3, "bundledBin", `检查二进制: ${this.bundledBinPath} → ${hasBin ? "存在" : "不存在"}`)

		if (hasBin) {
			this.ownership = "owned"
			this.source = "spawned"

			this.log(3, "bundledBin", `spawn: ${this.bundledBinPath} cloud start --port ${config.port} --host 0.0.0.0`)
			try {
				await this.spawnBundledBinary(config.port)
				this.log(3, "bundledBin", "进程已 spawn，等待 server_url 文件生成...")
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				this.log(3, "bundledBin", `spawn 失败: ${msg}`)
			}

			const url = await this.waitForServerUrlFile(5_000)
			if (url) {
				this.log(3, "bundledBin", `✓ server_url 就绪 → ${url}`)
				return url
			}
			this.log(3, "bundledBin", "超时未生成 server_url，继续下一步")
		}
		// which
		const cscCliPath = await which(config.defaultCli)

		if (!cscCliPath) {
			throw new Error("csc 未安装。安装命令: npm install -g @costrict/csc\n 安装 csc 后执行 csc cloud start")
		}

		// ── Step4: CLI status 命令 ──
		this.log(4, "cliStatus", `执行 ${cscCliPath} cloud status 检测...`)
		const cliUrl = await this.detectViaCliStatus(cscCliPath)
		if (cliUrl) {
			this.baseUrl = cliUrl
			this.ownership = "unmanaged"
			this.source = "detected"
			this.log(4, "cliStatus", `✓ 检测到运行中实例 → ${cliUrl}`)
			return cliUrl
		}
		this.log(4, "cliStatus", "未检测到运行中实例")

		// ── Step5: 全部失败 ──
		this.log(5, "failed", "所有策略均失败")
		throw new Error("手动执行：csc cloud start\n 然后重启编辑器")
	}

	// ═══════════════════════════════════════════════════════════════
	// restart()
	// ═══════════════════════════════════════════════════════════════

	async restart(): Promise<string> {
		this.log(0, "restart", "开始重启...")
		this.stopWatching()
		this.state = "loading"
		this.startupFailureReason = undefined
		this.lastCrashReason = undefined
		this.baseUrl = undefined
		this.operationPromise = undefined

		this.operationPromise = this.doEnsureStarted()

		try {
			const url = await this.operationPromise
			this.state = "running"
			this.startWatching()
			this.log(0, "restart", `✓ 重启成功 → ${url}`)
			return url
		} catch (err) {
			this.state = "error"
			this.startupFailureReason = err instanceof Error ? err.message : String(err)
			this.log(0, "restart", `✗ 重启失败: ${this.startupFailureReason}`)
			throw err
		} finally {
			this.operationPromise = undefined
		}
	}

	// ═══════════════════════════════════════════════════════════════
	// dispose()
	// ═══════════════════════════════════════════════════════════════

	dispose(): void {
		this.log(0, "dispose", "清理资源")
		this.stopWatching()
		this.removeAllListeners()
	}

	// ═══════════════════════════════════════════════════════════════
	// server_url 文件操作
	// ═══════════════════════════════════════════════════════════════

	private readServerUrlFile(): string | undefined {
		try {
			if (!fs.existsSync(this.serverUrlPath)) return undefined
			const content = fs.readFileSync(this.serverUrlPath, "utf-8").trim()
			if (!content) return undefined
			return trimTrailingSlash(content)
		} catch (err) {
			this.log(0, "readServerUrl", `读取失败: ${err instanceof Error ? err.message : String(err)}`)
			return undefined
		}
	}

	private async waitForServerUrlFile(timeoutMs: number): Promise<string | undefined> {
		const start = Date.now()
		while (Date.now() - start < timeoutMs) {
			const url = this.readServerUrlFile()
			if (url) {
				const baseUrl = `${url}/api/v1`
				if (await isHttpReady(`${baseUrl}/runtime/health`)) {
					this.baseUrl = baseUrl
					return baseUrl
				}
			}
			await sleep(1000)
		}
		return undefined
	}

	// ═══════════════════════════════════════════════════════════════
	// 文件监听
	// ═══════════════════════════════════════════════════════════════

	private startWatching(): void {
		this.stopWatching()

		const dir = path.dirname(this.serverUrlPath)
		if (!fs.existsSync(dir)) {
			this.log(0, "fileWatcher", `目录不存在，跳过监听: ${dir}`)
			return
		}

		this.log(0, "fileWatcher", `开始监听: ${dir}`)
		this.watcher = fs.watch(dir, (eventType, filename) => {
			if (filename !== "server_url") return

			this.log(0, "fileWatcher", `事件: ${eventType}`)

			// 文件删除 → cs-cloud 停止
			if (eventType === "rename" && !fs.existsSync(this.serverUrlPath)) {
				this.log(0, "fileWatcher", "server_url 被删除 → cs-cloud 已停止")
				this.stopWatching()
				this.lastCrashReason = "cs-cloud 进程已停止"
				if (this.state !== "error") {
					this.state = "error"
					this.emit("crashed", { reason: this.lastCrashReason })
				}
				return
			}

			// 文件变更 → URL 可能变了
			if (eventType === "change") {
				const newUrl = this.readServerUrlFile()
				if (newUrl) {
					const newBaseUrl = `${newUrl}/api/v1`
					if (newBaseUrl !== this.baseUrl) {
						this.log(0, "fileWatcher", `URL 变更: ${this.baseUrl} → ${newBaseUrl}`)
						this.baseUrl = newBaseUrl
						this.emit("urlChanged", { url: this.baseUrl })
					}
				}
			}
		})
	}

	private stopWatching(): void {
		if (this.watcher) {
			this.log(0, "fileWatcher", "停止监听")
			this.watcher.close()
			this.watcher = undefined
		}
	}

	// ═══════════════════════════════════════════════════════════════
	// 内置二进制 spawn
	// ═══════════════════════════════════════════════════════════════

	private spawnBundledBinary(port: number): Promise<void> {
		return new Promise((resolve, reject) => {
			this.log(
				0,
				"vscode.workspace.workspaceFolders",
				`${vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath).join(", ")}`,
			)
			const child = crossSpawn(this.bundledBinPath, ["start", "--port", String(port), "--host", "0.0.0.0"], {
				cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
				// detached: true,
				// stdio: "ignore",
				env: { ...process.env },
			})

			child.on("error", (err) => reject(err))
			// detached + unref: 让 daemon 进程独立运行
			child.unref()
			resolve()
		})
	}

	// ═══════════════════════════════════════════════════════════════
	// CLI status 检测
	// ═══════════════════════════════════════════════════════════════

	private async detectViaCliStatus(cscCliPath: string): Promise<string | undefined> {
		try {
			const output = await this.execCapture(cscCliPath, ["cloud", "status"], 15_000)
			this.log(4, "cliStatus", `输出: ${output.slice(0, 200)}...`)

			// 匹配 local_url: http://127.0.0.1:PORT
			const match = output.match(/local_url:\s+(https?:\/\/[^\s]+)/)
			if (!match) {
				this.log(4, "cliStatus", "输出中未找到 local_url 字段")
				return undefined
			}

			const url = trimTrailingSlash(match[1])
			const baseUrl = `${url}/api/v1`
			this.log(4, "cliStatus", `检测到 local_url: ${url}`)

			const healthUrl = `${baseUrl}/runtime/health`
			const healthy = await isHttpReady(healthUrl)
			this.log(4, "cliStatus", `health check [${healthUrl}] → ${healthy ? "OK" : "FAIL"}`)

			return healthy ? baseUrl : undefined
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			this.log(4, "cliStatus", `执行失败: ${msg}`)
			return undefined
		}
	}

	private execCapture(command: string, args: string[], timeoutMs: number): Promise<string> {
		return new Promise((resolve, reject) => {
			const child = crossSpawn(command, args, {
				env: { ...process.env },
				stdio: "pipe",
			})

			const chunks: string[] = []
			let settled = false

			const timer = setTimeout(() => {
				if (settled) return
				settled = true
				child.kill()
				reject(new Error(`Timed out: ${command} ${args.join(" ")}`))
			}, timeoutMs)

			child.stdout?.on("data", (d) => chunks.push(String(d)))
			child.stderr?.on("data", (d) => chunks.push(String(d)))

			child.on("close", () => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				resolve(stripAnsi(chunks.join("")))
			})

			child.on("error", (err) => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				reject(err)
			})
		})
	}
}

// ═══════════════════════════════════════════════════════════════════
// 公共工具函数
// ═══════════════════════════════════════════════════════════════════

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "")
}

function isHttpReady(url: string): Promise<boolean> {
	return new Promise((resolve) => {
		const req = http.get(url, (res) => {
			res.resume()
			resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 500)
		})
		req.setTimeout(2_000, () => {
			req.destroy()
			resolve(false)
		})
		req.on("error", () => resolve(false))
	})
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function stripAnsi(text: string): string {
	const ESC = String.fromCharCode(27)
	return text.replace(new RegExp(ESC + "\[[0-9;]*m", "g"), "")
}
