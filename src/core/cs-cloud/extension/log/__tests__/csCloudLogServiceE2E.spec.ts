import { spawn, type ChildProcess } from "child_process"
import { promises as fs } from "fs"
import * as http from "http"
import nock from "nock"
import * as os from "os"
import * as path from "path"

import { CsCloudLogService } from "../csCloudLogService"

const PORT = 8791
const BASE_URL = `http://127.0.0.1:${PORT}`

const MOCK_SCRIPT = "scripts/mock-telemetry-server.mjs"

/** 从当前工作目录逐级向上找到仓库根（mock server 脚本所在处）。 */
const findRepoRoot = async (): Promise<string> => {
	let current = process.cwd()
	for (let depth = 0; depth < 6; depth++) {
		try {
			await fs.access(path.join(current, MOCK_SCRIPT))
			return current
		} catch {
			current = path.dirname(current)
		}
	}
	throw new Error(`cannot locate ${MOCK_SCRIPT} from ${process.cwd()}`)
}

const waitForServer = async (): Promise<void> => {
	for (let attempt = 0; attempt < 40; attempt++) {
		try {
			await fetch(`${BASE_URL}/user-indicator/api/v1/telemetry/endpoints`, {
				headers: { Authorization: "Bearer warmup" },
			})
			return
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
	}
	throw new Error("mock server did not start")
}

describe("csCloudLogService (real HTTP against the local mock server)", () => {
	let child: ChildProcess
	let dir: string
	let outFile: string
	let stderr = ""

	beforeAll(async () => {
		// vitest.setup.ts 默认 nock.disableNetConnect()，这里放行本地 mock server
		nock.enableNetConnect(/127\.0\.0\.1/)
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-log-e2e-"))
		outFile = path.join(dir, "mock-telemetry.ndjson")
		const repoRoot = await findRepoRoot()
		child = spawn("node", [MOCK_SCRIPT, "--port", String(PORT), "--out", outFile], {
			cwd: repoRoot,
			stdio: ["ignore", "ignore", "pipe"],
		})
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk)
		})
		await waitForServer().catch((error) => {
			throw new Error(`${error instanceof Error ? error.message : error}; stderr=${stderr}`)
		})
	})

	afterAll(async () => {
		child?.kill()
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("uploads NDJSON to the discovered endpoint over real HTTP", async () => {
		const lines: string[] = []
		const service = new CsCloudLogService({
			baseUrl: BASE_URL,
			getAccessToken: async () => "e2e-token",
			deviceId: "e2e-device",
			clientType: "vscode-plugin",
			clientVersion: "e2e",
			storageDir: path.join(dir, "cache"),
			outputChannel: { appendLine: (line) => lines.push(line) },
		})

		service.ingest({
			timestamp: new Date().toISOString(),
			level: "error",
			message: "e2e over real http",
			event_id: "e2e-1",
			attributes: { operation: "e2e" },
		})
		await service.flush()

		const written = (await fs.readFile(outFile, "utf8")).trim()
		expect(written.length).toBeGreaterThan(0)
		const record = JSON.parse(written.split("\n")[0])
		expect(record).toMatchObject({
			message: "e2e over real http",
			level: "error",
			client_type: "vscode-plugin",
			device_id: "e2e-device",
			event_id: "e2e-1",
			attributes: { operation: "e2e" },
		})
		expect(record.workspace_id).toBeUndefined()
		expect(lines.some((line) => line.includes("batch sent ok"))).toBe(true)
	})
})

describe("csCloudLogService (real HTTP error response)", () => {
	const ERROR_PORT = 8792
	const ERROR_BASE = `http://127.0.0.1:${ERROR_PORT}`

	let server: http.Server
	let dir: string

	beforeAll(async () => {
		nock.enableNetConnect(/127\.0\.0\.1/)
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-log-e2e-error-"))
		server = http.createServer((request, response) => {
			if (request.url?.includes("/telemetry/endpoints")) {
				response.writeHead(200, { "content-type": "application/json" })
				response.end(
					JSON.stringify({
						success: true,
						code: "",
						data: {
							logs: {
								enabled: true,
								url: `${ERROR_BASE}/insert/jsonline`,
								fallback_urls: [],
								protocol: "victorialogs-jsonline-v1",
							},
							expires_in: 60,
						},
					}),
				)
				return
			}
			// 契约 §3.6 的失败响应：非 2xx + JSON + message + request_id
			response.writeHead(401, { "content-type": "application/json", "x-request-id": "e2e-req-401" })
			response.end(
				JSON.stringify({
					success: false,
					code: "TOKEN_SIGNATURE_INVALID",
					message: "Token 签名验证失败",
					request_id: "e2e-req-401",
				}),
			)
		})
		await new Promise<void>((resolve) => server.listen(ERROR_PORT, "127.0.0.1", resolve))
	})

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()))
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("surfaces HTTP status, code, message and request_id from a real error response", async () => {
		const lines: string[] = []
		const service = new CsCloudLogService({
			baseUrl: ERROR_BASE,
			getAccessToken: async () => "e2e-token",
			deviceId: "e2e-device",
			clientType: "vscode-plugin",
			clientVersion: "e2e",
			storageDir: dir,
			outputChannel: { appendLine: (line) => lines.push(line) },
		})

		service.ingest({
			timestamp: new Date().toISOString(),
			level: "error",
			message: "e2e error path",
			event_id: "e2e-err-1",
		})
		await service.flush({ timeoutMs: 3_000 })

		const failure = lines.find((line) => line.includes("TOKEN_SIGNATURE_INVALID"))
		expect(failure).toBeDefined()
		// 用户抱怨的正是「只有一个 code，看不到完整报错」——这四项必须都在
		expect(failure).toContain("HTTP 401")
		expect(failure).toContain("code=TOKEN_SIGNATURE_INVALID")
		expect(failure).toContain("message=Token 签名验证失败")
		expect(failure).toContain("request_id=e2e-req-401")

		const stats = await service.getStats()
		expect(stats.lastError).toBe("TOKEN_SIGNATURE_INVALID")
		expect(stats.lastErrorDetail).toContain("HTTP 401")
		expect(stats.lastErrorDetail).toContain("Token 签名验证失败")
	})
})
