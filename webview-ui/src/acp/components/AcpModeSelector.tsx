import { memo, useState, useRef, useEffect } from "react"
import { useAcpState} from "../AcpStateContext"
import { StandardTooltip } from "@src/components/ui/standard-tooltip"

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

// ── Mode Selector ─────────────────────────────────────────────────

const AcpModeSelector = memo(() => {
	const { state, setMode } = useAcpState()
	const [open, setOpen] = useState(false)
	const [search, setSearch] = useState("")
	const containerRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLInputElement>(null)

	const modes = state.modes?.availableModes ?? []
	const currentModeId = state.modes?.currentModeId
	const hasModes = modes.length > 0

	const currentMode = hasModes ? modes.find((m) => m.id === currentModeId) : undefined
	const currentModeName = toDisplayText(currentMode?.name, toDisplayText(currentModeId, "Mode"))
	const currentModeDescription = toDisplayText(currentMode?.description)

	const filtered = search
		? modes.filter((m) => {
				const modeName = toDisplayText(m.name).toLowerCase()
				const modeId = toDisplayText(m.id).toLowerCase()
				const modeDescription = toDisplayText(m.description).toLowerCase()
				const query = search.toLowerCase()
				return modeName.includes(query) || modeId.includes(query) || modeDescription.includes(query)
			})
		: modes

	useEffect(() => {
		if (open && inputRef.current) {
			inputRef.current.focus()
		}
	}, [open])

	useEffect(() => {
		if (!open) return
		const handler = (e: MouseEvent) => {
			if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
				setOpen(false)
				setSearch("")
			}
		}
		document.addEventListener("mousedown", handler)
		return () => document.removeEventListener("mousedown", handler)
	}, [open])

	if (!hasModes) return null

	return (
		<div ref={containerRef} className="relative">
			<StandardTooltip content={currentModeDescription || `Mode: ${currentModeName}`}>
				<button
					onClick={() => setOpen(!open)}
					className="flex items-center gap-1 px-1.5 py-0.5 text-xs rounded hover:bg-vscode-toolbar-hoverBackground text-vscode-editor-foreground transition-colors"
				>
					<span className="codicon codicon-symbol-color-mode text-xs" />
					<span className="max-w-[100px] truncate">{currentModeName}</span>
					<span className="codicon codicon-chevron-down text-[10px] opacity-60" />
				</button>
			</StandardTooltip>

			{open && (
				<div className="absolute bottom-full left-0 mb-1 w-52 rounded border border-vscode-editorWidget-border bg-vscode-editor-background shadow-lg z-50 overflow-hidden">
					<div className="p-1 border-b border-vscode-editorWidget-border">
						<input
							ref={inputRef}
							type="text"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder="Search modes..."
							className="w-full px-2 py-1 text-xs bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border rounded focus:outline-none focus:border-vscode-focusBorder"
						/>
					</div>
					<div className="max-h-48 overflow-y-auto py-0.5">
						{filtered.length === 0 && (
							<div className="px-2 py-1.5 text-xs text-vscode-descriptionForeground">No modes found</div>
						)}
						{filtered.map((mode) => {
							const modeId = toDisplayText(mode.id)
							const modeName = toDisplayText(mode.name, modeId || "Mode")
							const modeDescription = toDisplayText(mode.description)
							return (
								<button
									key={modeId}
									onClick={() => {
										setMode(modeId)
										setOpen(false)
										setSearch("")
									}}
									className={`w-full text-left px-2 py-1.5 text-xs hover:bg-vscode-list-hoverBackground flex items-center gap-2 ${
										modeId === currentModeId ? "bg-vscode-list-activeSelectionBackground text-vscode-list-activeSelectionForeground" : ""
									}`}
								>
									{modeId === currentModeId && <span className="codicon codicon-check text-xs" />}
									<div className="min-w-0 flex-1">
										<div className="truncate font-medium">{modeName}</div>
										{modeDescription && <div className="text-vscode-descriptionForeground truncate">{modeDescription}</div>}
									</div>
								</button>
							)
						})}
					</div>
				</div>
			)}
		</div>
	)
})
AcpModeSelector.displayName = "AcpModeSelector"

// ── Model Selector ────────────────────────────────────────────────

const AcpModelSelector = memo(() => {
	const { state, setModel } = useAcpState()
	const [open, setOpen] = useState(false)
	const containerRef = useRef<HTMLDivElement>(null)

	const models = state.models?.availableModels ?? []
	const currentModelId = state.models?.currentModelId
	const hasModels = models.length > 0

	const currentModel = hasModels ? models.find((m) => m.modelId === currentModelId) : undefined
	const currentModelName = toDisplayText(currentModel?.name, toDisplayText(currentModelId, "Model"))
	const currentModelDescription = toDisplayText(currentModel?.description)

	useEffect(() => {
		if (!open) return
		const handler = (e: MouseEvent) => {
			if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
				setOpen(false)
			}
		}
		document.addEventListener("mousedown", handler)
		return () => document.removeEventListener("mousedown", handler)
	}, [open])

	if (!hasModels) return null

	return (
		<div ref={containerRef} className="relative">
			<StandardTooltip content={currentModelDescription || `Model: ${currentModelName}`}>
				<button
					onClick={() => setOpen(!open)}
					className="flex items-center gap-1 px-1.5 py-0.5 text-xs rounded hover:bg-vscode-toolbar-hoverBackground text-vscode-editor-foreground transition-colors"
				>
					<span className="codicon codicon-server-process text-xs" />
					<span className="max-w-[120px] truncate">{currentModelName}</span>
					<span className="codicon codicon-chevron-down text-[10px] opacity-60" />
				</button>
			</StandardTooltip>

			{open && (
				<div className="absolute bottom-full left-0 mb-1 w-60 rounded border border-vscode-editorWidget-border bg-vscode-editor-background shadow-lg z-50 overflow-hidden">
					<div className="max-h-48 overflow-y-auto py-0.5">
						{models.map((model) => {
							const modelId = toDisplayText(model.modelId)
							const modelName = toDisplayText(model.name, modelId || "Model")
							const modelDescription = toDisplayText(model.description)
							return (
								<button
									key={modelId}
									onClick={() => {
										setModel(modelId)
										setOpen(false)
									}}
									className={`w-full text-left px-2 py-1.5 text-xs hover:bg-vscode-list-hoverBackground flex items-center gap-2 ${
										modelId === currentModelId
											? "bg-vscode-list-activeSelectionBackground text-vscode-list-activeSelectionForeground"
											: ""
									}`}
								>
									{modelId === currentModelId && <span className="codicon codicon-check text-xs" />}
									<div className="min-w-0 flex-1">
										<div className="truncate font-medium">{modelName}</div>
										{modelDescription && <div className="text-vscode-descriptionForeground truncate">{modelDescription}</div>}
									</div>
								</button>
							)
						})}
					</div>
				</div>
			)}
		</div>
	)
})
AcpModelSelector.displayName = "AcpModelSelector"

export { AcpModeSelector, AcpModelSelector }
