import * as vscode from 'vscode';
import { OpenBaseOrchestrator } from './orchestrators/openBaseOrchestrator';
import { OpenBasePanelProvider } from './providers/openBasePanelProvider';
import { SqlRunnerProvider } from './providers/sqlRunnerProvider';
import { setupTaskRunner } from './providers/taskRunnerProvider';
import { setupStatusBar } from './providers/statusBarProvider';
import { setupSolutionExplorer } from './providers/solutionExplorerProvider';
import { setupSqlTableBrowser } from './providers/sqlTableBrowserProvider';
import { HttpRequestData, getRequestsDir, setupHttpRequestLibrary } from './providers/httpRequestLibraryProvider';
import { setupEndpointsMap } from './providers/endpointsMapProvider';
import { setupMigrationRunner } from './providers/migrationRunnerProvider';
import { setupDepInspector } from './providers/dependencyInspectorProvider';
import { setupMonitor } from './providers/monitorProvider';
import { setupLogViewer } from './providers/logViewerProvider';
import { RunnerSidebarProvider } from './providers/runnerSidebarProvider';
import { buildHttpRunnerHtml } from './providers/httpRunnerHtml';
import { createTableInspectorProvider } from './providers/tableInspectorProvider';
import { getScriptsDir, promptScriptName, setupSqlScriptLibrary } from './providers/sqlScriptLibraryProvider';
import { DbConnection } from './models/dbConnection';
import { ConnectionService } from './services/connection.service';
import { SqlRunnerService } from './services/sqlRunner.service';
import { DbNativeClientService } from './services/dbNativeClient.service';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { execSync, exec } from 'child_process';

const DB_TEMPLATES = ['sqlserver', 'pgsql', 'oracle'] as const;
const BUILD_CONFIGS = ['Debug', 'Release'] as const;
const EXTENSIONS = ['jwt', 'redis', 'healthchecks', 'mongodb', 'domainevents'] as const;
const PARAM_TYPES = ['string', 'int', 'bool', 'decimal', 'Guid', 'DateTime', 'long', 'double', 'float', 'short'] as const;
const EXTENSION_PROVIDERS: Partial<Record<string, string[]>> = {};

type DbTemplate = typeof DB_TEMPLATES[number];

function dotnetToolsPath(): string {
    return path.join(os.homedir(), '.dotnet', 'tools');
}

function isOpenBaseInstalled(): boolean {
    const extraPath = dotnetToolsPath();
    const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
    try {
        execSync('openbase --help', { stdio: 'ignore', env });
        return true;
    } catch {
        return false;
    }
}

function openTerminal(name: string, cwd: string, command: string): void {
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

async function resolveWorkingDir(uri?: vscode.Uri): Promise<string | undefined> {
    if (uri) return uri.fsPath;

    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length === 1) return folders[0].uri.fsPath;

    const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select project folder',
    });

    return picked?.[0]?.fsPath;
}

async function guardInstalled(): Promise<boolean> {
    if (isOpenBaseInstalled()) return true;

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

let panelProvider: OpenBasePanelProvider | undefined;
let sqlRunnerProvider: SqlRunnerProvider | undefined;
let extContext: vscode.ExtensionContext | undefined;
let diagnosticCollection: vscode.DiagnosticCollection;
const connectionService = new ConnectionService();
const sqlRunnerService = new SqlRunnerService();
const dbNativeClientService = new DbNativeClientService();

// OpenBase command handlers moved to commands/services/orchestrator modules.

function findEntryProject(workspaceRoot: string): { csprojPath: string; targetFramework: string; assemblyName: string } | undefined {
        const found: string[] = [];

        function scan(dir: string, depth: number): void {
                if (depth > 4) return;
                try {
                        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                                        scan(path.join(dir, entry.name), depth + 1);
                                } else if (entry.isFile() && entry.name.endsWith('.csproj')) {
                                        found.push(path.join(dir, entry.name));
                                }
                        }
                } catch { /* ignore */ }
        }

        scan(workspaceRoot, 0);
        if (found.length === 0) return undefined;

        const preferred = found.find(f => /\.(api|web)\.csproj$/i.test(path.basename(f))) ?? found[0];
        const content = fs.readFileSync(preferred, 'utf-8');
        const tfm = content.match(/<TargetFramework>([^<]+)<\/TargetFramework>/)?.[1]?.trim() ?? 'net8.0';
        const assemblyName = content.match(/<AssemblyName>([^<]+)<\/AssemblyName>/)?.[1]?.trim() ?? path.basename(preferred, '.csproj');

        return { csprojPath: preferred, targetFramework: tfm, assemblyName };
}

