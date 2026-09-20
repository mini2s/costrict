import { describeError, readSnippet } from "./logDiagnostics"

export interface LogEndpoint {
	enabled: boolean
	url: string
	fallbackUrls: string[]
	protocol: string
	expiresAt: number
}

export interface EndpointCacheStore {
	load: () => Promise<LogEndpoint | undefined>
	save: (endpoint: LogEndpoint) => Promise<void>
}

/** 一次「真正发起」的发现请求的结果（缓存命中不触发，避免刷屏）。 */
export interface DiscoveryEvent {
	kind: "success" | "failure"
	/** 配置的发现基址（= logBaseUrl） */
	baseUrl: string
	/** 实际请求的完整地址 */
	discoveryUrl: string
	/** 成功时的 data.logs 字段 */
	enabled?: boolean
	url?: string
	fallbackUrls?: string[]
	protocol?: string
	expiresInMinutes?: number
	expiresAt?: number
	/** 失败原因 */
	status?: number
	error?: string
	bodySnippet?: string
	/** 失败时是否仍在沿用未过期的缓存 */
	usingCache?: boolean
}

export interface LogEndpointResolverOptions {
	/** 发现接口基址（costrict 后端），为空时调用方需自行保证非空 */
	baseUrl: string
	getAccessToken: () => Promise<string | null>
	fetchImpl?: typeof fetch
	now?: () => number
	random?: () => number
	cache?: EndpointCacheStore
	timeoutMs?: number
	onDiscovery?: (event: DiscoveryEvent) => void
}

export const DISCOVERY_PATH = "/user-indicator/api/v1/telemetry/endpoints"
export const DEFAULT_EXPIRES_IN_MINUTES = 300
const JITTER_RATIO = 0.1

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const readStringArray = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

export class LogEndpointResolver {
	private cached?: LogEndpoint
	private cacheLoaded = false

	constructor(private readonly options: LogEndpointResolverOptions) {}

	/** 取可用 endpoint；返回 undefined 表示当前不可上报。 */
	public async resolve(force = false): Promise<LogEndpoint | undefined> {
		const now = this.now()

		if (!force) {
			const existing = await this.ensureCacheLoaded()
			if (existing && now < existing.expiresAt) {
				return existing
			}
		}

		const discoveryUrl = `${this.options.baseUrl.replace(/\/$/, "")}${DISCOVERY_PATH}`
		// 凭据获取必须自证失败：既不进 try/catch 之外的裸 await，也不能让异常穿透 resolve()
		let token: string | null = null
		try {
			token = await this.options.getAccessToken()
		} catch (error) {
			this.emitDiscovery({
				kind: "failure",
				baseUrl: this.baseUrl,
				discoveryUrl,
				error: `获取 access token 失败：${describeError(error)}`,
				usingCache: this.stillValid(now) !== undefined,
			})
			return this.stillValid(now)
		}
		if (!token) {
			this.emitDiscovery({ kind: "failure", baseUrl: this.baseUrl, discoveryUrl, error: "missing access token" })
			return this.stillValid(now)
		}

		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000)

		try {
			const fetchImpl = this.options.fetchImpl ?? fetch
			const response = await fetchImpl(discoveryUrl, {
				method: "GET",
				headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
				signal: controller.signal,
			})
			if (!response.ok) {
				this.emitDiscovery({
					kind: "failure",
					baseUrl: this.baseUrl,
					discoveryUrl,
					status: response.status,
					bodySnippet: await readSnippet(response),
					usingCache: this.stillValid(now) !== undefined,
				})
				return this.stillValid(now)
			}

			const payload: unknown = await response.json()
			const data = isRecord(payload) && isRecord(payload.data) ? payload.data : undefined
			const logs = data && isRecord(data.logs) ? data.logs : undefined
			if (!logs || typeof logs.enabled !== "boolean") {
				this.emitDiscovery({
					kind: "failure",
					baseUrl: this.baseUrl,
					discoveryUrl,
					error: "响应缺少 data.logs.enabled",
					bodySnippet: JSON.stringify(payload).slice(0, 300),
					usingCache: this.stillValid(now) !== undefined,
				})
				return this.stillValid(now)
			}

			const expiresIn =
				data && typeof data.expires_in === "number" && data.expires_in > 0
					? data.expires_in
					: DEFAULT_EXPIRES_IN_MINUTES
			const ttlMs = expiresIn * 60_000
			const endpoint: LogEndpoint = {
				enabled: logs.enabled,
				url: typeof logs.url === "string" ? logs.url : "",
				fallbackUrls: readStringArray(logs.fallback_urls),
				protocol: typeof logs.protocol === "string" ? logs.protocol : "",
				expiresAt: now + ttlMs + Math.floor(ttlMs * JITTER_RATIO * this.random()),
			}

			this.emitDiscovery({
				kind: "success",
				baseUrl: this.baseUrl,
				discoveryUrl,
				enabled: endpoint.enabled,
				url: endpoint.url,
				fallbackUrls: endpoint.fallbackUrls,
				protocol: endpoint.protocol,
				expiresInMinutes: expiresIn,
				expiresAt: endpoint.expiresAt,
			})

			this.cached = endpoint
			await this.options.cache?.save(endpoint)
			return endpoint
		} catch (error) {
			this.emitDiscovery({
				kind: "failure",
				baseUrl: this.baseUrl,
				discoveryUrl,
				error: describeError(error),
				usingCache: this.stillValid(now) !== undefined,
			})
			return this.stillValid(now)
		} finally {
			clearTimeout(timer)
		}
	}

	/** 主地址不可用（连接失败 / 404 / 410）时调用，下次强制重新发现。 */
	public async invalidate(): Promise<void> {
		if (this.cached) {
			this.cached = { ...this.cached, expiresAt: 0 }
		}
	}

	public async candidateUrls(): Promise<string[]> {
		const endpoint = await this.resolve()
		if (!endpoint || !endpoint.enabled) {
			return []
		}
		return [endpoint.url, ...endpoint.fallbackUrls].filter((url) => url.length > 0)
	}

	private async ensureCacheLoaded(): Promise<LogEndpoint | undefined> {
		if (!this.cacheLoaded) {
			this.cacheLoaded = true
			if (!this.cached && this.options.cache) {
				try {
					this.cached = await this.options.cache.load()
				} catch {
					this.cached = undefined
				}
			}
		}
		return this.cached
	}

	private stillValid(now: number): LogEndpoint | undefined {
		return this.cached && now < this.cached.expiresAt ? this.cached : undefined
	}

	private get baseUrl(): string {
		return this.options.baseUrl
	}

	private emitDiscovery(event: DiscoveryEvent): void {
		try {
			this.options.onDiscovery?.(event)
		} catch {
			// 诊断日志失败不影响主链路
		}
	}

	private now(): number {
		return this.options.now?.() ?? Date.now()
	}

	private random(): number {
		return this.options.random?.() ?? Math.random()
	}
}
