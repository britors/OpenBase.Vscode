import * as vscode from 'vscode';
import { OpenBaseCliService } from '../services/openBaseCli.service';

export function createVersionCommand(
	cliService: OpenBaseCliService
): () => Promise<void> {
	return async (): Promise<void> => {
		if (!await cliService.ensureInstalled()) return;

		const version = cliService.getVersion();
		if (!version) {
			vscode.window.showErrorMessage('Could not retrieve OpenBase CLI version.');
			return;
		}

		vscode.window.showInformationMessage(`OpenBase CLI ${version}`);
	};
}
