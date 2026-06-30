import * as vscode from 'vscode';

export class WorkspaceService {

    async getWorkingDirectory(
        uri?: vscode.Uri
    ): Promise<string | undefined> {
        if (uri) return uri.fsPath;

        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length === 1) return folders[0].uri.fsPath;

        const picked = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Select project folder',
        });

        return picked?.[0]?.fsPath;
    }

    getDefaultWorkingDirectory(): string {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    }

}