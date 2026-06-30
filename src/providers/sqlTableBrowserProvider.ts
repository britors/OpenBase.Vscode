import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exec } from 'child_process';
import * as vscode from 'vscode';
import { DbConnection } from '../models/dbConnection';
import { DbTemplate } from '../models/dbTemplate';

type TableItemKind = 'schema' | 'table' | 'procedure' | 'message';

class SqlTableItem extends vscode.TreeItem {
    constructor(
        public readonly kind: TableItemKind,
        label: string,
        public readonly schema?: string,
        public readonly dbType?: DbTemplate
    ) {
        const collapsible = kind === 'schema' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
        super(label, collapsible);
        this.contextValue = kind;

        if (kind === 'schema') {
            this.iconPath = new vscode.ThemeIcon('symbol-namespace');
        } else if (kind === 'table') {
            this.iconPath = new vscode.ThemeIcon('table');
            this.tooltip = `${schema}.${label}`;
            this.command = {
                command: 'openbase.sqlRunner.tables.inspect',
                title: 'Inspect Table',
                arguments: [this],
            };
        } else if (kind === 'procedure') {
            this.iconPath = new vscode.ThemeIcon('symbol-method');
            this.tooltip = `${schema}.${label}`;
        } else {
            this.iconPath = new vscode.ThemeIcon('info');
        }
    }
}

