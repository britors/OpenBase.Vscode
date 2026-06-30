import * as vscode from 'vscode';
import { BUILD_CONFIGS } from '../utils/constants';
import { OpenBaseCliService } from '../services/openBaseCli.service';
import { WorkspaceService } from '../services/workspace.service';

export function createBuildCommand(
	cliService: OpenBaseCliService,
	workspaceService: WorkspaceService
): (uri?: vscode.Uri) => Promise<void> {
	return async (uri?: vscode.Uri): Promise<void> => {
		if (!await cliService.ensureInstalled()) return;

		const config = await vscode.window.showQuickPick(
			BUILD_CONFIGS.map((c): vscode.QuickPickItem => ({ label: c })),
			{ title: 'OpenBase: Build - Configuration' }
		);
		if (!config) return;

		const noRestore = await vscode.window.showQuickPick(
			[{ label: 'No', description: 'Run dotnet restore before build' }, { label: 'Yes', description: 'Skip dotnet restore' }],
			{ title: 'OpenBase: Build - Skip restore?' }
		);
		if (!noRestore) return;

		const cwd = await workspaceService.getWorkingDirectory(uri);
		if (!cwd) return;

		const flags = noRestore.label === 'Yes' ? ' --no-restore' : '';
		cliService.runInTerminal('Build', cwd, `openbase build -c ${config.label}${flags}`);
	};
}
