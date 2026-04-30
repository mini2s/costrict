import * as vscode from "vscode"
import * as path from "path"
import { CsCloudService } from "./csCloudService"
import { getAssistantUIConfig, type AssistantUIConfig } from "./config"
import { getAssistantUIStaticHtml, getAssistantUIIframeHtml, getAssistantUILoadingHtml } from "./html"
import { CostrictAuthService } from "../../costrict/auth"
import { CostrictAuthConfig } from "../../costrict/auth/authConfig"

export function getAssistantUIWorkspaceDirectory() {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
}

export function shouldUseAssistantUIIframe(context: vscode.ExtensionContext, config: AssistantUIConfig) {
	return context.extensionMode === vscode.ExtensionMode.Development || config.webviewMode === "iframe"
}

export class AssistantUISidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "costrict.AssistantUISidebarProvider"

	private view?: vscode.WebviewView
	private csCloudService: CsCloudService
	private disposables: vscode.Disposable[] = []

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly outputChannel: vscode.OutputChannel,
	) {
		this.csCloudService = new CsCloudService(outputChannel)
		context.subscriptions.push(this.csCloudService)
	}

	async resolveWebviewView(webviewView: vscode.WebviewView) {
		this.view = webviewView

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.context.extensionUri],
		}

		// Handle messages from webview (e.g. openExternal from iframe)
		webviewView.webview.onDidReceiveMessage(
			(message: { type: string; url?: string; path?: string }) => {
				if (message.type === "openExternal" && message.url) {
					vscode.env.openExternal(vscode.Uri.parse(message.url))
				}
				if (message.type === "openFile" && message.path) {
					const workspaceDir = getAssistantUIWorkspaceDirectory()
					const filePath = path.isAbsolute(message.path)
						? message.path
						: path.join(workspaceDir || "", message.path)
					const uri = vscode.Uri.file(filePath)
					vscode.commands.executeCommand("vscode.open", uri)
				}
			},
			null,
			this.disposables,
		)

		const config = getAssistantUIConfig()
		if (!config.enabled) {
			webviewView.webview.html = this.getDisabledHtml()
			return
		}

		webviewView.webview.html = getAssistantUILoadingHtml(this.context, "正在启动 CoStrict Assistant UI...")

		try {
			const workspaceDirectory = getAssistantUIWorkspaceDirectory()
			const baseUrl = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: "Starting CoStrict Assistant UI",
					cancellable: false,
				},
				() => this.csCloudService.ensureStarted(),
			)
			const accessToken = await CostrictAuthService.getInstance().getCurrentAccessToken()
			const costrictWebUrl = CostrictAuthConfig.getInstance().getDefaultApiBaseUrl()

			if (shouldUseAssistantUIIframe(this.context, config)) {
				webviewView.webview.html = getAssistantUIIframeHtml(
					webviewView.webview,
					this.context,
					baseUrl,
					config.webUrl,
					workspaceDirectory,
					accessToken ?? undefined,
					config.debug,
					costrictWebUrl,
				)
			} else {
				webviewView.webview.html = getAssistantUIStaticHtml(
					webviewView.webview,
					this.context,
					baseUrl,
					workspaceDirectory,
					accessToken ?? undefined,
				)
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			this.outputChannel.appendLine(`[AssistantUI] ${message}`)
			webviewView.webview.html = this.getErrorHtml(message)
		}

		// Handle visibility changes
		webviewView.onDidChangeVisibility(
			() => {
				if (webviewView.visible) {
					// Optional: refresh cs-cloud health or re-fetch state
				}
			},
			null,
			this.disposables,
		)

		// Handle dispose
		webviewView.onDidDispose(
			() => {
				this.view = undefined
				this.dispose()
			},
			null,
			this.disposables,
		)
	}

	private getDisabledHtml(): string {
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); }
  </style>
</head>
<body>
  <p>CoStrict Assistant UI is disabled. Enable it via <code>costrict.assistantUI.enabled</code>.</p>
</body>
</html>`
	}

	private getErrorHtml(message: string): string {
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-errorForeground); }
    pre { background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 4px; }
  </style>
</head>
<body>
  <h3>Failed to load CoStrict Assistant UI</h3>
  <pre>${message.replace(/</g, "&lt;")}</pre>
</body>
</html>`
	}

	dispose() {
		while (this.disposables.length) {
			this.disposables.pop()?.dispose()
		}
	}
}
