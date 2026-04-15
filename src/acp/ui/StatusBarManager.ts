import * as vscode from "vscode"

import type { SessionManager, SessionInfo } from "../core/SessionManager"

export class StatusBarManager implements vscode.Disposable {
	private readonly statusBar: vscode.StatusBarItem
	private readonly disposables: vscode.Disposable[] = []

	constructor(private readonly sessionManager: SessionManager) {
		this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98)
		this.statusBar.name = "ACP Status"
		this.statusBar.command = "workbench.view.extension.costrict-sidebar"

		this.registerSessionListener("agent-connected", () => this.update())
		this.registerSessionListener("agent-disconnected", () => this.update())
		this.registerSessionListener("active-session-changed", () => this.update())
		this.registerSessionListener("agent-error", (_agentId: string, error: Error) => this.showError(error))
		this.disposables.push({
			dispose: () => this.statusBar.dispose(),
		})

		this.update()
	}

	private registerSessionListener(event: string, listener: (...args: any[]) => void): void {
		this.sessionManager.on(event, listener)
		this.disposables.push({
			dispose: () => this.sessionManager.off(event, listener),
		})
	}

	private update(): void {
		const activeSession = this.sessionManager.getActiveSession()
		if (!activeSession) {
			this.statusBar.text = "$(plug) ACP: Disconnected"
			this.statusBar.tooltip = "ACP is not connected"
			this.statusBar.backgroundColor = undefined
			this.statusBar.show()
			return
		}

		this.showConnected(activeSession)
	}

	private showConnected(session: SessionInfo): void {
		this.statusBar.text = `$(hubot) ACP: ${session.agentDisplayName}`
		this.statusBar.tooltip = [
			`Connected to ${session.agentDisplayName}`,
			`Agent: ${session.agentName}`,
			`Session: ${session.sessionId}`,
		].join("\n")
		this.statusBar.backgroundColor = undefined
		this.statusBar.show()
	}

	private showError(error: Error): void {
		this.statusBar.text = "$(error) ACP: Error"
		this.statusBar.tooltip = error.message || "ACP error"
		this.statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground")
		this.statusBar.show()
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose()
		}
		this.disposables.length = 0
	}
}
