import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DbConnection } from '../models/dbConnection';
import { SqlRunnerService } from '../services/sqlRunner.service';
import { DbNativeClientService } from '../services/dbNativeClient.service';
import { buildSqlRunnerHtml } from './sqlRunnerHtml';

type CompletionItem = { schema: string; name: string; kind: 'table' | 'function' | 'procedure' };

const SQL_HISTORY_KEY = 'sqlQueryHistory';
const SQL_HISTORY_LIMIT = 50;
const SQL_AUTOSAVE_KEY = 'sqlRunnerAutoSave';

interface HistoryEntry {
    sql: string;
    timestamp: number;
    connectionLabel: string;
    rowCount: number;
}

export interface SqlRunnerProviderDeps {
    context: vscode.ExtensionContext;
    findConnection: (cwd: string) => DbConnection | undefined;
    getScriptsDir: () => string | undefined;
    onScriptSaved: () => void;
    onSendToSpecialist: (sql: string) => Promise<void>;
    sqlRunnerService: SqlRunnerService;
}

export class SqlRunnerProvider {
    private panel: vscode.WebviewPanel | undefined;
    private log: vscode.OutputChannel | undefined;
    private pendingScript: { content: string; name: string } | undefined;
    private readonly dbNative = new DbNativeClientService();
    private completionCache: CompletionItem[] = [];

    constructor(private readonly deps: SqlRunnerProviderDeps) {}

    private out(): vscode.OutputChannel {
        if (!this.log) this.log = vscode.window.createOutputChannel('OpenBase SQL Runner (Debug)');
        return this.log;
    }

