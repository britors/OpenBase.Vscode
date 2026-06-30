import * as childProcess from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { dotnetToolsPath } from '../utils/paths';
import { TerminalService } from './terminal.service';

export class OpenBaseCliService {

    constructor(
        private readonly terminalService: TerminalService
    ) {}

    private envWithDotnetTools(): NodeJS.ProcessEnv {
        const extraPath = dotnetToolsPath();
        return { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
    }

    isInstalled(): boolean {
        try {
            childProcess.execSync('openbase --help', { stdio: 'ignore', env: this.envWithDotnetTools() });
            return true;
        } catch {
            return false;
        }
    }

    async ensureInstalled(): Promise<boolean> {
        if (this.isInstalled()) return true;

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

        return false;
    }

    runInTerminal(name: string, cwd: string, command: string): void {
        this.terminalService.open(name, cwd, command);
    }

    async executeInOutputChannel(cmd: string, cwd: string, channelName: string): Promise<boolean> {
        const channel = vscode.window.createOutputChannel(channelName);
        channel.show(true);

        return new Promise<boolean>((resolve) => {
            const child = childProcess.exec(cmd, { cwd, env: this.envWithDotnetTools() });
            child.stdout?.on('data', (d: string) => channel.append(d));
            child.stderr?.on('data', (d: string) => channel.append(d));
            child.on('close', (code) => resolve(code === 0));
            child.on('error', (err) => {
                channel.appendLine(err.message);
                resolve(false);
            });
        });
    }

    getVersion(): string | undefined {
        try {
            return childProcess.execSync('openbase version show', { encoding: 'utf-8', env: this.envWithDotnetTools() }).trim();
        } catch {
            return undefined;
        }
    }

}