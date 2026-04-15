import { useRef, useEffect } from "react"
import { useAcpState } from "./AcpStateContext"
import AcpMessageItem from "./components/AcpMessageItem"
import AcpInputArea from "./components/AcpInputArea"
import { AcpModeSelector, AcpModelSelector } from "./components/AcpModeSelector"

const AcpChatView = () => {
	const { state, connect, disconnect, clearError } = useAcpState()
	const messagesEndRef = useRef<HTMLDivElement>(null)

	// Auto-scroll on new messages
	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
	}, [state.messages, state.isLoading])

	return (
		<div className="flex h-full min-h-0 flex-col overflow-hidden">
			{/* Header */}
			<div className="flex items-center justify-between px-3 py-1.5 border-b border-vscode-editorWidget-border shrink-0">
				<div className="flex items-center gap-2 min-w-0">
					<span className="codicon codicon-symbol-method text-vscode-editor-foreground" />
					<span className="text-sm font-medium text-vscode-editor-foreground">ACP</span>
					{state.connecting && (
						<span className="flex items-center gap-1 text-xs text-vscode-progressBar-background">
							<span className="inline-block w-2 h-2 border-2 border-vscode-progressBar-background border-t-transparent rounded-full animate-spin" />
							Connecting...
						</span>
					)}
					{state.connected && (
						<span className="flex items-center gap-1 text-xs text-vscode-terminal-ansiGreen">
							<span className="inline-block w-1.5 h-1.5 rounded-full bg-vscode-terminal-ansiGreen" />
							{state.agentName}
						</span>
					)}
				</div>
				<div className="flex items-center gap-1">
					{!state.connected && !state.connecting && (
						<button
							onClick={() => connect()}
							className="px-2 py-0.5 text-xs bg-vscode-button-background text-vscode-button-foreground rounded hover:bg-vscode-button-hoverBackground transition-colors flex items-center gap-1"
						>
							<span className="codicon codicon-plug text-[10px]" />
							Connect
						</button>
					)}
					{state.connected && (
						<button
							onClick={disconnect}
							className="px-2 py-0.5 text-xs text-vscode-errorForeground hover:bg-vscode-toolbar-hoverBackground rounded transition-colors flex items-center gap-1"
						>
							<span className="codicon codicon-debug-disconnect text-[10px]" />
							Disconnect
						</button>
					)}
				</div>
			</div>

			{/* Error banner */}
			{state.error && (
				<div className="flex items-center gap-2 px-3 py-1.5 text-xs text-vscode-errorForeground bg-vscode-inputValidation-errorBackground border-b border-vscode-inputValidation-errorBorder shrink-0">
					<span className="codicon codicon-error text-xs" />
					<span className="flex-1 min-w-0 truncate">{state.error}</span>
					<button
						onClick={clearError}
						className="shrink-0 hover:bg-vscode-toolbar-hoverBackground rounded p-0.5"
						title="Dismiss"
					>
						<span className="codicon codicon-close text-xs" />
					</button>
				</div>
			)}

			{/* Messages area */}
			<div className="flex-1 min-h-0 overflow-y-auto px-3 py-2">
				{!state.connected && !state.connecting && state.messages.length === 0 && (
					<div className="flex items-center justify-center h-full text-vscode-descriptionForeground">
						<div className="text-center max-w-[240px]">
							<div className="text-3xl mb-3 opacity-30">
								<span className="codicon codicon-hubot" />
							</div>
							<p className="text-sm font-medium mb-1 text-vscode-editor-foreground">ACP Chat</p>
							<p className="text-xs opacity-70">
								Connect to an ACP agent to start chatting. Configure agents in Settings &gt; CoStrict ACP &gt; Agents.
							</p>
						</div>
					</div>
				)}

				{state.messages.map((msg, i) => (
					<AcpMessageItem key={`AcpMessageItem-${msg.id}-${i}`} message={msg} />
				))}

				{/* Global thinking indicator (when no assistant message yet) */}
				{state.isLoading &&
					!state.messages.some((m) => m.role === "assistant" && (m.content || m.thinking)) && (
						<div className="flex items-center gap-2 mb-3 text-xs text-vscode-descriptionForeground">
							<span className="inline-block w-3 h-3 border-2 border-vscode-foreground border-t-transparent rounded-full animate-spin opacity-60" />
							Thinking...
						</div>
					)}

				<div ref={messagesEndRef} />
			</div>

			{/* Bottom bar: selectors + input */}
			{(state.connected || state.connecting) && (
				<>
					{/* Mode/Model selector bar */}
					{state.connected && (state.modes || state.models) && (
						<div className="flex items-center gap-1 px-3 py-0.5 border-t border-vscode-editorWidget-border shrink-0">
							<AcpModeSelector />
							<AcpModelSelector />
						</div>
					)}
					<AcpInputArea />
				</>
			)}
		</div>
	)
}

export default AcpChatView
