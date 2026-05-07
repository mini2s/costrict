/* eslint-disable no-undef */
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)

const scriptDir = path.dirname(__filename)
const srcDir = path.resolve(scriptDir, "..")
const extensionAssistantUiOut = path.join(srcDir, "assets", "cs-cloud-ui", "out")

// ── Phase: Extract from pre-built zip archive ──────────────────────────────
const zipPath = process.env.CS_CLOUD_UI_DIST_PATH

if (!zipPath) {
	console.warn("[cloud-ui] CS_CLOUD_UI_DIST_PATH is not set — skipping cloud-ui static extraction")
	process.exit(0)
}

console.log(`[cloud-ui] Extracting cs-cloud-ui dist from: ${zipPath}`)
if (!fs.existsSync(zipPath)) {
	console.warn(`[cloud-ui] CS_CLOUD_UI_DIST_PATH file not found: ${zipPath} — skipping`)
	process.exit(0)
}

fs.rmSync(extensionAssistantUiOut, { recursive: true, force: true })
fs.mkdirSync(extensionAssistantUiOut, { recursive: true })
execFileSync("unzip", ["-o", zipPath, "-d", extensionAssistantUiOut], {
	stdio: "inherit",
})

if (!fs.existsSync(path.join(extensionAssistantUiOut, "index.html"))) {
	console.warn(`[cloud-ui] Extracted zip missing index.html in: ${extensionAssistantUiOut} — skipping`)
	process.exit(0)
}

console.log(`[cloud-ui] Done — extracted to ${extensionAssistantUiOut}`)
