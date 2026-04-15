import type {
	Client,
	Agent,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionNotification,
	WriteTextFileRequest,
	WriteTextFileResponse,
	ReadTextFileRequest,
	ReadTextFileResponse,
	CreateTerminalRequest,
	CreateTerminalResponse,
	TerminalOutputRequest,
	TerminalOutputResponse,
	WaitForTerminalExitRequest,
	WaitForTerminalExitResponse,
	KillTerminalCommandRequest,
	KillTerminalCommandResponse,
	ReleaseTerminalRequest,
	ReleaseTerminalResponse,
} from '@agentclientprotocol/sdk';

import { FileSystemHandler } from '../handlers/FileSystemHandler';
import { TerminalAdapter } from '../handlers/TerminalAdapter';
import { PermissionHandler } from '../handlers/PermissionHandler';
import { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import { createLogger } from '../../utils/logger';

const log = createLogger('ACP:Client');

export class AcpClientImpl implements Client {
	private agent: Agent | null = null;

	constructor(
		private readonly fsHandler: FileSystemHandler,
		private readonly terminalHandler: TerminalAdapter,
		private readonly permissionHandler: PermissionHandler,
		private readonly sessionUpdateHandler: SessionUpdateHandler,
	) {}

	dispose(): void {
		this.agent = null;
		this.terminalHandler.dispose();
	}

	setAgent(agent: Agent): void {
		this.agent = agent;
	}

	getAgent(): Agent | null {
		return this.agent;
	}

	async requestPermission(
		params: RequestPermissionRequest,
	): Promise<RequestPermissionResponse> {
		return this.permissionHandler.requestPermission(params);
	}

	async sessionUpdate(params: SessionNotification): Promise<void> {
		this.sessionUpdateHandler.handleUpdate(params);
	}

	async writeTextFile(
		params: WriteTextFileRequest,
	): Promise<WriteTextFileResponse> {
		log.channel.appendLine(`Client.writeTextFile: ${params.path}`);
		return this.fsHandler.writeTextFile(params);
	}

	async readTextFile(
		params: ReadTextFileRequest,
	): Promise<ReadTextFileResponse> {
		log.channel.appendLine(`Client.readTextFile: ${params.path}`);
		return this.fsHandler.readTextFile(params);
	}

	async createTerminal(
		params: CreateTerminalRequest,
	): Promise<CreateTerminalResponse> {
		return this.terminalHandler.createTerminal(params);
	}

	async terminalOutput(
		params: TerminalOutputRequest,
	): Promise<TerminalOutputResponse> {
		return this.terminalHandler.terminalOutput(params);
	}

	async waitForTerminalExit(
		params: WaitForTerminalExitRequest,
	): Promise<WaitForTerminalExitResponse> {
		return this.terminalHandler.waitForTerminalExit(params);
	}

	async killTerminal(
		params: KillTerminalCommandRequest,
	): Promise<KillTerminalCommandResponse> {
		return this.terminalHandler.killTerminal(params);
	}

	async releaseTerminal(
		params: ReleaseTerminalRequest,
	): Promise<ReleaseTerminalResponse> {
		return this.terminalHandler.releaseTerminal(params);
	}
}
