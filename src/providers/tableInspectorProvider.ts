import * as path from 'path';
import * as vscode from 'vscode';
import { DbConnection } from '../models/dbConnection';
import { DbTemplate } from '../models/dbTemplate';
import {
    buildErDiagramHtml,
    buildErDiagramLoadingHtml,
    buildTableInspectorErrorHtml,
    buildTableInspectorHtml,
    buildTableInspectorLoadingHtml,
    ErTableData,
} from './tableInspectorHtml';
import {
    detectScaffoldEntity,
    loadTableDetails,
    tableToPascalCase,
} from './tableInspectorRuntimeProvider';

type SqlObjects = {
    tables: string[];
    procedures: string[];
    functions: string[];
    packages: string[];
    dbType: DbTemplate;
};

export interface TableInspectorProviderDeps {
    findConnection: (cwd: string) => DbConnection | undefined;
    loadSqlTables: (conn: DbConnection, targetSchema?: string) => Promise<Map<string, SqlObjects>>;
    openScriptInSqlRunner: (content: string) => Promise<void>;
    openTerminal: (name: string, cwd: string, command: string) => void;
    getNonce: () => string;
    dotnetToolsPath: () => string;
}

export interface TableInspectorProviderHandlers {
    openTableInspector: (conn: DbConnection, schema: string, table: string, dbType: DbTemplate) => Promise<void>;
    openErDiagram: () => Promise<void>;
}

