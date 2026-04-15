import * as vscode from "vscode"

import { AcpProvider } from "../AcpProvider"

vi.mock("../core/AgentManager", () => ({
	AgentManager: class MockAgentManager {},
}))

vi.mock("../core/ConnectionManager", () => ({
	ConnectionManager: class MockConnectionManager {
		constructor(_sessionUpdateHandler: unknown) {}
	},
}))

vi.mock("../core/SessionManager", () => ({
	SessionManager: class MockSessionManager {
		constructor(_agentManager: unknown, _connectionManager: unknown, _sessionUpdateHandler: unknown) {}
		on = vi.fn()
		dispose = vi.fn()
		getActiveSession = vi.fn(() => null)
		getActiveSessionId = vi.fn(() => null)
		getSession = vi.fn(() => null)
		getActiveAgentName = vi.fn(() => null)
		connectToAgent = vi.fn()
		disconnectAgent = vi.fn()
		sendPrompt = vi.fn()
		cancelTurn = vi.fn()
		setMode = vi.fn()
		setModel = vi.fn()
	},
}))

vi.mock("../handlers/SessionUpdateHandler", () => ({
	SessionUpdateHandler: class MockSessionUpdateHandler {
		addListener = vi.fn()
		dispose = vi.fn()
	},
}))

vi.mock("../ui/StatusBarManager", () => ({
	StatusBarManager: class MockStatusBarManager {
		constructor(_sessionManager: unknown) {}
		dispose = vi.fn()
	},
}))

describe("AcpProvider", () => {
	it("renders ACP webview HTML with a full-height root container so the input area can pin to the bottom", async () => {
		const extensionUri = vscode.Uri.file("/tmp/costrict-extension")
		const context = {
			extensionUri,
			extensionMode: vscode.ExtensionMode.Production,
		} as vscode.ExtensionContext

		const provider = new AcpProvider(context, {} as vscode.OutputChannel)

		const webview = {
			cspSource: "vscode-resource:",
			asWebviewUri: (uri: vscode.Uri) => uri,
			postMessage: vi.fn(),
			onDidReceiveMessage: vi.fn(),
			options: undefined,
			html: "",
		} as unknown as vscode.Webview

		const webviewView = {
			webview,
			onDidDispose: vi.fn(),
		} as unknown as vscode.WebviewView

		await provider.resolveWebviewView(webviewView)

		expect(webview.html).toContain("html, body, #root {")
		expect(webview.html).toContain("height: 100%;")
		expect(webview.html).toContain("body {")
		expect(webview.html).toContain("overflow: hidden;")
		expect(webview.html).toContain("#root {")
		expect(webview.html).toContain("display: flex;")
		expect(webview.html).toContain("flex-direction: column;")
	})
})
