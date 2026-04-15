import { EventEmitter } from "node:events"
import * as vscode from "vscode"

import { StatusBarManager } from "../ui/StatusBarManager"
import type { SessionInfo } from "../core/SessionManager"

vi.mock("vscode", () => {
	const statusBarItem = {
		text: "",
		tooltip: "",
		backgroundColor: undefined,
		name: "",
		command: undefined,
		show: vi.fn(),
		dispose: vi.fn(),
	}

	return {
		window: {
			createStatusBarItem: vi.fn(() => statusBarItem),
		},
		StatusBarAlignment: {
			Right: 2,
		},
		ThemeColor: vi.fn((id: string) => ({ id })),
	}
})

class MockSessionManager extends EventEmitter {
	private activeSession?: SessionInfo

	getActiveSession(): SessionInfo | undefined {
		return this.activeSession
	}

	setActiveSession(session?: SessionInfo) {
		this.activeSession = session
	}
}

const makeSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
	sessionId: "session-1",
	agentId: "agent-1",
	agentName: "gemini-cli",
	agentDisplayName: "Gemini CLI",
	cwd: "/workspace",
	createdAt: new Date().toISOString(),
	initResponse: {} as any,
	modes: null,
	models: null,
	availableCommands: [],
	...overrides,
})

describe("StatusBarManager", () => {
	const statusBarItem = vi.mocked(vscode.window.createStatusBarItem).mock.results[0]?.value as any

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("shows disconnected state initially", () => {
		const sessionManager = new MockSessionManager()
		new StatusBarManager(sessionManager as any)

		const item = vi.mocked(vscode.window.createStatusBarItem).mock.results[0]?.value as any
		expect(item.text).toBe("$(plug) ACP: Disconnected")
		expect(item.tooltip).toBe("ACP is not connected")
		expect(item.show).toHaveBeenCalled()
	})

	it("updates to connected state when an active session exists", () => {
		const sessionManager = new MockSessionManager()
		const manager = new StatusBarManager(sessionManager as any)
		const item = vi.mocked(vscode.window.createStatusBarItem).mock.results[0]?.value as any

		sessionManager.setActiveSession(makeSession())
		sessionManager.emit("active-session-changed", "session-1")

		expect(item.text).toBe("$(hubot) ACP: Gemini CLI")
		expect(item.tooltip).toContain("Connected to Gemini CLI")
		expect(item.tooltip).toContain("Agent: gemini-cli")
		expect(item.tooltip).toContain("Session: session-1")
		manager.dispose()
	})

	it("shows error state when session manager emits agent-error", () => {
		const sessionManager = new MockSessionManager()
		new StatusBarManager(sessionManager as any)
		const item = vi.mocked(vscode.window.createStatusBarItem).mock.results[0]?.value as any

		sessionManager.emit("agent-error", "agent-1", new Error("boom"))

		expect(item.text).toBe("$(error) ACP: Error")
		expect(item.tooltip).toBe("boom")
		expect(item.backgroundColor).toEqual({ id: "statusBarItem.errorBackground" })
	})

	it("disposes the underlying status bar item", () => {
		const sessionManager = new MockSessionManager()
		const manager = new StatusBarManager(sessionManager as any)
		const item = vi.mocked(vscode.window.createStatusBarItem).mock.results[0]?.value as any

		manager.dispose()

		expect(item.dispose).toHaveBeenCalled()
	})
})
