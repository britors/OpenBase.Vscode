import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Utils } from '../utils';

export type ScriptItemKind = 'folder' | 'script';

export class SqlScriptItem extends vscode.TreeItem {
    constructor(
        public readonly fsPath: string,
        public readonly kind: ScriptItemKind,
    ) {
        const basename = path.basename(fsPath);
        const label = kind === 'script' ? basename.replace(/\.sql$/i, '') : basename;
        super(label, kind === 'folder'
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None);
        this.contextValue = kind;
        this.tooltip = basename;
        this.iconPath = kind === 'script' ? new vscode.ThemeIcon('file-code') : vscode.ThemeIcon.Folder;
    }
}

export class SqlScriptTreeProvider implements vscode.TreeDataProvider<SqlScriptItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SqlScriptItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh(): void { this._onDidChangeTreeData.fire(); }

    getTreeItem(e: SqlScriptItem): vscode.TreeItem { return e; }

    getChildren(element?: SqlScriptItem): vscode.ProviderResult<SqlScriptItem[]> {
        const dir = element ? element.fsPath : Utils.getInstance().getScriptsDir();
        if (!dir || !fs.existsSync(dir)) return [];
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            const folders = entries
                .filter(e => e.isDirectory())
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(e => new SqlScriptItem(path.join(dir, e.name), 'folder'));
            const scripts = entries
                .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.sql'))
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(e => new SqlScriptItem(path.join(dir, e.name), 'script'));
            return [...folders, ...scripts];
        } catch { return []; }
    }
}
