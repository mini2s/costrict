import { classifyFailure, isCollectionDisabled } from "../logErrorPolicy"

describe("logErrorPolicy", () => {
	it("maps client-side validation codes to drop", () => {
		for (const code of [
			"INVALID_LOG",
			"TIMESTAMP_OUT_OF_RANGE",
			"RESERVED_FIELD",
			"FORBIDDEN_PARAMETER",
			"UNSUPPORTED_MEDIA_TYPE",
		]) {
			expect(classifyFailure({ status: 400, code }).action).toBe("drop")
		}
	})

	it("refreshes the token for token codes", () => {
		for (const code of ["INVALID_TOKEN", "TOKEN_SIGNATURE_INVALID", "TOKEN_EXPIRED"]) {
			expect(classifyFailure({ status: 401, code }).action).toBe("refresh-token")
		}
	})

	it("pauses uploads for identity and permission codes", () => {
		for (const code of [
			"TOKEN_NOT_YET_VALID",
			"TOKEN_CLAIMS_INVALID",
			"TOKEN_REVOKED",
			"INVALID_IDENTITY",
			"USER_NOT_FOUND",
			"USER_REPORTING_DISABLED",
			"LOG_COLLECTION_DISABLED",
			"TELEMETRY_FORBIDDEN",
		]) {
			expect(classifyFailure({ status: 403, code }).action).toBe("pause")
		}
	})

	it("splits oversized payloads", () => {
		expect(classifyFailure({ status: 413, code: "PAYLOAD_TOO_LARGE" }).action).toBe("split")
	})

	it("retries transient failures", () => {
		for (const code of [
			"RATE_LIMITED",
			"QUOTA_EXCEEDED",
			"UPSTREAM_ERROR",
			"OVERLOADED",
			"STORAGE_UNAVAILABLE",
			"AUTH_SERVICE_UNAVAILABLE",
			"RATE_LIMIT_SERVICE_UNAVAILABLE",
			"UPSTREAM_TIMEOUT",
			"INTERNAL_ERROR",
		]) {
			expect(classifyFailure({ status: 503, code }).action).toBe("retry")
		}
	})

	it("falls back to status classification when code is unknown", () => {
		expect(classifyFailure({ status: 400 }).action).toBe("drop")
		expect(classifyFailure({ status: 401 }).action).toBe("refresh-token")
		expect(classifyFailure({ status: 403 }).action).toBe("pause")
		expect(classifyFailure({ status: 413 }).action).toBe("split")
		expect(classifyFailure({ status: 429 }).action).toBe("retry")
		expect(classifyFailure({ status: 504 }).action).toBe("retry")
	})

	it("treats network errors as retryable", () => {
		expect(classifyFailure({ networkError: "ECONNRESET" })).toEqual({ action: "retry", code: "ECONNRESET" })
	})

	it("flags LOG_COLLECTION_DISABLED", () => {
		expect(isCollectionDisabled("LOG_COLLECTION_DISABLED")).toBe(true)
		expect(isCollectionDisabled("INVALID_TOKEN")).toBe(false)
	})
})
