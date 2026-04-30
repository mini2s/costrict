import nock from "nock"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { allowNetConnect } from "../vitest.setup"

const { getConfigValues, setConfigValues } = vi.hoisted(() => {
	let configValues: Record<string, unknown> = {}
	return {
		getConfigValues: () => configValues,
		setConfigValues: (next: Record<string, unknown>) => {
			configValues = next
		},
	}
})

vi.mock("vscode", () => ({
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
		getConfiguration: vi.fn(() => ({
			get: vi.fn((key: string, defaultValue: unknown) => {
				const configValues = getConfigValues()
				return key in configValues ? configValues[key] : defaultValue
			}),
		})),
	},
}))

vi.mock("child_process", () => ({
	spawn: vi.fn(),
	exec: vi.fn(),
}))

import { CsCloudService } from "../core/cs-cloud/extension/csCloudService"
import { exec, spawn } from "child_process"

function createOutputChannel() {
	return { appendLine: vi.fn() }
}

function mockExecReturn(stdout: string) {
	vi.mocked(exec).mockImplementation((cmd, options, callback) => {
		if (typeof options === "function") {
			callback = options
		}
		if (callback) {
			callback(null, stdout, "")
		}
		return undefined as any
	})
}

describe("CsCloudService", () => {
	beforeEach(() => {
		allowNetConnect("127.0.0.1")
		setConfigValues({
			baseUrl: "",
			port: 45489,
			autoStartCsCloud: false,
			csCloudPath: "cs-cloud",
		})
		mockExecReturn("")
	})

	afterEach(() => {
		nock.cleanAll()
		nock.disableNetConnect()
	})

	it("returns a ready and OpenCode-compatible local base URL", async () => {
		nock("http://127.0.0.1:45489").get("/api/v1/runtime/health").reply(200, { ok: true })
		nock("http://127.0.0.1:45489")
			.get("/api/v1/experimental/session")
			.query({ roots: "true", archived: "true" })
			.reply(200, [])

		const service = new CsCloudService(createOutputChannel() as never)

		await expect(service.ensureStarted()).resolves.toBe("http://127.0.0.1:45489/api/v1")
	})

	it("fails clearly when an existing daemon lacks OpenCode-compatible routes", async () => {
		nock("http://127.0.0.1:45489").get("/api/v1/runtime/health").reply(200, { ok: true })
		nock("http://127.0.0.1:45489")
			.get("/api/v1/experimental/session")
			.query({ roots: "true", archived: "true" })
			.reply(404, "404 page not found")

		const service = new CsCloudService(createOutputChannel() as never)

		await expect(service.ensureStarted()).rejects.toThrow("is not OpenCode-compatible yet")
	})

	it("uses detected port when cs-cloud is already running on a non-default port", async () => {
		mockExecReturn(
			"\x1b[1;38;2;125;86;244mcs-cloud status\x1b[m\n               \n\x1b[38;2;4;181;117m  ✓\x1b[m \x1b[38;2;4;181;117mRunning\x1b[m\n  \x1b[38;2;176;176;176mlocal_url:\x1b[m \x1b[38;2;255;255;255mhttp://127.0.0.1:55555\x1b[m\n",
		)
		nock("http://127.0.0.1:55555").get("/api/v1/runtime/health").reply(200, { ok: true })
		nock("http://127.0.0.1:55555")
			.get("/api/v1/experimental/session")
			.query({ roots: "true", archived: "true" })
			.reply(200, [])

		const service = new CsCloudService(createOutputChannel() as never)

		await expect(service.ensureStarted()).resolves.toBe("http://127.0.0.1:55555/api/v1")
		expect(spawn).not.toHaveBeenCalled()
	})

	it("waits for detected port to become ready instead of falling back to config.port", async () => {
		setConfigValues({ baseUrl: "", port: 45489, autoStartCsCloud: false, csCloudPath: "cs-cloud" })
		mockExecReturn(
			"\x1b[1;38;2;125;86;244mcs-cloud status\x1b[m\n               \n\x1b[38;2;4;181;117m  ✓\x1b[m \x1b[38;2;4;181;117mRunning\x1b[m\n  \x1b[38;2;176;176;176mlocal_url:\x1b[m \x1b[38;2;255;255;255mhttp://127.0.0.1:55555\x1b[m\n",
		)

		let callCount = 0
		nock("http://127.0.0.1:55555")
			.get("/api/v1/runtime/health")
			.reply(() => {
				callCount++
				return callCount === 1 ? [503, "Not Ready"] : [200, { ok: true }]
			})
			.persist()

		nock("http://127.0.0.1:55555")
			.get("/api/v1/experimental/session")
			.query({ roots: "true", archived: "true" })
			.reply(200, [])

		const service = new CsCloudService(createOutputChannel() as never)

		await expect(service.ensureStarted()).resolves.toBe("http://127.0.0.1:55555/api/v1")
		expect(spawn).not.toHaveBeenCalled()
	})

	it("falls back to default port when cs-cloud status command fails", async () => {
		mockExecReturn("")
		nock("http://127.0.0.1:45489").get("/api/v1/runtime/health").reply(200, { ok: true })
		nock("http://127.0.0.1:45489")
			.get("/api/v1/experimental/session")
			.query({ roots: "true", archived: "true" })
			.reply(200, [])

		const service = new CsCloudService(createOutputChannel() as never)

		await expect(service.ensureStarted()).resolves.toBe("http://127.0.0.1:45489/api/v1")
		expect(spawn).not.toHaveBeenCalled()
	})

	it("throws clear error when cs-cloud is not running and autoStartCsCloud is false", async () => {
		mockExecReturn("")
		nock("http://127.0.0.1:45489").get("/api/v1/runtime/health").replyWithError("connection refused")

		const service = new CsCloudService(createOutputChannel() as never)

		await expect(service.ensureStarted()).rejects.toThrow("cs-cloud 没有运行")
		expect(spawn).not.toHaveBeenCalled()
	})
})
