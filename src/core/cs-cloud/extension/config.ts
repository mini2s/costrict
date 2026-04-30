import * as vscode from "vscode"

export interface AssistantUIConfig {
	enabled: boolean
	csCloudPath: string
	port: number
	autoStartCsCloud: boolean
	baseUrl: string
	webUrl: string
	webviewMode: "static" | "iframe"
	debug: boolean
}

export function getAssistantUIConfig(): AssistantUIConfig {
	const config = vscode.workspace.getConfiguration("costrict.assistantUI")

	return {
		enabled: config.get<boolean>("enabled", true),
		csCloudPath: config.get<string>("csCloudPath", "cs-cloud"),
		port: config.get<number>("port", 45489),
		autoStartCsCloud: config.get<boolean>("autoStartCsCloud", true),
		baseUrl: config.get<string>("baseUrl", ""),
		webUrl: config.get<string>("webUrl", "http://127.0.0.1:3000"),
		webviewMode: config.get<"static" | "iframe">("webviewMode", "static"),
		debug: config.get<boolean>("debug", false),
	}
}
