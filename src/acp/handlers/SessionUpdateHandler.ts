import { createLogger } from '../../utils/logger';
import type { SessionNotification } from '@agentclientprotocol/sdk';

const log = createLogger('ACP:SessionUpdate');

export type SessionUpdateListener = (update: SessionNotification) => void;

export class SessionUpdateHandler {
	private listeners: Set<SessionUpdateListener> = new Set();

	addListener(listener: SessionUpdateListener): void {
		this.listeners.add(listener);
	}

	removeListener(listener: SessionUpdateListener): void {
		this.listeners.delete(listener);
	}

	handleUpdate(update: SessionNotification): void {
		const updateType = (update.update as any)?.sessionUpdate || 'unknown';
		log.channel.appendLine(`sessionUpdate: type=${updateType}, sessionId=${update.sessionId}`);

		for (const listener of this.listeners) {
			try {
				listener(update);
			} catch (e) {
				log.channel.appendLine(`Error in session update listener: ${e}`);
			}
		}
	}

	dispose(): void {
		this.listeners.clear();
	}
}
