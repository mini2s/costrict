import { useState, useRef, useCallback, useEffect } from "react"
import { useAcpState } from "../AcpStateContext"
import { AutosizeTextarea, type AutosizeTextAreaRef } from "@src/components/ui/autosize-textarea"

const AcpInputArea = () => {
	const { state, sendPrompt, cancelTurn } = useAcpState()
	const [input, setInput] = useState("")
	const textareaRef = useRef<AutosizeTextAreaRef>(null)

	const handleSend = useCallback(() => {
		if (!input.trim()) return
		sendPrompt(input)
		setInput("")
		// Reset textarea height after sending
		setTimeout(() => {
			if (textareaRef.current?.textArea) {
				textareaRef.current.textArea.style.height = "auto"
			}
		}, 0)
	}, [input, sendPrompt])

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault()
				if (state.isLoading) {
					cancelTurn()
				} else {
					handleSend()
				}
			}
		},
		[state.isLoading, cancelTurn, handleSend],
	)

	// Auto-focus on connect
	useEffect(() => {
		if (state.connected) {
			textareaRef.current?.textArea?.focus()
		}
	}, [state.connected])

	const canSend = state.connected && !state.connecting && input.trim().length > 0

	return (
		<div className="border-t border-vscode-editorWidget-border px-3 py-2">
			<div className="flex items-end gap-2">
				<div className="flex-1 min-w-0">
					<AutosizeTextarea
						ref={textareaRef}
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder={state.connected ? "Type a message... (Enter to send, Shift+Enter for new line)" : "Connect to an agent first..."}
						disabled={!state.connected || state.connecting}
						minHeight={32}
						maxHeight={160}
						className="text-sm leading-normal py-1.5 px-2.5"
					/>
				</div>
				<button
					onClick={() => (state.isLoading ? cancelTurn() : handleSend())}
					disabled={state.isLoading ? false : !canSend}
					className={`shrink-0 px-3 py-1.5 text-sm rounded flex items-center gap-1.5 transition-colors ${
						state.isLoading
							? "bg-vscode-inputValidation-errorBackground text-vscode-errorForeground border border-vscode-inputValidation-errorBorder hover:opacity-90"
							: canSend
								? "bg-vscode-button-background text-vscode-button-foreground hover:bg-vscode-button-hoverBackground"
								: "bg-vscode-button-secondaryBackground text-vscode-button-secondaryForeground opacity-50 cursor-not-allowed"
					}`}
					title={state.isLoading ? "Stop generation" : "Send message"}
				>
					{state.isLoading ? (
						<>
							<span className="codicon codicon-debug-stop text-xs" />
							<span>Stop</span>
						</>
					) : (
						<>
							<span className="codicon codicon-send text-xs" />
							<span>Send</span>
						</>
					)}
				</button>
			</div>
		</div>
	)
}

export default AcpInputArea
