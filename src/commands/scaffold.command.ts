import * as vscode from 'vscode';
import { OpenBaseCliService } from '../services/openBaseCli.service';
import { WorkspaceService } from '../services/workspace.service';
import { validatePascalCase } from '../utils/validators';

export function createScaffoldCommand(
	cliService: OpenBaseCliService,
	workspaceService: WorkspaceService
): (uri?: vscode.Uri) => Promise<void> {
	return async (uri?: vscode.Uri): Promise<void> => {
		if (!await cliService.ensureInstalled()) return;

		const entity = await vscode.window.showInputBox({
			title: 'OpenBase: Scaffold',
			prompt: 'Entity name (PascalCase)',
			placeHolder: 'Product',
			validateInput: validatePascalCase,
		});
		if (!entity) return;

		const cwd = await workspaceService.getWorkingDirectory(uri);
		if (!cwd) return;

		cliService.runInTerminal('Scaffold', cwd, `openbase scaffold -e ${entity}`);
	};
}
