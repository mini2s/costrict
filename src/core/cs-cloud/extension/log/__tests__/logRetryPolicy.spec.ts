import { LogRetryPolicy } from "../logRetryPolicy"

describe("LogRetryPolicy", () => {
	it("grows exponentially and stays within the cap", () => {
		const policy = new LogRetryPolicy({ baseDelayMs: 1000, maxDelayMs: 60_000, random: () => 1 })
		expect(policy.nextDelayMs(0)).toBe(1000)
		expect(policy.nextDelayMs(1)).toBe(2000)
		expect(policy.nextDelayMs(2)).toBe(4000)
		expect(policy.nextDelayMs(10)).toBe(60_000)
	})

	it("applies full jitter", () => {
		const policy = new LogRetryPolicy({ baseDelayMs: 1000, maxDelayMs: 60_000, random: () => 0.5 })
		expect(policy.nextDelayMs(3)).toBe(4000)
		const zero = new LogRetryPolicy({ baseDelayMs: 1000, maxDelayMs: 60_000, random: () => 0 })
		expect(zero.nextDelayMs(3)).toBe(0)
	})

	it("never waits less than Retry-After", () => {
		const policy = new LogRetryPolicy({ baseDelayMs: 1000, maxDelayMs: 60_000, random: () => 0 })
		expect(policy.nextDelayMs(0, 30)).toBe(30_000)
	})

	it("enters cooldown after 5 consecutive failures", () => {
		const policy = new LogRetryPolicy({ cooldownAfterFailures: 5, cooldownMs: 300_000 })
		const now = 1_000_000

		for (let index = 0; index < 4; index++) {
			policy.recordFailure(now)
		}
		expect(policy.isCoolingDown(now)).toBe(false)

		policy.recordFailure(now)
		expect(policy.isCoolingDown(now)).toBe(true)
		expect(policy.isCoolingDown(now + 299_999)).toBe(true)
		expect(policy.isCoolingDown(now + 300_000)).toBe(false)
	})

	it("clears failures and cooldown on success", () => {
		const policy = new LogRetryPolicy({ cooldownAfterFailures: 2, cooldownMs: 300_000 })
		const now = 1_000_000
		policy.recordFailure(now)
		policy.recordFailure(now)
		expect(policy.isCoolingDown(now)).toBe(true)

		policy.recordSuccess()
		expect(policy.isCoolingDown(now)).toBe(false)
		expect(policy.consecutiveFailures).toBe(0)
	})
})