// â”€â”€â”€ panel moved to providers/openBasePanelProvider.ts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// â”€â”€â”€ sql runner â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function findConnection(cwd: string): DbConnection | undefined {
        return connectionService.findConnection(cwd);
}


function getNonce(): string {
        let text = '';
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
        return text;
}

const NEW_PROJECT_PREFS_KEY = 'newProjectPrefs';
const HTTP_AUTOSAVE_KEY = 'httpRunnerAutoSave';
const HTTP_HISTORY_KEY = 'httpCallHistory';
const HTTP_HISTORY_LIMIT = 100;
const HTTP_ENVS_SUBDIR = path.join('.openbase', 'http-runner', 'envs');
const HTTP_ACTIVE_ENV_KEY = 'httpActiveEnv';

interface HttpEnvFile {
        name: string;
        variables: Record<string, string>;
}

function getEnvsDir(): string | undefined {
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return cwd ? path.join(cwd, HTTP_ENVS_SUBDIR) : undefined;
}

function loadEnvFiles(): Array<{ filename: string; name: string; varCount: number }> {
        const dir = getEnvsDir();
        if (!dir || !fs.existsSync(dir)) return [];
        try {
                return fs.readdirSync(dir)
                        .filter(f => f.endsWith('.json'))
                        .sort()
                        .map(f => {
                                try {
                                        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as HttpEnvFile;
                                        return { filename: f, name: data.name || f.replace(/\.json$/i, ''), varCount: Object.keys(data.variables ?? {}).length };
                                } catch { return null; }
                        })
                        .filter((x): x is { filename: string; name: string; varCount: number } => x !== null);
        } catch { return []; }
}

function resolveEnvVars(text: string, variables: Record<string, string>): string {
        return text.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => variables[key.trim()] ?? `{{${key.trim()}}}`);
}

interface HttpHistoryEntry {
        timestamp: number;
        method: string;
        url: string;
        headers: Array<{name: string; value: string}>;
        bodyType: string;
        body: string;
        authToken: string;
        statusCode: number;
        statusText: string;
        responseBody: string;
        responseTimeMs: number;
}

// ÔöÇÔöÇÔöÇ http runner ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

interface HttpResult {
    status: number;
    statusText: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
    time: number;
    size: number;
}

function doHttpRequest(
    method: string,
    urlStr: string,
    headers: Record<string, string>,
    body?: string
): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
        let parsed: URL;
        try { parsed = new URL(urlStr); }
        catch { reject(new Error(`Invalid URL: ${urlStr}`)); return; }

        const isHttps = parsed.protocol === 'https:';
        const t0 = Date.now();

        const onResponse = (res: http.IncomingMessage) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                resolve({
                    status: res.statusCode ?? 0,
                    statusText: res.statusMessage ?? '',
                    headers: res.headers as Record<string, string | string[] | undefined>,
                    body: buf.toString('utf-8'),
                    time: Date.now() - t0,
                    size: buf.length,
                });
            });
            res.on('error', reject);
        };

        const req = isHttps
            ? https.request(parsed, { method, headers, rejectUnauthorized: false }, onResponse)
            : http.request(parsed, { method, headers }, onResponse);

        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timed out (30 s)')); });
        if (body) req.write(body);
        req.end();
    });
}

