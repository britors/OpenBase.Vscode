import * as path from 'path';
import * as vscode from 'vscode';
import { dotnetToolsPath } from '../utils/paths';

export class TerminalService {

    open(
        name: string,
        cwd: string,
        command: string
    ): void {
        const extraPath = dotnetToolsPath();
        const currentPath = process.env.PATH ?? '';
        const terminal = vscode.window.createTerminal({
            name: `OpenBase: ${name}`,
            cwd,
            env: { PATH: `${extraPath}${path.delimiter}${currentPath}` },
        });
        terminal.show();
        terminal.sendText(command);
    }

}