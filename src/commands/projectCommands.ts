import * as vscode from 'vscode';
import { Utils } from '../utils';
import { NEW_PROJECT_PREFS_KEY, BUILD_CONFIGS, extContext } from '../types';

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
        if (!await Utils.getInstance().guardInstalled()) return;
        // Logic implemented in extension.ts for now, need to be fully moved.
    }

    async scaffold(uri?: vscode.Uri): Promise<void> {
        if (!await Utils.getInstance().guardInstalled()) return;
        const entity = await vscode.window.showInputBox({ title: 'OpenBase: Scaffold', prompt: 'Entity name' });
        if (!entity) return;
        const cwd = await Utils.getInstance().resolveWorkingDir(uri);
        if (!cwd) return;
        Utils.getInstance().openTerminal('Scaffold', cwd, `openbase scaffold -e ${entity}`);
    }

    async scaffoldUpdate(uri?: vscode.Uri): Promise<void> {
        if (!await Utils.getInstance().guardInstalled()) return;
        const entity = await vscode.window.showInputBox({ title: 'OpenBase: Scaffold Update', prompt: 'Entity name' });
        if (!entity) return;
        const cwd = await Utils.getInstance().resolveWorkingDir(uri);
        if (!cwd) return;
        Utils.getInstance().openTerminal('Scaffold Update', cwd, `openbase scaffold -e ${entity} --update`);
    }

    async build(uri?: vscode.Uri): Promise<void> {
        if (!await Utils.getInstance().guardInstalled()) return;
        const config = await vscode.window.showQuickPick(BUILD_CONFIGS.map(c => ({ label: c })));
        if (!config) return;
        const cwd = await Utils.getInstance().resolveWorkingDir(uri);
        if (!cwd) return;
        Utils.getInstance().openTerminal('Build', cwd, `openbase build -c ${config.label}`);
    }

    async run(uri?: vscode.Uri): Promise<void> {
        if (!await Utils.getInstance().guardInstalled()) return;
        const cwd = await Utils.getInstance().resolveWorkingDir(uri);
        if (!cwd) return;
        Utils.getInstance().openTerminal('Run', cwd, `openbase run`);
    }

    async update(): Promise<void> {
        if (!await Utils.getInstance().guardInstalled()) return;
        Utils.getInstance().openTerminal('Update', process.cwd(), `openbase update`);
    }

    async history(): Promise<void> {
        if (!await Utils.getInstance().guardInstalled()) return;
        Utils.getInstance().openTerminal('History', process.cwd(), `openbase history`);
    }
}