function detectApiUrl(cwd: string): string {
    function scan(dir: string, depth: number): string | undefined {
        if (depth > 4) return undefined;
        const p = path.join(dir, 'Properties', 'launchSettings.json');
        if (fs.existsSync(p)) return p;
        try {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
                    const found = scan(path.join(dir, e.name), depth + 1);
                    if (found) return found;
                }
            }
        } catch { /* ignore */ }
    }

    const file = scan(cwd, 0);
    if (!file) return '';
    try {
        const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
        for (const profile of Object.values(json?.profiles ?? {})) {
            const urls = (profile as { applicationUrl?: string }).applicationUrl;
            if (urls) {
                const parts = urls.split(';').map((u: string) => u.trim());
                return parts.find((u: string) => u.startsWith('https://')) ?? parts[0] ?? '';
            }
        }
    } catch { /* ignore */ }
    return '';
}

let httpPanel: vscode.WebviewPanel | undefined;
let httpPendingRequest: HttpRequestData | undefined;

function ensureLocalEnv(baseUrl: string): void {
    const dir = getEnvsDir();
    if (!dir) return;
    const url = baseUrl || 'https://localhost:7215';
    const localFile = path.join(dir, 'local.json');
    if (fs.existsSync(localFile)) {
        try {
            const existing = JSON.parse(fs.readFileSync(localFile, 'utf-8')) as HttpEnvFile;
            if (existing.variables?.LOCAL_URL === url) return;
            existing.variables = { ...existing.variables, LOCAL_URL: url };
            fs.writeFileSync(localFile, JSON.stringify(existing, null, 2), 'utf-8');
        } catch {}
        return;
    }
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(localFile, JSON.stringify({ name: 'Local', variables: { LOCAL_URL: url } }, null, 2), 'utf-8');
        const active = extContext?.workspaceState.get<string>(HTTP_ACTIVE_ENV_KEY) ?? '';
        if (!active) extContext?.workspaceState.update(HTTP_ACTIVE_ENV_KEY, 'local.json');
    } catch {}
}

