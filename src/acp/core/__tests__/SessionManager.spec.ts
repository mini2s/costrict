import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { EventEmitter } from "node:events"

vi.mock("vscode", () => ({
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
		getConfiguration: vi.fn(() => ({
			get: vi.fn((key: string, fallback: unknown) => {
				if (key === "agents") {
					return {
						gemini: {
							command: "gemini",
							args: ["serve"],
							env: {},
						},
					}
				}
				return fallback
			}),
		})),
	},
	window: {
		showQuickPick: vi.fn(),
		showInformationMessage: vi.fn(),
	},
}))

vi.mock("../config/AgentConfig", () => ({
	getAgentConfigs: vi.fn(() => ({
		gemini: {
			command: "gemini",
			args: ["serve"],
			env: {},
		},
	})),
}))

vi.mock("../../utils/logger", () => ({
	createLogger: vi.fn(() => ({ channel: { appendLine: vi.fn() } })),
}))

vi.mock("../../../utils/logger", () => ({
	createLogger: vi.fn(() => ({ channel: { appendLine: vi.fn() } })),
}))

import { SessionManager } from "../SessionManager"
import { SessionUpdateHandler } from "../../handlers/SessionUpdateHandler"

class MockAgentManager extends EventEmitter {
	spawnAgent = vi.fn((name: string) => ({ id: `${name}-id`, name, process: {} }))
	getAgent = vi.fn((agentId: string) => ({ id: agentId, process: {} }))
	killAgent = vi.fn(() => true)
	killAll = vi.fn()
}

class MockConnectionManager {
	connect = vi.fn(async () => ({
		connection: {
			newSession: vi.fn(async () => ({ sessionId: "session-1", modes: null, models: null })),
			prompt: vi.fn(),
			cancel: vi.fn(),
			setSessionMode: vi.fn(),
			unstable_setSessionModel: vi.fn(),
		},
		client: {} as any,
		initResponse: {
			agentInfo: { title: "Gemini", name: "gemini", version: "1.0.0" },
		},
	}))
	removeConnection = vi.fn()
	getConnection = vi.fn(() => ({
		connection: {
			prompt: vi.fn(),
			cancel: vi.fn(),
			setSessionMode: vi.fn(),
			unstable_setSessionModel: vi.fn(),
		},
	}))
	dispose = vi.fn()
}

describe("SessionManager reconnect behavior", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.runOnlyPendingTimers()
		vi.useRealTimers()
	})

	it("schedules reconnect and reconnects automatically after unexpected close", async () => {
		const agentManager = new MockAgentManager()
		const connectionManager = new MockConnectionManager()
		const sessionManager = new SessionManager(
			agentManager as any,
			connectionManager as any,
			new SessionUpdateHandler(),
		)

		const reconnectingHandler = vi.fn()
		const reconnectedHandler = vi.fn()
		sessionManager.on("agent-reconnecting", reconnectingHandler)
		sessionManager.on("agent-reconnected", reconnectedHandler)

		await sessionManager.connectToAgent("gemini")
		agentManager.emit("agent-closed", { agentId: "gemini-id", code: 1, signal: null })

		expect(reconnectingHandler).toHaveBeenCalledWith("gemini", 1)

		await vi.advanceTimersByTimeAsync(1500)

		expect(agentManager.spawnAgent).toHaveBeenCalledTimes(2)
		expect(reconnectedHandler).toHaveBeenCalledWith("gemini", 1)
	})

	it("does not reconnect after an intentional disconnect", async () => {
		const agentManager = new MockAgentManager()
		const connectionManager = new MockConnectionManager()
		const sessionManager = new SessionManager(
			agentManager as any,
			connectionManager as any,
			new SessionUpdateHandler(),
		)

		const reconnectingHandler = vi.fn()
		sessionManager.on("agent-reconnecting", reconnectingHandler)

		await sessionManager.connectToAgent("gemini")
		await sessionManager.disconnectAgent("gemini")
		agentManager.emit("agent-closed", { agentId: "gemini-id", code: 0, signal: null })
		await vi.advanceTimersByTimeAsync(1500)

		expect(reconnectingHandler).not.toHaveBeenCalled()
		expect(agentManager.spawnAgent).toHaveBeenCalledTimes(1)
	})
})
