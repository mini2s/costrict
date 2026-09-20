/**
 * 失败处置策略：把服务端返回的 HTTP 状态 / code 映射成客户端动作。
 * 契约见 plans/待上线的新版本日志采集API.md §3.6。
 */

export type FailureAction = "retry" | "drop" | "pause" | "split" | "refresh-token"

export interface FailureClassification {
	action: FailureAction
	code: string
}

const CODE_ACTIONS: Record<string, FailureAction> = {
	INVALID_LOG: "drop",
	TIMESTAMP_OUT_OF_RANGE: "drop",
	RESERVED_FIELD: "drop",
	FORBIDDEN_PARAMETER: "drop",
	UNSUPPORTED_MEDIA_TYPE: "drop",
	INVALID_TOKEN: "refresh-token",
	TOKEN_SIGNATURE_INVALID: "refresh-token",
	TOKEN_EXPIRED: "refresh-token",
	TOKEN_NOT_YET_VALID: "pause",
	TOKEN_CLAIMS_INVALID: "pause",
	TOKEN_REVOKED: "pause",
	INVALID_IDENTITY: "pause",
	USER_NOT_FOUND: "pause",
	USER_REPORTING_DISABLED: "pause",
	LOG_COLLECTION_DISABLED: "pause",
	TELEMETRY_FORBIDDEN: "pause",
	PAYLOAD_TOO_LARGE: "split",
	RATE_LIMITED: "retry",
	QUOTA_EXCEEDED: "retry",
	UPSTREAM_ERROR: "retry",
	OVERLOADED: "retry",
	STORAGE_UNAVAILABLE: "retry",
	AUTH_SERVICE_UNAVAILABLE: "retry",
	RATE_LIMIT_SERVICE_UNAVAILABLE: "retry",
	UPSTREAM_TIMEOUT: "retry",
	INTERNAL_ERROR: "retry",
}

const STATUS_ACTIONS: Array<{ test: (status: number) => boolean; action: FailureAction }> = [
	{ test: (status) => status === 400, action: "drop" },
	{ test: (status) => status === 401, action: "refresh-token" },
	{ test: (status) => status === 403, action: "pause" },
	{ test: (status) => status === 413, action: "split" },
	{ test: (status) => status === 415, action: "drop" },
	{ test: (status) => status === 429, action: "retry" },
	{ test: (status) => status >= 500, action: "retry" },
]

export const classifyFailure = (failure: {
	status?: number
	code?: string
	networkError?: string
}): FailureClassification => {
	const code = failure.code ?? ""
	if (code && CODE_ACTIONS[code]) {
		return { action: CODE_ACTIONS[code], code }
	}

	if (typeof failure.status === "number") {
		const matched = STATUS_ACTIONS.find((entry) => entry.test(failure.status as number))
		if (matched) {
			return { action: matched.action, code: code || `HTTP_${failure.status}` }
		}
	}

	return { action: "retry", code: code || failure.networkError || "NETWORK_ERROR" }
}

/** LOG_COLLECTION_DISABLED 需要额外停止采集。 */
export const isCollectionDisabled = (code?: string): boolean => code === "LOG_COLLECTION_DISABLED"
