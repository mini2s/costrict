import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { mockFs, mockSpawn, mockHomedir, mockHttp } = vi.hoisted(() => {
	const mockHttp: Record<string, any> = {}
	return {
		mockFs: {
			existsSync: vi.fn(),
			readFileSync: vi.fn(),
			writeFileSync: vi.fn(),
			mkdirSync: vi.fn(),
			watch: vi.fn(),
		},
		mockSpawn: { spawn: vi.fn(), execFile: vi.fn() },
		mockHomedir: vi.fn(() => "/home/testuser"),
		mockHttp,
	}
})

vi.mock("fs", () => mockFs)
vi.mock("os", () => ({ homedir: mockHomedir }))
vi.mock("child_process", () => ({
	spawn: (...args: any[]) => mockSpawn.spawn(...args),
	execFile: (...args: any[]) => mockSpawn.execFile(...args),
}))
vi.mock("http", () => mockHttp)

const { getConfigValues, setConfigValues } = vi.hoisted(() => {
	let vals: Record<string, unknown> = {}
	return {
		getConfigValues: () => vals,
		setConfigValues: (next: Record<string, unknown>) => {
			vals = next
		},
	}
})

vi.mock("vscode", () => ({
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
		getConfiguration: vi.fn(() => ({
			get: vi.fn((key: string, defaultValue: unknown) => {
				const v = getConfigValues()
				return key in v ? v[key] : defaultValue
			}),
		})),
	},
}))

import { CsCloudService } from "../core/cs-cloud/extension/csCloudService"

function createOutputChannel() {
	return { appendLine: vi.fn() }
}

function resetMocks() {
	vi.clearAllMocks()
	setConfigValues({ baseUrl: "", port: 45489, autoStartCsCloud: true, defaultCli: "csc" })
	mockFs.existsSync.mockReturnValue(false)
	mockFs.readFileSync.mockImplementation(() => {
		throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
	})
	mockFs.watch.mockReturnValue({ close: vi.fn() })
	mockHomedir.mockReturnValue("/home/testuser")
	mockSpawn.spawn.mockReturnValue({ unref: vi.fn() })
	mockSpawn.execFile.mockImplementation((...args: any[]) => {
		const cb = args[args.length - 1]
		if (typeof cb === "function") cb(new Error("not found"), "", "")
		return undefined as any
	})
}

function mockHealthOk() {
	mockHttp.get = vi.fn((_url: string, cb: (res: any) => void) => {
		setTimeout(() => cb({ statusCode: 200, resume: vi.fn() }), 10)
		return { setTimeout: vi.fn(), on: vi.fn(), destroy: vi.fn() }
	})
}

function mockHealthDown() {
	mockHttp.get = vi.fn((_url: string, _cb: (res: any) => void) => {
		return {
			setTimeout: vi.fn((_ms: number, fn: () => void) => setTimeout(fn, 10)),
			on: vi.fn((ev: string, fn: () => void) => {
				if (ev === "error") setTimeout(fn, 10)
			}),
			destroy: vi.fn(),
		}
	})
}

function setExecFileStdout(output: string) {
	mockSpawn.execFile.mockImplementation((...args: any[]) => {
		const cb = args[args.length - 1]
		if (typeof cb === "function") cb(null, output, "")
		return undefined as any
	})
}

function denyServerUrlFile() {
	mockFs.readFileSync.mockImplementation(() => {
		throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
	})
}

function setServerUrlFile(raw: string) {
	mockFs.readFileSync.mockReturnValue(raw)
}

describe("CsCloudService (refactored)", () => {
	beforeEach(resetMocks)
	afterEach(() => {
		mockHttp.get = vi.fn()
	})

	it("uses configured baseUrl directly", async () => {
		setConfigValues({ baseUrl: "http://custom:8080/api/v1", port: 45489 })
		const svc = new CsCloudService(createOutputChannel() as never)
		await expect(svc.ensureStarted()).resolves.toBe("http://custom:8080/api/v1")
		expect(svc.state).toBe("running")
	})

	it("reads server_url file when it exists and health passes", async () => {
		setServerUrlFile("http://127.0.0.1:59249")
		mockHealthOk()
		const svc = new CsCloudService(createOutputChannel() as never)
		await expect(svc.ensureStarted()).resolves.toBe("http://127.0.0.1:59249/api/v1")
		expect(svc.state).toBe("running")
	})

	it("parses local_url from csc cloud status", async () => {
		denyServerUrlFile()
		setExecFileStdout("local_url: http://127.0.0.1:55555\nmode: cloud\n")
		mockHealthOk()
		const svc = new CsCloudService(createOutputChannel() as never)
		await expect(svc.ensureStarted()).resolves.toBe("http://127.0.0.1:55555/api/v1")
		expect(svc.state).toBe("running")
		expect(mockFs.writeFileSync).toHaveBeenCalledWith(
			expect.stringContaining("server_url"),
			"http://127.0.0.1:55555",
			"utf-8",
		)
	})

	it("throws install prompt when nothing works", async () => {
		denyServerUrlFile()
		mockHealthDown()
		mockFs.existsSync.mockReturnValue(false)
		const svc = new CsCloudService(createOutputChannel() as never)
		await expect(svc.ensureStarted()).rejects.toThrow("未检测到 cs-cloud")
		expect(svc.state).toBe("failed")
	})

	it("restart clears state and re-resolves", async () => {
		setServerUrlFile("http://127.0.0.1:59249")
		mockHealthOk()
		const svc = new CsCloudService(createOutputChannel() as never)
		await svc.ensureStarted()
		expect(svc.state).toBe("running")
		setServerUrlFile("http://127.0.0.1:60000")
		await expect(svc.restart()).resolves.toBe("http://127.0.0.1:60000/api/v1")
	})

	it("deduplicates concurrent ensureStarted calls", async () => {
		setServerUrlFile("http://127.0.0.1:59249")
		mockHealthOk()
		const svc = new CsCloudService(createOutputChannel() as never)
		const [a, b] = await Promise.all([svc.ensureStarted(), svc.ensureStarted()])
		expect(a).toBe(b)
	})
})
