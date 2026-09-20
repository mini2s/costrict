import { LogUploader, parseRetryAfter } from "../logUploader"

const URL = "http://log.test/insert/jsonline"
const BODY = Buffer.from('{"message":"hi"}\n', "utf8")

const jsonResponse = (status: number, payload: unknown, headers: Record<string, string> = {}): Response =>
	new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json", ...headers },
	})

describe("parseRetryAfter", () => {
	it("parses seconds", () => {
		expect(parseRetryAfter("30")).toBe(30)
		expect(parseRetryAfter("0")).toBe(0)
	})

	it("parses an http date", () => {
		const future = new Date(Date.now() + 60_000).toUTCString()
		const seconds = parseRetryAfter(future)
		expect(seconds).toBeGreaterThanOrEqual(55)
		expect(seconds).toBeLessThanOrEqual(60)
	})

	it("returns undefined for missing or invalid values", () => {
		expect(parseRetryAfter(null)).toBeUndefined()
		expect(parseRetryAfter("later")).toBeUndefined()
	})
})

describe("LogUploader", () => {
	it("posts NDJSON with bearer auth and stream content type", async () => {
		const calls: Array<{ headers: Record<string, string>; body: unknown }> = []
		const uploader = new LogUploader({
			fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
				calls.push({
					headers: (init?.headers ?? {}) as Record<string, string>,
					body: init?.body,
				})
				return new Response("", { status: 200, headers: { "x-request-id": "server-1" } })
			}) as typeof fetch,
		})

		const result = await uploader.upload(URL, { body: BODY }, "token-1")

		expect(result).toEqual({ ok: true, status: 200, requestId: "server-1" })
		expect(calls[0]?.headers).toMatchObject({
			Authorization: "Bearer token-1",
			"Content-Type": "application/stream+json",
		})
		expect(calls[0]?.headers["Content-Encoding"]).toBeUndefined()
		expect(calls[0]?.body).toBe(BODY)
	})

	it("declares gzip encoding when the payload is compressed", async () => {
		let headers: Record<string, string> = {}
		const uploader = new LogUploader({
			fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
				headers = (init?.headers ?? {}) as Record<string, string>
				return new Response("", { status: 200 })
			}) as typeof fetch,
		})

		await uploader.upload(URL, { body: BODY, encoding: "gzip" }, "token-1")

		expect(headers["Content-Encoding"]).toBe("gzip")
	})

	it("parses the error body and Retry-After", async () => {
		const uploader = new LogUploader({
			fetchImpl: (async () =>
				jsonResponse(
					429,
					{ success: false, code: "QUOTA_EXCEEDED", message: "quota" },
					{
						"retry-after": "120",
						"x-request-id": "server-2",
					},
				)) as typeof fetch,
		})

		const result = await uploader.upload(URL, { body: BODY }, "token-1")

		expect(result).toEqual({
			ok: false,
			status: 429,
			code: "QUOTA_EXCEEDED",
			message: "quota",
			retryAfterSec: 120,
			requestId: "server-2",
		})
	})

	it("tolerates a non-JSON error body", async () => {
		const uploader = new LogUploader({
			fetchImpl: (async () => new Response("<html>boom</html>", { status: 502 })) as typeof fetch,
		})

		const result = await uploader.upload(URL, { body: BODY }, "token-1")

		expect(result).toMatchObject({ ok: false, status: 502 })
		expect(result.code).toBeUndefined()
		expect(result.message).toBeUndefined()
		// 非 JSON 响应体必须留证据，否则只剩一个 HTTP 502
		expect(result.bodySnippet).toContain("boom")
	})

	it("keeps the contract-mandated failure fields (request_id, details) so the cause is readable", async () => {
		const uploader = new LogUploader({
			fetchImpl: (async () =>
				jsonResponse(401, {
					success: false,
					code: "TOKEN_SIGNATURE_INVALID",
					message: "Token 签名验证失败",
					request_id: "body-req-9",
					details: { line: 3, field: "timestamp" },
				})) as typeof fetch,
		})

		const result = await uploader.upload(URL, { body: BODY }, "token-1")

		expect(result).toMatchObject({
			ok: false,
			status: 401,
			code: "TOKEN_SIGNATURE_INVALID",
			message: "Token 签名验证失败",
			requestId: "body-req-9",
			detailsLine: 3,
			detailsField: "timestamp",
		})
	})

	it("prefers the X-Request-ID header over the body copy", async () => {
		const uploader = new LogUploader({
			fetchImpl: (async () =>
				jsonResponse(
					401,
					{ success: false, code: "INVALID_TOKEN", message: "m", request_id: "body-id" },
					{ "x-request-id": "header-id" },
				)) as typeof fetch,
		})

		const result = await uploader.upload(URL, { body: BODY }, "token-1")

		expect(result.requestId).toBe("header-id")
	})

	it("captures network failures", async () => {
		const uploader = new LogUploader({
			fetchImpl: (async () => {
				throw new TypeError("Failed to fetch")
			}) as typeof fetch,
		})

		const result = await uploader.upload(URL, { body: BODY }, "token-1")

		expect(result).toEqual({ ok: false, networkError: "Failed to fetch" })
	})

	it("aborts the request on timeout", async () => {
		const uploader = new LogUploader({
			timeoutMs: 20,
			fetchImpl: ((_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
				})) as unknown as typeof fetch,
		})

		const result = await uploader.upload(URL, { body: BODY }, "token-1")

		expect(result.ok).toBe(false)
		expect(result.networkError).toBe("aborted")
	})
})