async function httpRunner(): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const baseUrl = cwd ? detectApiUrl(cwd) : '';
    ensureLocalEnv(baseUrl);

    if (httpPanel) {
        httpPanel.reveal(vscode.ViewColumn.One);
        const envs = loadEnvFiles();
        const activeFilename = extContext?.workspaceState.get<string>(HTTP_ACTIVE_ENV_KEY) ?? '';
        httpPanel.webview.postMessage({ command: 'loadEnvs', envs, activeFilename });
        return;
    }

    httpPanel = vscode.window.createWebviewPanel(
        'openbase.httpRunner', 'OpenBase HTTP', vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    httpPanel.onDidDispose(() => { httpPanel = undefined; });
    const httpNonce = getNonce();
    httpPanel.webview.html = buildHttpRunnerHtml(baseUrl, httpNonce, httpPanel.webview.cspSource);

    if (cwd) {
        const envsPattern = new vscode.RelativePattern(cwd, '.openbase/http-runner/envs/*.json');
        const envsWatcher = vscode.workspace.createFileSystemWatcher(envsPattern);
        const refreshEnvs = () => {
            const envs = loadEnvFiles();
            const activeFilename = extContext?.workspaceState.get<string>(HTTP_ACTIVE_ENV_KEY) ?? '';
            httpPanel?.webview.postMessage({ command: 'loadEnvs', envs, activeFilename });
        };
        envsWatcher.onDidCreate(refreshEnvs);
        envsWatcher.onDidDelete(refreshEnvs);
        envsWatcher.onDidChange(refreshEnvs);
        httpPanel.onDidDispose(() => envsWatcher.dispose());
    }

    httpPanel.webview.onDidReceiveMessage(async (msg: {
        command: string;
        method?: string;
        url?: string;
        headers?: Array<{name: string; value: string}> | Record<string, string>;
        headersArray?: Array<{name: string; value: string}>;
        bodyType?: string;
        body?: string;
        authToken?: string;
        filename?: string;
    }) => {
        if (msg.command === 'ready') {
            if (httpPendingRequest) {
                const pending = httpPendingRequest;
                httpPendingRequest = undefined;
                httpPanel?.webview.postMessage({ command: 'loadRequest', ...pending });
            }
            const httpHistory = extContext?.globalState.get<HttpHistoryEntry[]>(HTTP_HISTORY_KEY) ?? [];
            httpPanel?.webview.postMessage({ command: 'loadHttpHistory', entries: httpHistory });
            const envs = loadEnvFiles();
            const activeFilename = extContext?.workspaceState.get<string>(HTTP_ACTIVE_ENV_KEY) ?? '';
            httpPanel?.webview.postMessage({ command: 'loadEnvs', envs, activeFilename });
            return;
        }

        if (msg.command === 'autoSaveHttp') {
            const autoSaveEnabled = vscode.workspace.getConfiguration('openbase').get('editor.autoSave', true);
            if (autoSaveEnabled) {
                await extContext?.globalState.update(HTTP_AUTOSAVE_KEY, {
                    method: msg.method,
                    url: msg.url,
                    headers: msg.headers,
                    bodyType: msg.bodyType,
                    body: msg.body,
                    authToken: msg.authToken
                });
            }
            return;
        }

        if (msg.command === 'setEnv') {
            await extContext?.workspaceState.update(HTTP_ACTIVE_ENV_KEY, msg.filename ?? '');
            return;
        }

        if (msg.command === 'newEnv') {
            const dir = getEnvsDir();
            if (!dir) { vscode.window.showErrorMessage('No workspace folder open.'); return; }
            const name = await vscode.window.showInputBox({
                prompt: 'Environment name',
                placeHolder: 'Development',
                validateInput: v => v?.trim() ? undefined : 'Name required',
            });
            if (!name?.trim()) return;
            const filename = name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '') + '.json';
            const filepath = path.join(dir, filename);
            if (fs.existsSync(filepath)) { vscode.window.showErrorMessage(`Environment "${filename}" already exists.`); return; }
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(filepath, JSON.stringify({ name: name.trim(), variables: { baseUrl: 'http://localhost:7215', token: '' } }, null, 2), 'utf-8');
            await vscode.window.showTextDocument(vscode.Uri.file(filepath));
            return;
        }

        if (msg.command === 'clearHttpHistory') {
            await extContext?.globalState.update(HTTP_HISTORY_KEY, []);
            httpPanel?.webview.postMessage({ command: 'loadHttpHistory', entries: [] });
            return;
        }

        if (msg.command === 'saveRequest') {
            const requestsDir = getRequestsDir();
            if (!requestsDir) { vscode.window.showErrorMessage('No workspace folder open.'); return; }
            const name = await vscode.window.showInputBox({
                prompt: 'Save request as',
                placeHolder: 'get-users',
                validateInput: v => v?.trim() && /^[^\\/:\*\?"<>\|]+$/.test(v.trim()) ? undefined : 'Invalid name',
            });
            if (!name?.trim()) return;
            const safeName = name.trim().replace(/\.json$/i, '') + '.json';
            fs.mkdirSync(requestsDir, { recursive: true });
            const data = { method: msg.method, url: msg.url, headers: msg.headers, bodyType: msg.bodyType, body: msg.body, authToken: msg.authToken };
            fs.writeFileSync(path.join(requestsDir, safeName), JSON.stringify(data, null, 2), 'utf-8');
            vscode.window.showInformationMessage(`Request saved: ${safeName}`);
            void vscode.commands.executeCommand('openbase.httpRunner.requests.refresh');
            return;
        }

        if (msg.command !== 'send') return;
        const { method = 'GET', url = '', body } = msg;
        const headers = (Array.isArray(msg.headers) ? {} : msg.headers) ?? {};

        const activeEnvFilename = extContext?.workspaceState.get<string>(HTTP_ACTIVE_ENV_KEY) ?? '';
        let envVars: Record<string, string> = {};
        if (activeEnvFilename) {
            const dir = getEnvsDir();
            if (dir) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(dir, activeEnvFilename), 'utf-8')) as HttpEnvFile;
                    envVars = data.variables ?? {};
                } catch { /* ignore */ }
            }
        }
        const resolvedUrl = resolveEnvVars(url, envVars);
        const resolvedHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(headers as Record<string, string>)) {
            resolvedHeaders[resolveEnvVars(k, envVars)] = resolveEnvVars(v, envVars);
        }
        const resolvedBody = body ? resolveEnvVars(body, envVars) : body;

        try {
            const result = await doHttpRequest(method, resolvedUrl, resolvedHeaders, resolvedBody);
            httpPanel?.webview.postMessage({ command: 'response', ...result });

            const prevHistory = extContext?.globalState.get<HttpHistoryEntry[]>(HTTP_HISTORY_KEY) ?? [];
            const histEntry: HttpHistoryEntry = {
                timestamp: Date.now(),
                method,
                url,
                headers: msg.headersArray ?? [],
                bodyType: msg.bodyType ?? 'none',
                body: msg.body ?? '',
                authToken: msg.authToken ?? '',
                statusCode: result.status,
                statusText: result.statusText,
                responseBody: result.body,
                responseTimeMs: result.time,
            };
            const updatedHistory = [histEntry, ...prevHistory].slice(0, HTTP_HISTORY_LIMIT);
            await extContext?.globalState.update(HTTP_HISTORY_KEY, updatedHistory);
            httpPanel?.webview.postMessage({ command: 'loadHttpHistory', entries: updatedHistory });
        } catch (e: unknown) {
            httpPanel?.webview.postMessage({ command: 'error', text: e instanceof Error ? e.message : String(e) });
        }
    });
}

