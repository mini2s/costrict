import { promises as fs } from "fs"
import * as os from "os"
import * as path from "path"

import { LogOfflineStore } from "../logOfflineStore"
import type { LogRecord } from "../types"

const buildRecord = (level: LogRecord["level"], message: string): LogRecord => ({
	timestamp: "2025-09-18T10:00:00.000Z",
	message,
	level,
	client_type: "vscode-plugin",
	event_id: `event-${message}`,
})

describe("LogOfflineStore", () => {
	let dir: string

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-log-offline-"))
	})

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("persists shards and reads them back", async () => {
		const store = new LogOfflineStore({ dir, now: () => 1000 })
		await store.save([buildRecord("info", "one"), buildRecord("error", "two")])

		const shards = await store.list()
		expect(shards).toHaveLength(1)
		expect(shards[0].records.map((record) => record.message)).toEqual(["one", "two"])
	})

	it("appends synchronously and seals into a new shard", async () => {
		let clock = 1000
		const store = new LogOfflineStore({ dir, now: () => clock })

		store.appendSync([buildRecord("info", "a")])
		store.appendSync([buildRecord("info", "b")])

		clock = 2000
		const sealed = store.sealCurrent()
		expect(sealed?.records).toBe(2)

		store.appendSync([buildRecord("info", "c")])
		store.sealCurrent()

		const shards = await store.list()
		expect(shards).toHaveLength(2)
		expect(shards.flatMap((shard) => shard.records.map((record) => record.message))).toEqual(["a", "b", "c"])
		expect(store.durability).toEqual({ durable: 3, writeFailures: 0 })
	})

	it("writes durable data in fsync mode and can drop the sealed shard", async () => {
		const store = new LogOfflineStore({ dir, now: () => 3000, fsync: true })
		store.appendSync([buildRecord("error", "durable")])

		const sealed = store.sealCurrent()
		expect(sealed).toBeDefined()

		const shards = await store.list()
		expect(shards[0]?.records[0]?.message).toBe("durable")

		await store.removeSealed(sealed!)
		expect(await store.list()).toHaveLength(0)
		expect(store.durability.durable).toBe(1)
	})

	it("removes a shard by path", async () => {
		const store = new LogOfflineStore({ dir, now: () => 1000 })
		const shard = await store.save([buildRecord("info", "one")])
		await store.remove(shard!)

		expect(await store.list()).toHaveLength(0)
	})

	it("prunes shards older than 24h and counts drops", async () => {
		const old = new LogOfflineStore({ dir, now: () => 0 })
		await old.save([buildRecord("info", "stale")])

		const store = new LogOfflineStore({ dir, now: () => 25 * 60 * 60 * 1000 })
		const dropped = await store.prune()

		expect(dropped).toBe(1)
		expect(await store.list()).toHaveLength(0)
		expect((await store.getStats()).dropped).toBe(1)
	})

	it("evicts the lowest level first when over the byte budget", async () => {
		const writer = new LogOfflineStore({ dir, now: () => 1000 })
		const keepShard = await writer.save([buildRecord("error", "keep-me")])
		await writer.save([buildRecord("trace", "drop-me")])

		const store = new LogOfflineStore({ dir, now: () => 1000, maxBytes: keepShard?.bytes ?? 0 })
		const dropped = await store.prune()
		const remaining = await store.list()

		expect(dropped).toBe(1)
		expect(remaining).toHaveLength(1)
		expect(remaining[0].records[0].message).toBe("keep-me")
	})

	it("ignores corrupt lines instead of failing", async () => {
		await fs.mkdir(dir, { recursive: true })
		await fs.writeFile(
			path.join(dir, "1000-abc.ndjson"),
			`${JSON.stringify(buildRecord("info", "ok"))}\nnot-json\n`,
		)

		const store = new LogOfflineStore({ dir, now: () => 1000 })
		const shards = await store.list()
		expect(shards[0].records).toHaveLength(1)
	})

	it("reports pruned shards through onDrop so silent data loss becomes visible", async () => {
		const old = new LogOfflineStore({ dir, now: () => 0 })
		await old.save([buildRecord("info", "stale")])

		const events: Array<{ shards: number; records: number; reason: string }> = []
		const store = new LogOfflineStore({
			dir,
			now: () => 25 * 60 * 60 * 1000,
			onDrop: (info) => events.push(info),
		})
		await store.prune()

		expect(events).toEqual([{ shards: 1, records: 1, reason: "expired" }])
	})

	it("writes an upload receipt and counts confirmed records once a shard is deleted", async () => {
		const store = new LogOfflineStore({ dir, now: () => 5000 })
		store.appendSync([buildRecord("info", "a"), buildRecord("info", "b")])
		const sealed = store.sealCurrent()

		await store.removeSealed(sealed!, "req-42")

		const receipt = await fs.readFile(path.join(dir, "uploaded.log"), "utf8")
		expect(receipt).toContain("records=2")
		expect(receipt).toContain("first_event=event-a")
		expect(receipt).toContain("request_id=req-42")
		expect(store.confirmedRecords).toBe(2)
		expect((await store.getStats()).confirmed).toBe(2)
	})
})
