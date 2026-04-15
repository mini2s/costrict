import { memo } from "react"
import MarkdownBlock from "@src/components/common/MarkdownBlock"
import { useAcpState, type AcpMessage, type AcpToolCall, getToolKindIcon } from "../AcpStateContext"
import { ProgressIndicator } from "@src/components/chat/ProgressIndicator"

function toDisplayText(value: unknown, fallback = ""): string {
	if (typeof value === "string") {
		return value
	}

	if (typeof value === "number" || typeof value === "boolean") {
		return String(value)
	}

	if (value && typeof value === "object") {
		const candidate = value as Record<string, unknown>
		const namedValue = candidate.text ?? candidate.title ?? candidate.name ?? candidate.label ?? candidate.id
		if (typeof namedValue === "string") {
			return namedValue
		}
	}

	return fallback
}

// ── Thinking Block ────────────────────────────────────────────────

const AcpThinkingBlock = memo(({ thinking, isStreaming }: { thinking: unknown; isStreaming?: boolean }) => {
	const displayThinking = toDisplayText(thinking)
	console.log("AcpThinkingBlock", thinking, isStreaming);
	
	if (!displayThinking) return null

	return (
		<details className="mb-2 rounded border border-vscode-panel-border bg-vscode-editor-inactiveSelectionBackground">
			<summary className="cursor-pointer px-2 py-1 text-xs text-vscode-descriptionForeground select-none flex items-center gap-1.5">
				{isStreaming && <ProgressIndicator />}
				<span className="codicon codicon-lightbulb text-xs" />
				Thinking
			</summary>
			<div className="px-2 pb-2 text-xs text-vscode-descriptionForeground opacity-80 whitespace-pre-wrap break-words">
				{displayThinking}
			</div>
		</details>
	)
})
AcpThinkingBlock.displayName = "AcpThinkingBlock"

// ── Tool Call Item ────────────────────────────────────────────────

const AcpToolCallItem = memo(({ toolCall }: { toolCall: AcpToolCall }) => {
	const iconClass = getToolKindIcon(toolCall.kind)
	const title = toDisplayText(toolCall.title, "Tool Call")
	// const rawInput = toDisplayText(toolCall.rawInput)
	// const rawOutput = toDisplayText(toolCall.rawOutput)

	const statusIcon =
		toolCall.status === "completed" ? (
			<span className="codicon codicon-check text-vscode-terminal-ansiGreen text-xs" />
		) : toolCall.status === "failed" ? (
			<span className="codicon codicon-error text-vscode-terminal-ansiRed text-xs" />
		) : toolCall.status === "running" ? (
			<ProgressIndicator />
		) : (
			<span className="codicon codicon-clock text-vscode-descriptionForeground text-xs" />
		)

	return (
		<details className="group rounded border border-vscode-panel-border overflow-hidden">
			<summary className="cursor-pointer flex items-center gap-1.5 px-2 py-1 text-xs select-none hover:bg-vscode-list-hoverBackground">
				{statusIcon}
				<span className={`codicon ${iconClass} text-xs text-vscode-descriptionForeground`} />
				<span className="truncate flex-1">{title}</span>
			</summary>
			{/* <div className="border-t border-vscode-panel-border px-2 py-1.5 text-xs">
				{rawInput && (
					<div className="mb-1">
						<div className="text-vscode-descriptionForeground mb-0.5">Input:</div>
						<pre className="whitespace-pre-wrap break-words text-vscode-editor-foreground opacity-90 max-h-40 overflow-y-auto">
							{rawInput}
						</pre>
					</div>
				)}
				{rawOutput && (
					<div>
						<div className="text-vscode-descriptionForeground mb-0.5">Output:</div>
						<pre className="whitespace-pre-wrap break-words text-vscode-editor-foreground opacity-90 max-h-40 overflow-y-auto">
							{rawOutput}
						</pre>
					</div>
				)}
				{toolCall.content && toolCall.content.length > 0 && (
					<div>
						{toolCall.content.map((c, i) => {
							if (c.type === "content" && "text" in c.content && c.content.type === "text") {
								const markdown = toDisplayText(c.content.text)
								return markdown ? <MarkdownBlock key={i} markdown={markdown} /> : null
							}
							if (c.type === "diff" && c.content.type === "diff") {
								const diffText = toDisplayText(c.content.text)
								return diffText ? <MarkdownBlock key={i} markdown={`
\`\`\`diff
${diffText}
\`\`\`
`} /> : null
							}
							return null
						})}
					</div>
				)}
			</div> */}
		</details>
	)
})
AcpToolCallItem.displayName = "AcpToolCallItem"

// ── Message Item ──────────────────────────────────────────────────

const AcpMessageItem = memo(({ message }: { message: AcpMessage }) => {
	const { state } = useAcpState()
	const isUser = message.role === "user"
	const roleLabel = isUser ? "You" : toDisplayText(state.agentName, "Assistant")
	const userContent = toDisplayText(message.content)
	const assistantContent = toDisplayText(message.content)
	const thinkingContent = toDisplayText(message.thinking)

	return (
		<div className={`mb-4 ${isUser ? "ml-8" : ""}`}>
			{/* Role label */}
			<div className="flex items-center gap-1.5 mb-1">
				{isUser ? (
					<span className="codicon codicon-account text-xs text-vscode-descriptionForeground" />
				) : (
					<span className="codicon codicon-hubot text-xs text-vscode-descriptionForeground" />
				)}
				<span className="text-xs text-vscode-descriptionForeground font-medium">{roleLabel}</span>
			</div>

			{/* Thinking block */}
			{!isUser && thinkingContent && (
				<AcpThinkingBlock thinking={thinkingContent} isStreaming={message.isStreaming} />
			)}

			{/* Content */}
			{isUser ? (
				<div className="bg-vscode-input-background rounded-lg p-2.5 text-sm whitespace-pre-wrap break-words">
					{userContent}
				</div>
			) : assistantContent ? (
				<div className="acp-message-content">
					<MarkdownBlock markdown={assistantContent} />
					{message.isStreaming && (
						<span className="inline-block w-1.5 h-4 ml-0.5 bg-vscode-foreground animate-pulse align-text-bottom" />
					)}
				</div>
			) : message.isStreaming && !thinkingContent ? (
				<div className="flex items-center gap-2 text-xs text-vscode-descriptionForeground">
					<ProgressIndicator />
					<span>Thinking...</span>
				</div>
			) : null}

			{/* Tool calls inline */}
			{/* {!isUser && message.toolCalls && message.toolCalls.length > 0 && (
				<div className="mt-2 flex flex-col gap-1">
					{message.toolCalls.map((tc, i) => (
						<AcpToolCallItem key={`AcpToolCallItem-${tc.toolCallId}-${i}`} toolCall={tc} />
					))}
				</div>
			)} */}
		</div>
	)
})
AcpMessageItem.displayName = "AcpMessageItem"

export default AcpMessageItem
