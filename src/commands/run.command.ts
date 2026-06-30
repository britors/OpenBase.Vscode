import * as vscode from 'vscode';
import { BUILD_CONFIGS } from '../utils/constants';
import { OpenBaseCliService } from '../services/openBaseCli.service';
import { WorkspaceService } from '../services/workspace.service';

export function createRunCommand(
	cliService: OpenBaseCliService,
	workspaceService: WorkspaceService
): (uri?: vscode.Uri) => Promise<void> {
	return async (uri?: vscode.Uri): Promise<void> => {
		if (!await cliService.ensureInstalled()) return;

		const config = await vscode.window.showQuickPick(
			BUILD_CONFIGS.map((c): vscode.QuickPickItem => ({ label: c })),
			{ title: 'OpenBase: Run - Configuration' }
		);
		if (!config) return;

		const noBuild = await vscode.window.showQuickPick(
			[{ label: 'No', description: 'Build before run' }, { label: 'Yes', description: 'Skip build step' }],
			{ title: 'OpenBase: Run - Skip build?' }
		);
		if (!noBuild) return;

		const cwd = await workspaceService.getWorkingDirectory(uri);
		if (!cwd) return;

		const flags = noBuild.label === 'Yes' ? ' --no-build' : '';
		cliService.runInTerminal('Run', cwd, `openbase run -c ${config.label}${flags}`);
	};
}
