import * as vscode from 'vscode';
import { OpenBaseCliService } from '../services/openBaseCli.service';
import { WorkspaceService } from '../services/workspace.service';
import { validatePascalCase } from '../utils/validators';

export function createProcedureCommand(
	cliService: OpenBaseCliService,
	workspaceService: WorkspaceService
): (uri?: vscode.Uri) => Promise<void> {
	return async (uri?: vscode.Uri): Promise<void> => {
		if (!await cliService.ensureInstalled()) return;

		const name = await vscode.window.showInputBox({
			title: 'OpenBase: Procedure',
			prompt: 'Procedure name (PascalCase, e.g. GetOrderById)',
			placeHolder: 'GetOrderById',
			validateInput: (v) => {
				if (!v.trim()) return 'Procedure name is required';
				return validatePascalCase(v);
			},
		});
		if (!name) return;

		const schema = await vscode.window.showInputBox({
			title: 'OpenBase: Procedure - Schema',
			prompt: 'Schema/owner (leave empty for auto-detect)',
			placeHolder: 'dbo',
		});
		if (schema === undefined) return;

		const cwd = await workspaceService.getWorkingDirectory(uri);
		if (!cwd) return;

		const args = schema?.trim() ? `-n ${name} -s ${schema.trim()}` : `-n ${name}`;
		cliService.runInTerminal('Procedure', cwd, `openbase procedure ${args}`);
	};
}
