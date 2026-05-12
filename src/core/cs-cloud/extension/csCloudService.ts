import * as http from "http"
import { spawn, exec, type ChildProcessWithoutNullStreams } from "child_process"
import * as vscode from "vscode"
import { getAssistantUIConfig } from "./config"

export class CsCloudService implements vscode.Disposable {
	private process: ChildProcessWithoutNullStreams | undefined
	private baseUrl: string | undefined
	private lastErrorLine: string | undefined
	private processExited = false

	constructor(private readonly outputChannel: vscode.OutputChannel) {}

	async ensureStarted(): Promise<string> {
		const config = getAssistantUIConfig()
		if (config.baseUrl.trim()) {
			this.baseUrl = trimTrailingSlash(config.baseUrl.trim())
			return this.baseUrl
		}

		const detectedPort = await detectCsCloudPort()
		if (detectedPort !== undefined) {
			const healthUrl = `http://127.0.0.1:${detectedPort}/api/v1/runtime/health`
			this.baseUrl = `http://127.0.0.1:${detectedPort}/api/v1`

			if (await isHttpReady(healthUrl)) {
				await assertOpenCodeCompatible(this.baseUrl)
				return this.baseUrl
			}

			this.outputChannel.appendLine(
				`[AssistantUI] Detected cs-cloud on port ${detectedPort}, waiting for it to be ready...`,
			)
			await this.waitForHttpReady(healthUrl, 15_000)
			await assertOpenCodeCompatible(this.baseUrl)
			return this.baseUrl
		}

		const port = config.port
		const healthUrl = `http://127.0.0.1:${port}/api/v1/runtime/health`
		this.baseUrl = `http://127.0.0.1:${port}/api/v1`

		if (await isHttpReady(healthUrl)) {
			await assertOpenCodeCompatible(this.baseUrl)
			return this.baseUrl
		}

		if (!config.autoStartCsCloud) {
			throw new Error("cs-cloud 没有运行，请先启动 cs-cloud 或设置 costrict.assistantUI.baseUrl")
		}

		if (!this.process) {
			this.lastErrorLine = undefined
			this.processExited = false

			this.outputChannel.appendLine(`[AssistantUI] Starting cs-cloud: cs cloud start --port ${port}`)
			this.process = spawn("cs", ["cloud", "start"].concat(port ? ["--port", String(port)] : []), {
				cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
				env: process.env,
			})

			this.process.stdout.on("data", (data) => {
				const text = String(data).trimEnd()
				this.outputChannel.appendLine(`[cs-cloud] ${text}`)
				this.captureErrorLine(text)
			})
			this.process.stderr.on("data", (data) => {
				const text = String(data).trimEnd()
				this.outputChannel.appendLine(`[cs-cloud] ${text}`)
				this.captureErrorLine(text)
			})
			this.process.on("exit", (code, signal) => {
				this.outputChannel.appendLine(`[AssistantUI] cs-cloud exited code=${code ?? ""} signal=${signal ?? ""}`)
				this.process = undefined
				if (code !== 0 || signal !== null) {
					this.processExited = true
				}
			})
			this.process.on("error", (error) => {
				this.outputChannel.appendLine(`[AssistantUI] Failed to start cs-cloud: ${error.message}`)
				this.lastErrorLine = error.message
				this.processExited = true
			})
		}

		await this.waitForHttpReady(healthUrl, 60_000)
		await assertOpenCodeCompatible(this.baseUrl)
		return this.baseUrl
	}

	dispose(): void {
		if (this.process && !this.process.killed) {
			this.process.kill()
		}
		this.process = undefined
	}

	private captureErrorLine(text: string) {
		const clean = stripAnsi(text).toLowerCase()
		if (
			clean.includes("error") ||
			clean.includes("unauthorized") ||
			clean.includes("fatal") ||
			clean.includes("failed") ||
			clean.includes("panic") ||
			clean.includes("cannot")
		) {
			this.lastErrorLine = stripAnsi(text).trim()
		}
	}

	private async waitForHttpReady(url: string, timeoutMs: number, initialDelayMs = 1000) {
		const startedAt = Date.now()
		let lastError: unknown
		let attempt = 0

		while (Date.now() - startedAt < timeoutMs) {
			if (this.processExited) {
				const reason = this.lastErrorLine ? `: ${this.lastErrorLine}` : ""
				throw new Error(`cs-cloud 启动失败${reason}`)
			}

			try {
				if (await isHttpReady(url)) return
			} catch (error) {
				lastError = error
			}
			// 指数退避：1s, 2s, 4s, 4s, 4s...
			const delay = Math.min(initialDelayMs * Math.pow(2, attempt), 4000)
			attempt++
			await new Promise((resolve) => setTimeout(resolve, delay))
		}

		if (this.processExited) {
			const reason = this.lastErrorLine ? `: ${this.lastErrorLine}` : ""
			throw new Error(`cs-cloud 启动失败${reason}`)
		}

		throw new Error(
			`Timed out waiting for cs-cloud at ${url}${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
		)
	}
}

async function detectCsCloudPort(retries = 3, delayMs = 2000): Promise<number | undefined> {
	for (let i = 0; i < retries; i++) {
		try {
			const stdout = await new Promise<string>((resolve) => {
				exec(`cs cloud status`, { timeout: 5000 }, (err, stdout) => {
					resolve(stdout || "")
				})
			})

			const cleanStdout = stripAnsi(stdout)

			// 匹配 local_url: http://127.0.0.1:PORT 或 local_url: https://...:PORT
			const match = cleanStdout.match(/local_url:\s+(https?:\/\/[^\s:]+:(\d+))/)
			if (match) {
				const port = parseInt(match[2], 10)
				if (port > 0) {
					return port
				}
			}
		} catch {
			// ignore detection failures
		}

		if (i < retries - 1) {
			await new Promise((resolve) => setTimeout(resolve, delayMs))
		}
	}
	return undefined
}

function trimTrailingSlash(value: string) {
	return value.replace(/\/+$/, "")
}

function isHttpReady(url: string): Promise<boolean> {
	return new Promise((resolve) => {
		const req = http.get(url, (res) => {
			res.resume()
			resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 500)
		})
		req.setTimeout(1_000, () => {
			req.destroy()
			resolve(false)
		})
		req.on("error", () => resolve(false))
	})
}

async function assertOpenCodeCompatible(baseUrl: string): Promise<void> {
	const probeUrl = `${baseUrl}/conversations?roots=true&archived=true`
	const statusCode = await getStatusCode(probeUrl)
	if (statusCode >= 200 && statusCode < 500 && statusCode !== 404) {
		return
	}

	throw new Error(
		`cs-cloud at ${baseUrl} is not OpenCode-compatible yet; ${probeUrl} returned ${statusCode}. ` +
			"Restart the daemon built from the current cs-cloud sources or set costrict.assistantUI.baseUrl to a compatible /api/v1 endpoint.",
	)
}

function getStatusCode(url: string): Promise<number> {
	return new Promise((resolve) => {
		const req = http.get(url, (res) => {
			res.resume()
			resolve(res.statusCode ?? 0)
		})
		req.setTimeout(2_000, () => {
			req.destroy()
			resolve(0)
		})
		req.on("error", () => resolve(0))
	})
}

function stripAnsi(text: string): string {
	const ESC = String.fromCharCode(27)
	return text.replace(new RegExp(ESC + "\\[[0-9;]*m", "g"), "")
}
