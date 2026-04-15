import * as vscode from 'vscode';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { SessionManager, type SessionInfo } from './core/SessionManager';
import { SessionUpdateHandler } from './handlers/SessionUpdateHandler';
import { getAgentNames } from './config/AgentConfig';
import { createLogger } from '../utils/logger';

const log = createLogger('ACP:MessageHandler');

function normalizeAgentName(value: unknown): string | null {
	if (typeof value === 'string') {
		return value;
	}

	if (!value || typeof value !== 'object') {
		return null;
	}

	const candidate = value as Record<string, unknown>;
	const namedValue = candidate.displayName ?? candidate.title ?? candidate.name ?? candidate.label ?? candidate.id;
	return typeof namedValue === 'string' ? namedValue : null;
}

export interface AcpStateMessage {
	type: 'acpState';
	agentName: string | null;
	connected: boolean;
	sessionId: string | null;
	modes: any | null;
	models: any | null;
}

export class AcpMessageHandler {
	private sessionUpdateListener: (update: SessionNotification) => void;

	constructor(
		private readonly sessionManager: SessionManager,
		private readonly sessionUpdateHandler: SessionUpdateHandler,
		private readonly postMessageToWebview: (message: any) => void,
	) {
		this.sessionUpdateListener = (update: SessionNotification) => {
			this.handleSessionUpdate(update);
		};
		this.sessionUpdateHandler.addListener(this.sessionUpdateListener);

		this.sessionManager.on('active-session-changed', () => {
			this.sendCurrentState();
		});

		this.sessionManager.on('agent-connected', (agentName: string) => {
			this.postMessageToWebview({ type: 'acpConnected', agentName: normalizeAgentName(agentName) });
		});

		this.sessionManager.on('agent-disconnected', (agentName: string) => {
			this.postMessageToWebview({ type: 'acpDisconnected', agentName: normalizeAgentName(agentName) });
		});

		this.sessionManager.on('agent-error', (_agentId: string, error: Error) => {
			this.postMessageToWebview({ type: 'acpError', error: error.message });
		});

		this.sessionManager.on('agent-reconnecting', (agentName: string, attempt: number) => {
			this.postMessageToWebview({
				type: 'acpConnecting',
				agentName: normalizeAgentName(agentName),
				attempt,
				reconnecting: true,
			});
		});

		this.sessionManager.on('agent-reconnected', (agentName: string, attempt: number) => {
			this.postMessageToWebview({
				type: 'acpConnected',
				agentName: normalizeAgentName(agentName),
				attempt,
				reconnected: true,
			});
		});

		this.sessionManager.on('agent-reconnect-failed', (agentName: string, attempt: number, error: Error) => {
			this.postMessageToWebview({
				type: 'acpError',
				error: `Failed to reconnect to ${normalizeAgentName(agentName) ?? 'agent'} (attempt ${attempt}): ${error.message}`,
			});
		});

		this.sessionManager.on('mode-changed', (_sessionId: string, _modeId: string) => {
			const session = this.sessionManager.getActiveSession();
			if (session?.modes) {
				this.postMessageToWebview({ type: 'acpModesUpdate', modes: session.modes });
			}
		});

		this.sessionManager.on('model-changed', (_sessionId: string, _modelId: string) => {
			const session = this.sessionManager.getActiveSession();
			if (session?.models) {
				this.postMessageToWebview({ type: 'acpModelsUpdate', models: session.models });
			}
		});
	}

	async handleMessage(message: { type: string; [key: string]: any }): Promise<void> {
		switch (message.type) {
			case 'acpReady':
				log.channel.appendLine('[ACP] Webview ready');
				this.sendCurrentState();
				break;

			case 'acpConnect':
				await this.connectToAgent(message.agentName);
				break;

			case 'acpDisconnect':
				await this.disconnectAgent();
				break;

			case 'acpSendPrompt':
				await this.handleSendPrompt(message.text);
				break;

			case 'acpCancelTurn':
				await this.handleCancelTurn();
				break;

			case 'acpSetMode':
				await this.handleSetMode(message.modeId);
				break;

			case 'acpSetModel':
				await this.handleSetModel(message.modelId);
				break;

			case 'openFile':
				this.handleOpenFile(message.text, message.values);
				break;

			default:
				log.channel.appendLine(`[ACP] Unknown message type: ${message.type}`);
		}
	}

	public async connectToAgent(agentName?: string): Promise<void> {
		await this.handleConnect(agentName)
	}

	public async disconnectAgent(): Promise<void> {
		await this.handleDisconnect()
	}

