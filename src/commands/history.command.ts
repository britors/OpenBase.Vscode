import * as vscode from 'vscode';
import { OpenBaseCliService } from '../services/openBaseCli.service';
import { WorkspaceService } from '../services/workspace.service';

export function createHistoryCommand(
	cliService: OpenBaseCliService,
	workspaceService: WorkspaceService
): () => Promise<void> {
	return async (): Promise<void> => {
		if (!await cliService.ensureInstalled()) return;
		cliService.runInTerminal('History', workspaceService.getDefaultWorkingDirectory(), 'openbase history');
	};
}
