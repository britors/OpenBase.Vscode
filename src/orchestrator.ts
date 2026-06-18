import * as vscode from 'vscode';
import { ProjectCommands } from './commands/projectCommands';
import { SqlTableTreeProvider } from './providers/sqlTableProvider';
import { SqlScriptTreeProvider } from './providers/sqlScriptProvider';

export class ExtensionOrchestrator {
    private sqlTableProvider?: SqlTableTreeProvider;
    private sqlScriptProvider?: SqlScriptTreeProvider;

    constructor(private context: vscode.ExtensionContext) {}

    activate(): void {
        this.setupComponents();
        this.registerCommands();
    }

    private setupComponents(): void {
        this.setupStatusBar();
        this.setupSqlTableBrowser();
        this.setupSqlScriptLibrary();
    }

    private registerCommands(): void {
        new ProjectCommands(this.context).register();
    }

    private setupStatusBar(): void {
        const connItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        connItem.command = 'openbase.sqlRunner';

        const activeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
        activeItem.text = '$(rocket) OpenBase';
        activeItem.tooltip = 'OpenBase CLI';
        activeItem.show();

        const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 102);
        statusItem.text = '$(sync~spin) OpenBase: Idle';
        statusItem.show();

        this.context.subscriptions.push(connItem, activeItem, statusItem);
    }

    private setupSqlTableBrowser(): void {
        this.sqlTableProvider = new SqlTableTreeProvider();

        const treeView = vscode.window.createTreeView('openbase.sqlrunner.tables', {
            treeDataProvider: this.sqlTableProvider,
            showCollapseAll: true,
        });
        this.sqlTableProvider.setTreeView(treeView);
        this.context.subscriptions.push(treeView);

        this.context.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.sqlTableProvider?.refresh()),
        );
    }

    private setupSqlScriptLibrary(): void {
        this.sqlScriptProvider = new SqlScriptTreeProvider();
        const treeView = vscode.window.createTreeView('openbase.sqlrunner.scripts', {
            treeDataProvider: this.sqlScriptProvider,
            showCollapseAll: true,
        });
        this.context.subscriptions.push(treeView);
        
        this.context.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.sqlScriptProvider?.refresh()),
            vscode.commands.registerCommand('openbase.sqlRunner.scripts.refresh', () => this.sqlScriptProvider?.refresh())
        );
    }
}
