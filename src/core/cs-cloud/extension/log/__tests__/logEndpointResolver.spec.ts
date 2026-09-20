import { DISCOVERY_PATH, LogEndpointResolver, type DiscoveryEvent, type LogEndpoint } from "../logEndpointResolver"

const BASE_URL = "http://costrict.test"
const NOW = 1_000_000

const discoveryPayload = (
	options: { enabled?: boolean; url?: string; fallback?: string[]; expiresIn?: number } = {},
) => {
	const enabled = options.enabled ?? true
	return {
		success: true,
		code: "",
		data: {
			logs: {
				enabled,
				url: options.url ?? (enabled ? "http://log.test/insert/jsonline" : ""),
				fallback_urls: options.fallback ?? [],
				protocol: "victorialogs-jsonline-v1",
			},
			expires_in: options.expiresIn ?? 10,
		},
	}
}

const jsonResponse = (payload: unknown, status = 200): Response =>
	new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })

const createResolver = (
	responder: () => Response | Promise<Response>,
	options: {
		now?: () => number
		cache?: { load: () => Promise<LogEndpoint | undefined>; save: (e: LogEndpoint) => Promise<void> }
		onDiscovery?: (event: DiscoveryEvent) => void
	} = {},
) => {
	const calls: string[] = []
	const resolver = new LogEndpointResolver({
		baseUrl: BASE_URL,
		getAccessToken: async () => "token-1",
		fetchImpl: (async (input: RequestInfo | URL) => {
			calls.push(String(input))
			return responder()
		}) as typeof fetch,
		now: options.now ?? (() => NOW),
		random: () => 0,
		cache: options.cache,
		onDiscovery: options.onDiscovery,
	})
	return { resolver, calls }
}

describe("LogEndpointResolver", () => {
	it("reports the resolved data.logs.url through onDiscovery", async () => {
		const events: DiscoveryEvent[] = []
		const { resolver } = createResolver(() => jsonResponse(discoveryPayload()), {
			onDiscovery: (e) => events.push(e),
		})

		await resolver.resolve()

		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			kind: "success",
			baseUrl: BASE_URL,
			discoveryUrl: `${BASE_URL}${DISCOVERY_PATH}`,
			enabled: true,
			url: "http://log.test/insert/jsonline",
			expiresInMinutes: 10,
		})
	})

	it("reports discovery failures with status and body snippet", async () => {
		const events: DiscoveryEvent[] = []
		const { resolver } = createResolver(
			() => new Response('{"success":false,"code":"INVALID_TOKEN"}', { status: 401 }),
			{ onDiscovery: (e) => events.push(e) },
		)

		await resolver.resolve()

		expect(events[0]).toMatchObject({ kind: "failure", status: 401, usingCache: false })
		expect(events[0]?.bodySnippet).toContain("INVALID_TOKEN")
	})

	it("reports network errors and missing tokens", async () => {
		const events: DiscoveryEvent[] = []
		const { resolver } = createResolver(
			() => {
				throw new Error("socket hang up")
			},
			{ onDiscovery: (e) => events.push(e) },
		)

		await resolver.resolve()
		expect(events[0]).toMatchObject({ kind: "failure", error: "socket hang up" })

		const noToken: DiscoveryEvent[] = []
		const noTokenResolver = new LogEndpointResolver({
			baseUrl: BASE_URL,
			getAccessToken: async () => null,
			fetchImpl: (async () => jsonResponse(discoveryPayload())) as typeof fetch,
			onDiscovery: (event) => noToken.push(event),
		})
		await noTokenResolver.resolve()
		expect(noToken[0]).toMatchObject({ kind: "failure", error: "missing access token" })
	})

	it("includes the error cause chain so TLS/DNS failures are diagnosable", async () => {
		const events: DiscoveryEvent[] = []
		const cause = Object.assign(new Error("getaddrinfo ENOTFOUND zgsmtest.cn"), { code: "ENOTFOUND" })
		const { resolver } = createResolver(
			() => {
				throw new TypeError("fetch failed", { cause })
			},
			{ onDiscovery: (e) => events.push(e) },
		)

		await resolver.resolve()

		expect(events[0]?.error).toContain("fetch failed")
		expect(events[0]?.error).toContain("ENOTFOUND")
		expect(events[0]?.error).toContain("zgsmtest.cn")
	})

	it("does not emit for cache hits", async () => {
		const events: DiscoveryEvent[] = []
		const { resolver } = createResolver(() => jsonResponse(discoveryPayload()), {
			onDiscovery: (e) => events.push(e),
		})

		await resolver.resolve()
		await resolver.resolve()

		expect(events).toHaveLength(1)
	})

	it("requests the documented discovery path with a bearer token", async () => {
		const { resolver, calls } = createResolver(() => jsonResponse(discoveryPayload()))
		const endpoint = await resolver.resolve()

		expect(calls).toEqual([`${BASE_URL}${DISCOVERY_PATH}`])
		expect(endpoint?.url).toBe("http://log.test/insert/jsonline")
		expect(endpoint?.enabled).toBe(true)
	})

	it("reuses the cached endpoint until expires_in elapses", async () => {
		let now = NOW
		const { resolver, calls } = createResolver(() => jsonResponse(discoveryPayload({ expiresIn: 10 })), {
			now: () => now,
		})

		await resolver.resolve()
		now += 9 * 60_000
		await resolver.resolve()
		expect(calls).toHaveLength(1)

		now += 2 * 60_000
		await resolver.resolve()
		expect(calls).toHaveLength(2)
	})

	it("keeps a still-valid cache when discovery fails", async () => {
		let now = NOW
		let fail = false
		const { resolver, calls } = createResolver(
			() => (fail ? jsonResponse({}, 500) : jsonResponse(discoveryPayload())),
			{
				now: () => now,
			},
		)

		await resolver.resolve()
		fail = true
		now += 60_000
		const endpoint = await resolver.resolve(true)

		expect(calls).toHaveLength(2)
		expect(endpoint).toBeDefined()
		expect(endpoint?.enabled).toBe(true)
	})

	it("reports disabled collection without exposing a url", async () => {
		const { resolver } = createResolver(() => jsonResponse(discoveryPayload({ enabled: false })))
		const endpoint = await resolver.resolve()

		expect(endpoint?.enabled).toBe(false)
		expect(endpoint?.url).toBe("")
		expect(await resolver.candidateUrls()).toEqual([])
	})

	it("lists fallback urls after the primary", async () => {
		const { resolver } = createResolver(() =>
			jsonResponse(discoveryPayload({ fallback: ["http://log-2.test/insert/jsonline"] })),
		)
		expect(await resolver.candidateUrls()).toEqual([
			"http://log.test/insert/jsonline",
			"http://log-2.test/insert/jsonline",
		])
	})

	it("forces re-discovery after invalidate", async () => {
		const { resolver, calls } = createResolver(() => jsonResponse(discoveryPayload()))
		await resolver.resolve()
		await resolver.invalidate()
		await resolver.resolve()
		expect(calls).toHaveLength(2)
	})

	it("loads and stores the endpoint through the cache", async () => {
		const saved: LogEndpoint[] = []
		const { resolver } = createResolver(() => jsonResponse(discoveryPayload()), {
			cache: {
				load: async () => undefined,
				save: async (endpoint) => {
					saved.push(endpoint)
				},
			},
		})

		await resolver.resolve()
		expect(saved).toHaveLength(1)
		expect(saved[0].expiresAt).toBeGreaterThan(NOW)
	})
})
