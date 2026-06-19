import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { exec } from 'child_process';
import { Utils } from '../utils';
import { DbConnection, DbTemplate } from '../types';

export type TableItemKind = 'schema' | 'table' | 'procedure' | 'message';

export class SqlTableItem extends vscode.TreeItem {
    constructor(
        public readonly kind: TableItemKind,
        public readonly label: string,
        public readonly schema?: string,
        public readonly dbType?: DbTemplate,
    ) {
        const collapsible = kind === 'schema'
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;
        super(label, collapsible);
        this.contextValue = kind;
        this.iconPath = kind === 'schema' ? new vscode.ThemeIcon('symbol-namespace') : new vscode.ThemeIcon('table');
    }
}

export class SqlTableTreeProvider implements vscode.TreeDataProvider<SqlTableItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private schemas: Map<string, { tables: string[]; dbType: DbTemplate }> = new Map();
    private state: 'idle' | 'loading' | 'error' | 'noconn' = 'idle';
    private errorMsg = '';
    private treeView?: vscode.TreeView<SqlTableItem>;
    filterText = '';
    selectedSchema?: string;

    setTreeView(tv: vscode.TreeView<SqlTableItem>): void { this.treeView = tv; }

    setFilter(text: string): void {
        this.filterText = text.toLowerCase().trim();
        const total = Array.from(this.schemas.values()).reduce((s, v) => s + v.tables.length, 0);
        if (this.filterText) {
            const matches = Array.from(this.schemas.values())
                .reduce((s, v) => s + v.tables.filter(t => t.toLowerCase().includes(this.filterText)).length, 0);
            if (this.treeView) this.treeView.description = `${matches}/${total} tables`;
        } else {
            if (this.treeView) this.treeView.description = undefined;
        }
        this._onDidChangeTreeData.fire();
    }

    async refresh(schema?: string, findConnection?: (cwd: string) => DbConnection | undefined): Promise<void> {
        this.selectedSchema = schema;
        this.schemas.clear();
        this.state = 'loading';
        if (this.treeView) this.treeView.message = 'Loading tables…';
        this._onDidChangeTreeData.fire();

        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const conn = cwd && findConnection ? findConnection(cwd) : undefined;

        if (!conn) {
            this.state = 'noconn';
            if (this.treeView) this.treeView.message = 'No OpenBase project found in workspace.';
            this._onDidChangeTreeData.fire();
            return;
        }

        try {
            const data = await this.loadSqlTables(conn, this.selectedSchema);
            this.schemas = data;
            this.state = 'idle';
            const total = Array.from(data.values()).reduce((s, v) => s + v.tables.length, 0);
            if (this.treeView) this.treeView.message = total === 0 ? 'No tables found.' : undefined;
        } catch (e) {
            this.state = 'error';
            this.errorMsg = e instanceof Error ? e.message : String(e);
            if (this.treeView) this.treeView.message = undefined;
        }
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(e: SqlTableItem): vscode.TreeItem { return e; }

    getChildren(element?: SqlTableItem): vscode.ProviderResult<SqlTableItem[]> {
        if (this.state === 'loading') return [new SqlTableItem('message', 'Loading…')];
        if (this.state === 'error') return [new SqlTableItem('message', `Error: ${this.errorMsg}`)];
        if (this.state === 'noconn') return [];

        if (!element) {
            if (this.schemas.size === 0) return [];
            const filter = this.filterText;
            return Array.from(this.schemas.entries())
                .sort(([a], [b]) => a.localeCompare(b))
                .filter(([, { tables }]) => !filter || tables.some(t => t.toLowerCase().includes(filter)))
                .map(([schema, { tables }]) => {
                    const count = filter ? tables.filter(t => t.toLowerCase().includes(filter)).length : tables.length;
                    const item = new SqlTableItem('schema', `${schema}  (${count})`);
                    if (filter) item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
                    return item;
                });
        }

        if (element.kind === 'schema') {
            const schemaName = (element.label as string).replace(/\s+\(\d+\)$/, '');
            const entry = this.schemas.get(schemaName);
            if (!entry) return [];
            const filter = this.filterText;
            const tables = filter ? entry.tables.filter(t => t.toLowerCase().includes(filter)) : entry.tables;
            return tables.map(t => new SqlTableItem('table', t, schemaName, entry.dbType));
        }
        return [];
    }

    private async loadSqlTables(conn: DbConnection, targetSchema?: string): Promise<Map<string, { tables: string[]; procedures: string[]; functions: string[]; packages: string[]; dbType: DbTemplate }>> {
        const extraPath = Utils.getInstance().dotnetToolsPath();
        const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
        const tmpFile = path.join(os.tmpdir(), `ob_tables_${Date.now()}.sql`);
        let cmd = '';

        const HEADER_COLS = new Set(['table_schema', 'table_name', 'owner', 'tablename', 'tableschema']);

        try {
            // Implementation of query logic...
            return new Map();
        } finally {
            try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        }
    }
}
