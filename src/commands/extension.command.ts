import * as vscode from 'vscode';
import { EXTENSIONS } from '../utils/constants';
import { extensionLabel } from '../utils/labels';
import { EXTENSION_PROVIDERS } from '../config/extensionProviders';
import { OpenBaseCliService } from '../services/openBaseCli.service';
import { WorkspaceService } from '../services/workspace.service';

export function createExtensionAddCommand(
	cliService: OpenBaseCliService,
	workspaceService: WorkspaceService
): (uri?: vscode.Uri) => Promise<void> {
	return async (uri?: vscode.Uri): Promise<void> => {
		if (!await cliService.ensureInstalled()) return;

		const ext = await vscode.window.showQuickPick(
			EXTENSIONS.map((e): vscode.QuickPickItem => ({ label: e, description: extensionLabel(e) })),
			{ title: 'OpenBase: Add Extension', placeHolder: 'Choose an extension' }
		);
		if (!ext) return;

		const providers = EXTENSION_PROVIDERS[ext.label];
		let provider: string | undefined;

		if (providers) {
			const picked = await vscode.window.showQuickPick(
				providers.map((p): vscode.QuickPickItem => ({ label: p })),
				{ title: `OpenBase: Add Extension - ${ext.label} provider` }
			);
			if (!picked) return;
			provider = picked.label;
		}

		const cwd = await workspaceService.getWorkingDirectory(uri);
		if (!cwd) return;

		const args = provider ? `${ext.label} -p ${provider}` : ext.label;
		cliService.runInTerminal('Extension Add', cwd, `openbase extension add ${args}`);
	};
}

export function createExtensionListCommand(
	cliService: OpenBaseCliService,
	workspaceService: WorkspaceService
): (uri?: vscode.Uri) => Promise<void> {
	return async (uri?: vscode.Uri): Promise<void> => {
		if (!await cliService.ensureInstalled()) return;

		const cwd = await workspaceService.getWorkingDirectory(uri);
		if (!cwd) return;

		cliService.runInTerminal('Extension List', cwd, 'openbase extension list');
	};
}
