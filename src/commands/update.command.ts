import * as vscode from 'vscode';
import { OpenBaseCliService } from '../services/openBaseCli.service';
import { WorkspaceService } from '../services/workspace.service';

export function createUpdateCommand(
	cliService: OpenBaseCliService,
	workspaceService: WorkspaceService
): () => Promise<void> {
	return async (): Promise<void> => {
		if (!await cliService.ensureInstalled()) return;
		cliService.runInTerminal('Update', workspaceService.getDefaultWorkingDirectory(), 'openbase update');
	};
}
