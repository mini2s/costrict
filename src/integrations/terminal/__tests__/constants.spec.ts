// npx vitest run integrations/terminal/__tests__/constants.spec.ts

import { describe, it, expect, beforeEach, afterEach } from "vitest"

import { isGbkEncodedCommand, GBK_ENCODED_COMMANDS } from "../constants"

describe("isGbkEncodedCommand", () => {
	let originalPlatform: string

	beforeEach(() => {
		originalPlatform = process.platform
	})

	afterEach(() => {
		// Restore original platform
		Object.defineProperty(process, "platform", {
			value: originalPlatform,
			configurable: true,
		})
	})

	const setPlatform = (platform: string) => {
		Object.defineProperty(process, "platform", {
			value: platform,
			configurable: true,
		})
	}

	describe("on win32", () => {
		beforeEach(() => setPlatform("win32"))

		it("detects .NET toolchain commands as GBK-encoded", () => {
			// Regression: `dotnet build` previously produced mojibake because
			// dotnet was missing from GBK_ENCODED_COMMANDS.
			expect(isGbkEncodedCommand("dotnet build")).toBe(true)
			expect(isGbkEncodedCommand("dotnet run")).toBe(true)
			expect(isGbkEncodedCommand("dotnet publish -c Release")).toBe(true)
			expect(isGbkEncodedCommand("msbuild /p:Configuration=Release")).toBe(true)
			expect(isGbkEncodedCommand("nuget restore")).toBe(true)
		})

		it("detects MSVC C/C++ toolchain commands as GBK-encoded", () => {
			// MSVC tools are native Windows programs; their diagnostics use the
			// OEM code page (GBK on Chinese Windows) and are not affected by
			// the LANG/LC_ALL env vars injected by execa.
			expect(isGbkEncodedCommand("cl /c main.cpp")).toBe(true)
			expect(isGbkEncodedCommand("link /OUT:app.exe main.obj")).toBe(true)
			expect(isGbkEncodedCommand("nmake /f Makefile")).toBe(true)
			expect(isGbkEncodedCommand("lib main.obj")).toBe(true)
			expect(isGbkEncodedCommand("rc resource.rc")).toBe(true)
		})

		it("detects existing GBK-encoded system commands", () => {
			expect(isGbkEncodedCommand("tasklist")).toBe(true)
			expect(isGbkEncodedCommand("ping 127.0.0.1")).toBe(true)
			expect(isGbkEncodedCommand("dir")).toBe(true)
			expect(isGbkEncodedCommand("systeminfo")).toBe(true)
		})

		it("returns false for commands that output UTF-8", () => {
			expect(isGbkEncodedCommand("node script.js")).toBe(false)
			expect(isGbkEncodedCommand("git log")).toBe(false)
			expect(isGbkEncodedCommand("echo hello")).toBe(false)
		})

		it("respects word boundaries", () => {
			// Must not match "dotnet_custom" as a GBK command, otherwise the
			// \b anchor in the regex would be broken.
			expect(isGbkEncodedCommand("dotnet_custom")).toBe(false)
			expect(isGbkEncodedCommand("dotnet.exe build")).toBe(true)
		})

		it("is case-insensitive", () => {
			expect(isGbkEncodedCommand("DOTNET BUILD")).toBe(true)
			expect(isGbkEncodedCommand("Dotnet Build")).toBe(true)
		})

		it("trims leading whitespace before matching", () => {
			expect(isGbkEncodedCommand("   dotnet build")).toBe(true)
		})

		it("returns false for empty input", () => {
			expect(isGbkEncodedCommand("")).toBe(false)
		})
	})

	describe("on non-win32 platforms", () => {
		beforeEach(() => setPlatform("linux"))

		it("always returns false regardless of the command", () => {
			// GBK handling is a Windows-only concern.
			expect(isGbkEncodedCommand("dotnet build")).toBe(false)
			expect(isGbkEncodedCommand("tasklist")).toBe(false)
		})
	})
})

describe("GBK_ENCODED_COMMANDS", () => {
	it("includes the .NET toolchain commands", () => {
		// Guards against accidental removal in future edits.
		expect(GBK_ENCODED_COMMANDS).toContain("dotnet")
		expect(GBK_ENCODED_COMMANDS).toContain("msbuild")
		expect(GBK_ENCODED_COMMANDS).toContain("nuget")
	})

	it("includes the MSVC C/C++ toolchain commands", () => {
		expect(GBK_ENCODED_COMMANDS).toContain("cl")
		expect(GBK_ENCODED_COMMANDS).toContain("link")
		expect(GBK_ENCODED_COMMANDS).toContain("nmake")
		expect(GBK_ENCODED_COMMANDS).toContain("lib")
		expect(GBK_ENCODED_COMMANDS).toContain("rc")
	})
})
