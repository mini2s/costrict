import { describeError } from "./logDiagnostics"
import type { SerializedPayload } from "./logSerializer"

export interface UploadResult {
	ok: boolean
	status?: number
	statusText?: string
	code?: string
	message?: string
	retryAfterSec?: number
	requestId?: string
	networkError?: string
	/** 校验错误的定位信息：details.line / details.field（契约 §3.6） */
	detailsLine?: number
	detailsField?: string
	/** 响应体片段（非 JSON 或无法解析时保留），便于看到网关 / 代理返回的原始内容 */
	bodySnippet?: string
}

export interface LogUploaderOptions {
	fetchImpl?: typeof fetch
	timeoutMs?: number
}

/** 失败响应体的保留长度：够看到网关的 HTML/纯文本原因，又不至于刷爆日志。 */
const MAX_BODY_SNIPPET = 500

export const parseRetryAfter = (value: string | null): number | undefined => {
	if (!value) {
		return undefined
	}
	const seconds = Number(value)
	if (Number.isFinite(seconds) && seconds >= 0) {
		return seconds
	}
	const date = Date.parse(value)
	if (!Number.isNaN(date)) {
		return Math.max(0, Math.ceil((date - Date.now()) / 1000))
	}
	return undefined
}

interface ParsedErrorBody {
	code?: string
	message?: string
	requestId?: string
	detailsLine?: number
	detailsField?: string
	bodySnippet?: string
}

/**
 * 解析失败响应。契约 §3.6 规定失败必须带非空 `message` 和 `request_id`，
 * 校验错误可带 `details.line` / `details.field`；这里全部取出来，
 * 否则排障时只剩一个 code，看不到服务端到底说了什么。
 */
const parseErrorBody = async (response: Response): Promise<ParsedErrorBody> => {
	// 注意：text 必须在 try 外声明，否则 catch 里取原文片段会 ReferenceError
	let text = ""
	try {
		text = await response.text()
		if (!text) {
			return {}
		}
		const parsed = JSON.parse(text) as {
			code?: unknown
			message?: unknown
			request_id?: unknown
			details?: { line?: unknown; field?: unknown }
		}
		return {
			code: typeof parsed.code === "string" ? parsed.code : undefined,
			message: typeof parsed.message === "string" ? parsed.message : undefined,
			requestId: typeof parsed.request_id === "string" ? parsed.request_id : undefined,
			detailsLine: typeof parsed.details?.line === "number" ? parsed.details.line : undefined,
			detailsField: typeof parsed.details?.field === "string" ? parsed.details.field : undefined,
		}
	} catch {
		// 非 JSON（网关 / 代理 / HTML 错误页）：原文片段是最有价值的证据
		return text ? { bodySnippet: text.slice(0, MAX_BODY_SNIPPET) } : {}
	}
}

export class LogUploader {
	constructor(private readonly options: LogUploaderOptions = {}) {}

	public async upload(url: string, payload: SerializedPayload, token: string): Promise<UploadResult> {
		const fetchImpl = this.options.fetchImpl ?? fetch
		const timeoutMs = this.options.timeoutMs ?? 30_000
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), timeoutMs)

		try {
			const response = await fetchImpl(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/stream+json",
					...(payload.encoding ? { "Content-Encoding": payload.encoding } : {}),
				},
				body: payload.body,
				signal: controller.signal,
			})

			const headerRequestId = response.headers.get("x-request-id") ?? undefined
			if (response.ok) {
				return { ok: true, status: response.status, requestId: headerRequestId }
			}

			const retryAfterSec = parseRetryAfter(response.headers.get("retry-after"))
			const parsed = await parseErrorBody(response)
			return {
				ok: false,
				status: response.status,
				statusText: response.statusText || undefined,
				code: parsed.code,
				message: parsed.message,
				// 头与响应体应一致（契约 §3.6），以头为准，缺失时用响应体兜底
				requestId: headerRequestId ?? parsed.requestId,
				retryAfterSec,
				detailsLine: parsed.detailsLine,
				detailsField: parsed.detailsField,
				bodySnippet: parsed.bodySnippet,
			}
		} catch (error) {
			return { ok: false, networkError: describeError(error) }
		} finally {
			clearTimeout(timer)
		}
	}
}
