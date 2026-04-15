import * as vscode from 'vscode';
import { createLogger } from '../../utils/logger';
import type {
	ReadTextFileRequest,
	ReadTextFileResponse,
	WriteTextFileRequest,
	WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

const log = createLogger('ACP:FileSystem');

export class FileSystemHandler {
	async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
		log.channel.appendLine(`readTextFile: ${params.path}`);

		try {
			const uri = vscode.Uri.file(params.path);

			const openDoc = vscode.workspace.textDocuments.find(
				doc => doc.uri.fsPath === uri.fsPath
			);

			let content: string;
			if (openDoc) {
				content = openDoc.getText();
			} else {
				const raw = await vscode.workspace.fs.readFile(uri);
				content = Buffer.from(raw).toString('utf-8');
			}

			if (params.line !== undefined && params.line !== null
				|| params.limit !== undefined && params.limit !== null) {
				const lines = content.split("\n");
				const startLine = (params.line ?? 1) - 1;
				const endLine = params.limit
					? startLine + params.limit
					: lines.length;
				content = lines.slice(startLine, endLine).join("\n");
			}

			return { content };
		} catch (e) {
			log.channel.appendLine(`readTextFile failed: ${params.path} - ${e}`);
			throw e;
		}
	}

	async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
		log.channel.appendLine(`writeTextFile: ${params.path}`);

		try {
			const uri = vscode.Uri.file(params.path);
			const encoded = Buffer.from(params.content, 'utf-8');

			await vscode.workspace.fs.writeFile(uri, encoded);

			const doc = await vscode.workspace.openTextDocument(uri);
			await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });

			return {};
		} catch (e) {
			log.channel.appendLine(`writeTextFile failed: ${params.path} - ${e}`);
			throw e;
		}
	}
}
