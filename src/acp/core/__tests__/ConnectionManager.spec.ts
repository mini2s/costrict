import { describe, expect, it, vi, beforeEach } from "vitest"
import { Readable, Writable } from "node:stream"

const clientDisposeMock = vi.fn()
const fileSystemHandlerMock = vi.fn()
const terminalAdapterMock = vi.fn()
const permissionHandlerMock = vi.fn()

vi.mock("@agentclientprotocol/sdk", () => {
	class MockClientSideConnection {
		async initialize() {
			return { agentInfo: { name: "Test Agent", version: "1.0.0" } }
		}
	}

	return {
		ClientSideConnection: MockClientSideConnection,
		ndJsonStream: vi.fn(() => ({
			writable: {},
			readable: {
				pipeTo: vi.fn(() => Promise.resolve()),
			},
		})),
		PROTOCOL_VERSION: "1.0.0",
	}
})

vi.mock("../AcpClientImpl", () => ({
	AcpClientImpl: vi.fn().mockImplementation(() => ({
		setAgent: vi.fn(),
		dispose: clientDisposeMock,
	})),
}))

vi.mock("../../handlers/FileSystemHandler", () => ({
	FileSystemHandler: vi.fn().mockImplementation(() => {
		fileSystemHandlerMock()
		return {}
	}),
}))

vi.mock("../../handlers/TerminalAdapter", () => ({
	TerminalAdapter: vi.fn().mockImplementation(() => {
		terminalAdapterMock()
		return { dispose: vi.fn() }
	}),
}))

vi.mock("../../handlers/PermissionHandler", () => ({
	PermissionHandler: vi.fn().mockImplementation(() => {
		permissionHandlerMock()
		return {}
	}),
}))

vi.mock("../../utils/logger", () => ({
	createLogger: vi.fn(() => ({ channel: { appendLine: vi.fn() } })),
}))

vi.mock("../../shared/package", () => ({
	Package: { version: "1.0.0" },
}))

import { ConnectionManager } from "../ConnectionManager"
import { SessionUpdateHandler } from "../../handlers/SessionUpdateHandler"

describe("ConnectionManager dispose cleanup", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.spyOn(Readable, "toWeb").mockReturnValue({} as any)
		vi.spyOn(Writable, "toWeb").mockReturnValue({} as any)
	})

	it("disposes managed connection resources when removeConnection is called", async () => {
		const manager = new ConnectionManager(new SessionUpdateHandler())
		const process = {
			stdout: {},
			stdin: {},
		} as any

		await manager.connect("agent-1", process)
		manager.removeConnection("agent-1")

		expect(clientDisposeMock).toHaveBeenCalledTimes(1)
		expect(manager.getConnection("agent-1")).toBeUndefined()
	})

	it("disposes all managed connection resources on manager dispose", async () => {
		const manager = new ConnectionManager(new SessionUpdateHandler())
		const processA = {
			stdout: {},
			stdin: {},
		} as any
		const processB = {
			stdout: {},
			stdin: {},
		} as any

		await manager.connect("agent-1", processA)
		await manager.connect("agent-2", processB)
		manager.dispose()

		expect(clientDisposeMock).toHaveBeenCalledTimes(2)
		expect(manager.getConnection("agent-1")).toBeUndefined()
		expect(manager.getConnection("agent-2")).toBeUndefined()
	})
})
