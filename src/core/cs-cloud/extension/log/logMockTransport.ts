import { promises as fs } from "fs"
import * as path from "path"

import type { SerializedPayload } from "./logSerializer"
import type { UploadResult } from "./logUploader"

/** 一次上报动作的抽象：默认走 HTTP，后端未就绪时可替换为本地落盘。 */
export type LogTransport = (url: string, payload: SerializedPayload, token: string) => Promise<UploadResult>

/**
 * 后端未就绪时的本地替代传输：不发起 HTTP，而是把「本该发出的请求体」原样写入目录，
 * 便于后端就绪后补发或人工核对。
 *
 * 目录结构：
 *   <dir>/<ts>-<rand>.ndjson(.gz)        请求体原文
 *   <dir>/<ts>-<rand>.ndjson(.gz).meta.json  目标 url / 编码 / 字节数
 */
export const createFileTransport = (dir: string): LogTransport => {
	return async (url: string, payload: SerializedPayload) => {
		const name = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
		const bodyName = `${name}${payload.encoding === "gzip" ? ".ndjson.gz" : ".ndjson"}`
		const bodyPath = path.join(dir, bodyName)
		const metaPath = `${bodyPath}.meta.json`

		try {
			await fs.mkdir(dir, { recursive: true })
			await fs.writeFile(bodyPath, payload.body)
			await fs.writeFile(
				metaPath,
				JSON.stringify({ url, encoding: payload.encoding ?? "identity", bytes: payload.body.byteLength }),
				"utf8",
			)
			return { ok: true, status: 200, requestId: `mock-${name}` }
		} catch (error) {
			return { ok: false, networkError: error instanceof Error ? error.message : String(error) }
		}
	}
}
