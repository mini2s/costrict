import * as vscode from 'vscode';
import { createLogger } from '../../utils/logger';
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

const log = createLogger('ACP:Permission');

export class PermissionHandler {
	async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		const config = vscode.workspace.getConfiguration('costrict.acp');
		const autoApprove = config.get<string>('autoApprovePermissions', 'none');

		const title = params.toolCall?.title || 'Permission Request';
		log.channel.appendLine(`requestPermission: ${title} (autoApprove=${autoApprove})`);

		if (autoApprove === 'allowAll') {
			const allowOption = params.options.find(o =>
				o.kind === 'allow_once' || o.kind === 'allow_always'
			);
			if (allowOption) {
				return {
					outcome: {
						outcome: 'selected',
						optionId: allowOption.optionId,
					},
				};
			}
		}

		const items: (vscode.QuickPickItem & { optionId: string })[] = params.options.map(option => {
			const icon = option.kind.startsWith('allow') ? '$(check)' : '$(x)';
			return {
				label: `${icon} ${option.name}`,
				description: option.kind,
				optionId: option.optionId,
			};
		});

		const selection = await vscode.window.showQuickPick(items, {
			placeHolder: title,
			title: 'ACP Agent Permission Request',
			ignoreFocusOut: true,
		});

		if (!selection) {
			log.channel.appendLine('Permission cancelled by user');
			return {
				outcome: { outcome: 'cancelled' },
			};
		}

		log.channel.appendLine(`Permission selected: ${selection.optionId}`);
		return {
			outcome: {
				outcome: 'selected',
				optionId: selection.optionId,
			},
		};
	}
}
