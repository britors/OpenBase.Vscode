import * as vscode from 'vscode';
import * as path from 'path';
import { execSync } from 'child_process';

const DB_TEMPLATES = ['sqlserver', 'pgsql', 'oracle'] as const;
type DbTemplate = typeof DB_TEMPLATES[number];

function isOpenBaseInstalled(): boolean {
    try {
        execSync('openbase --version', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

async function pickTargetFolder(): Promise<string | undefined> {
    const workspaceFolders = vscode.workspace.workspaceFolders;

    if (workspaceFolders && workspaceFolders.length === 1) {
        return workspaceFolders[0].uri.fsPath;
    }

    const uri = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select folder for new project',
    });

    return uri?.[0]?.fsPath;
}

async function newProject(): Promise<void> {
    if (!isOpenBaseInstalled()) {
        const install = 'Install OpenBase CLI';
        const choice = await vscode.window.showErrorMessage(
            'OpenBase CLI not found. Install it with: dotnet tool install -g w3ti.OpenBase.CLI',
            install
        );
        if (choice === install) {
            const terminal = vscode.window.createTerminal('OpenBase');
            terminal.show();
            terminal.sendText('dotnet tool install -g w3ti.OpenBase.CLI');
        }
        return;
    }

    const projectName = await vscode.window.showInputBox({
        title: 'OpenBase: New Project',
        prompt: 'Project name',
        placeHolder: 'MyProject',
        validateInput: (value) => {
            if (!value.trim()) return 'Project name is required';
            if (!/^[a-zA-Z0-9._-]+$/.test(value)) return 'Invalid project name';
            return undefined;
        },
    });

    if (!projectName) return;

    const template = await vscode.window.showQuickPick(
        DB_TEMPLATES.map((t): vscode.QuickPickItem => ({
            label: t,
            description: templateDescription(t),
        })),
        {
            title: 'OpenBase: Select database template',
            placeHolder: 'Choose a database',
        }
    );

    if (!template) return;

    const targetFolder = await pickTargetFolder();
    if (!targetFolder) return;

    const terminal = vscode.window.createTerminal({
        name: 'OpenBase: New Project',
        cwd: targetFolder,
    });

    terminal.show();
    terminal.sendText(`openbase new -n ${projectName} -s ${template.label}`);
}

function templateDescription(template: DbTemplate): string {
    switch (template) {
        case 'sqlserver': return 'SQL Server';
        case 'pgsql':     return 'PostgreSQL';
        case 'oracle':    return 'Oracle';
    }
}

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('openbase.newProject', newProject)
    );
}

export function deactivate(): void {}
