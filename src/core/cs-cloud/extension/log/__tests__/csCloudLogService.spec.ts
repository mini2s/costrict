import { promises as fs } from "fs"
import * as os from "os"
import * as path from "path"

import { CsCloudLogService, type CsCloudLogServiceOptions } from "../csCloudLogService"
import { createFileTransport } from "../logMockTransport"
import type { UploadResult } from "../logUploader"

const NOW = Date.parse("2025-09-18T10:00:00.000Z")
const BASE_URL = "http://costrict.test"
const LOG_URL = "http://log.test/insert/jsonline"

interface FetchCall {
	url: string
	headers: Record<string, string>
	body?: Buffer
}

const discoveryResponse = (enabled: boolean, expiresIn = 10): Response =>
	new Response(
		JSON.stringify({
			success: true,
			code: "",
			data: {
				logs: {
					enabled,
					url: enabled ? LOG_URL : "",
					fallback_urls: [],
					protocol: "victorialogs-jsonline-v1",
				},
				expires_in: expiresIn,
			},
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	)

const errorResponse = (status: number, code: string): Response =>
	new Response(JSON.stringify({ success: false, code, message: code }), {
		status,
		headers: { "content-type": "application/json" },
	})

const createFetchMock = (
	options: {
		enabled?: boolean | (() => boolean)
		expiresIn?: number
		onUpload?: (call: FetchCall) => Response
	} = {},
) => {
	const calls: FetchCall[] = []
	const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input)
		const headers = (init?.headers ?? {}) as Record<string, string>
		const body = init?.body ? Buffer.from(init.body as ArrayBuffer) : undefined
		const call: FetchCall = { url, headers, body }
		calls.push(call)

		if (url.includes("/telemetry/endpoints")) {
			const enabled = typeof options.enabled === "function" ? options.enabled() : (options.enabled ?? true)
			return discoveryResponse(enabled, options.expiresIn)
		}
		return options.onUpload?.(call) ?? new Response("", { status: 200 })
	}) as typeof fetch

	return { impl, calls }
}

const createdDirs: string[] = []

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 轮询等待条件成立（真实定时器，避免假定时器与 fs I/O 冲突）。 */
const waitFor = async (predicate: () => boolean, timeoutMs = 3_000): Promise<void> => {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (predicate()) {
			return
		}
		await sleep(10)
	}
	throw new Error("condition not met within timeout")
}

const createService = async (
	overrides: Partial<CsCloudLogServiceOptions> = {},
): Promise<{ service: CsCloudLogService; dir: string; lines: string[] }> => {
	const dir = overrides.storageDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "cs-log-service-")))
	createdDirs.push(dir)
	const lines: string[] = []

	const service = new CsCloudLogService({
		baseUrl: BASE_URL,
		getAccessToken: async () => "token-1",
		deviceId: "device-1",
		clientType: "vscode-plugin",
		clientVersion: "9.9.9",
		storageDir: dir,
		getWorkspaceDirectory: () => "/work/space",
		outputChannel: { appendLine: (line) => lines.push(line) },
		now: () => NOW,
		random: () => 0,
		...overrides,
	})

	return { service, dir, lines }
}

const sampleLog = (overrides: Record<string, unknown> = {}) => ({
	timestamp: new Date(NOW).toISOString(),
	level: "error",
	message: "boom",
	event_id: "event-1",
	attributes: { operation: "window_error" },
	...overrides,
})

