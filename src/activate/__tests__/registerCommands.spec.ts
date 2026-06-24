import type { Mock } from "vitest"
import * as vscode from "vscode"
import { ClineProvider } from "../../core/webview/ClineProvider"

import { getVisibleProviderOrLog } from "../registerCommands"

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

vi.mock("vscode", async () => {
	return {
		CodeActionKind: {
			QuickFix: { value: "quickfix" },
			RefactorRewrite: { value: "refactor.rewrite" },
		},
		FileType: {
			File: 1,
			Directory: 2,
		},
		Uri: {
			parse: vi.fn(),
		},
		window: {
			createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			createOutputChannel: () => ({
				appendLine: vi.fn(),
				show: vi.fn(),
			}),
			showInformationMessage: vi.fn(),
		},
		workspace: {
			workspaceFolders: [
				{
					uri: {
						fsPath: "/mock/workspace",
						path: "/mock/workspace",
					},
				},
			],
			fs: {
				stat: vi.fn(),
			},
			getWorkspaceFolder: vi.fn(),
			getConfiguration: vi.fn().mockReturnValue({
				get: vi.fn().mockReturnValue("classic"),
			}),
			createFileSystemWatcher: vi.fn().mockReturnValue({
				onDidCreate: vi.fn().mockReturnValue({ dispose: vi.fn() }),
				onDidChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
				onDidDelete: vi.fn().mockReturnValue({ dispose: vi.fn() }),
				dispose: vi.fn(),
			}),
		},
		RelativePattern: vi.fn().mockImplementation((base, pattern) => ({ base, pattern })),
		extensions: {
			getExtension: (extensionId: string) => ({
				extensionPath: "/mock/extension/path",
				extensionUri: { fsPath: "/mock/extension/path", path: "/mock/extension/path", scheme: "file" },
				packageJSON: {
					name: "costrict",
					publisher: "zgsm-ai",
					version: "2.0.27",
				},
			}),
			all: [],
		},
		env: {
			uriScheme: "vscode",
		},
	}
})

vi.mock("../../core/webview/ClineProvider")

describe("registerCommands", () => {
	let mockOutputChannel: vscode.OutputChannel

	beforeEach(() => {
		mockOutputChannel = {
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			hide: vi.fn(),
			name: "mock",
			replace: vi.fn(),
			show: vi.fn(),
			dispose: vi.fn(),
		}
		vi.clearAllMocks()
		vi.mocked(vscode.Uri.parse).mockReset()
		vi.mocked(vscode.workspace.getWorkspaceFolder).mockReset()
		vi.mocked(vscode.workspace.fs.stat).mockReset()
	})

	it("returns the visible provider if found", () => {
		const mockProvider = {} as ClineProvider
		;(ClineProvider.getVisibleInstance as Mock).mockReturnValue(mockProvider)

		const result = getVisibleProviderOrLog(mockOutputChannel)

		expect(result).toBe(mockProvider)
		expect(mockOutputChannel.appendLine).not.toHaveBeenCalled()
	})

	it("logs and returns undefined if no provider found", () => {
		;(ClineProvider.getVisibleInstance as Mock).mockReturnValue(undefined)

		const result = getVisibleProviderOrLog(mockOutputChannel)

		expect(result).toBeUndefined()
		expect(mockOutputChannel.appendLine).toHaveBeenCalledWith("Cannot find any visible CoStrict instances.")
	})
})
