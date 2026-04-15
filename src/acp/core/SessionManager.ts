import * as vscode from 'vscode';
import { EventEmitter } from 'node:events';

import type {
	NewSessionResponse,
	PromptResponse,
	InitializeResponse,
	ContentBlock,
	SessionModeState,
	SessionModelState,
	AvailableCommand,
} from '@agentclientprotocol/sdk';
import { RequestError } from '@agentclientprotocol/sdk';

import { AgentManager } from './AgentManager';
import { ConnectionManager, type ConnectionInfo } from './ConnectionManager';
import { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import { getAgentConfigs } from '../config/AgentConfig';
import { createLogger } from '../../utils/logger';

const log = createLogger('ACP:Session');
const RECONNECT_DELAY_MS = 1500;

export interface SessionInfo {
	sessionId: string;
	agentId: string;
	agentName: string;
	agentDisplayName: string;
	cwd: string;
	createdAt: string;
	initResponse: InitializeResponse;
	modes: SessionModeState | null;
	models: SessionModelState | null;
	availableCommands: AvailableCommand[];
}

interface ReconnectState {
	attempts: number;
	timer?: NodeJS.Timeout;
	manualDisconnect: boolean;
}

export class SessionManager extends EventEmitter {
	private sessions: Map<string, SessionInfo> = new Map();
	private activeSessionId: string | null = null;
	private agentSessions: Map<string, string> = new Map();
	private reconnectStates: Map<string, ReconnectState> = new Map();
	private agentErrorListeners: Map<string, (evt: { agentId: string; error: Error }) => void> = new Map();
	private agentClosedListeners: Map<string, (evt: { agentId: string; code: number | null; signal?: NodeJS.Signals | null }) => void> = new Map();

	constructor(
		private readonly agentManager: AgentManager,
		private readonly connectionManager: ConnectionManager,
		private readonly sessionUpdateHandler: SessionUpdateHandler,
	) {
		super();
	}

	async connectToAgent(agentName: string): Promise<SessionInfo> {
		const existingSessionId = this.agentSessions.get(agentName);
		if (existingSessionId && this.sessions.has(existingSessionId)) {
			this.clearReconnectTimer(agentName);
			this.activeSessionId = existingSessionId;
			this.emit('active-session-changed', existingSessionId);
			return this.sessions.get(existingSessionId)!;
		}

		const currentAgent = this.getActiveAgentName();
		if (currentAgent && currentAgent !== agentName) {
			await this.disconnectAgent(currentAgent);
		}

		const reconnectState = this.getOrCreateReconnectState(agentName);
		reconnectState.manualDisconnect = false;
		this.clearReconnectTimer(agentName);

		const configs = getAgentConfigs();
		const config = configs[agentName];
		if (!config) {
			throw new Error(`Unknown agent: ${agentName}. Available: ${Object.keys(configs).join(', ')}`);
		}

		log.channel.appendLine(`SessionManager: connecting to agent "${agentName}"`);

		try {
			const agentInstance = this.agentManager.spawnAgent(agentName, config);
			const agentId = agentInstance.id;
			this.attachAgentLifecycle(agentName, agentId);

			const agentProcess = this.agentManager.getAgent(agentId);
			if (!agentProcess) {
				throw new Error('Agent process not found after spawn');
			}

			let connInfo: ConnectionInfo;
			try {
				connInfo = await this.connectionManager.connect(agentId, agentProcess.process);
			} catch (e) {
				this.agentManager.killAgent(agentId);
				throw e;
			}

			const sessionInfo = await this.createAcpSession(agentName, agentId, connInfo);

			this.sessions.set(sessionInfo.sessionId, sessionInfo);
			this.agentSessions.set(agentName, sessionInfo.sessionId);
			this.activeSessionId = sessionInfo.sessionId;
			reconnectState.attempts = 0;
			this.clearReconnectTimer(agentName);

			this.emit('agent-connected', agentName);
			this.emit('active-session-changed', sessionInfo.sessionId);

			log.channel.appendLine(`Connected to agent ${agentName}, session ${sessionInfo.sessionId}`);
			return sessionInfo;
		} catch (e: any) {
			log.channel.appendLine(`Failed to connect to agent ${agentName}: ${e.message}`);
			throw e;
		}
	}

	async newConversation(): Promise<SessionInfo | null> {
		const activeSession = this.getActiveSession();
		if (!activeSession) {
			return null;
		}

		const agentName = activeSession.agentName;
		await this.disconnectAgent(agentName);
		this.emit('clear-chat');
		return this.connectToAgent(agentName);
	}

	async disconnectAgent(agentName: string): Promise<void> {
		const reconnectState = this.getOrCreateReconnectState(agentName);
		reconnectState.manualDisconnect = true;
		this.clearReconnectTimer(agentName);

		const sessionId = this.agentSessions.get(agentName);
		if (!sessionId) {
			return;
		}

		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}

		log.channel.appendLine(`Disconnecting agent ${agentName}`);

		this.connectionManager.removeConnection(session.agentId);
		this.agentManager.killAgent(session.agentId);
		this.removeSession(agentName, sessionId);
		this.detachAgentLifecycle(session.agentId);
		this.emit('agent-disconnected', agentName);
		this.emit('active-session-changed', null);
	}

	private async createAcpSession(
		agentName: string,
		agentId: string,
		connInfo: ConnectionInfo,
	): Promise<SessionInfo> {
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
		let sessionResponse: NewSessionResponse;
		try {
			sessionResponse = await connInfo.connection.newSession({
				cwd,
				mcpServers: [],
			});
		} catch (e: any) {
			const isAuthRequired = (e instanceof RequestError && e.code === -32000)
				|| (e?.code === -32000)
				|| (typeof e?.message === 'string' && /auth.?required/i.test(e.message));

			if (!isAuthRequired) {
				log.channel.appendLine(`Failed to create session: ${e.message}`);
				this.agentManager.killAgent(agentId);
				throw e;
			}

			const authMethods = connInfo.initResponse.authMethods;
			if (!authMethods || authMethods.length === 0) {
				this.agentManager.killAgent(agentId);
				throw new Error(
					`Agent "${agentName}" requires authentication but did not advertise any auth methods.`,
				);
			}

			log.channel.appendLine(`Agent requires authentication. Methods: ${authMethods.map(m => m.name).join(', ')}`);

			let selectedMethod = authMethods[0];
			if (authMethods.length > 1) {
				const picked = await vscode.window.showQuickPick(
					authMethods.map(m => ({
						label: m.name,
						description: m.description || '',
						detail: `ID: ${m.id}`,
						method: m,
					})),
					{
						placeHolder: 'Select an authentication method',
						title: `${agentName} requires authentication`,
					},
				);
				if (!picked) {
					this.agentManager.killAgent(agentId);
					throw new Error('Authentication cancelled by user.');
				}
				selectedMethod = picked.method;
			} else {
				const confirm = await vscode.window.showInformationMessage(
					`${agentName} requires authentication via "${selectedMethod.name}".`,
					{ modal: true, detail: selectedMethod.description || undefined },
					'Authenticate',
				);
				if (confirm !== 'Authenticate') {
					this.agentManager.killAgent(agentId);
					throw new Error('Authentication cancelled by user.');
				}
			}

			try {
				log.channel.appendLine(`Authenticating with method: ${selectedMethod.name} (${selectedMethod.id})`);
				await connInfo.connection.authenticate({ methodId: selectedMethod.id });
				log.channel.appendLine('Authentication successful');
			} catch (authErr: any) {
				log.channel.appendLine(`Authentication failed: ${authErr.message}`);
				this.agentManager.killAgent(agentId);
				throw new Error(`Authentication failed: ${authErr.message}`);
			}

			try {
				sessionResponse = await connInfo.connection.newSession({
					cwd,
					mcpServers: [],
				});
			} catch (retryErr) {
				log.channel.appendLine(`Failed to create session after authentication: ${retryErr}`);
				this.agentManager.killAgent(agentId);
				throw retryErr;
			}
		}

		return {
			sessionId: sessionResponse.sessionId,
			agentId,
			agentName,
			agentDisplayName: connInfo.initResponse.agentInfo?.title ||
				connInfo.initResponse.agentInfo?.name ||
				agentName,
			cwd,
			createdAt: new Date().toISOString(),
			initResponse: connInfo.initResponse,
			modes: sessionResponse.modes ?? null,
			models: (sessionResponse as any).models ?? null,
			availableCommands: [],
		};
	}

	private attachAgentLifecycle(agentName: string, agentId: string): void {
		this.detachAgentLifecycle(agentId);

		const errorListener = (evt: { agentId: string; error: Error }) => {
			if (evt.agentId === agentId) {
				log.channel.appendLine(`Agent ${agentName} error: ${evt.error.message}`);
				this.emit('agent-error', agentId, evt.error);
			}
		};

		const closeListener = (evt: { agentId: string; code: number | null; signal?: NodeJS.Signals | null }) => {
			if (evt.agentId !== agentId) {
				return;
			}

			log.channel.appendLine(`Agent ${agentName} closed with code ${evt.code}`);
			const sessionId = this.agentSessions.get(agentName);
			if (sessionId) {
				this.removeSession(agentName, sessionId);
				this.emit('agent-disconnected', agentName);
				this.emit('active-session-changed', null);
			}

			this.emit('agent-closed', agentId, evt.code);
			this.detachAgentLifecycle(agentId);
			this.scheduleReconnect(agentName, evt.code);
		};

		this.agentErrorListeners.set(agentId, errorListener);
		this.agentClosedListeners.set(agentId, closeListener);
		this.agentManager.on('agent-error', errorListener);
		this.agentManager.on('agent-closed', closeListener);
	}

	private detachAgentLifecycle(agentId: string): void {
		const errorListener = this.agentErrorListeners.get(agentId);
		if (errorListener) {
			this.agentManager.off('agent-error', errorListener);
			this.agentErrorListeners.delete(agentId);
		}

		const closeListener = this.agentClosedListeners.get(agentId);
		if (closeListener) {
			this.agentManager.off('agent-closed', closeListener);
			this.agentClosedListeners.delete(agentId);
		}
	}

	private scheduleReconnect(agentName: string, exitCode: number | null): void {
		const reconnectState = this.getOrCreateReconnectState(agentName);
		if (reconnectState.manualDisconnect) {
			return;
		}

		reconnectState.attempts += 1;
		this.clearReconnectTimer(agentName);
		this.emit('agent-reconnecting', agentName, reconnectState.attempts);

		reconnectState.timer = setTimeout(() => {
			void this.retryReconnect(agentName, exitCode, reconnectState.attempts);
		}, RECONNECT_DELAY_MS);
	}

	private async retryReconnect(agentName: string, exitCode: number | null, attempt: number): Promise<void> {
		const reconnectState = this.getOrCreateReconnectState(agentName);
		reconnectState.timer = undefined;
		if (reconnectState.manualDisconnect) {
			return;
		}

		try {
			await this.connectToAgent(agentName);
			this.emit('agent-reconnected', agentName, attempt);
		} catch (error: any) {
			log.channel.appendLine(`Reconnect failed for agent ${agentName}: ${error.message}`);
			this.emit('agent-reconnect-failed', agentName, attempt, error);
			this.emit('agent-error', agentName, new Error(`Agent exited with code ${exitCode ?? 'unknown'} and reconnection failed: ${error.message}`));
		}
	}

	private removeSession(agentName: string, sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (session) {
			this.connectionManager.removeConnection(session.agentId);
		}
		this.sessions.delete(sessionId);
		this.agentSessions.delete(agentName);
		if (this.activeSessionId === sessionId) {
			this.activeSessionId = null;
		}
	}

	private getOrCreateReconnectState(agentName: string): ReconnectState {
		let state = this.reconnectStates.get(agentName);
		if (!state) {
			state = { attempts: 0, manualDisconnect: false };
			this.reconnectStates.set(agentName, state);
		}
		return state;
	}

	private clearReconnectTimer(agentName: string): void {
		const state = this.reconnectStates.get(agentName);
		if (state?.timer) {
			clearTimeout(state.timer);
			state.timer = undefined;
		}
	}

	async sendPrompt(sessionId: string, text: string): Promise<PromptResponse> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`);
		}

		const connInfo = this.connectionManager.getConnection(session.agentId);
		if (!connInfo) {
			throw new Error(`No connection for agent: ${session.agentId}`);
		}

		log.channel.appendLine(`sendPrompt: session=${sessionId}, text="${text.substring(0, 50)}..."`);

		const prompt: ContentBlock[] = [{ type: 'text', text }];
		const response = await connInfo.connection.prompt({ sessionId, prompt });
		log.channel.appendLine(`Prompt response: stopReason=${response.stopReason}`);
		return response;
	}

	async cancelTurn(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) { return; }
		const connInfo = this.connectionManager.getConnection(session.agentId);
		if (!connInfo) { return; }
		log.channel.appendLine(`Cancelling turn for session ${sessionId}`);
		await connInfo.connection.cancel({ sessionId });
	}

	async setMode(sessionId: string, modeId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) { return; }
		const connInfo = this.connectionManager.getConnection(session.agentId);
		if (!connInfo) { return; }
		await connInfo.connection.setSessionMode({ sessionId, modeId });
		if (session.modes) {
			session.modes.currentModeId = modeId;
		}
		this.emit('mode-changed', sessionId, modeId);
	}

	async setModel(sessionId: string, modelId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) { return; }
		const connInfo = this.connectionManager.getConnection(session.agentId);
		if (!connInfo) { return; }
		await (connInfo.connection as any).unstable_setSessionModel({ sessionId, modelId });
		if (session.models) {
			session.models.currentModelId = modelId;
		}
		this.emit('model-changed', sessionId, modelId);
	}

	getSession(sessionId: string): SessionInfo | undefined {
		return this.sessions.get(sessionId);
	}

	getActiveSession(): SessionInfo | undefined {
		if (!this.activeSessionId) { return undefined; }
		return this.sessions.get(this.activeSessionId);
	}

	getActiveSessionId(): string | null {
		return this.activeSessionId;
	}

	getActiveAgentName(): string | null {
		const session = this.getActiveSession();
		return session?.agentName ?? null;
	}

	isAgentConnected(agentName: string): boolean {
		return this.agentSessions.has(agentName);
	}

	getConnectedAgentNames(): string[] {
		return Array.from(this.agentSessions.keys());
	}

	getConnectionForSession(sessionId: string): ConnectionInfo | undefined {
		const session = this.sessions.get(sessionId);
		if (!session) { return undefined; }
		return this.connectionManager.getConnection(session.agentId);
	}

	dispose(): void {
		for (const agentName of this.reconnectStates.keys()) {
			this.clearReconnectTimer(agentName);
		}
		this.agentErrorListeners.forEach((_, agentId) => this.detachAgentLifecycle(agentId));
		this.agentManager.killAll();
		this.connectionManager.dispose();
		this.sessions.clear();
		this.agentSessions.clear();
		this.reconnectStates.clear();
	}
}