	private async handleConnect(agentName?: string): Promise<void> {
		if (!agentName) {
			const agentNamesList = getAgentNames();
			if (agentNamesList.length === 0) {
				this.postMessageToWebview({
					type: 'acpError',
					error: 'No ACP agents configured. Add agents in Settings > CoStrict ACP > Agents.',
				});
				return;
			}
			agentName = await vscode.window.showQuickPick(agentNamesList, {
				placeHolder: 'Select an agent to connect',
				title: 'Connect to Agent',
			});
			if (!agentName) { return; }
		}

		try {
			this.postMessageToWebview({ type: 'acpConnecting' });
			await this.sessionManager.connectToAgent(agentName);
		} catch (e: any) {
			log.channel.appendLine(`Failed to connect: ${e.message}`);
			this.postMessageToWebview({ type: 'acpError', error: e.message });
		}
	}

	private async handleDisconnect(): Promise<void> {
		const agentName = this.sessionManager.getActiveAgentName();
		if (agentName) {
			await this.sessionManager.disconnectAgent(agentName);
		}
	}

	private async handleSendPrompt(text: string): Promise<void> {
		const activeId = this.sessionManager.getActiveSessionId();
		if (!activeId) {
			this.postMessageToWebview({
				type: 'acpError',
				error: 'No active session. Connect to an agent first.',
			});
			return;
		}

		this.postMessageToWebview({ type: 'acpPromptStart' });

		try {
			const response = await this.sessionManager.sendPrompt(activeId, text);
			this.postMessageToWebview({
				type: 'acpPromptEnd',
				stopReason: response.stopReason,
				usage: (response as any).usage,
			});
		} catch (e: any) {
			log.channel.appendLine(`Prompt failed: ${e.message}`);
			this.postMessageToWebview({ type: 'acpError', error: e.message });
			this.postMessageToWebview({ type: 'acpPromptEnd', stopReason: 'error' });
		}
	}

	private async handleCancelTurn(): Promise<void> {
		const activeId = this.sessionManager.getActiveSessionId();
		if (activeId) {
			try {
				await this.sessionManager.cancelTurn(activeId);
			} catch (e: any) {
				log.channel.appendLine(`Cancel failed: ${e.message}`);
			}
		}
	}

	private async handleSetMode(modeId: string): Promise<void> {
		const activeId = this.sessionManager.getActiveSessionId();
		if (!activeId || !modeId) { return; }
		try {
			await this.sessionManager.setMode(activeId, modeId);
		} catch (e: any) {
			this.postMessageToWebview({ type: 'acpError', error: `Failed to set mode: ${e.message}` });
		}
	}

	private async handleSetModel(modelId: string): Promise<void> {
		const activeId = this.sessionManager.getActiveSessionId();
		if (!activeId || !modelId) { return; }
		try {
			await this.sessionManager.setModel(activeId, modelId);
		} catch (e: any) {
			this.postMessageToWebview({ type: 'acpError', error: `Failed to set model: ${e.message}` });
		}
	}

	private handleSessionUpdate(update: SessionNotification): void {
		const activeId = this.sessionManager.getActiveSessionId();
		if (update.sessionId !== activeId) { return; }

		this.postMessageToWebview({
			type: 'acpSessionUpdate',
			update: update.update,
			sessionId: update.sessionId,
		});
	}

	private sendCurrentState(): void {
		const activeId = this.sessionManager.getActiveSessionId();
		const session = activeId ? this.sessionManager.getSession(activeId) : null;

		const stateMessage: AcpStateMessage = {
			type: 'acpState',
			connected: !!session,
			agentName: normalizeAgentName(session?.agentDisplayName ?? session?.agentName ?? null),
			sessionId: session?.sessionId ?? null,
			modes: session?.modes ?? null,
			models: session?.models ?? null,
		};

		this.postMessageToWebview(stateMessage);
	}

	private handleOpenFile(filePath: string, values?: any): void {
		try {
			const uri = vscode.Uri.file(filePath);
			vscode.workspace.openTextDocument(uri).then((doc) => {
				vscode.window.showTextDocument(doc, {
					selection: values?.line !== undefined
						? new vscode.Range(values.line, values?.character ?? 0, values.line, values?.character ?? 0)
						: undefined,
				});
			}, (err) => {
				log.channel.appendLine(`Failed to open file ${filePath}: ${err.message}`);
			});
		} catch (e: any) {
			log.channel.appendLine(`Failed to open file ${filePath}: ${e.message}`);
		}
	}

	dispose(): void {
		this.sessionUpdateHandler.removeListener(this.sessionUpdateListener);
	}
}