class SqlTableTreeProvider implements vscode.TreeDataProvider<SqlTableItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private schemas: Map<string, { tables: string[]; dbType: DbTemplate }> = new Map();
    private state: 'idle' | 'loading' | 'error' | 'noconn' = 'idle';
    private errorMsg = '';
    private treeView?: vscode.TreeView<SqlTableItem>;
    filterText = '';
    selectedSchema?: string;

    constructor(
        private readonly findConnection: (cwd: string) => DbConnection | undefined,
        private readonly loadSqlTables: (
            conn: DbConnection,
            targetSchema?: string
        ) => Promise<Map<string, { tables: string[]; procedures: string[]; functions: string[]; packages: string[]; dbType: DbTemplate }>>
    ) {}

    setTreeView(tv: vscode.TreeView<SqlTableItem>): void {
        this.treeView = tv;
    }

    setFilter(text: string): void {
        this.filterText = text.toLowerCase().trim();
        const total = Array.from(this.schemas.values()).reduce((s, v) => s + v.tables.length, 0);
        if (this.filterText) {
            const matches = Array.from(this.schemas.values()).reduce(
                (s, v) => s + v.tables.filter((t) => t.toLowerCase().includes(this.filterText)).length,
                0
            );
            if (this.treeView) this.treeView.description = `${matches}/${total} tables`;
        } else {
            if (this.treeView) this.treeView.description = undefined;
        }
        this._onDidChangeTreeData.fire();
    }

    async refresh(schema?: string): Promise<void> {
        this.selectedSchema = schema;
        this.schemas.clear();
        this.state = 'loading';
        if (this.treeView) this.treeView.message = 'Loading tables...';
        this._onDidChangeTreeData.fire();

        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const conn = cwd ? this.findConnection(cwd) : undefined;

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

    getTreeItem(e: SqlTableItem): vscode.TreeItem {
        return e;
    }

    getChildren(element?: SqlTableItem): vscode.ProviderResult<SqlTableItem[]> {
        if (this.state === 'loading') return [new SqlTableItem('message', 'Loading...')];
        if (this.state === 'error') return [new SqlTableItem('message', `Error: ${this.errorMsg}`)];
        if (this.state === 'noconn') return [];

        if (!element) {
            if (this.schemas.size === 0) return [];
            const filter = this.filterText;
            return Array.from(this.schemas.entries())
                .sort(([a], [b]) => a.localeCompare(b))
                .filter(([, { tables }]) => !filter || tables.some((t) => t.toLowerCase().includes(filter)))
                .map(([schema, { tables }]) => {
                    const count = filter ? tables.filter((t) => t.toLowerCase().includes(filter)).length : tables.length;
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
            const tables = filter ? entry.tables.filter((t) => t.toLowerCase().includes(filter)) : entry.tables;
            return tables.map((t) => new SqlTableItem('table', t, schemaName, entry.dbType));
        }
        return [];
    }
}

export interface SqlTableBrowserProviderDeps {
    findConnection: (cwd: string) => DbConnection | undefined;
    loadSqlTables: (
        conn: DbConnection,
        targetSchema?: string
    ) => Promise<Map<string, { tables: string[]; procedures: string[]; functions: string[]; packages: string[]; dbType: DbTemplate }>>;
    buildSelectQuery: (schema: string, table: string, dbType: DbTemplate) => string;
    openScriptInSqlRunner: (name: string, content: string) => Promise<void>;
    openTableInspector: (conn: DbConnection, schema: string, table: string, dbType: DbTemplate) => Promise<void>;
    openErDiagram: () => Promise<void>;
    dotnetToolsPath: () => string;
}

export function setupSqlTableBrowser(context: vscode.ExtensionContext, deps: SqlTableBrowserProviderDeps): void {
    const sqlTableProvider = new SqlTableTreeProvider(deps.findConnection, deps.loadSqlTables);

    const treeView = vscode.window.createTreeView('openbase.sqlrunner.tables', {
        treeDataProvider: sqlTableProvider,
        showCollapseAll: true,
    });
    sqlTableProvider.setTreeView(treeView);
    context.subscriptions.push(treeView);

    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => void sqlTableProvider.refresh()),
        vscode.commands.registerCommand('openbase.sqlRunner.tables.changeSchema', async () => {
            const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const conn = cwd ? deps.findConnection(cwd) : undefined;
            if (!conn) {
                vscode.window.showErrorMessage('No connection found.');
                return;
            }

            let schemas: string[] = [];
            const tmpFile = path.join(os.tmpdir(), `ob_schemas_${Date.now()}.sql`);
            const extraPath = deps.dotnetToolsPath();
            const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };

            try {
                if (conn.type === 'oracle') {
                    const q =
                        "SET PAGESIZE 0\nSET FEEDBACK OFF\nSET HEADING OFF\nSELECT DISTINCT username FROM all_users ORDER BY username;\nEXIT\n";
                    fs.writeFileSync(tmpFile, q, 'utf-8');
                    const cmd = `sqlplus -S "${conn.user}/${conn.password ?? ''}@${conn.server}" @"${tmpFile}"`;
                    const stdout = await new Promise<string>((resolve, reject) => {
                        exec(cmd, { env }, (err, out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(out)));
                    });
                    schemas = stdout
                        .trim()
                        .split('\n')
                        .filter((s) => s.trim() && !s.includes('USERNAME'))
                        .map((s) => s.trim());
                } else if (conn.type === 'pgsql') {
                    const q =
                        "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog','information_schema') ORDER BY schema_name";
                    fs.writeFileSync(tmpFile, q, 'utf-8');
                    const port = conn.port ?? '5432';
                    const u = encodeURIComponent(conn.user ?? 'postgres');
                    const p = encodeURIComponent(conn.password ?? '');
                    const cmd = `psql "postgresql://${u}:${p}@${conn.server}:${port}/${conn.database}" -t -A -f "${tmpFile}"`;
                    const stdout = await new Promise<string>((resolve, reject) => {
                        exec(cmd, { env }, (err, out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(out)));
                    });
                    schemas = stdout
                        .trim()
                        .split('\n')
                        .filter((s) => s.trim())
                        .map((s) => s.trim());
                } else if (conn.type === 'sqlserver') {
                    const q = "SELECT name FROM sys.schemas WHERE name NOT IN ('sys', 'information_schema', 'guest') ORDER BY name";
                    fs.writeFileSync(tmpFile, q, 'utf-8');
                    const parts = ['sqlcmd', `-S "${conn.server}"`, `-d "${conn.database}"`];
                    if (conn.user) parts.push(`-U "${conn.user}"`);
                    if (conn.password) parts.push(`-P "${conn.password}"`);
                    parts.push(`-i "${tmpFile}" -W -h -1`);
                    const cmd = parts.join(' ');
                    const stdout = await new Promise<string>((resolve, reject) => {
                        exec(cmd, { env }, (err, out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(out)));
                    });
                    schemas = stdout
                        .trim()
                        .split('\n')
                        .filter((s) => s.trim())
                        .map((s) => s.trim());
                }

                const selected = await vscode.window.showQuickPick(schemas, { placeHolder: 'Select a schema' });
                if (selected) {
                    await sqlTableProvider.refresh(selected);
                }
            } catch (e) {
                vscode.window.showErrorMessage('Failed to fetch schemas: ' + (e instanceof Error ? e.message : String(e)));
            } finally {
                try {
                    fs.unlinkSync(tmpFile);
                } catch {
                    // ignore cleanup errors
                }
            }
        }),
        vscode.commands.registerCommand('openbase.sqlRunner.tables.refresh', () => void sqlTableProvider.refresh()),
        vscode.commands.registerCommand('openbase.sqlRunner.tables.select', async (item: SqlTableItem) => {
            if (item.kind !== 'table' || !item.schema || !item.dbType) return;
            const sql = deps.buildSelectQuery(item.schema, item.label as string, item.dbType);
            await deps.openScriptInSqlRunner('', sql);
        }),
        vscode.commands.registerCommand('openbase.sqlRunner.tables.inspect', async (item: SqlTableItem) => {
            if (item.kind !== 'table' || !item.schema || !item.dbType) return;
            const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const conn = cwd ? deps.findConnection(cwd) : undefined;
            if (!conn) {
                vscode.window.showErrorMessage('No database connection found in workspace.');
                return;
            }
            await deps.openTableInspector(conn, item.schema, item.label as string, item.dbType);
        }),
        vscode.commands.registerCommand('openbase.sqlRunner.erDiagram', () => void deps.openErDiagram()),
        vscode.commands.registerCommand('openbase.sqlRunner.tables.filter', () => {
            const inputBox = vscode.window.createInputBox();
            inputBox.placeholder = 'Filter tables...';
            inputBox.value = sqlTableProvider.filterText;
            inputBox.onDidChangeValue((text) => sqlTableProvider.setFilter(text));
            inputBox.onDidAccept(() => inputBox.hide());
            inputBox.onDidHide(() => inputBox.dispose());
            inputBox.show();
        }),
        vscode.commands.registerCommand('openbase.sqlRunner.tables.clearFilter', () => {
            sqlTableProvider.setFilter('');
        })
    );

    void sqlTableProvider.refresh();
}
