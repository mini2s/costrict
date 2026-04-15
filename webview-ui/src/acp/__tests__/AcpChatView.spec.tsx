import { render, screen } from "@/utils/test-utils"
import { ReactNode } from "react"

import AcpChatView from "../AcpChatView"

const useAcpStateMock = vi.fn()

vi.mock("../AcpStateContext", () => ({
	useAcpState: () => useAcpStateMock(),
}))

vi.mock("../components/AcpMessageItem", () => ({
	__esModule: true,
	default: ({ message }: { message: { content: string } }) => <div data-testid="acp-message-item">{message.content}</div>,
}))

vi.mock("../components/AcpInputArea", () => ({
	__esModule: true,
	default: () => <div data-testid="acp-input-area">Input Area</div>,
}))

vi.mock("../components/AcpModeSelector", () => ({
	AcpModeSelector: () => <div data-testid="acp-mode-selector">Mode Selector</div>,
	AcpModelSelector: () => <div data-testid="acp-model-selector">Model Selector</div>,
}))

describe("AcpChatView", () => {
	beforeEach(() => {
		useAcpStateMock.mockReturnValue({
			state: {
				connecting: false,
				connected: true,
				agentName: "ACP Agent",
				error: null,
				messages: [
					{ id: "m1", role: "user", content: "hello" },
					{ id: "m2", role: "assistant", content: "world" },
				],
				isLoading: false,
				modes: { currentModeId: "default", availableModes: [] },
				models: { currentModelId: "model-a", availableModels: [] },
			},
			connect: vi.fn(),
			disconnect: vi.fn(),
			clearError: vi.fn(),
		})
	})

	it("keeps only the message area scrollable while the input area stays outside the scroll container", () => {
		const { container } = render(<AcpChatView />)

		const root = container.firstElementChild
		expect(root).toHaveClass("flex", "h-full", "min-h-0", "flex-col", "overflow-hidden")

		const inputArea = screen.getByTestId("acp-input-area")
		expect(inputArea).toBeInTheDocument()

		const scrollContainer = inputArea.previousElementSibling?.previousElementSibling as HTMLElement | null
		const actualScrollContainer = scrollContainer?.classList.contains("overflow-y-auto")
			? scrollContainer
			: (container.querySelector(".flex-1.min-h-0.overflow-y-auto") as HTMLElement | null)

		expect(actualScrollContainer).toBeInTheDocument()
		expect(actualScrollContainer).toHaveClass("flex-1", "min-h-0", "overflow-y-auto")
		expect(actualScrollContainer).toContainElement(screen.getAllByTestId("acp-message-item")[0])
		expect(actualScrollContainer).not.toContainElement(inputArea)
	})
})