describe("CsCloudLogService", () => {
	afterEach(async () => {
		while (createdDirs.length > 0) {
			await fs.rm(createdDirs.pop() as string, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
		}
	})

	it("does not lose logs when the host crashes before flushing", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-log-crash-"))
		createdDirs.push(dir)

		// 第一个实例：只采集，不 flush、不 dispose —— 模拟发送前进程被杀
		const crashed = await createService({ storageDir: dir, now: () => Date.now() })
		crashed.service.ingest({ ...sampleLog(), timestamp: new Date().toISOString(), event_id: "crash-1" })

		const shardsBefore = (await fs.readdir(dir)).filter((file) => file.endsWith(".ndjson"))
		expect(shardsBefore).toHaveLength(1)

		// 新实例在同一目录启动（模拟重启后补发）
		const { impl, calls } = createFetchMock()
		const revived = await createService({ storageDir: dir, fetchImpl: impl, now: () => Date.now() })
		await revived.service.flush()

		const upload = calls.find((call) => call.url === LOG_URL)
		expect(upload).toBeDefined()
		expect(JSON.parse(upload?.body?.toString("utf8").trim() as string).event_id).toBe("crash-1")

		const shardsAfter = (await fs.readdir(dir)).filter((file) => file.endsWith(".ndjson"))
		expect(shardsAfter).toHaveLength(0)
	})

	it("removes the write-ahead shard once the batch is delivered", async () => {
		const { impl } = createFetchMock()
		const { service, dir } = await createService({ fetchImpl: impl })

		service.ingest(sampleLog())
		expect((await fs.readdir(dir)).some((file) => file.endsWith(".ndjson"))).toBe(true)

		await service.flush()

		expect((await fs.readdir(dir)).some((file) => file.endsWith(".ndjson"))).toBe(false)
		expect(await service.getStats()).toMatchObject({
			persisted: 1,
			writeFailures: 0,
			cached: 0,
			sent: 1,
		})
	})

	it("prints logBaseUrl and the discovered data.logs.url to the output channel", async () => {
		const { impl } = createFetchMock()
		const { service, lines } = await createService({ fetchImpl: impl })

		service.start()
		await waitFor(() => lines.some((line) => line.includes("data.logs.url=")))
		service.dispose()

		expect(lines.some((line) => line.includes(`日志上报启动 logBaseUrl=${BASE_URL}`))).toBe(true)
		expect(
			lines.some(
				(line) => line.includes(`发现接口成功 base=${BASE_URL}`) && line.includes(`data.logs.url=${LOG_URL}`),
			),
		).toBe(true)
	})

	it("prints the discovery failure reason when the endpoint is unreachable", async () => {
		const failingFetch = (async () => {
			throw new Error("socket hang up")
		}) as typeof fetch
		const { service, lines } = await createService({ fetchImpl: failingFetch })

		service.start()
		await waitFor(() => lines.some((line) => line.includes("发现接口失败")))
		service.dispose()

		expect(lines.some((line) => line.includes("reason=socket hang up"))).toBe(true)
	})

	it("throttles identical discovery failures and persists diagnostics to disk", async () => {
		const cause = Object.assign(new Error("getaddrinfo ENOTFOUND zgsmtest.cn"), { code: "ENOTFOUND" })
		const failingFetch = (async () => {
			throw new TypeError("fetch failed", { cause })
		}) as typeof fetch

		const { service, dir, lines } = await createService({
			fetchImpl: failingFetch,
			flushIntervalMs: 20,
			now: () => Date.now(),
		})

		service.start()
		await waitFor(() => lines.some((line) => line.includes("发现接口失败")))
		await sleep(140)
		service.dispose()

		const failures = lines.filter((line) => line.includes("发现接口失败"))
		expect(failures).toHaveLength(1)
		expect(failures[0]).toContain("第1次")
		expect(failures[0]).toContain("ENOTFOUND")

		const diagnostics = await fs.readFile(path.join(dir, "diagnostics.log"), "utf8")
		expect(diagnostics).toContain("发现接口失败")
		expect(diagnostics).toContain("logBaseUrl=")
	})

	it("discovers the endpoint and posts NDJSON with host-filled fields", async () => {
		const { impl, calls } = createFetchMock()
		const { service } = await createService({ fetchImpl: impl })

		service.ingest(sampleLog())
		await service.flush()

		const upload = calls.find((call) => call.url === LOG_URL)
		expect(upload).toBeDefined()
		expect(upload?.headers.Authorization).toBe("Bearer token-1")
		expect(upload?.headers["Content-Type"]).toBe("application/stream+json")

		const record = JSON.parse(upload?.body?.toString("utf8").trim() as string)
		expect(record).toMatchObject({
			message: "boom",
			level: "error",
			event_id: "event-1",
			device_id: "device-1",
			client_type: "vscode-plugin",
			client_version: "9.9.9",
			attributes: { operation: "window_error" },
		})
		expect(record.workspace_id).toMatch(/^ws-[0-9a-f]{32}$/)
		expect(await service.getStats()).toMatchObject({ received: 1, sent: 1, cached: 0 })
		// 服务端返回的完整地址必须原样使用，不得追加任何查询参数
		expect(calls.every((call) => !call.url.includes("?"))).toBe(true)
	})

	it("preserves event_id and timestamp when a cached batch is retried", async () => {
		let fail = true
		const bodies: string[] = []
		const { impl } = createFetchMock({
			onUpload: (call) => {
				bodies.push(call.body?.toString("utf8") ?? "")
				return fail ? errorResponse(503, "OVERLOADED") : new Response("", { status: 200 })
			},
		})
		const { service } = await createService({ fetchImpl: impl, now: () => Date.now() })

		service.ingest({ ...sampleLog(), timestamp: new Date().toISOString() })
		await service.flush()
		expect(bodies).toHaveLength(1)

		fail = false
		await service.flush()
		expect(bodies).toHaveLength(2)

		const first = JSON.parse(bodies[0]?.trim() as string)
		const second = JSON.parse(bodies[1]?.trim() as string)
		expect(second.event_id).toBe(first.event_id)
		expect(second.timestamp).toBe(first.timestamp)
	})

	it("drops records rejected by the local validator", async () => {
		const { impl, calls } = createFetchMock()
		const { service, lines } = await createService({ fetchImpl: impl })

		service.ingest(sampleLog({ message: "" }))
		await service.flush()

		expect(calls.filter((call) => call.url === LOG_URL)).toHaveLength(0)
		expect(lines.some((line) => line.includes("dropped record"))).toBe(true)
		expect((await service.getStats()).dropped).toBe(1)
	})

	it("stops sending and writes to the local cache when collection is disabled", async () => {
		const { impl, calls } = createFetchMock({ enabled: false })
		const { service, dir } = await createService({ fetchImpl: impl })

		service.ingest(sampleLog())
		await service.flush()

		expect(calls.filter((call) => call.url === LOG_URL)).toHaveLength(0)
		expect((await service.getStats()).cached).toBe(1)

		const files = await fs.readdir(dir)
		expect(files.some((file) => file.endsWith(".ndjson"))).toBe(true)
	})

	it("refreshes the token once on 401 and then succeeds", async () => {
		let token = "token-1"
		const { impl, calls } = createFetchMock({
			onUpload: (call) => {
				if (call.headers.Authorization === "Bearer token-1") {
					token = "token-2"
					return errorResponse(401, "INVALID_TOKEN")
				}
				return new Response("", { status: 200 })
			},
		})
		const { service } = await createService({ fetchImpl: impl, getAccessToken: async () => token })

		service.ingest(sampleLog())
		await service.flush()

		expect(calls.filter((call) => call.url === LOG_URL)).toHaveLength(2)
		expect((await service.getStats()).sent).toBe(1)
	})

	it("caches the batch locally when the upload is retryable", async () => {
		const { impl } = createFetchMock({ onUpload: () => errorResponse(503, "OVERLOADED") })
		const { service, dir } = await createService({ fetchImpl: impl })

		service.ingest(sampleLog())
		await service.flush()

		const stats = await service.getStats()
		expect(stats.failed).toBeGreaterThan(0)
		expect(stats.lastError).toBe("OVERLOADED")
		const files = await fs.readdir(dir)
		expect(files.some((file) => file.endsWith(".ndjson"))).toBe(true)
	})

	it("enqueues host-side records through the same pipeline", async () => {
		const { impl, calls } = createFetchMock()
		const { service } = await createService({ fetchImpl: impl })

		service.log("error", "cs-cloud failed to start", { operation: "cs_cloud_start" })
		await service.flush()

		const upload = calls.find((call) => call.url === LOG_URL)
		const record = JSON.parse(upload?.body?.toString("utf8").trim() as string)
		expect(record).toMatchObject({
			message: "cs-cloud failed to start",
			level: "error",
			client_type: "vscode-plugin",
			device_id: "device-1",
			attributes: { operation: "cs_cloud_start" },
		})
		expect(typeof record.event_id).toBe("string")
		expect((await service.getStats()).sent).toBe(1)
	})

	it("notifies the webview when the server disables collection", async () => {
		const { impl } = createFetchMock({ enabled: false })
		const configs: Array<{ enabled: boolean }> = []
		const { service } = await createService({
			fetchImpl: impl,
			onConfigChange: (config) => configs.push(config),
		})

		service.ingest(sampleLog())
		await service.flush()

		expect(configs).toEqual([{ enabled: false }])
	})

	it("resumes collection and notifies the webview when the server re-enables it", async () => {
		let enabled = false
		// expires_in 用极小值，让 tick 能在测试时间内重新发现
		const { impl, calls } = createFetchMock({ enabled: () => enabled, expiresIn: 0.001 })
		const configs: Array<{ enabled: boolean }> = []
		const { service } = await createService({
			fetchImpl: impl,
			now: () => Date.now(),
			flushIntervalMs: 20,
			onConfigChange: (config) => configs.push(config),
		})

		service.start()
		service.ingest({ ...sampleLog(), timestamp: new Date().toISOString() })
		await waitFor(() => configs.length > 0)

		expect(configs.at(-1)).toEqual({ enabled: false })
		expect(calls.filter((call) => call.url === LOG_URL)).toHaveLength(0)

		enabled = true
		await waitFor(() => configs.at(-1)?.enabled === true)
		expect(configs.at(-1)).toEqual({ enabled: true })

		service.dispose()
	})

	it("retries uploads after the auth pause window expires", async () => {
		let forbidden = true
		const counters = { uploads: 0 }
		const { impl } = createFetchMock({
			onUpload: () => {
				counters.uploads++
				return forbidden ? errorResponse(403, "USER_NOT_FOUND") : new Response("", { status: 200 })
			},
		})
		const { service } = await createService({
			fetchImpl: impl,
			now: () => Date.now(),
			flushIntervalMs: 20,
			pauseRetryMs: 200,
		})

		service.start()
		service.ingest({ ...sampleLog(), timestamp: new Date().toISOString() })
		await waitFor(() => counters.uploads > 0)
		expect(counters.uploads).toBe(1)

		// 静默期内不再重试
		await sleep(120)
		expect(counters.uploads).toBe(1)

		// 越过静默期后允许再试
		forbidden = false
		await waitFor(() => counters.uploads > 1)

		service.dispose()
	})

	it("writes payloads to the local outbox without any network call in mock transport mode", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-log-service-"))
		createdDirs.push(dir)
		const outbox = path.join(dir, "outbox")
		const throwingFetch = (async () => {
			throw new Error("no network call expected in mock transport mode")
		}) as typeof fetch

		const { service } = await createService({
			storageDir: dir,
			transport: createFileTransport(outbox),
			fetchImpl: throwingFetch,
		})

		service.ingest(sampleLog())
		await service.flush()

		const files = await fs.readdir(outbox)
		expect(files.some((file) => file.endsWith(".ndjson"))).toBe(true)
		expect(files.some((file) => file.endsWith(".meta.json"))).toBe(true)

		const bodyFile = files.find((file) => file.endsWith(".ndjson")) as string
		const body = JSON.parse((await fs.readFile(path.join(outbox, bodyFile), "utf8")).trim())
		expect(body).toMatchObject({ message: "boom", device_id: "device-1" })
		expect((await service.getStats()).sent).toBe(1)
	})

	it("force-releases a wedged tick latch so the pipeline cannot stall silently", async () => {
		const { service, lines } = await createService({
			transport: () => new Promise<UploadResult>(() => undefined),
			now: () => Date.now(),
			flushIntervalMs: 20,
			tickTimeoutMs: 60,
		})

		service.start()
		service.ingest({ ...sampleLog(), timestamp: new Date().toISOString() })

		await waitFor(() => lines.some((line) => line.includes("强制释放闩锁")), 3_000)
		service.dispose()

		expect((await service.getStats()).tickTimeouts).toBeGreaterThan(0)
	})

	it("reports a credential timeout instead of going silent", async () => {
		const { service, dir, lines } = await createService({
			getAccessToken: () => new Promise<string | null>(() => undefined),
			now: () => Date.now(),
			tokenTimeoutMs: 30,
		})

		service.ingest({ ...sampleLog(), timestamp: new Date().toISOString() })
		await service.flush({ timeoutMs: 500 })

		expect(lines.some((line) => line.includes("超时"))).toBe(true)
		expect(lines.some((line) => line.includes("跳过上报"))).toBe(true)
		expect((await service.getStats()).skipped).toBeGreaterThan(0)
		// 拿不到凭据时分片必须保留，等待下次重试
		expect((await fs.readdir(dir)).some((file) => file.endsWith(".ndjson"))).toBe(true)
	})

	it("logs the reason when an offline replay fails instead of failing silently", async () => {
		const { impl } = createFetchMock({ onUpload: () => errorResponse(503, "OVERLOADED") })
		const { service, lines } = await createService({ fetchImpl: impl })

		service.ingest(sampleLog())
		await service.flush() // 直发失败 → 分片封口保留
		await service.flush() // 走补发路径 → 必须留下可读原因

		expect(lines.some((line) => line.includes("补发失败") && line.includes("OVERLOADED"))).toBe(true)
	})

	it("writes an upload receipt so 'was it reported?' is answerable from disk", async () => {
		const { impl, calls } = createFetchMock({
			onUpload: () => new Response("", { status: 200, headers: { "x-request-id": "req-777" } }),
		})
		const { service, dir, lines } = await createService({ fetchImpl: impl })

		service.ingest(sampleLog())
		const stats = await service.flushNow()

		expect(stats.confirmed).toBe(1)
		expect(stats.sent).toBe(1)
		expect(lines.some((line) => line.includes("batch sent ok") && line.includes("request_id=req-777"))).toBe(true)

		const receipt = await fs.readFile(path.join(dir, "uploaded.log"), "utf8")
		expect(receipt).toContain("records=1")
		expect(receipt).toContain("first_event=event-1")
		expect(receipt).toContain("request_id=req-777")
		// 确认后分片必须被删除：盘上为空才等价于「都送出去了」
		expect((await fs.readdir(dir)).filter((file) => file.endsWith(".ndjson"))).toHaveLength(0)
		expect(calls.filter((call) => call.url === LOG_URL)).toHaveLength(1)
	})

	it("honors a configurable retention window instead of hardcoding 24h", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-log-retention-"))
		createdDirs.push(dir)
		const failingFetch = (async () => {
			throw new Error("offline")
		}) as typeof fetch

		let clock = Date.now()
		const seeded = await createService({ storageDir: dir, fetchImpl: failingFetch, now: () => clock })
		seeded.service.ingest({ ...sampleLog(), timestamp: new Date(clock).toISOString() })
		expect((await fs.readdir(dir)).some((file) => file.endsWith(".ndjson"))).toBe(true)

		// 时间前进 30 小时：超过旧的 24h 硬编码，但仍在契约允许的 3 天内
		clock += 30 * 60 * 60 * 1000

		const wide = await createService({ storageDir: dir, fetchImpl: failingFetch, now: () => clock })
		wide.service.start()
		await waitFor(() => wide.lines.some((line) => line.includes("启动补发")), 3_000)
		wide.service.dispose()

		expect(wide.lines.some((line) => line.includes("淘汰本地分片"))).toBe(false)
		expect((await fs.readdir(dir)).filter((file) => file.endsWith(".ndjson"))).toHaveLength(1)

		// 显式收窄到 1 小时：同一个分片必须被淘汰，且留下可读日志
		const narrow = await createService({
			storageDir: dir,
			fetchImpl: failingFetch,
			now: () => clock,
			offlineMaxAgeHours: 1,
		})
		narrow.service.start()
		await waitFor(() => narrow.lines.some((line) => line.includes("淘汰本地分片")), 3_000)
		narrow.service.dispose()

		expect(narrow.lines.some((line) => line.includes("超过保留时长 1h"))).toBe(true)
		expect((await fs.readdir(dir)).filter((file) => file.endsWith(".ndjson"))).toHaveLength(0)
	})

	it("surfaces the full failure response, not just the code", async () => {
		const { impl } = createFetchMock({
			onUpload: () =>
				new Response(
					JSON.stringify({
						success: false,
						code: "TOKEN_SIGNATURE_INVALID",
						message: "Token 签名验证失败",
						request_id: "req-abc",
					}),
					{ status: 401, headers: { "content-type": "application/json" } },
				),
		})
		const { service, lines } = await createService({ fetchImpl: impl })

		service.ingest(sampleLog())
		await service.flush()

		const failure = lines.find((line) => line.includes("TOKEN_SIGNATURE_INVALID"))
		expect(failure).toBeDefined()
		// 契约 §3.6 的四个字段都要能看到，否则无法定位「哪个凭据不对」
		expect(failure).toContain("HTTP 401")
		expect(failure).toContain("code=TOKEN_SIGNATURE_INVALID")
		expect(failure).toContain("message=Token 签名验证失败")
		expect(failure).toContain("request_id=req-abc")

		const stats = await service.getStats()
		expect(stats.lastError).toBe("TOKEN_SIGNATURE_INVALID")
		expect(stats.lastErrorDetail).toContain("HTTP 401")
		expect(stats.lastErrorDetail).toContain("Token 签名验证失败")
		expect(stats.lastErrorDetail).toContain("req-abc")
	})

	it("throttles repeated failures by code even when request_id keeps changing", async () => {
		let seq = 0
		const { impl } = createFetchMock({
			onUpload: () =>
				new Response(
					JSON.stringify({
						success: false,
						code: "TOKEN_SIGNATURE_INVALID",
						message: "Token 签名验证失败",
						request_id: `req-${++seq}`,
					}),
					{ status: 401, headers: { "content-type": "application/json" } },
				),
		})
		const { service, lines } = await createService({ fetchImpl: impl, now: () => Date.now() })

		for (let i = 0; i < 4; i++) {
			service.ingest({ ...sampleLog(), timestamp: new Date().toISOString(), event_id: `e-${i}` })
			await service.flush({ timeoutMs: 500 })
		}

		// 每次 request_id 都不同，但节流键是 code+status，所以不能刷屏
		const failures = lines.filter((line) => line.includes("TOKEN_SIGNATURE_INVALID"))
		expect(failures.length).toBeGreaterThan(0)
		expect(failures.length).toBeLessThan(4)
	})

	it("announces pending shards on startup so persisted-but-unsent logs are visible", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-log-pending-"))
		createdDirs.push(dir)

		const crashed = await createService({ storageDir: dir, now: () => Date.now() })
		crashed.service.ingest({ ...sampleLog(), timestamp: new Date().toISOString() })
		expect((await fs.readdir(dir)).some((file) => file.endsWith(".ndjson"))).toBe(true)

		const failingFetch = (async () => {
			throw new Error("offline")
		}) as typeof fetch
		const { service, lines } = await createService({
			storageDir: dir,
			fetchImpl: failingFetch,
			now: () => Date.now(),
		})

		service.start()
		await waitFor(() => lines.some((line) => line.includes("启动补发")), 3_000)
		service.dispose()

		expect(lines.some((line) => line.includes("启动补发：发现 1 个未确认分片"))).toBe(true)
	})
})
