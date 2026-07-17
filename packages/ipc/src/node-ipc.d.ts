// Type override for @node-ipc/node-ipc v11 — the built-in types have `of: {}` and
// `server: boolean` which are incorrect. This file provides proper types via
// tsconfig paths mapping.

interface Client {
	on(event: string, callback: (...args: unknown[]) => void): Client
	on(event: "error", callback: (err: unknown) => void): Client
	on(event: "connect" | "disconnect" | "destroy", callback: (socket: import("net").Socket) => void): Client
	on(
		event: "socket.disconnected",
		callback: (socket: import("net").Socket, destroyedSocketID: string) => void,
	): Client
	on(event: "data", callback: (buffer: Buffer) => void): Client
	emit(event: string, value?: unknown): Client
	off(event: string, handler: unknown): Client
}

interface Server extends Client {
	start(): void
	stop(): void
	emit(socket: import("net").Socket, event: string, value?: unknown): Server
	broadcast(event: string, value?: unknown): Client
	on(event: "connect" | "disconnect" | "destroy", callback: (socket: import("net").Socket) => void): Server
	on(
		event: "socket.disconnected",
		callback: (socket: import("net").Socket, destroyedSocketID: string) => void,
	): Server
	on(event: "error", callback: (err: unknown) => void): Server
	on(event: "data", callback: (buffer: Buffer) => void): Server
	on(event: string, callback: (...args: unknown[]) => void): Server
}

interface Config {
	appspace: string
	socketRoot: string
	id: string
	networkHost: string
	networkPort: number
	readableAll: boolean
	writableAll: boolean
	encoding: "ascii" | "utf8" | "utf16le" | "ucs2" | "base64" | "hex"
	rawBuffer: boolean
	sync: boolean
	silent: boolean
	logInColor: boolean
	logDepth: number
	logger(msg: string): void
	maxConnections: number
	retry: number
	maxRetries: boolean | number
	stopRetrying: boolean
	unlink: boolean
	interfaces?: {
		localAddress?: boolean | undefined
		localPort?: boolean | undefined
		family?: boolean | undefined
		hints?: boolean | undefined
		lookup?: boolean | undefined
	}
	tls:
		| {
				rejectUnauthorized?: boolean | undefined
				public?: string | undefined
				private?: string | undefined
		  }
		| false
}

declare class IPC {
	config: Config
	of: Record<string, Client>
	server: Server
	connectTo(id: string, path?: string, callback?: () => void): void
	connectTo(id: string, callback?: () => void): void
	connectToNet(id: string, host?: string, port?: number, callback?: () => void): void
	connectToNet(id: string, callback?: () => void): void
	connectToNet(id: string, hostOrPort: number | string, callback?: () => void): void
	disconnect(id: string): void
	serve(path?: string, callback?: () => void): void
	serve(callback?: () => void): void
	serveNet(host?: string, port?: number, UDPType?: "udp4" | "udp6", callback?: () => void): void
	serveNet(UDPType: "udp4" | "udp6", callback?: () => void): void
	serveNet(callbackOrPort: (() => void) | number): void
	serveNet(host: string, port: number, callback?: () => void): void
}

declare const ipc: IPC
export default ipc
export { IPC, type Client, type Server, type Config }
