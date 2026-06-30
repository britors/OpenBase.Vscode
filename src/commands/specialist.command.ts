import * as vscode from 'vscode';
import { OpenBaseCliService } from '../services/openBaseCli.service';
import { WorkspaceService } from '../services/workspace.service';
import { PARAM_TYPES } from '../utils/constants';
import { escapeCliQuotedValue } from '../utils/parsers';
import { validateNameTypeInput, validatePascalCase } from '../utils/validators';

export function createSpecialistCommand(
	cliService: OpenBaseCliService,
	workspaceService: WorkspaceService
): (uri?: vscode.Uri) => Promise<void> {
	return async (uri?: vscode.Uri): Promise<void> => {
		if (!await cliService.ensureInstalled()) return;

		const entity = await vscode.window.showInputBox({
			title: 'OpenBase: Specialist (1/4) - Entity',
			prompt: 'Entity name (PascalCase)',
			placeHolder: 'Product',
			validateInput: validatePascalCase,
		});
		if (!entity) return;

		const method = await vscode.window.showInputBox({
			title: 'OpenBase: Specialist (2/4) - Method name',
			prompt: 'Method name (PascalCase)',
			placeHolder: 'GetByCategoria',
			validateInput: validatePascalCase,
		});
		if (!method) return;

		const typeItem = await vscode.window.showQuickPick(
			[
				{ label: 'query', description: 'MediatR query - returns data (SELECT)' },
				{ label: 'command', description: 'MediatR command - modifies data (INSERT/UPDATE/DELETE)' },
				{ label: 'httpcall', description: 'External HTTP call - no SQL required' },
			],
			{ title: 'OpenBase: Specialist (3/4) - Type' }
		);
		if (!typeItem) return;

		let sql = '';
		if (typeItem.label !== 'httpcall') {
			const sqlInput = await vscode.window.showInputBox({
				title: 'OpenBase: Specialist (4/4) - SQL',
				prompt: 'SQL statement (use {{paramName}} for parameters)',
				placeHolder: 'SELECT Nome FROM Produtos WHERE CategoriaId = {{categoriaId}}',
				validateInput: (v) => (!v.trim() ? 'SQL is required' : undefined),
			});
			if (!sqlInput) return;
			sql = sqlInput;
		}

		const validTypes = PARAM_TYPES.join(', ');
		const params: string[] = [];
		while (true) {
			const param = await vscode.window.showInputBox({
				title: `OpenBase: Specialist - Param ${params.length + 1} (leave empty to finish)`,
				prompt: `Parameter in name:Type format - valid types: ${validTypes}`,
				placeHolder: 'paramName:Type  (e.g. categoriaId:Guid)',
				validateInput: validateNameTypeInput,
			});
			if (param === undefined) return;
			if (!param.trim()) break;
			params.push(param.trim());
		}

		const columns: string[] = [];
		if (typeItem.label === 'query') {
			while (true) {
				const col = await vscode.window.showInputBox({
					title: `OpenBase: Specialist - Column ${columns.length + 1} (leave empty to finish)`,
					prompt: `Column in name:Type format - valid types: ${validTypes}`,
					placeHolder: 'ColumnName:Type  (e.g. Nome:string)',
					validateInput: validateNameTypeInput,
				});
				if (col === undefined) return;
				if (!col.trim()) break;
				columns.push(col.trim());
			}
		}

		const cwd = await workspaceService.getWorkingDirectory(uri);
		if (!cwd) return;

		const args: string[] = [
			`-e ${entity}`,
			`--method ${method}`,
			`--type ${typeItem.label}`,
		];
		if (sql) args.push(`--sql "${escapeCliQuotedValue(sql)}"`);
		for (const p of params) args.push(`--param ${p}`);
		for (const c of columns) args.push(`--column ${c}`);

		cliService.runInTerminal('Specialist', cwd, `openbase specialist ${args.join(' ')}`);
	};
}