async function loadSqlTables(conn: DbConnection, targetSchema?: string): Promise<Map<string, { tables: string[]; procedures: string[]; functions: string[]; packages: string[]; dbType: DbTemplate }>> {
    try {
        const native = await dbNativeClientService.loadSqlObjects(conn, targetSchema);
        if (native) {
            return native;
        }
    } catch (e) {
        if (conn.type === 'pgsql') {
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(`PostgreSQL metadata unavailable via native driver: ${msg}`);
        }
        if (conn.type === 'oracle') {
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(`Oracle metadata unavailable via native driver: ${msg}`);
        }
        if (conn.type === 'sqlserver' && conn.user && conn.password) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(`SQL Server metadata unavailable via native driver: ${msg}`);
        }
        // Keep legacy CLI fallback for compatibility with environments where native drivers cannot connect.
    }

    const extraPath = dotnetToolsPath();
    const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
    const tmpFile = path.join(os.tmpdir(), `ob_tables_${Date.now()}.sql`);
    let cmd = '';

    const HEADER_COLS = new Set(['table_schema', 'table_name', 'owner', 'tablename', 'tableschema']);

    try {
        switch (conn.type) {
            case 'sqlserver': {
                const schemaFilter = targetSchema ? `WHERE TABLE_SCHEMA = '${targetSchema}'` : '';
                const q = `
                    SELECT TABLE_SCHEMA, TABLE_NAME, 'TABLE' AS TYPE FROM INFORMATION_SCHEMA.TABLES ${schemaFilter} AND TABLE_TYPE='BASE TABLE'
                    UNION ALL
                    SELECT ROUTINE_SCHEMA, ROUTINE_NAME, ROUTINE_TYPE FROM INFORMATION_SCHEMA.ROUTINES ${targetSchema ? `WHERE ROUTINE_SCHEMA = '${targetSchema}'` : ''}
                    ORDER BY TABLE_SCHEMA, TYPE, TABLE_NAME`;
                fs.writeFileSync(tmpFile, q, 'utf-8');
                const parts = ['sqlcmd', `-S "${conn.server}"`, `-d "${conn.database}"`];
                if (conn.user)     parts.push(`-U "${conn.user}"`);
                if (conn.password) parts.push(`-P "${conn.password}"`);
                parts.push(`-i "${tmpFile}" -s "|" -W -h -1`);
                cmd = parts.join(' ');
                break;
            }
        }
        
        const stdout = await new Promise<string>((resolve, reject) => {
            exec(cmd, { env, timeout: 15000 }, (err, out, stderr) => {
                console.log('EXEC CMD:', cmd);
                console.log('EXEC STDOUT:', out);
                console.log('EXEC STDERR:', stderr);
                if (err) console.log('EXEC ERROR:', err);
                if (stderr) console.log('EXEC STDERR:', stderr);
                
                if (err && !out) reject(new Error(stderr || err.message));
                else resolve(out);
            });
        });

        const result = new Map<string, { tables: string[]; procedures: string[]; functions: string[]; packages: string[]; dbType: DbTemplate }>();
        const sep = conn.type === 'pgsql' ? ',' : '|';

        
        for (const raw of stdout.split('\n')) {
            const line = raw.trim();
            if (!line || line.startsWith('---') || /^\d+ rows? selected/i.test(line)) continue;
            
            const parts = line.split(sep).map(p => p.replace(/^"|"$/g, '').trim());
            if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) continue;
            if (HEADER_COLS.has(parts[0].toLowerCase())) continue;
            
            const [schema, name, type] = parts;
            
            let entry = result.get(schema);
            if (!entry) {
                entry = { tables: [], procedures: [], functions: [], packages: [], dbType: conn.type };
                result.set(schema, entry);
            }
            
            if (type === 'TABLE') entry.tables.push(name);
            else if (type === 'PROCEDURE') entry.procedures.push(name);
            else if (type === 'FUNCTION') entry.functions.push(name);
            else if (type === 'PACKAGE') entry.packages.push(name);
        }
        return result;
    } finally {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
}