    async open(): Promise<void> {
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const conn = cwd ? this.deps.findConnection(cwd) : undefined;

        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.One);
            return;
        }

        this.out().appendLine(`[SQL Runner] Opening panel. cwd=${cwd ?? '(none)'}`);
        this.out().appendLine(`[SQL Runner] Connection detected: ${conn ? conn.label : '(none)'}`);

        this.panel = vscode.window.createWebviewPanel(
            'openbase.sqlRunner',
            'OpenBase SQL',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.out().appendLine('[SQL Runner] Panel disposed.');
        });

        const sqlNonce = this.getNonce();
        this.panel.webview.html = buildSqlRunnerHtml(conn, sqlNonce, this.panel.webview.cspSource);

        const savedSql = this.deps.context.globalState.get<string>(SQL_AUTOSAVE_KEY);
        if (savedSql && !this.pendingScript) {
            this.pendingScript = { content: savedSql, name: 'autosave' };
        }

        this.panel.webview.onDidReceiveMessage(async (msg: { command: string; sql?: string; csvData?: string; csvName?: string; table?: string; keyColumn?: string; keyValue?: string; column?: string; newValue?: string }) => {
            await this.handleMessage(msg);
        });
    }

    async openScript(content: string, name: string): Promise<void> {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.One);
            this.panel.webview.postMessage({ command: 'loadScript', content, name });
            return;
        }

        this.pendingScript = { content, name };
        await this.open();
    }

    triggerRun(): void {
        this.panel?.webview.postMessage({ command: 'triggerRun' });
    }

    private getNonce(): string {
        let text = '';
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
        return text;
    }

    private async handleMessage(msg: { command: string; sql?: string; csvData?: string; csvName?: string; table?: string; keyColumn?: string; keyValue?: string; column?: string; newValue?: string }): Promise<void> {
        this.out().appendLine(`[SQL Runner] Message received: ${msg.command}`);

        if (msg.command === 'autoSave' && msg.sql) {
            const autoSaveEnabled = vscode.workspace.getConfiguration('openbase').get('editor.autoSave', true);
            if (autoSaveEnabled) {
                await this.deps.context.globalState.update(SQL_AUTOSAVE_KEY, msg.sql);
            }
            return;
        }

        if (msg.command === 'ready') {
            if (this.pendingScript) {
                const pending = this.pendingScript;
                this.pendingScript = undefined;
                this.panel?.webview.postMessage({ command: 'loadScript', content: pending.content, name: pending.name });
            }
            const historyEntries = this.deps.context.globalState.get<HistoryEntry[]>(SQL_HISTORY_KEY) ?? [];
            this.panel?.webview.postMessage({ command: 'loadHistory', entries: historyEntries });
            void this.preloadCompletions();
            return;
        }

        if (msg.command === 'refreshCompletions') {
            this.completionCache = [];
            void this.preloadCompletions();
            return;
        }

        if (msg.command === 'saveScript') {
            const scriptsDir = this.deps.getScriptsDir();
            if (!scriptsDir) {
                vscode.window.showErrorMessage('No workspace folder open.');
                return;
            }
            if (!msg.sql?.trim()) return;

            const name = await vscode.window.showInputBox({
                prompt: 'Save script as',
                placeHolder: 'my-query',
                validateInput: (v) => v?.trim() && /^[^\\/:\*\?"<>\|]+$/.test(v.trim()) ? undefined : 'Invalid name',
            });
            if (!name?.trim()) return;

            const safeName = name.trim().replace(/\.sql$/i, '') + '.sql';
            fs.mkdirSync(scriptsDir, { recursive: true });
            fs.writeFileSync(path.join(scriptsDir, safeName), msg.sql, 'utf-8');
            vscode.window.showInformationMessage(`Script saved: ${safeName}`);
            this.deps.onScriptSaved();
            return;
        }

        if (msg.command === 'clearHistory') {
            await this.deps.context.globalState.update(SQL_HISTORY_KEY, []);
            this.panel?.webview.postMessage({ command: 'loadHistory', entries: [] });
            return;
        }

        if (msg.command === 'cancel') {
            this.panel?.webview.postMessage({ command: 'cancelled' });
            return;
        }

        if (msg.command === 'saveCsv') {
            const activeCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(activeCwd ?? os.homedir(), msg.csvName ?? 'query.csv')),
                filters: { CSV: ['csv'] },
            });
            if (uri && msg.csvData) {
                fs.writeFileSync(uri.fsPath, msg.csvData, 'utf-8');
                vscode.window.showInformationMessage(`Saved: ${uri.fsPath}`);
            }
            return;
        }

        if (msg.command === 'editCell') {
            if (!msg.table || !msg.keyColumn || !msg.column) return;
            const quoteVal = (v: string) => /^-?\d+(\.\d+)?$/.test(v) ? v : `'${v.replace(/'/g, "''")}'`;
            const updateSql = `UPDATE ${msg.table}\nSET ${msg.column} = ${quoteVal(msg.newValue ?? '')}\nWHERE ${msg.keyColumn} = ${quoteVal(msg.keyValue ?? '')};`;
            this.panel?.webview.postMessage({ command: 'loadScript', content: updateSql, name: 'update' });
            return;
        }

        if (msg.command === 'sendToSpecialist') {
            await this.deps.onSendToSpecialist(msg.sql ?? '');
            return;
        }

        if (msg.command === 'explain') {
            await this.handleExplain(msg.sql);
            return;
        }

        if (msg.command !== 'run' || !msg.sql?.trim()) {
            this.out().appendLine(`[SQL Runner] Ignored message: command=${msg.command}, sql empty=${!msg.sql?.trim()}`);
            return;
        }

        await this.handleRun(msg.sql.trim());
    }

    private async preloadCompletions(): Promise<void> {
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const conn = cwd ? this.deps.findConnection(cwd) : undefined;
        if (!conn) return;
        try {
            const objects = await this.dbNative.loadSqlObjects(conn);
            if (!objects) return;
            const items: CompletionItem[] = [];
            for (const [schema, obj] of objects) {
                for (const name of obj.tables)     items.push({ schema, name, kind: 'table' });
                for (const name of obj.functions)  items.push({ schema, name, kind: 'function' });
                for (const name of obj.procedures) items.push({ schema, name, kind: 'procedure' });
            }
            this.completionCache = items;
            this.panel?.webview.postMessage({ command: 'loadCompletions', items });
        } catch {
            // ignore — completions are best-effort
        }
    }

    private async handleExplain(sqlRaw?: string): Promise<void> {
        if (!sqlRaw?.trim()) return;

        const sql = sqlRaw.trim();
        const activeCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const activeConn = activeCwd ? this.deps.findConnection(activeCwd) : undefined;

        if (!activeConn) {
            this.panel?.webview.postMessage({ command: 'explainError', text: 'No connection configured.' });
            return;
        }

        this.panel?.webview.postMessage({ command: 'explainRunning' });

        try {
            const output = await this.dbNative.explainQuery(activeConn, sql);
            const tree = this.deps.sqlRunnerService.parseExplainPlan(output, activeConn.type);
            this.panel?.webview.postMessage({ command: 'explainResult', tree, dbType: activeConn.type });
        } catch (e: unknown) {
            const text = e instanceof Error ? e.message : String(e);
            this.panel?.webview.postMessage({ command: 'explainError', text });
        }
    }

    private async handleRun(sql: string): Promise<void> {
        const activeCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        this.out().appendLine(`[SQL Runner] Run requested. activeCwd=${activeCwd ?? '(none)'}`);

        const activeConn = activeCwd ? this.deps.findConnection(activeCwd) : undefined;
        this.out().appendLine(`[SQL Runner] Active connection: ${activeConn ? `${activeConn.label} type=${activeConn.type}` : '(none)'}`);

        if (!activeConn) {
            this.out().appendLine('[SQL Runner] No connection - sending error to webview.');
            this.panel?.webview.postMessage({ command: 'error', text: 'No OpenBase project found in workspace.\nappsettings.json with ConnectionStrings is required.' });
            return;
        }

        this.panel?.webview.postMessage({ command: 'running' });
        this.out().appendLine('[SQL Runner] Sent "running" to webview.');

        try {
            const result = await this.dbNative.executeQuery(activeConn, sql);
            this.out().appendLine(`[SQL Runner] Result: ${result.columns.length} cols, ${result.rows.length} rows.`);
            this.panel?.webview.postMessage({ command: 'result', ...result });

            const prevEntries = this.deps.context.globalState.get<HistoryEntry[]>(SQL_HISTORY_KEY) ?? [];
            const newEntry: HistoryEntry = {
                sql,
                timestamp: Date.now(),
                connectionLabel: activeConn.label,
                rowCount: result.rows.length,
            };
            const updatedEntries = [newEntry, ...prevEntries].slice(0, SQL_HISTORY_LIMIT);
            await this.deps.context.globalState.update(SQL_HISTORY_KEY, updatedEntries);
            this.panel?.webview.postMessage({ command: 'loadHistory', entries: updatedEntries });
        } catch (e: unknown) {
            const text = e instanceof Error ? e.message : String(e);
            this.out().appendLine(`[SQL Runner] Error: ${text}`);
            this.panel?.webview.postMessage({ command: 'error', text });
        }
    }
}
