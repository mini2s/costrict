import fs from "fs"
import os from "os"
import path from "path"

const { patchPackageJson, patchRuntimeBundle } = require("../../scripts/make-nightly-vsix.js")

describe("make-nightly-vsix patchPackageJson", () => {
	let tempDir: string

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "make-nightly-vsix-test-"))
		fs.mkdirSync(path.join(tempDir, "extension"), { recursive: true })
	})

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it("保留 author、repository、homepage，并继续应用 nightly 变换", () => {
		const packagePath = path.join(tempDir, "extension", "package.json")
		const originalPackage = {
			name: "zgsm-nightly",
			publisher: "zgsm-ai",
			version: "0.0.1-nightly",
			displayName: "CoStrict Nightly",
			description: "nightly build for costrict",
			command: "costrict.openPanel",
			author: { name: "unexpected-author" },
			repository: {
				type: "git",
				url: "https://example.com/incorrect/repo",
			},
			homepage: "https://example.com/wrong-homepage",
		}

		fs.writeFileSync(packagePath, `${JSON.stringify(originalPackage, null, "\t")}\n`)

		patchPackageJson(tempDir)

		const patchedPackage = JSON.parse(fs.readFileSync(packagePath, "utf8"))

		expect(patchedPackage.name).toBe("zgsm-nightly")
		expect(patchedPackage.publisher).toBe("zgsm-ai")
		expect(patchedPackage.version).toBe("3.0.0")
		expect(patchedPackage.displayName).toBe("CoStrict Nightly")
		expect(patchedPackage.description).toBe("nightly build for costrict-nightly")
		expect(patchedPackage.command).toBe("costrict-nightly.openPanel")
		expect(patchedPackage.author).toEqual({ name: "zgsm-ai" })
		expect(patchedPackage.repository).toEqual({
			type: "git",
			url: "https://github.com/zgsm-ai/costrict",
		})
		expect(patchedPackage.homepage).toBe("https://github.com/zgsm-ai/costrict")
	})

	it("patches runtime Package metadata for nightly activation", () => {
		const distDir = path.join(tempDir, "extension", "dist")
		fs.mkdirSync(distDir, { recursive: true })
		const bundlePath = path.join(distDir, "extension.js")
		fs.writeFileSync(
			bundlePath,
			'name:process.env.COSTRICT_PKG_NAME||"zgsm",commandIDPrefix:process.env.COSTRICT_PKG_COMMAND_ID_PREFIX||"costrict",other:true',
		)

		patchRuntimeBundle(tempDir)

		const patchedBundle = fs.readFileSync(bundlePath, "utf8")
		expect(patchedBundle).toContain('name:"zgsm-nightly"')
		expect(patchedBundle).toContain('commandIDPrefix:"costrict-nightly"')
		expect(patchedBundle).not.toContain('name:process.env.COSTRICT_PKG_NAME||"zgsm"')
	})
})
