import { gzipSync } from "zlib"

import type { LogRecord } from "./types"

/** 低于该体积不压缩，避免压缩反而变大。 */
export const GZIP_THRESHOLD_BYTES = 8 * 1024

/** 序列化为 NDJSON（每行一个 JSON 对象，末尾换行）。 */
export const serializeNdjson = (records: LogRecord[]): Buffer =>
	Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8")

export interface SerializedPayload {
	body: Buffer
	encoding?: "gzip"
}

export const compressIfWorthwhile = (body: Buffer, threshold: number = GZIP_THRESHOLD_BYTES): SerializedPayload => {
	if (body.byteLength < threshold) {
		return { body }
	}
	const compressed = gzipSync(body)
	return compressed.byteLength < body.byteLength ? { body: compressed, encoding: "gzip" } : { body }
}
