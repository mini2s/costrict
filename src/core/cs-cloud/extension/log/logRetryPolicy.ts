/**
 * 退避策略：指数退避 + full jitter，遵循 Retry-After，连续失败进入冷却。
 * 契约见 plans/待上线的新版本日志采集API.md §5.3。
 */

export interface LogRetryPolicyOptions {
	baseDelayMs?: number
	maxDelayMs?: number
	cooldownAfterFailures?: number
	cooldownMs?: number
	random?: () => number
}

export class LogRetryPolicy {
	private readonly baseDelayMs: number
	private readonly maxDelayMs: number
	private readonly cooldownAfterFailures: number
	private readonly cooldownMs: number
	private readonly random: () => number

	private failures = 0
	private cooldownUntil = 0

	constructor(options: LogRetryPolicyOptions = {}) {
		this.baseDelayMs = options.baseDelayMs ?? 1000
		this.maxDelayMs = options.maxDelayMs ?? 60_000
		this.cooldownAfterFailures = options.cooldownAfterFailures ?? 5
		this.cooldownMs = options.cooldownMs ?? 300_000
		this.random = options.random ?? Math.random
	}

	public nextDelayMs(attempt: number, retryAfterSec?: number): number {
		const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.max(0, attempt))
		const jittered = Math.floor(this.random() * exponential)
		const floor = typeof retryAfterSec === "number" && retryAfterSec > 0 ? retryAfterSec * 1000 : 0
		return Math.max(floor, jittered)
	}

	public recordFailure(now: number): void {
		this.failures++
		if (this.failures >= this.cooldownAfterFailures) {
			this.cooldownUntil = now + this.cooldownMs
			this.failures = 0
		}
	}

	public recordSuccess(): void {
		this.failures = 0
		this.cooldownUntil = 0
	}

	public isCoolingDown(now: number): boolean {
		return now < this.cooldownUntil
	}

	public get consecutiveFailures(): number {
		return this.failures
	}
}
