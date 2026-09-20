import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "fs"
import * as path from "path"

/**
 * 展开 Error 的 cause 链并带出 code。
 * Node fetch 在网络层失败时只给 "fetch failed"，真正原因（ENOTFOUND / ETIMEDOUT /
 * CERT_HAS_EXPIRED / UNABLE_TO_VERIFY_LEAF_SIGNATURE…）都在 cause 里。
 */
export const describeError = (error: unknown): string => {
	if (!(error instanceof Error)) {
		return String(error)
	}

	const parts: string[] = []
	let current: unknown = error

	for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
		const code = (current as { code?: unknown }).code
		parts.push(code ? `${String(code)}: ${current.message}` : current.message)
		current = (current as { cause?: unknown }).cause
	}

	if (parts.length === 0) {
		parts.push(error.message)
	}
	if (current !== undefined && !(current instanceof Error)) {
		parts.push(String(current))
	}

	return parts.join(" <- ")
}

export const readSnippet = async (response: Response): Promise<string | undefined> => {
	try {
		return (await response.text()).slice(0, 300)
	} catch {
		return undefined
	}
}

const MAX_DIAGNOSTICS_BYTES = 2 * 1024 * 1024

/**
 * 诊断日志落盘。VSCode 输出通道的内容不持久（重启窗口即丢），
 * 这里在缓存目录留一份，便于虚拟机 / 远程场景事后排查。
 */
export class DiagnosticsFile {
	private initialized = false
	private bytes = 0

	constructor(private readonly filePath: string) {}

	public append(line: string): void {
		try {
			if (!this.initialized) {
				this.initialized = true
				mkdirSync(path.dirname(this.filePath), { recursive: true })
				this.bytes = existsSync(this.filePath) ? statSync(this.filePath).size : 0
			}

			if (this.bytes > MAX_DIAGNOSTICS_BYTES) {
				writeFileSync(this.filePath, "", "utf8")
				this.bytes = 0
			}

			const entry = `${new Date().toISOString()} ${line}\n`
			appendFileSync(this.filePath, entry, "utf8")
			this.bytes += Buffer.byteLength(entry, "utf8")
		} catch {
			// 诊断落盘失败不影响主链路
		}
	}
}
