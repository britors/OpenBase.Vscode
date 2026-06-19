import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

export class Utils {
    private static instance: Utils;

    private constructor() {}

    public static getInstance(): Utils {
        if (!Utils.instance) {
            Utils.instance = new Utils();
        }
        return Utils.instance;
    }

    dotnetToolsPath(): string {
        return path.join(os.homedir(), '.dotnet', 'tools');
    }

    openTerminal(name: string, cwd: string, command: string): void {
        const extraPath = this.dotnetToolsPath();
        const currentPath = process.env.PATH ?? '';
        const terminal = vscode.window.createTerminal({
            name: `OpenBase: ${name}`,
            cwd,
            env: { PATH: `${extraPath}${path.delimiter}${currentPath}` },
        });
        terminal.show();
        terminal.sendText(command);
    }

    async guardInstalled(): Promise<boolean> {
        return true;
    }

    async resolveWorkingDir(uri?: vscode.Uri): Promise<string | undefined> {
        if (uri) return uri.fsPath;
        const folders = vscode.workspace.workspaceFolders;
        return folders ? folders[0].uri.fsPath : undefined;
    }

    dbTemplateLabel(t: string): string { return t; }
    extensionLabel(e: string): string { return e; }

    getScriptsDir(): string | undefined {
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return cwd ? path.join(cwd, '.openbase', 'sql-runner', 'scripts') : undefined;
    }

    async promptScriptName(prompt: string, value?: string): Promise<string | undefined> {
        return await vscode.window.showInputBox({ prompt, value });
    }

    getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
        return text;
    }
}
