import * as http from "http"
import { spawn, exec, type ChildProcessWithoutNullStreams } from "child_process"
import * as vscode from "vscode"
import { getAssistantUIConfig } from "./config"

export class CsCloudService implements vscode.Disposable {
	private process: ChildProcessWithoutNullStreams | undefined
	private baseUrl: string | undefined

	constructor(private readonly outputChannel: vscode.OutputChannel) {}

	async ensureStarted(): Promise<string> {
		const config = getAssistantUIConfig()
		if (config.baseUrl.trim()) {
			this.baseUrl = trimTrailingSlash(config.baseUrl.trim())
			return this.baseUrl
		}

		const detectedPort = await detectCsCloudPort(config.csCloudPath)
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
			await waitForHttpReady(healthUrl, 15_000)
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
			this.outputChannel.appendLine(`[AssistantUI] Starting cs-cloud: ${config.csCloudPath} start --port ${port}`)
			this.process = spawn(config.csCloudPath, ["start"].concat(port ? ["--port", String(port)] : []), {
				cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
				env: process.env,
			})

			this.process.stdout.on("data", (data) =>
				this.outputChannel.appendLine(`[cs-cloud] ${String(data).trimEnd()}`),
			)
			this.process.stderr.on("data", (data) =>
				this.outputChannel.appendLine(`[cs-cloud] ${String(data).trimEnd()}`),
			)
			this.process.on("exit", (code, signal) => {
				this.outputChannel.appendLine(`[AssistantUI] cs-cloud exited code=${code ?? ""} signal=${signal ?? ""}`)
				this.process = undefined
			})
			this.process.on("error", (error) => {
				this.outputChannel.appendLine(`[AssistantUI] Failed to start cs-cloud: ${error.message}`)
			})
		}

		await waitForHttpReady(healthUrl, 30_000)
		await assertOpenCodeCompatible(this.baseUrl)
		return this.baseUrl
	}

	dispose(): void {
		if (this.process && !this.process.killed) {
			this.process.kill()
		}
		this.process = undefined
	}
}

async function detectCsCloudPort(csCloudPath: string): Promise<number | undefined> {
	try {
		const stdout = await new Promise<string>((resolve) => {
			exec(`"${csCloudPath}" status`, { timeout: 5000 }, (err, stdout) => {
				resolve(stdout || "")
			})
		})

		// 去掉 ANSI 颜色码（SGR 序列）
		const ESC = String.fromCharCode(27)
		const cleanStdout = stdout.replace(new RegExp(ESC + "\\[[0-9;]*m", "g"), "")

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
	return undefined
}

function trimTrailingSlash(value: string) {
	return value.replace(/\/+$/, "")
}

async function waitForHttpReady(url: string, timeoutMs: number) {
	const startedAt = Date.now()
	let lastError: unknown

	while (Date.now() - startedAt < timeoutMs) {
		try {
			if (await isHttpReady(url)) return
		} catch (error) {
			lastError = error
		}
		await new Promise((resolve) => setTimeout(resolve, 300))
	}

	throw new Error(
		`Timed out waiting for cs-cloud at ${url}${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
	)
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
	const probeUrl = `${baseUrl}/experimental/session?roots=true&archived=true`
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
