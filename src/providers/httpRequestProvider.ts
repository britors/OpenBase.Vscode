import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Utils } from '../utils';

export interface HttpRequestData {
    method?: string;
    url?: string;
    headers?: Array<{name: string; value: string}>;
    bodyType?: string;
    body?: string;
    authToken?: string;
}

export class HttpRequestItem extends vscode.TreeItem {
    constructor(
        public readonly fsPath: string,
        public readonly kind: 'folder' | 'script',
    ) {
        const basename = path.basename(fsPath);
        const label = kind === 'script' ? basename.replace(/\.json$/i, '') : basename;
        super(label, kind === 'folder'
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None);
        this.contextValue = kind;
        this.tooltip = basename;
        if (kind === 'script') {
            this.command = {
                command: 'openbase.httpRunner.requests.open',
                title: 'Open in HTTP Runner',
                arguments: [this],
            };
            this.iconPath = new vscode.ThemeIcon('globe');
        } else {
            this.iconPath = vscode.ThemeIcon.Folder;
        }
    }
}

export class HttpRequestTreeProvider implements vscode.TreeDataProvider<HttpRequestItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<HttpRequestItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh(): void { this._onDidChangeTreeData.fire(); }

    getTreeItem(e: HttpRequestItem): vscode.TreeItem { return e; }

    getChildren(element?: HttpRequestItem): vscode.ProviderResult<HttpRequestItem[]> {
        const dir = element ? element.fsPath : Utils.getInstance().getScriptsDir(); // Simplified, need to update to request-specific path
        if (!dir || !fs.existsSync(dir)) return [];
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            const folders = entries
                .filter(e => e.isDirectory())
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(e => new HttpRequestItem(path.join(dir, e.name), 'folder'));
            const files = entries
                .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.json'))
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(e => new HttpRequestItem(path.join(dir, e.name), 'script'));
            return [...folders, ...files];
        } catch { return []; }
    }
}
