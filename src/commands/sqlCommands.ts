import * as vscode from 'vscode';

export class SqlCommands {
    constructor(private context: vscode.ExtensionContext) {}

    register() {
        this.context.subscriptions.push(
            vscode.commands.registerCommand('openbase.sqlRunner.tables.refresh', () => this.refreshTables()),
            // ... add others
        );
    }

    private refreshTables() {
        // Implementation
    }
}
