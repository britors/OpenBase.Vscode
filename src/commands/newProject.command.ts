import * as path from 'path';
import * as vscode from 'vscode';
import { DB_TEMPLATES } from '../utils/constants';
import { dbTemplateLabel } from '../utils/labels';
import { validateProjectName } from '../utils/validators';
import { DbTemplate } from '../models/dbTemplate';
import { OpenBaseCliService } from '../services/openBaseCli.service';
import { SettingsService } from '../services/settings.service';
import { WorkspaceService } from '../services/workspace.service';

export function createNewProjectCommand(
	cliService: OpenBaseCliService,
	workspaceService: WorkspaceService,
	settingsService: SettingsService
): (uri?: vscode.Uri) => Promise<void> {
	return async (uri?: vscode.Uri): Promise<void> => {
		if (!await cliService.ensureInstalled()) return;

		const prefs = settingsService.getNewProjectPreferences();

		const projectName = await vscode.window.showInputBox({
			title: 'OpenBase: New Project (1/8) - Project name',
			prompt: 'Project name (PascalCase, no spaces)',
			placeHolder: 'MyProject',
			validateInput: validateProjectName,
		});
		if (!projectName) return;

		const template = await vscode.window.showQuickPick(
			DB_TEMPLATES.map((t): vscode.QuickPickItem => ({ label: t, description: dbTemplateLabel(t as DbTemplate) })),
			{ title: 'OpenBase: New Project (2/8) - Database template', placeHolder: 'Choose a database' }
		);
		if (!template) return;

		const dbServerDefault = prefs.dbServer ?? (template.label === 'sqlserver' ? '.' : 'localhost');
		const dbServer = await vscode.window.showInputBox({
			title: 'OpenBase: New Project (3/8) - Database server',
			prompt: 'Database server address (leave empty for default)',
			placeHolder: template.label === 'sqlserver' ? '.' : 'localhost',
			value: dbServerDefault,
		});
		if (dbServer === undefined) return;

		const dbName = await vscode.window.showInputBox({
			title: 'OpenBase: New Project (4/8) - Database name',
			prompt: 'Database name (leave empty to use project name)',
			placeHolder: projectName,
			value: projectName,
		});
		if (dbName === undefined) return;

		const dbUser = await vscode.window.showInputBox({
			title: 'OpenBase: New Project (5/8) - Database user',
			prompt: template.label === 'sqlserver' ? 'Database user (leave empty for Windows Authentication)' : 'Database user',
			placeHolder: template.label === 'sqlserver' ? 'Windows Auth' : 'postgres',
			value: prefs.dbUser ?? '',
		});
		if (dbUser === undefined) return;

		const dbPassword = await vscode.window.showInputBox({
			title: 'OpenBase: New Project (6/8) - Database password',
			prompt: template.label === 'sqlserver' ? 'Database password (leave empty for Windows Authentication)' : 'Database password',
			password: true,
		});
		if (dbPassword === undefined) return;

		const mediatrLicense = await vscode.window.showInputBox({
			title: 'OpenBase: New Project (7/8) - MediatR license',
			prompt: 'MediatR commercial license key (leave empty if none)',
			placeHolder: 'Leave empty if not applicable',
			value: prefs.mediatrLicense ?? '',
		});
		if (mediatrLicense === undefined) return;

		const automapperLicense = await vscode.window.showInputBox({
			title: 'OpenBase: New Project (8/8) - AutoMapper license',
			prompt: 'AutoMapper commercial license key (leave empty if none)',
			placeHolder: 'Leave empty if not applicable',
			value: prefs.automapperLicense ?? '',
		});
		if (automapperLicense === undefined) return;

		const cwd = await workspaceService.getWorkingDirectory(uri);
		if (!cwd) return;

		const args: string[] = [`-n ${projectName}`, `-s ${template.label}`];
		if (dbServer.trim()) args.push(`--db-server "${dbServer.trim()}"`);
		if (dbName.trim()) args.push(`--db-name "${dbName.trim()}"`);
		if (dbUser.trim()) args.push(`--db-user "${dbUser.trim()}"`);
		if (dbPassword.trim()) args.push(`--db-password "${dbPassword.trim()}"`);
		args.push(`--mediatr-license "${mediatrLicense.trim()}"`);
		args.push(`--automapper-license "${automapperLicense.trim()}"`);

		const success = await cliService.executeInOutputChannel(
			`openbase new ${args.join(' ')}`,
			cwd,
			'OpenBase: New Project'
		);

		if (!success) {
			vscode.window.showErrorMessage(`Failed to create project "${projectName}". Check the output for details.`);
			return;
		}

		await settingsService.saveNewProjectPreferences({
			template: template.label,
			dbServer: dbServer.trim(),
			dbUser: dbUser.trim(),
			mediatrLicense: mediatrLicense.trim(),
			automapperLicense: automapperLicense.trim(),
		});

		const projectUri = vscode.Uri.file(path.join(cwd, projectName));
		const action = await vscode.window.showInformationMessage(
			`Project "${projectName}" created successfully!`,
			'Open Folder',
			'Open in New Window'
		);

		if (action === 'Open Folder') {
			vscode.commands.executeCommand('vscode.openFolder', projectUri, false);
		} else if (action === 'Open in New Window') {
			vscode.commands.executeCommand('vscode.openFolder', projectUri, true);
		}
	};
}
