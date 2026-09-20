#!/usr/bin/env node
/* eslint-disable no-undef */
/*
 * 本地 mock：模拟 user-indicator 的 endpoint 发现接口 + Telemetry Service 的 NDJSON 写入。
 *
 * 用法：
 *   node scripts/mock-telemetry-server.mjs
 *   node scripts/mock-telemetry-server.mjs --port 8788 --enabled=false
 *   node scripts/mock-telemetry-server.mjs --out tmp/mock-telemetry.ndjson
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { dirname, resolve } from "node:path"

const argv = process.argv.slice(2)

const readArg = (name, fallback) => {
	const index = argv.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`))
	if (index === -1) return fallback
	const hit = argv[index]
	const eq = hit.indexOf("=")
	if (eq !== -1) return hit.slice(eq + 1)
	const next = argv[index + 1]
	return next && !next.startsWith("--") ? next : "true"
}

const port = Number(readArg("port", "8788"))
const enabled = readArg("enabled", "true") !== "false"
const outPath = resolve(process.cwd(), readArg("out", "tmp/mock-telemetry.ndjson"))
const endpointUrl = `http://127.0.0.1:${port}/insert/jsonline`

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, "")

const json = (res, status, payload, extraHeaders = {}) => {
	res.writeHead(status, { "content-type": "application/json", ...extraHeaders })
	res.end(JSON.stringify(payload))
}

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`)
	const chunks = []
	req.on("data", (chunk) => chunks.push(chunk))
	req.on("end", () => {
		const body = Buffer.concat(chunks)

		if (req.method === "GET" && url.pathname === "/user-indicator/api/v1/telemetry/endpoints") {
			if (!req.headers.authorization) {
				json(res, 401, { success: false, code: "INVALID_TOKEN", message: "missing bearer token" })
				return
			}
			console.log(`[mock] discovery → enabled=${enabled}`)
			json(
				res,
				200,
				{
					success: true,
					code: "",
					data: {
						logs: {
							enabled,
							url: enabled ? endpointUrl : "",
							fallback_urls: [],
							protocol: "victorialogs-jsonline-v1",
						},
						expires_in: 5,
					},
				},
				{ "cache-control": "private, max-age=300" },
			)
			return
		}

		if (req.method === "POST" && url.pathname === "/insert/jsonline") {
			const text = body.toString("utf8")
			const lines = text.split("\n").filter((line) => line.trim().length > 0)
			appendFileSync(outPath, text.endsWith("\n") ? text : `${text}\n`)
			console.log(`[mock] received ${lines.length} line(s) → ${outPath}`)
			res.writeHead(200, { "x-request-id": `mock-${Date.now()}` })
			res.end()
			return
		}

		json(res, 404, { success: false, code: "NOT_FOUND", message: `${req.method} ${url.pathname}` })
	})
})

server.listen(port, "127.0.0.1", () => {
	console.log(`[mock] listening       http://127.0.0.1:${port}`)
	console.log(`[mock] discovery URL   http://127.0.0.1:${port}/user-indicator/api/v1/telemetry/endpoints`)
	console.log(`[mock] log output      ${outPath}`)
	console.log(`[mock] enabled         ${enabled}`)
})
