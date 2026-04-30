import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)

const scriptDir = path.dirname(__filename)
const srcDir = path.resolve(scriptDir, "..")
const extensionAssistantUiOut = path.join(srcDir, "assets", "assistant-ui", "out")
const workspaceRoot = path.resolve(srcDir, "..", "..")
const assistantUiDir = path.join(workspaceRoot, "assistant-ui")
const withOpencodeDir = path.join(assistantUiDir, "examples", "with-opencode")
const withOpencodeOut = path.join(withOpencodeDir, "out")

function copyDirSync(src, dest) {
	fs.mkdirSync(dest, { recursive: true })
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		const srcPath = path.join(src, entry.name)
		const destPath = path.join(dest, entry.name)
		const stat = fs.statSync(srcPath)
		if (stat.isDirectory()) {
			copyDirSync(srcPath, destPath)
		} else {
			fs.copyFileSync(srcPath, destPath)
		}
	}
}

function run(command, args, cwd, env = {}) {
	console.log(`[assistant-ui] ${command} ${args.join(" ")} (cwd: ${cwd})`)
	execFileSync(command, args, {
		cwd,
		stdio: "inherit",
		env: { ...process.env, ...env },
	})
}

if (!fs.existsSync(withOpencodeDir)) {
	throw new Error(`with-opencode directory not found: ${withOpencodeDir}`)
}

run("pnpm", ["--filter", "with-opencode", "build:static"], assistantUiDir, {
	NEXT_TELEMETRY_DISABLED: "1",
})

if (!fs.existsSync(path.join(withOpencodeOut, "index.html"))) {
	throw new Error(`with-opencode static export missing index.html: ${withOpencodeOut}`)
}

fs.rmSync(extensionAssistantUiOut, { recursive: true, force: true })
fs.mkdirSync(path.dirname(extensionAssistantUiOut), { recursive: true })
copyDirSync(withOpencodeOut, extensionAssistantUiOut)

console.log(`[assistant-ui] Synced fresh with-opencode static export to ${extensionAssistantUiOut}`)
