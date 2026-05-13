import * as vscode from "vscode"
// import os from "os"
// import path from "path"
export interface AssistantUIConfig {
	enabled: boolean
	defaultCli: "csc" | "cs"
	port: number
	autoStartCsCloud: boolean
	baseUrl: string
	webUrl: string
	webviewMode: "static" | "iframe"
	debug: boolean
}

export function getAssistantUIConfig(): AssistantUIConfig {
	const config = vscode.workspace.getConfiguration("costrict.assistantUI")
	// csc
	return {
		defaultCli: config.get<"csc" | "cs">("defaultCli", "csc"),
		enabled: config.get<boolean>("enabled", true),
		port: config.get<number>("port", 45489),
		autoStartCsCloud: config.get<boolean>("autoStartCsCloud", true),
		baseUrl: config.get<string>("baseUrl", ""),
		webUrl: config.get<string>("webUrl", "http://127.0.0.1:3000"),
		webviewMode: config.get<"static" | "iframe">("webviewMode", "static"),
		debug: config.get<boolean>("debug", false),
	}
}