function buildSelectQuery(schema: string, table: string, dbType: DbTemplate): string {
    switch (dbType) {
        case 'sqlserver': return `SELECT TOP 100 *\nFROM [${schema}].[${table}]`;
        case 'pgsql':     return `SELECT *\nFROM "${schema}"."${table}"\nLIMIT 100`;
        case 'oracle':    return `SELECT *\nFROM "${schema}"."${table}"\nWHERE ROWNUM <= 100`;
    }
}

// ÔöÇÔöÇÔöÇ SQL Table Inspector ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

// ÔöÇÔöÇÔöÇ Log Viewer ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

export function activate(context: vscode.ExtensionContext): void {
    extContext = context;
    diagnosticCollection = vscode.languages.createDiagnosticCollection('openbase');
    context.subscriptions.push(diagnosticCollection);
    panelProvider = new OpenBasePanelProvider({
        ensureInstalled: guardInstalled,
        openTerminal,
        getNewProjectPrefs: () => context.globalState.get<Record<string, string>>('newProjectPrefs') ?? {},
        saveNewProjectPrefs: async (prefs) => { await context.globalState.update('newProjectPrefs', prefs); },
        diagnosticCollection,
        dotnetToolsPath,
    });
    sqlRunnerProvider = new SqlRunnerProvider({
        context,
        findConnection,
        dotnetToolsPath,
        getScriptsDir,
      onScriptSaved: () => { void vscode.commands.executeCommand('openbase.sqlRunner.scripts.refresh'); },
        onSendToSpecialist: async (sql: string) => {
            await vscode.commands.executeCommand('openbase.panel.focus');
            panelProvider?.postNavigateTo('sp', sql);
        },
        sqlRunnerService,
    });
    setupStatusBar(context, { findConnection });
    const tableInspectorHandlers = createTableInspectorProvider({
        findConnection,
        loadSqlTables,
        openScriptInSqlRunner: async (content: string) => {
            await sqlRunnerProvider?.openScript(content, '');
        },
        openTerminal,
        getNonce,
        dotnetToolsPath,
    });
    setupSqlTableBrowser(context, {
        findConnection,
        loadSqlTables,
        buildSelectQuery,
      openScriptInSqlRunner: async (filePath: string, directContent?: string) => {
        const content = directContent ?? fs.readFileSync(filePath, 'utf-8');
        const name = directContent ? '' : path.basename(filePath);
        await sqlRunnerProvider?.openScript(content, name);
      },
        openTableInspector: tableInspectorHandlers.openTableInspector,
        openErDiagram: tableInspectorHandlers.openErDiagram,
        dotnetToolsPath,
    });
    setupSqlScriptLibrary(context, {
      openScript: async (content: string, name: string) => {
        await sqlRunnerProvider?.openScript(content, name);
      },
    });
    setupHttpRequestLibrary(context, {
        getHttpPanel: () => httpPanel,
        openHttpRunner: httpRunner,
        setPendingRequest: (data) => { httpPendingRequest = data; },
        promptScriptName,
    });
    setupMigrationRunner(context, {
        dotnetToolsPath,
        findConnection,
        getNonce,
        getScriptsDir,
      refreshSqlScripts: () => { void vscode.commands.executeCommand('openbase.sqlRunner.scripts.refresh'); },
    });
    setupDepInspector(context, { dotnetToolsPath });
    setupMonitor(context, { dotnetToolsPath, getNonce });
    setupLogViewer(context, { dotnetToolsPath, getNonce });
    setupEndpointsMap(context, {
        getHttpPanel: () => httpPanel,
        setPendingRequest: (data) => { httpPendingRequest = data; },
        openHttpRunner: httpRunner,
    });
    setupSolutionExplorer(context, {
        findEntryProject,
        openTerminal,
        dotnetToolsPath,
    });
    setupTaskRunner(context, {
        dotnetToolsPath,
        postToPanel: (msg) => panelProvider?.postMessage(msg),
    });

    // Helper to execute commands
    const execute = async (command: string, message: string, stream: any) => {
        stream.markdown(message + '\n\n*Running command...*');
        try {
            await vscode.commands.executeCommand(command);
            stream.markdown(`\n\nâœ… Command \`${command}\` executed successfully.`);
        } catch (error) {
            stream.markdown(`\n\nâŒ Error executing \`${command}\`: ${error}`);
        }
    };

    // Handler para implementaÃ§Ã£o de issue
    async function handleIssueImplementation(type: string, id: string, stream: any) {
        stream.markdown(`Analisando issue \`#${type}/${id}\`...`);

        let command = '';
        let message = '';

        switch (type) {
            case 'feature':
                message = `Feature #${id} detectada. Preparando scaffold...`;
                command = 'openbase.scaffold';
                break;
            case 'fix':
                message = `Fix #${id} detectado. Preparando atualizaÃ§Ã£o de scaffold...`;
                command = 'openbase.scaffoldUpdate';
                break;
            case 'api':
                message = `API #${id} detectada. Preparando specialist...`;
                command = 'openbase.specialist';
                break;
            default:
                stream.markdown(`Tipo de issue \`${type}\` nÃ£o mapeado para um fluxo automÃ¡tico.`);
                return;
        }

        stream.markdown(`\n\n${message}`);
        try {
            await vscode.commands.executeCommand(command);
            stream.markdown(`\n\nâœ… Fluxo para \`#${type}/${id}\` iniciado com sucesso.`);
        } catch (error) {
            stream.markdown(`\n\nâŒ Erro ao iniciar fluxo para \`#${type}/${id}\`: ${error}`);
        }
    }

    const orchestrator = new OpenBaseOrchestrator(context, execute, handleIssueImplementation);
    void orchestrator.initialize();

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(OpenBasePanelProvider.viewType, panelProvider),
        vscode.window.registerWebviewViewProvider('openbase.sqlrunner.sidebar', new RunnerSidebarProvider('SQL Runner', 'Open SQL Runner', () => sqlRunnerProvider?.open())),
        vscode.window.registerWebviewViewProvider('openbase.httprunner.sidebar', new RunnerSidebarProvider('HTTP Runner', 'Open HTTP Runner', httpRunner)),
        vscode.window.registerWebviewViewProvider('openbase.erdiagram.sidebar', new RunnerSidebarProvider('ER Diagram', 'Open ER Diagram', tableInspectorHandlers.openErDiagram)),
        vscode.window.registerWebviewViewProvider('openbase.logviewer.sidebar', new RunnerSidebarProvider('Log Viewer', 'Open Log Viewer', () => { void vscode.commands.executeCommand('openbase.logViewer'); })),
        vscode.window.registerWebviewViewProvider('openbase.migrationrunner.sidebar', new RunnerSidebarProvider('Migration Runner', 'Refresh Migrations', () => { void vscode.commands.executeCommand('openbase.migrationRunner.refresh'); })),
        vscode.window.registerWebviewViewProvider('openbase.monitor.sidebar', new RunnerSidebarProvider('Monitor', 'Open Monitor', () => { void vscode.commands.executeCommand('openbase.monitor'); })),
        vscode.window.registerWebviewViewProvider('openbase.depinspector.sidebar', new RunnerSidebarProvider('Dependency Inspector', 'Refresh Packages', () => { void vscode.commands.executeCommand('openbase.dependencyInspector.refresh'); })),
        vscode.commands.registerCommand('openbase.migrationRunner', () => vscode.commands.executeCommand('openbase.migrationRunner.refresh')),
        vscode.commands.registerCommand('openbase.teamsMeeting', () => vscode.window.showInformationMessage('MS Teams integration opening...')),
        vscode.commands.registerCommand('openbase.zoomMeeting', () => vscode.window.showInformationMessage('Zoom integration opening...')),
        vscode.commands.registerCommand('openbase.slackMeeting', () => vscode.window.showInformationMessage('Slack integration opening...')),
        vscode.commands.registerCommand('openbase.quickAccess', async () => {
            const commands = [
                { label: 'New Project', command: 'openbase.newProject' },
                { label: 'Scaffold', command: 'openbase.scaffold' },
                { label: 'Specialist', command: 'openbase.specialist' },
                { label: 'SQL Runner', command: 'openbase.sqlRunner' },
                { label: 'HTTP Runner', command: 'openbase.httpRunner' },
                { label: 'Migration Runner', command: 'openbase.migrationRunner' },
                { label: 'Monitor', command: 'openbase.monitor' },
            ];
            const selection = await vscode.window.showQuickPick(commands.map(c => c.label), {
                placeHolder: 'Select an OpenBase command'
            });
            if (selection) {
                const cmd = commands.find(c => c.label === selection);
                if (cmd) {
                    vscode.commands.executeCommand(cmd.command);
                }
            }
        }),
        vscode.commands.registerCommand('openbase.sqlRunner', () => sqlRunnerProvider?.open()),
        vscode.commands.registerCommand('openbase.httpRunner', () => httpRunner()),
        vscode.commands.registerCommand('openbase.sqlRunner.run', () => sqlRunnerProvider?.triggerRun()),
        vscode.commands.registerCommand('openbase.httpRunner.send', () => httpPanel?.webview.postMessage({ command: 'triggerSend' })),
    );
}

export function deactivate(): void {}









