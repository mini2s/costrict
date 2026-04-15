import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { Agent, InitializeResponse } from '@agentclientprotocol/sdk';
import type { Stream } from '@agentclientprotocol/sdk/dist/stream.js';
import { type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

import { AcpClientImpl } from './AcpClientImpl';
import { FileSystemHandler } from '../handlers/FileSystemHandler';
import { TerminalAdapter } from '../handlers/TerminalAdapter';
import { PermissionHandler } from '../handlers/PermissionHandler';
import { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import { createLogger } from '../../utils/logger';
import { Package } from '../../shared/package';

const log = createLogger('ACP:Connection');

export interface ConnectionInfo {
	connection: ClientSideConnection;
	client: AcpClientImpl;
	initResponse: InitializeResponse;
}

interface ManagedConnectionInfo extends ConnectionInfo {
	terminalHandler: TerminalAdapter;
	fsHandler: FileSystemHandler;
	permissionHandler: PermissionHandler;
	dispose: () => void;
}

export class ConnectionManager {
	private connections: Map<string, ManagedConnectionInfo> = new Map();

	constructor(
		private readonly sessionUpdateHandler: SessionUpdateHandler,
	) {}

	async connect(agentId: string, process: ChildProcess): Promise<ConnectionInfo> {
		if (!process.stdout || !process.stdin) {
			throw new Error('Agent process missing stdio streams');
		}

		log.channel.appendLine(`ConnectionManager: connecting to agent ${agentId}`);

		const readable = Readable.toWeb(process.stdout) as ReadableStream<Uint8Array>;
		const writable = Writable.toWeb(process.stdin) as WritableStream<Uint8Array>;

		const stream = ndJsonStream(writable, readable);
		const tappedStream = this.tapStream(stream);

		const fsHandler = new FileSystemHandler();
		const terminalHandler = new TerminalAdapter();
		const permissionHandler = new PermissionHandler();

		const client = new AcpClientImpl(
			fsHandler,
			terminalHandler,
			permissionHandler,
			this.sessionUpdateHandler,
		);

		const connection = new ClientSideConnection(
			(agent: Agent) => {
				client.setAgent(agent);
				return client;
			},
			tappedStream,
		);

		log.channel.appendLine(`ConnectionManager: initializing connection to agent ${agentId}`);
		const initResponse = await connection.initialize({
			protocolVersion: PROTOCOL_VERSION,
			clientInfo: {
				name: 'costrict-acp-client',
				version: Package.version,
			},
			clientCapabilities: {
				fs: {
					readTextFile: true,
					writeTextFile: true,
				},
				terminal: true,
			},
		});

		log.channel.appendLine(`ConnectionManager: initialized. Agent: ${initResponse.agentInfo?.name || 'unknown'} v${initResponse.agentInfo?.version || '?'}`);

		const info: ManagedConnectionInfo = {
			connection,
			client,
			initResponse,
			terminalHandler,
			fsHandler,
			permissionHandler,
			dispose: () => {
				client.dispose();
			},
		};
		this.connections.set(agentId, info);

		return info;
	}

	getConnection(agentId: string): ConnectionInfo | undefined {
		return this.connections.get(agentId);
	}

	removeConnection(agentId: string): void {
		const info = this.connections.get(agentId);
		if (!info) {
			return;
		}
		info.dispose();
		this.connections.delete(agentId);
	}

	dispose(): void {
		for (const [agentId, info] of this.connections) {
			try {
				info.dispose();
			} catch (e) {
				log.channel.appendLine(`Failed to dispose connection ${agentId}: ${e}`);
			}
		}
		this.connections.clear();
	}

	private tapStream(stream: Stream): Stream {
		const sendTap = new TransformStream({
			transform(chunk: unknown, controller: TransformStreamDefaultController) {
				log.channel.appendLine(`[ACP send] ${JSON.stringify(chunk)}`);
				controller.enqueue(chunk);
			},
		});

		const recvTap = new TransformStream({
			transform(chunk: unknown, controller: TransformStreamDefaultController) {
				log.channel.appendLine(`[ACP recv] ${JSON.stringify(chunk)}`);
				controller.enqueue(chunk);
			},
		});

		void sendTap.readable.pipeTo(stream.writable).catch(e => log.channel.appendLine(`Traffic tap send pipe error: ${e}`));
		void stream.readable.pipeTo(recvTap.writable).catch(e => log.channel.appendLine(`Traffic tap recv pipe error: ${e}`));

		return {
			writable: sendTap.writable,
			readable: recvTap.readable,
		};
	}
}
