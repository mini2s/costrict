import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from "react"
import { vscode } from "@src/utils/vscode"

// ── ACP SDK type mirrors (frontend-safe) ──────────────────────────

export interface AcpSessionMode {
	id: string
	name: string
	description?: string | null
}

export interface AcpSessionModeState {
	currentModeId: string
	availableModes: AcpSessionMode[]
}

export interface AcpModelInfo {
	modelId: string
	name: string
	description?: string | null
}

export interface AcpSessionModelState {
	currentModelId: string
	availableModels: AcpModelInfo[]
}

// ── Content types ─────────────────────────────────────────────────

export interface AcpTextContent {
	type: "text"
	text: string
}

export interface AcpImageContent {
	type: "image"
	data: string
	mimeType: string
}

export interface AcpResourceContent {
	type: "resource"
	uri: string
	mimeType?: string
	text?: string
}

export type AcpContentBlock = AcpTextContent | AcpImageContent | AcpResourceContent

// ── Tool call types ───────────────────────────────────────────────

export type AcpToolKind = "read" | "edit" | "execute" | "search" | "other"

export interface AcpToolCallContent {
	type: "content" | "diff"
	content: AcpContentBlock | { type: "diff"; text: string; path?: string }
}

export interface AcpToolCall {
	toolCallId: string
	title: string
	kind?: AcpToolKind
	status: "pending" | "running" | "completed" | "failed"
	content?: AcpToolCallContent[]
	rawInput?: string
	rawOutput?: string
}

// ── Message types ─────────────────────────────────────────────────

export interface AcpMessage {
	id: string
	role: "user" | "assistant"
	content: string
	timestamp: number
	/** Whether this message is still being streamed */
	isStreaming?: boolean
	/** Thinking/reasoning content (from agent_thought_chunk) */
	thinking?: string
	/** Tool calls associated with this assistant message */
	toolCalls?: AcpToolCall[]
}

// ── State ─────────────────────────────────────────────────────────

export interface AcpState {
	connected: boolean
	connecting: boolean
	agentName: string | null
	sessionId: string | null
	messages: AcpMessage[]
	toolCalls: AcpToolCall[]
	modes: AcpSessionModeState | null
	models: AcpSessionModelState | null
	isLoading: boolean
	error: string | null
}

interface AcpStateContextType {
	state: AcpState
	setState: React.Dispatch<React.SetStateAction<AcpState>>
	connect: (agentName?: string) => void
	disconnect: () => void
	sendPrompt: (text: string) => void
	cancelTurn: () => void
	setMode: (modeId: string) => void
	setModel: (modelId: string) => void
	clearError: () => void
}

const defaultState: AcpState = {
	connected: false,
	connecting: false,
	agentName: null,
	sessionId: null,
	messages: [],
	toolCalls: [],
	modes: null,
	models: null,
	isLoading: false,
	error: null,
}

const AcpStateContext = createContext<AcpStateContextType | undefined>(undefined)

function postAcpMessage(message: { type: string; [key: string]: unknown }) {
	vscode.postMessage(message as any)
}

function normalizeAgentName(value: unknown): string | null {
	if (typeof value === "string") {
		return value
	}

	if (!value || typeof value !== "object") {
		return null
	}

	const candidate = value as Record<string, unknown>
	const namedValue = candidate.displayName ?? candidate.title ?? candidate.name ?? candidate.label ?? candidate.id
	return typeof namedValue === "string" ? namedValue : null
}

