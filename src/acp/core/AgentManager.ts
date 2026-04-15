import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createLogger } from '../../utils/logger';
import type { AgentConfigEntry } from '../config/AgentConfig';

const log = createLogger('ACP:AgentManager');

function shellEscape(arg: string): string {
	return `'${arg.replace(/'/g, "'''")}'`;
}

function resolveUnixShell(): { shell: string; useLoginFlag: boolean } {
	const userShell = process.env.SHELL;

	if (userShell) {
		const base = userShell.split('/').pop() || '';
		if (['zsh', 'bash', 'ksh'].includes(base)) {
			return { shell: userShell, useLoginFlag: true };
		}
		if (['fish', 'sh', 'dash'].includes(base)) {
			return { shell: userShell, useLoginFlag: false };
		}
		log.channel.appendLine(`User shell "${userShell}" is not POSIX-compatible, falling back to bash/sh`);
	}

	if (existsSync('/bin/bash')) {
		return { shell: '/bin/bash', useLoginFlag: true };
	}
	if (existsSync('/usr/bin/bash')) {
		return { shell: '/usr/bin/bash', useLoginFlag: true };
	}
	return { shell: '/bin/sh', useLoginFlag: false };
}

export interface AgentInstance {
	id: string;
	name: string;
	process: ChildProcess;
	config: AgentConfigEntry;
}

export class AgentManager extends EventEmitter {
	private agents: Map<string, AgentInstance> = new Map();
	private nextId = 1;

	spawnAgent(name: string, config: AgentConfigEntry): AgentInstance {
		const id = `agent_${this.nextId++}`;
		log.channel.appendLine(`Spawning agent "${name}" (${id}): ${config.command} ${(config.args || []).join(' ')}`);

		const child = (() => {
			if (process.platform === 'win32') {
				return spawn(config.command, config.args || [], {
					stdio: ['pipe', 'pipe', 'pipe'],
					env: { ...process.env, ...(config.env || {}) },
					shell: true,
				});
			}

			const { shell, useLoginFlag } = resolveUnixShell();
			const commandStr = [config.command, ...(config.args || [])].map(shellEscape).join(' ');
			const shellArgs = useLoginFlag ? ['-l', '-c', commandStr] : ['-c', commandStr];

			log.channel.appendLine(`Using shell: ${shell} ${shellArgs.join(' ')}`);
			return spawn(shell, shellArgs, {
				stdio: ['pipe', 'pipe', 'pipe'],
				env: { ...process.env, ...(config.env || {}) },
			});
		})();

		const instance: AgentInstance = { id, name, process: child, config };
		this.agents.set(id, instance);

		child.stderr?.on('data', (data: Buffer) => {
			const line = data.toString().trim();
			if (line) {
				log.channel.appendLine(`[${name} stderr] ${line}`);
				this.emit('agent-stderr', { agentId: id, line });
			}
		});

		child.on('error', (err) => {
			log.channel.appendLine(`Agent "${name}" process error: ${err.message}`);
			this.emit('agent-error', { agentId: id, error: err });
		});

		child.on('close', (code, signal) => {
			log.channel.appendLine(`Agent "${name}" exited (code=${code}, signal=${signal})`);
			this.agents.delete(id);
			this.emit('agent-closed', { agentId: id, code, signal });
		});

		return instance;
	}

	killAgent(agentId: string): boolean {
		const instance = this.agents.get(agentId);
		if (!instance) {
			return false;
		}

		log.channel.appendLine(`Killing agent "${instance.name}" (${agentId})`);

		try {
			instance.process.kill('SIGTERM');
			setTimeout(() => {
				if (instance.process.exitCode === null) {
					instance.process.kill('SIGKILL');
				}
			}, 5000);
		} catch (e) {
			log.channel.appendLine(`Failed to kill agent ${agentId}: ${e}`);
		}

		this.agents.delete(agentId);
		return true;
	}

	getAgent(agentId: string): AgentInstance | undefined {
		return this.agents.get(agentId);
	}

	getRunningAgents(): AgentInstance[] {
		return Array.from(this.agents.values());
	}

	killAll(): void {
		for (const [id] of this.agents) {
			this.killAgent(id);
		}
	}

	dispose(): void {
		this.killAll();
		this.removeAllListeners();
	}
}
