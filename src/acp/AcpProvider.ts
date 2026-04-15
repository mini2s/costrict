import * as vscode from "vscode"
import { getUri } from "../core/webview/getUri"
import { getNonce } from "../core/webview/getNonce"
import { Package } from "../shared/package"
import { AgentManager } from "./core/AgentManager"
import { ConnectionManager } from "./core/ConnectionManager"
import { SessionManager } from "./core/SessionManager"
import { SessionUpdateHandler } from "./handlers/SessionUpdateHandler"
import { AcpMessageHandler } from "./AcpMessageHandler"
import { StatusBarManager } from "./ui/StatusBarManager"

export class AcpProvider implements vscode.WebviewViewProvider {
	public static readonly viewId = `${Package?.commandIDPrefix || "costrict"}.AcpProvider`

	private view?: vscode.WebviewView
	private disposables: vscode.Disposable[] = []

	private readonly sessionUpdateHandler: SessionUpdateHandler
	private readonly agentManager: AgentManager
	private readonly connectionManager: ConnectionManager
	private readonly sessionManager: SessionManager
	private readonly statusBarManager: StatusBarManager
	private readonly messageHandler: AcpMessageHandler

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly outputChannel: vscode.OutputChannel,
	) {
		this.sessionUpdateHandler = new SessionUpdateHandler()
		this.agentManager = new AgentManager()
		this.connectionManager = new ConnectionManager(this.sessionUpdateHandler)
		this.sessionManager = new SessionManager(
			this.agentManager,
			this.connectionManager,
			this.sessionUpdateHandler,
		)
		this.statusBarManager = new StatusBarManager(this.sessionManager)
		this.messageHandler = new AcpMessageHandler(
			this.sessionManager,
			this.sessionUpdateHandler,
			(message: unknown) => this.postMessageToWebview(message),
		)
	}

	async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
		this.view = webviewView

		const resourceRoots = [this.context.extensionUri]
		if (vscode.workspace.workspaceFolders) {
			resourceRoots.push(...vscode.workspace.workspaceFolders.map((folder) => folder.uri))
		}

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: resourceRoots,
		}

		webviewView.webview.html =
			this.context.extensionMode === vscode.ExtensionMode.Development
				? await this.getHMRHtmlContent(webviewView.webview)
				: await this.getHtmlContent(webviewView.webview)

		this.setWebviewMessageListener(webviewView.webview)

		webviewView.onDidDispose(
			() => {
				this.dispose()
			},
			null,
			this.disposables,
		)
	}

	private async getHtmlContent(webview: vscode.Webview): Promise<string> {
		const stylesUri = getUri(webview, this.context.extensionUri, [
			"webview-ui",
			"build",
			"assets",
			"index.css",
		])
		const scriptUri = getUri(webview, this.context.extensionUri, [
			"webview-ui",
			"build",
			"assets",
			"acp.js",
		])
		const codiconsUri = getUri(webview, this.context.extensionUri, [
			"assets",
			"codicons",
			"codicon.css",
		])
		const nonce = getNonce()

		return /*html*/ `
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
            <meta name="theme-color" content="#000000">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https: data:; script-src ${webview.cspSource} 'nonce-${nonce}';">
            <link rel="stylesheet" type="text/css" href="${stylesUri}">
            <link href="${codiconsUri}" rel="stylesheet" />
            <style>
              html, body, #root {
                height: 100%;
                min-height: 0;
                margin: 0;
              }

              body {
                overflow: hidden;
              }

              #root {
                display: flex;
                flex-direction: column;
                overflow: hidden;
              }
            </style>
            <title>ACP</title>
          </head>
          <body>
            <div id="root"></div>
            <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
          </body>
        </html>
      `
	}

	private async getHMRHtmlContent(webview: vscode.Webview): Promise<string> {
		return this.getHtmlContent(webview)
	}

	private setWebviewMessageListener(webview: vscode.Webview): void {
		webview.onDidReceiveMessage(
			(message: { type: string; [key: string]: unknown }) => {
				this.messageHandler.handleMessage(message)
			},
			undefined,
			this.disposables,
		)
	}

	public async connectToAgent(agentName?: string): Promise<void> {
		await this.messageHandler.connectToAgent(agentName)
	}

	public async disconnectAgent(): Promise<void> {
		await this.messageHandler.disconnectAgent()
	}

	public postMessageToWebview(message: unknown): void {
		this.view?.webview.postMessage(message)
	}

	public dispose(): void {
		this.messageHandler.dispose()
		this.statusBarManager.dispose()
		this.sessionManager.dispose()
		this.sessionUpdateHandler.dispose()
		for (const disposable of this.disposables) {
			disposable.dispose()
		}
		this.disposables = []
	}
}