export function createTableInspectorProvider(deps: TableInspectorProviderDeps): TableInspectorProviderHandlers {
    const tableInspectorPanels = new Map<string, vscode.WebviewPanel>();
    let erDiagramPanel: vscode.WebviewPanel | undefined;

    const openTableInspector = async (
        conn: DbConnection,
        schema: string,
        table: string,
        dbType: DbTemplate,
    ): Promise<void> => {
        const key = `${schema}.${table}`;
        const existing = tableInspectorPanels.get(key);
        if (existing) {
            existing.reveal(vscode.ViewColumn.Two);
            return;
        }

        const nonce = deps.getNonce();
        const panel = vscode.window.createWebviewPanel(
            'openbase.tableInspector',
            `${schema}.${table}`,
            vscode.ViewColumn.Two,
            { enableScripts: true, retainContextWhenHidden: true },
        );

        tableInspectorPanels.set(key, panel);

        let scaffoldWatcher: vscode.FileSystemWatcher | undefined;
        panel.onDidDispose(() => {
            scaffoldWatcher?.dispose();
            tableInspectorPanels.delete(key);
        });

        panel.webview.html = buildTableInspectorLoadingHtml(nonce, panel.webview.cspSource, schema, table);

        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        panel.webview.onDidReceiveMessage(async (msg: { command: string; entity?: string }) => {
            if (msg.command === 'runSelect') {
                const sql = buildSelectQuery(schema, table, dbType);
                await deps.openScriptInSqlRunner(sql);
                return;
            }
            if (msg.command === 'scaffold' || msg.command === 'scaffoldUpdate') {
                if (!cwd) {
                    vscode.window.showErrorMessage('No workspace folder open.');
                    return;
                }
                const isUpdate = msg.command === 'scaffoldUpdate';
                const inputEntity = await vscode.window.showInputBox({
                    title: isUpdate ? 'OpenBase: Update Scaffold' : 'OpenBase: Scaffold',
                    prompt: 'Entity name (PascalCase)',
                    value: msg.entity ?? '',
                    validateInput: (v) => {
                        if (!v?.trim()) return 'Entity name is required';
                        if (!/^[A-Z][a-zA-Z0-9]*$/.test(v.trim())) return 'Must be PascalCase (e.g. Product)';
                        return undefined;
                    },
                });
                if (!inputEntity) return;
                const args = [`-e ${inputEntity}`, `--schema "${schema}"`, `--table "${table}"`];
                if (isUpdate) args.push('--update');
                else args.push('--mode modelfirst');
                deps.openTerminal(isUpdate ? 'Scaffold Update' : 'Scaffold', cwd, `openbase scaffold ${args.join(' ')}`);
            }
        });

        const renderPanel = async (hasScaffold: boolean, entityName: string) => {
            const details = await loadTableDetails(conn, schema, table, deps.dotnetToolsPath);
            panel.webview.html = buildTableInspectorHtml(
                nonce,
                panel.webview.cspSource,
                schema,
                table,
                dbType,
                details.columns,
                details.constraints,
                entityName,
                hasScaffold,
            );
        };

        try {
            const [details, scaffoldEntity] = await Promise.all([
                loadTableDetails(conn, schema, table, deps.dotnetToolsPath),
                cwd ? detectScaffoldEntity(cwd, table) : Promise.resolve(undefined),
            ]);
            const entityName = scaffoldEntity ?? tableToPascalCase(table);
            const hasScaffold = scaffoldEntity !== undefined;
            panel.webview.html = buildTableInspectorHtml(
                nonce,
                panel.webview.cspSource,
                schema,
                table,
                dbType,
                details.columns,
                details.constraints,
                entityName,
                hasScaffold,
            );

            if (!hasScaffold && cwd) {
                scaffoldWatcher = vscode.workspace.createFileSystemWatcher(
                    new vscode.RelativePattern(vscode.Uri.file(cwd), 'src/**/Configurations/*Configuration.cs'),
                );
                const checkAndFlip = async (uri: vscode.Uri) => {
                    try {
                        const bytes = await vscode.workspace.fs.readFile(uri);
                        if (!Buffer.from(bytes).toString('utf-8').includes(`ToTable("${table}")`)) return;
                        const m = path.basename(uri.fsPath).match(/^(.+)Configuration\.cs$/);
                        if (!m) return;
                        scaffoldWatcher?.dispose();
                        scaffoldWatcher = undefined;
                        await renderPanel(true, m[1]);
                    } catch {
                        // ignore watcher read errors
                    }
                };
                scaffoldWatcher.onDidCreate(checkAndFlip);
                scaffoldWatcher.onDidChange(checkAndFlip);
            }
        } catch (e) {
            panel.webview.html = buildTableInspectorErrorHtml(
                nonce,
                panel.webview.cspSource,
                schema,
                table,
                e instanceof Error ? e.message : String(e),
            );
        }
    };

    const openErDiagram = async (): Promise<void> => {
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const conn = cwd ? deps.findConnection(cwd) : undefined;
        if (!conn) {
            vscode.window.showErrorMessage('No database connection found in workspace.');
            return;
        }

        if (erDiagramPanel) {
            erDiagramPanel.reveal(vscode.ViewColumn.One);
            return;
        }

        const nonce = deps.getNonce();
        erDiagramPanel = vscode.window.createWebviewPanel(
            'openbase.erDiagram',
            'ER Diagram',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        erDiagramPanel.onDidDispose(() => {
            erDiagramPanel = undefined;
        });
        erDiagramPanel.webview.html = buildErDiagramLoadingHtml(nonce, erDiagramPanel.webview.cspSource);

        erDiagramPanel.webview.onDidReceiveMessage(async (msg: { command: string; schema?: string; table?: string; svg?: string }) => {
            if (msg.command === 'inspect' && msg.schema && msg.table) {
                await openTableInspector(conn, msg.schema, msg.table, conn.type as DbTemplate);
            } else if (msg.command === 'exportSvg' && msg.svg) {
                const uri = await vscode.window.showSaveDialog({
                    filters: { 'SVG Image': ['svg'] },
                    defaultUri: vscode.Uri.file('er-diagram.svg'),
                });
                if (uri) {
                    await vscode.workspace.fs.writeFile(uri, Buffer.from(msg.svg, 'utf-8'));
                    vscode.window.showInformationMessage(`ER Diagram exported to ${uri.fsPath}`);
                }
            }
        });

        try {
            const schemas = await deps.loadSqlTables(conn);
            const allTables: Array<{ schema: string; table: string }> = [];
            for (const [schema, { tables }] of schemas) {
                for (const table of tables) {
                    allTables.push({ schema, table });
                }
            }

            const BATCH = 8;
            const erTables: ErTableData[] = [];
            for (let i = 0; i < allTables.length; i += BATCH) {
                const batch = allTables.slice(i, i + BATCH);
                const results = await Promise.all(batch.map(async ({ schema, table }) => {
                    try {
                        const details = await loadTableDetails(conn, schema, table, deps.dotnetToolsPath);
                        const pkCols = new Set(details.constraints.filter((c) => c.type === 'PRIMARY KEY').map((c) => c.column));
                        const fkCols = new Set(details.constraints.filter((c) => c.type === 'FOREIGN KEY').map((c) => c.column));
                        return {
                            schema,
                            name: table,
                            columns: details.columns.map((col) => ({
                                name: col.name,
                                type: col.type,
                                pk: pkCols.has(col.name),
                                fk: fkCols.has(col.name),
                            })),
                            fks: details.constraints
                                .filter((c) => c.type === 'FOREIGN KEY' && c.refTable)
                                .map((c) => ({ toSchema: c.refSchema, toTable: c.refTable })),
                        };
                    } catch {
                        return { schema, name: table, columns: [], fks: [] };
                    }
                }));
                erTables.push(...results);
            }

            if (erDiagramPanel) {
                erDiagramPanel.webview.html = buildErDiagramHtml(nonce, erDiagramPanel.webview.cspSource, erTables);
            }
        } catch (e) {
            vscode.window.showErrorMessage(`ER Diagram failed: ${e instanceof Error ? e.message : String(e)}`);
            erDiagramPanel?.dispose();
        }
    };

    return { openTableInspector, openErDiagram };
}

function buildSelectQuery(schema: string, table: string, dbType: DbTemplate): string {
    switch (dbType) {
        case 'sqlserver':
            return `SELECT TOP 100 *\nFROM [${schema}].[${table}]`;
        case 'pgsql':
            return `SELECT *\nFROM "${schema}"."${table}"\nLIMIT 100`;
        case 'oracle':
            return `SELECT *\nFROM "${schema}"."${table}"\nWHERE ROWNUM <= 100`;
    }
}
