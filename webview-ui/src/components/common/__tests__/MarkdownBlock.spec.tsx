import { render, screen, fireEvent } from "@/utils/test-utils"

import MarkdownBlock from "../MarkdownBlock"
import { vscode } from "@src/utils/vscode"

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		theme: "dark",
	}),
}))

const mockedPostMessage = vscode.postMessage as unknown as ReturnType<typeof vi.fn>

describe("MarkdownBlock", () => {
	it("should correctly handle URLs with trailing punctuation", async () => {
		const markdown = "Check out this link: https://example.com."
		const { container } = render(<MarkdownBlock markdown={markdown} />)

		// Wait for the content to be processed
		await screen.findByText(/Check out this link/, { exact: false })

		// Check for nested links - this should not happen
		const nestedLinks = container.querySelectorAll("a a")
		expect(nestedLinks.length).toBe(0)

		// Should have exactly one link
		const linkElement = screen.getByRole("link")
		expect(linkElement).toHaveAttribute("href", "https://example.com")
		expect(linkElement.textContent).toBe("https://example.com")

		// Check that the period is outside the link
		const paragraph = container.querySelector("p")
		expect(paragraph?.textContent).toBe("Check out this link: https://example.com.")
	}, 10000)

	it("should render unordered lists with proper styling", async () => {
		const markdown = `Here are some items:
- First item
- Second item
  - Nested item
  - Another nested item`

		const { container } = render(<MarkdownBlock markdown={markdown} />)

		// Wait for the content to be processed
		await screen.findByText(/Here are some items/, { exact: false })

		// Check that ul elements exist
		const ulElements = container.querySelectorAll("ul")
		expect(ulElements.length).toBeGreaterThan(0)

		// Check that list items exist
		const liElements = container.querySelectorAll("li")
		expect(liElements.length).toBe(4)

		// Verify the text content
		expect(screen.getByText("First item")).toBeInTheDocument()
		expect(screen.getByText("Second item")).toBeInTheDocument()
		expect(screen.getByText("Nested item")).toBeInTheDocument()
		expect(screen.getByText("Another nested item")).toBeInTheDocument()
	})

	it("should render ordered lists with proper styling", async () => {
		const markdown = `And a numbered list:
1. Step one
2. Step two
3. Step three`

		const { container } = render(<MarkdownBlock markdown={markdown} />)

		// Wait for the content to be processed
		await screen.findByText(/And a numbered list/, { exact: false })

		// Check that ol elements exist
		const olElements = container.querySelectorAll("ol")
		expect(olElements.length).toBe(1)

		// Check that list items exist
		const liElements = container.querySelectorAll("li")
		expect(liElements.length).toBe(3)

		// Verify the text content
		expect(screen.getByText("Step one")).toBeInTheDocument()
		expect(screen.getByText("Step two")).toBeInTheDocument()
		expect(screen.getByText("Step three")).toBeInTheDocument()
	})

	it("should render nested lists with proper hierarchy", async () => {
		const markdown = `Complex list:
1. First level ordered
   - Second level unordered
   - Another second level
     1. Third level ordered
     2. Another third level
2. Back to first level`

		const { container } = render(<MarkdownBlock markdown={markdown} />)

		// Wait for the content to be processed
		await screen.findByText(/Complex list/, { exact: false })

		// Check nested structure
		const olElements = container.querySelectorAll("ol")
		const ulElements = container.querySelectorAll("ul")

		expect(olElements.length).toBeGreaterThan(0)
		expect(ulElements.length).toBeGreaterThan(0)

		// Verify all text is rendered
		expect(screen.getByText("First level ordered")).toBeInTheDocument()
		expect(screen.getByText("Second level unordered")).toBeInTheDocument()
		expect(screen.getByText("Third level ordered")).toBeInTheDocument()
		expect(screen.getByText("Back to first level")).toBeInTheDocument()
	})

	describe("link click handling", () => {
		beforeEach(() => {
			mockedPostMessage.mockClear()
		})

		it("relative path -> openFile with ./ prefix", async () => {
			render(<MarkdownBlock markdown="[link](AGENTS.md)" />)
			const link = await screen.findByRole("link", { name: "link" })
			fireEvent.click(link)
			expect(mockedPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: "openFile", text: "./AGENTS.md" }),
			)
		})

		it("./relative path -> openFile as-is", async () => {
			render(<MarkdownBlock markdown="[link](./src/foo.ts)" />)
			const link = await screen.findByRole("link", { name: "link" })
			fireEvent.click(link)
			expect(mockedPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: "openFile", text: "./src/foo.ts" }),
			)
		})

		it("absolute path -> openFile without ./ prefix", async () => {
			render(<MarkdownBlock markdown="[link](/etc/hosts)" />)
			const link = await screen.findByRole("link", { name: "link" })
			fireEvent.click(link)
			expect(mockedPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: "openFile", text: "/etc/hosts" }),
			)
		})

		it("file:// path -> openFile with file:// stripped", async () => {
			render(<MarkdownBlock markdown="[link](file:///tmp/x.md)" />)
			const link = await screen.findByRole("link", { name: "link" })
			fireEvent.click(link)
			expect(mockedPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: "openFile", text: "/tmp/x.md" }),
			)
		})

		it("path with line number -> openFile with values.line", async () => {
			render(<MarkdownBlock markdown="[link](./src/foo.ts:123)" />)
			const link = await screen.findByRole("link", { name: "link" })
			fireEvent.click(link)
			expect(mockedPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: "openFile", text: "./src/foo.ts", values: { line: 123 } }),
			)
		})

		it("https URL -> openExternal (never falls through to webview navigation)", async () => {
			render(<MarkdownBlock markdown="[link](https://example.com)" />)
			const link = await screen.findByRole("link", { name: "link" })
			fireEvent.click(link)
			expect(mockedPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: "openExternal", url: "https://example.com" }),
			)
		})

		it("command link -> executeCommand", async () => {
			render(<MarkdownBlock markdown="[link](command:workbench.action.openWalkthrough)" />)
			const link = await screen.findByRole("link", { name: "link" })
			fireEvent.click(link)
			expect(mockedPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "executeCommand",
					command: "workbench.action.openWalkthrough",
				}),
			)
		})

		it("mailto link -> openExternal", async () => {
			render(<MarkdownBlock markdown="[link](mailto:test@example.com)" />)
			const link = await screen.findByRole("link", { name: "link" })
			fireEvent.click(link)
			expect(mockedPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: "openExternal", url: "mailto:test@example.com" }),
			)
		})

		it("in-page anchor (#) -> does not post any message", async () => {
			render(<MarkdownBlock markdown="[link](#section)" />)
			const link = await screen.findByRole("link", { name: "link" })
			fireEvent.click(link)
			expect(mockedPostMessage).not.toHaveBeenCalled()
		})
	})
})
