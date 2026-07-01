import * as path from 'path';
import * as vscode from 'vscode';
import { DbConnection } from '../models/dbConnection';

export interface StatusBarProviderDeps {
    findConnection: (cwd: string) => DbConnection | undefined;
}

export function setupStatusBar(context: vscode.ExtensionContext, deps: StatusBarProviderDeps): void {
    const connItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    connItem.command = 'openbase.sqlRunner';

    const activeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    activeItem.text = '$(rocket) OpenBase';
    activeItem.tooltip = 'OpenBase CLI';
    activeItem.show();

    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 102);
    statusItem.text = '$(sync~spin) OpenBase: Idle';
    statusItem.show();

    context.subscriptions.push(connItem, activeItem, statusItem);

    const refresh = (): void => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            connItem.hide();
            activeItem.text = '$(rocket) OpenBase (No project)';
            statusItem.text = '$(error) OpenBase: Inactive';
            return;
        }

        activeItem.text = `$(rocket) OpenBase: ${path.basename(folder.uri.fsPath)}`;
        statusItem.text = '$(check) OpenBase: Ready';

        const conn = deps.findConnection(folder.uri.fsPath);
        if (!conn) {
            connItem.text = '$(database) No Connection';
            connItem.tooltip = 'No database connection configured';
        } else {
            connItem.text = `$(database) ${conn.label}`;
            connItem.tooltip = `Connected to: ${conn.server}/${conn.database}`;
        }
        connItem.show();
    };

    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(refresh),
        vscode.window.onDidChangeActiveTextEditor(refresh)
    );

    refresh();
}
