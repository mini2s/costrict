import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { describe, expect, it, vi } from "vitest"

vi.mock("vscode", () => ({
	ExtensionMode: {
		Production: 1,
		Development: 2,
		Test: 3,
	},
	ProgressLocation: {
		Notification: 15,
	},
	Uri: {
		file: (fsPath: string) => ({ fsPath }),
	},
	window: {
		withProgress: vi.fn(),
		activeColorTheme: { kind: 2 },
	},
	workspace: {
		workspaceFolders: [],
	},
	env: {
		uriScheme: "vscode",
	},
	extensions: {
		getExtension: () => ({ extensionUri: { fsPath: "/tmp/test-extension" } }),
	},
}))

import * as vscode from "vscode"
import { shouldUseAssistantUIIframe } from "../core/cs-cloud/extension/sidebarProvider"
import {
	addNonceToScriptTags,
	injectIntoHead,
	buildAssistantUIFrameUrl,
	getAssistantUIStaticHtml,
	getAssistantUIStaticOutDir,
	rewriteStaticAssetUrls,
	rewriteWebpackPublicPath,
} from "../core/cs-cloud/extension/html"

describe("AssistantUIPanel", () => {
	const baseAssistantUIConfig = {
		enabled: true,
		csCloudPath: "cs-cloud",
		port: 45489,
		autoStartCsCloud: true,
		baseUrl: "",
		webUrl: "http://127.0.0.1:3000",
		debug: false,
	} as const

	it("uses the iframe dev server while the extension runs in development mode", () => {
		expect(
			shouldUseAssistantUIIframe({ extensionMode: vscode.ExtensionMode.Development } as never, {
				...baseAssistantUIConfig,
				webviewMode: "static",
			}),
		).toBe(true)
	})

	it("honors static webview mode outside extension development", () => {
		expect(
			shouldUseAssistantUIIframe({ extensionMode: vscode.ExtensionMode.Production } as never, {
				...baseAssistantUIConfig,
				webviewMode: "static",
			}),
		).toBe(false)
	})

	it("honors explicit iframe webview mode outside extension development", () => {
		expect(
			shouldUseAssistantUIIframe({ extensionMode: vscode.ExtensionMode.Production } as never, {
				...baseAssistantUIConfig,
				webviewMode: "iframe",
			}),
		).toBe(true)
	})

	it("adds csCloudBaseUrl to the iframe URL without debug by default", () => {
		const frameUrl = buildAssistantUIFrameUrl("http://127.0.0.1:3000", "http://127.0.0.1:45489/api/v1")

		const url = new URL(frameUrl)
		expect(url.origin).toBe("http://127.0.0.1:3000")
		expect(url.searchParams.get("csCloudBaseUrl")).toBe("http://127.0.0.1:45489/api/v1")
		expect(url.searchParams.get("assistantUIDebug")).toBeNull()
	})

	it("preserves existing iframe URL query parameters", () => {
		const frameUrl = buildAssistantUIFrameUrl("http://127.0.0.1:3000?foo=bar", "http://127.0.0.1:45489/api/v1")

		const url = new URL(frameUrl)
		expect(url.searchParams.get("foo")).toBe("bar")
		expect(url.searchParams.get("csCloudBaseUrl")).toBe("http://127.0.0.1:45489/api/v1")
		expect(url.searchParams.get("assistantUIDebug")).toBeNull()
	})

	it("adds workspace directory to the iframe URL", () => {
		const frameUrl = buildAssistantUIFrameUrl(
			"http://127.0.0.1:3000",
			"http://127.0.0.1:45489/api/v1",
			"/home/mini/workspace/project one",
		)

		const url = new URL(frameUrl)
		expect(url.searchParams.get("csCloudWorkspaceDirectory")).toBe("/home/mini/workspace/project one")
	})

	it("adds assistantUIDebug only when debug mode is enabled", () => {
		const frameUrl = buildAssistantUIFrameUrl(
			"http://127.0.0.1:3000",
			"http://127.0.0.1:45489/api/v1",
			undefined,
			true,
		)

		const url = new URL(frameUrl)
		expect(url.searchParams.get("assistantUIDebug")).toBe("1")
	})

	it("adds accessToken to the iframe URL when provided", () => {
		const frameUrl = buildAssistantUIFrameUrl(
			"http://127.0.0.1:3000",
			"http://127.0.0.1:45489/api/v1",
			undefined,
			false,
			"test-access-token-123",
		)

		const url = new URL(frameUrl)
		expect(url.searchParams.get("csCloudAccessToken")).toBe("test-access-token-123")
	})

	it("omits csCloudAccessToken from the iframe URL when not provided", () => {
		const frameUrl = buildAssistantUIFrameUrl("http://127.0.0.1:3000", "http://127.0.0.1:45489/api/v1")

		const url = new URL(frameUrl)
		expect(url.searchParams.get("csCloudAccessToken")).toBeNull()
	})

	it("rewrites webpack runtime publicPath for dynamic chunks", () => {
		const webview = {
			asWebviewUri: (uri: { fsPath: string }) => ({
				toString: () => `vscode-resource:${uri.fsPath}`,
			}),
		}
		const html = '<script>(()=>{i.p="/_next/",i.f.j=function(){}})()</script>'
		const rewritten = rewriteWebpackPublicPath(html, webview as never, "/extension/assets/assistant-ui/out")

		expect(rewritten).toContain('i.p="vscode-resource:/extension/assets/assistant-ui/out/_next/"')
		expect(rewritten).not.toContain('i.p="/_next/"')
	})

	it("rewrites patched relative webpack runtime publicPath for packaged static exports", () => {
		const webview = {
			asWebviewUri: (uri: { fsPath: string }) => ({
				toString: () => `vscode-resource:${uri.fsPath}`,
			}),
		}
		const html = '<script>(()=>{i.p="_next/",i.f.j=function(){}})()</script>'
		const rewritten = rewriteWebpackPublicPath(html, webview as never, "/extension/dist/assets/assistant-ui/out")

		expect(rewritten).toContain('i.p="vscode-resource:/extension/dist/assets/assistant-ui/out/_next/"')
		expect(rewritten).not.toContain('i.p="_next/"')
	})

	it("prefers packaged dist assistant-ui static export when source assets are absent", () => {
		const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-ui-static-"))
		try {
			const distOutDir = path.join(extensionRoot, "dist", "assets", "assistant-ui", "out")
			fs.mkdirSync(distOutDir, { recursive: true })
			fs.writeFileSync(path.join(distOutDir, "index.html"), "<!DOCTYPE html>")

			const outDir = getAssistantUIStaticOutDir({ extensionUri: { fsPath: extensionRoot } } as never)

			expect(outDir).toBe(distOutDir)
		} finally {
			fs.rmSync(extensionRoot, { recursive: true, force: true })
		}
	})

	it("rewrites Next and public static asset href/src attributes and leaves inline scripts untouched", () => {
		const webview = {
			asWebviewUri: (uri: { fsPath: string }) => ({
				toString: () => `vscode-resource:${uri.fsPath}`,
			}),
		}
		const html =
			'<link rel="preload" as="image" href="/costrict/logo.png"><link href="/_next/static/app.css"><script src="/_next/static/app.js"></script><script>self.__next_f.push(["/_next/static/in-rsc.js"])</script>'
		const rewritten = rewriteStaticAssetUrls(html, webview as never, "/extension/assets/assistant-ui/out")

		expect(rewritten).toContain('href="vscode-resource:/extension/assets/assistant-ui/out/costrict/logo.png"')
		expect(rewritten).toContain('href="vscode-resource:/extension/assets/assistant-ui/out/_next/static/app.css"')
		expect(rewritten).toContain('src="vscode-resource:/extension/assets/assistant-ui/out/_next/static/app.js"')
		expect(rewritten).toContain(
			'self.__next_f.push(["vscode-resource:/extension/assets/assistant-ui/out/_next/static/in-rsc.js"])',
		)
	})

	it("generates static HTML with connect-src CSP and rewritten public logo asset", () => {
		const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-ui-html-"))
		try {
			const outDir = path.join(extensionRoot, "assets", "assistant-ui", "out")
			fs.mkdirSync(path.join(outDir, "costrict"), { recursive: true })
			fs.writeFileSync(
				path.join(outDir, "index.html"),
				'<!DOCTYPE html><html><head><link rel="preload" as="image" href="/costrict/logo.png"><script src="/_next/static/app.js"></script></head><body></body></html>',
			)
			fs.writeFileSync(path.join(outDir, "costrict", "logo.png"), "logo")

			const webview = {
				cspSource: "vscode-webview://test-csp-source",
				asWebviewUri: (uri: { fsPath: string }) => ({
					toString: () => `vscode-resource:${uri.fsPath}`,
				}),
			}

			const html = getAssistantUIStaticHtml(
				webview as never,
				{ extensionUri: { fsPath: extensionRoot } } as never,
				"http://127.0.0.1:45489/api/v1",
				"/workspace",
			)

			expect(html).toContain("connect-src http://127.0.0.1:45489")
			expect(html).toContain(`href="vscode-resource:${outDir}/costrict/logo.png"`)
			expect(html).not.toContain('href="/costrict/logo.png"')
		} finally {
			fs.rmSync(extensionRoot, { recursive: true, force: true })
		}
	})

	it("adds nonce to script tags for static Webview CSP", () => {
		const html =
			'<script src="app.js"></script><script>self.__next_f=[]</script><script nonce="existing">ok()</script>'
		const rewritten = addNonceToScriptTags(html, "abc123")

		expect(rewritten).toContain('<script nonce="abc123" src="app.js"></script>')
		expect(rewritten).toContain('<script nonce="abc123">self.__next_f=[]</script>')
		expect(rewritten).toContain('<script nonce="existing">ok()</script>')
	})

	it("injects content into the HTML head", () => {
		expect(injectIntoHead("<html><head><title>x</title></head></html>", "<script></script>")).toBe(
			"<html><head>\n<script></script><title>x</title></head></html>",
		)
	})
})
