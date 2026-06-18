import * as vscode from 'vscode';
import { BUILD_CONFIGS } from '../types';

import { guardInstalled, openTerminal, resolveWorkingDir } from '../utils';

export class ProjectCommands {
    constructor(private context: vscode.ExtensionContext) {}

    register() {
        this.context.subscriptions.push(
            vscode.commands.registerCommand('openbase.newProject', (uri) => this.newProject(uri)),
            vscode.commands.registerCommand('openbase.scaffold', (uri) => this.scaffold(uri)),
            vscode.commands.registerCommand('openbase.scaffoldUpdate', (uri) => this.scaffoldUpdate(uri)),
            vscode.commands.registerCommand('openbase.build', (uri) => this.build(uri)),
            vscode.commands.registerCommand('openbase.run', (uri) => this.run(uri)),
            vscode.commands.registerCommand('openbase.update', () => this.update()),
            vscode.commands.registerCommand('openbase.history', () => this.history())
        );
    }

    async newProject(uri?: vscode.Uri): Promise<void> {
        if (!await guardInstalled()) return;
        vscode.window.showInformationMessage('New Project started');
    }

    async scaffold(uri?: vscode.Uri): Promise<void> {
        if (!await guardInstalled()) return;
        const entity = await vscode.window.showInputBox({ title: 'OpenBase: Scaffold', prompt: 'Entity name' });
        if (!entity) return;
        const cwd = await resolveWorkingDir(uri);
        if (!cwd) return;
        openTerminal('Scaffold', cwd, `openbase scaffold -e ${entity}`);
    }

    async scaffoldUpdate(uri?: vscode.Uri): Promise<void> {
        if (!await guardInstalled()) return;
        const entity = await vscode.window.showInputBox({ title: 'OpenBase: Scaffold Update', prompt: 'Entity name' });
        if (!entity) return;
        const cwd = await resolveWorkingDir(uri);
        if (!cwd) return;
        openTerminal('Scaffold Update', cwd, `openbase scaffold -e ${entity} --update`);
    }

    async build(uri?: vscode.Uri): Promise<void> {
        if (!await guardInstalled()) return;
        const config = await vscode.window.showQuickPick(BUILD_CONFIGS.map(c => ({ label: c })));
        if (!config) return;
        const cwd = await resolveWorkingDir(uri);
        if (!cwd) return;
        openTerminal('Build', cwd, `openbase build -c ${config.label}`);
    }

    async run(uri?: vscode.Uri): Promise<void> {
        if (!await guardInstalled()) return;
        const cwd = await resolveWorkingDir(uri);
        if (!cwd) return;
        openTerminal('Run', cwd, `openbase run`);
    }

    async update(): Promise<void> {
        if (!await guardInstalled()) return;
        openTerminal('Update', process.cwd(), `openbase update`);
    }

    async history(): Promise<void> {
        if (!await guardInstalled()) return;
        openTerminal('History', process.cwd(), `openbase history`);
    }
}