function normalizeDisplayText(value: unknown, fallback = ""): string {
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

function normalizeToolCallContent(content: unknown): AcpToolCallContent[] | undefined {
	if (!Array.isArray(content)) {
		return undefined
	}

	const normalized = content.flatMap((item): AcpToolCallContent[] => {
		if (!isRecord(item) || (item.type !== "content" && item.type !== "diff")) {
			return []
		}

		if (item.type === "diff") {
			return [
				{
					type: "diff",
					content: {
						type: "diff",
						text: normalizeDisplayText(item.content, ""),
						path: typeof item.path === "string" ? item.path : undefined,
					},
				},
			]
		}

		const block = item.content
		if (!isRecord(block) || typeof block.type !== "string") {
			return []
		}

		switch (block.type) {
			case "text":
				return [
					{
						type: "content",
						content: {
							type: "text",
							text: normalizeDisplayText(block.text, ""),
						},
					},
				]
			case "image":
				return [
					{
						type: "content",
						content: {
							type: "image",
							data: normalizeDisplayText(block.data, ""),
							mimeType: normalizeDisplayText(block.mimeType, "application/octet-stream"),
						},
					},
				]
			case "resource":
				return [
					{
						type: "content",
						content: {
							type: "resource",
							uri: normalizeDisplayText(block.uri, ""),
							mimeType: normalizeDisplayText(block.mimeType, "") || undefined,
							text: normalizeDisplayText(block.text, "") || undefined,
						},
					},
				]
			default:
				return []
		}
	})

	return normalized.length > 0 ? normalized : undefined
}

function isRecord(value: unknown): value is Record<string, any> {
	return value !== null && typeof value === "object"
}

/** Icon mapping for tool kinds */
export function getToolKindIcon(kind?: AcpToolKind): string {
	switch (kind) {
		case "read":
			return "codicon-eye"
		case "edit":
			return "codicon-edit"
		case "execute":
			return "codicon-terminal"
		case "search":
			return "codicon-search"
		default:
			return "codicon-symbol-method"
	}
}

export const AcpStateContextProvider = ({ children }: { children: ReactNode }) => {
	const [state, setState] = useState<AcpState>(defaultState)
	const currentAssistantMsgIdRef = useRef<string | null>(null)

	useEffect(() => {
		const handler = (event: MessageEvent) => {
			const msg = event.data
			if (!isRecord(msg) || typeof msg.type !== "string") {
				return
			}

			switch (msg.type) {
				case "acpState":
					setState((prev) => ({
						...prev,
						connected: Boolean(msg.connected),
						agentName: normalizeAgentName(msg.agentName),
						sessionId: typeof msg.sessionId === "string" ? msg.sessionId : null,
						modes: (msg.modes as AcpSessionModeState | null) ?? null,
						models: (msg.models as AcpSessionModelState | null) ?? null,
						connecting: false,
						error: null,
					}))
					break

				case "acpConnected":
					setState((prev) => ({
						...prev,
						connected: true,
						agentName: normalizeAgentName(msg.agentName),
						connecting: false,
					}))
					break

				case "acpConnecting":
					setState((prev) => ({
						...prev,
						connecting: true,
						agentName: normalizeAgentName(msg.agentName) ?? prev.agentName,
					}))
					break

				case "acpDisconnected":
					currentAssistantMsgIdRef.current = null
					setState((prev) => ({
						...prev,
						connected: false,
						agentName: null,
						sessionId: null,
						messages: [],
						toolCalls: [],
						modes: null,
						models: null,
						isLoading: false,
					}))
					break

				case "acpError":
					setState((prev) => ({
						...prev,
						error: typeof msg.error === "string" ? msg.error : "Unknown ACP error",
						connecting: false,
						isLoading: false,
					}))
					break

				case "acpPromptStart":
					currentAssistantMsgIdRef.current = null
					setState((prev) => ({ ...prev, isLoading: true }))
					break

				case "acpPromptEnd":
					setState((prev) => {
						const messages = prev.messages.map((m) =>
							m.role === "assistant" && m.isStreaming ? { ...m, isStreaming: false } : m,
						)
						return { ...prev, messages, isLoading: false }
					})
					currentAssistantMsgIdRef.current = null
					break

				case "acpSessionUpdate":
					handleSessionUpdate(msg.update)
					break

				case "acpModesUpdate":
					setState((prev) => ({ ...prev, modes: (msg.modes as AcpSessionModeState | null) ?? null }))
					break

				case "acpModelsUpdate":
					setState((prev) => ({ ...prev, models: (msg.models as AcpSessionModelState | null) ?? null }))
					break
			}
		}

		window.addEventListener("message", handler)
		return () => window.removeEventListener("message", handler)
	}, [])

	const handleSessionUpdate = useCallback((update: unknown) => {
		if (!isRecord(update)) return
		const type = update.sessionUpdate

		switch (type) {
			case "agent_message_chunk": {
				const content = update.content
				if (isRecord(content) && content.type === "text") {
					const text = normalizeDisplayText(content.text)
					if (!text) break
					setState((prev) => {
						const messages = [...prev.messages]
						const lastMsg = messages[messages.length - 1]
						if (lastMsg && lastMsg.role === "assistant" && lastMsg.id === currentAssistantMsgIdRef.current) {
							messages[messages.length - 1] = {
								...lastMsg,
								content: lastMsg.content + text,
							}
						} else {
							const newId = `assistant-${Date.now()}`
							currentAssistantMsgIdRef.current = newId
							messages.push({
								id: newId,
								role: "assistant",
								content: text,
								timestamp: Date.now(),
								isStreaming: true,
							})
						}
						return { ...prev, messages }
					})
				}
				break
			}

			case "agent_thought_chunk": {
				const content = update.content
				if (isRecord(content) && content.type === "text") {
					const text = normalizeDisplayText(content.text)
					if (!text) break
					setState((prev) => {
						const messages = [...prev.messages]
						const lastMsg = messages[messages.length - 1]
						if (lastMsg && lastMsg.role === "assistant" && lastMsg.id === currentAssistantMsgIdRef.current) {
							messages[messages.length - 1] = {
								...lastMsg,
								thinking: (lastMsg.thinking || "") + text,
							}
						} else {
							const newId = `assistant-${Date.now()}`
							currentAssistantMsgIdRef.current = newId
							messages.push({
								id: newId,
								role: "assistant",
								content: "",
								thinking: text,
								timestamp: Date.now(),
								isStreaming: true,
							})
						}
						return { ...prev, messages }
					})
				}
				break
			}

			case "tool_call": {
				const newToolCall: AcpToolCall = {
					toolCallId: normalizeDisplayText(update.toolCallId, "unknown"),
					title: normalizeDisplayText(update.title, "Tool Call"),
					kind: update.kind as AcpToolKind | undefined,
					status: (update.status as AcpToolCall["status"]) || "pending",
					content: normalizeToolCallContent(update.content),
					rawInput: normalizeDisplayText(update.rawInput) || undefined,
				}
				setState((prev) => {
					const messages = prev.messages.map((m) => {
						if (m.role === "assistant" && m.id === currentAssistantMsgIdRef.current) {
							return { ...m, toolCalls: [...(m.toolCalls || []), newToolCall] }
						}
						return m
					})
					return {
						...prev,
						messages,
						toolCalls: [...prev.toolCalls, newToolCall],
					}
				})
				break
			}

			case "tool_call_update": {
				setState((prev) => ({
					...prev,
					toolCalls: prev.toolCalls.map((tc) =>
						tc.toolCallId === normalizeDisplayText(update.toolCallId, tc.toolCallId)
							? {
									...tc,
									status: (update.status as AcpToolCall["status"]) || tc.status,
									title: normalizeDisplayText(update.title, tc.title),
									kind: (update.kind as AcpToolKind | undefined) || tc.kind,
									content: normalizeToolCallContent(update.content) ?? tc.content,
									rawOutput: normalizeDisplayText(update.rawOutput, tc.rawOutput ?? "") || tc.rawOutput,
								}
							: tc,
					),
					messages: prev.messages.map((m) => {
						if (m.role === "assistant" && m.toolCalls) {
							return {
								...m,
								toolCalls: m.toolCalls.map((tc) =>
									tc.toolCallId === normalizeDisplayText(update.toolCallId, tc.toolCallId)
										? {
												...tc,
												status: (update.status as AcpToolCall["status"]) || tc.status,
												title: normalizeDisplayText(update.title, tc.title),
												kind: (update.kind as AcpToolKind | undefined) || tc.kind,
												content: normalizeToolCallContent(update.content) ?? tc.content,
												rawOutput:
													normalizeDisplayText(update.rawOutput, tc.rawOutput ?? "") || tc.rawOutput,
											}
										: tc,
								),
							}
						}
						return m
					}),
				}))
				break
			}
		}
	}, [])

	const connect = useCallback((agentName?: string) => {
		postAcpMessage({ type: "acpConnect", agentName })
	}, [])

	const disconnect = useCallback(() => {
		postAcpMessage({ type: "acpDisconnect" })
	}, [])

	const sendPrompt = useCallback((text: string) => {
		if (!text.trim()) return

		setState((prev) => ({
			...prev,
			messages: [
				...prev.messages,
				{
					id: `user-${Date.now()}`,
					role: "user",
					content: text.trim(),
					timestamp: Date.now(),
				},
			],
		}))

		postAcpMessage({ type: "acpSendPrompt", text: text.trim() })
	}, [])

	const cancelTurn = useCallback(() => {
		postAcpMessage({ type: "acpCancelTurn" })
	}, [])

	const setMode = useCallback((modeId: string) => {
		postAcpMessage({ type: "acpSetMode", modeId })
	}, [])

	const setModel = useCallback((modelId: string) => {
		postAcpMessage({ type: "acpSetModel", modelId })
	}, [])

	const clearError = useCallback(() => {
		setState((prev) => ({ ...prev, error: null }))
	}, [])

	useEffect(() => {
		postAcpMessage({ type: "acpReady" })
	}, [])

	return (
		<AcpStateContext.Provider
			value={{
				state,
				setState,
				connect,
				disconnect,
				sendPrompt,
				cancelTurn,
				setMode,
				setModel,
				clearError,
			}}
		>
			{children}
		</AcpStateContext.Provider>
	)
}

export const useAcpState = () => {
	const context = useContext(AcpStateContext)
	if (context === undefined) {
		throw new Error("useAcpState must be used within an AcpStateContextProvider")
	}
	return context
}
