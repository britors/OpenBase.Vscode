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
import { getScriptsDir, promptScriptName, setupSqlScriptLibrary } from './providers/sqlScriptLibraryProvider';
import { DbConnection } from './models/dbConnection';
import { ConnectionService } from './services/connection.service';
import { SqlRunnerService } from './services/sqlRunner.service';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { execSync, exec, spawn } from 'child_process';

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

function buildHttpRunnerHtml(baseUrl: string, nonce: string, cspSource: string): string {
    const safeBase = JSON.stringify(baseUrl);
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%;overflow:hidden}
  body{display:flex;flex-direction:column;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background)}
  input,select,textarea{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);font-family:inherit;font-size:inherit;outline:none;padding:4px 7px}
  input:focus,select:focus,textarea:focus{border-color:var(--vscode-focusBorder)}
  input::placeholder,textarea::placeholder{color:var(--vscode-input-placeholderForeground)}
  .btn{border:none;cursor:pointer;font-family:inherit;font-size:inherit;padding:4px 10px}
  .btn-primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
  .btn-primary:hover{background:var(--vscode-button-hoverBackground)}
  .btn-primary:disabled{opacity:.5;cursor:not-allowed}
  .btn-secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);font-size:11px}
  .btn-secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}
  .btn-ghost{background:transparent;color:var(--vscode-foreground);padding:1px 6px;opacity:.5;border:none;cursor:pointer;font-size:14px}
  .btn-ghost:hover{opacity:1;background:var(--vscode-list-hoverBackground)}

  /* URL bar */
  .url-bar{display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;background:var(--vscode-sideBar-background);align-items:center}
  #method{width:92px}
  #url-input{flex:1}

  /* method color hints */
  .m-GET{color:#6fbf6f} .m-POST{color:#bf9c6f} .m-PUT{color:#6f9cbf}
  .m-PATCH{color:#bf6fbf} .m-DELETE{color:#bf6f6f} .m-OPTIONS,.m-HEAD{color:#9c9c9c}

  /* tabs */
  .tab-strip{display:flex;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;background:var(--vscode-sideBar-background)}
  .tab{padding:5px 14px;cursor:pointer;font-size:12px;border-bottom:2px solid transparent;user-select:none}
  .tab:hover{background:var(--vscode-list-hoverBackground)}
  .tab.active{border-bottom-color:var(--vscode-focusBorder);color:var(--vscode-textLink-activeForeground)}

  /* request section */
  .req-section{flex:0 0 auto;border-bottom:2px solid var(--vscode-panel-border);display:flex;flex-direction:column}
  .tab-content{flex:1;overflow-y:auto;padding:8px 12px;max-height:190px;min-height:60px}
  .hidden{display:none!important}

  /* kv rows */
  .kv-row{display:flex;gap:4px;margin-bottom:4px;align-items:center}
  .kv-row .key{flex:0 0 38%}
  .kv-row .val{flex:1}

  /* body */
  .body-toolbar{display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:12px}
  #body-text{width:100%;min-height:110px;resize:none;font-family:var(--vscode-editor-font-family,monospace);font-size:var(--vscode-editor-font-size,12px);line-height:1.5}

  /* auth */
  .auth-label{font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:6px}

  /* response section */
  .res-section{flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0}
  .res-bar{display:flex;align-items:center;gap:8px;padding:5px 12px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;font-size:12px;background:var(--vscode-sideBar-background);min-height:32px}
  .status-badge{padding:2px 8px;border-radius:3px;font-weight:700;font-size:12px}
  .s2xx{background:rgba(80,180,80,.2);color:#6fca6f;border:1px solid rgba(80,180,80,.3)}
  .s3xx{background:rgba(200,160,60,.2);color:#cabd6f;border:1px solid rgba(200,160,60,.3)}
  .s4xx{background:rgba(200,80,60,.2);color:#ca7a6f;border:1px solid rgba(200,80,60,.3)}
  .s5xx{background:rgba(200,40,40,.2);color:#ca5a5a;border:1px solid rgba(200,40,40,.3)}
  .meta{font-size:11px;color:var(--vscode-descriptionForeground)}
  .res-body-wrap{flex:1;overflow:auto;padding:10px 12px}
  .placeholder-msg{color:var(--vscode-descriptionForeground);font-size:12px;font-style:italic}
  .err-box{padding:8px 10px;background:var(--vscode-inputValidation-errorBackground);border:1px solid var(--vscode-inputValidation-errorBorder);font-size:12px;white-space:pre-wrap;font-family:monospace}
  pre{font-family:var(--vscode-editor-font-family,monospace);font-size:var(--vscode-editor-font-size,12px);white-space:pre-wrap;word-break:break-all;line-height:1.6}

  /* json syntax */
  .jk{color:#9cdcfe} .js{color:#ce9178} .jn{color:#b5cea8} .jb{color:#569cd6}

  /* response headers table */
  .hdr-table{width:100%;border-collapse:collapse;font-size:12px}
  .hdr-table th{text-align:left;padding:4px 8px;border-bottom:1px solid var(--vscode-panel-border);font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--vscode-descriptionForeground);font-weight:600}
  .hdr-table td{padding:4px 8px;border-bottom:1px solid color-mix(in srgb,var(--vscode-panel-border) 30%,transparent);font-family:monospace;font-size:12px;word-break:break-all}
  .hdr-table tr:hover td{background:var(--vscode-list-hoverBackground)}
  .hdr-name{white-space:nowrap;width:34%;color:#9cdcfe}

  .spinner{display:inline-block;width:11px;height:11px;border:2px solid var(--vscode-foreground);border-top-color:transparent;border-radius:50%;animation:spin .6s linear infinite;flex-shrink:0}
  @keyframes spin{to{transform:rotate(360deg)}}

  /* ÔöÇÔöÇ OpenBase brand theme ÔöÇÔöÇ */
  :root{
    --ob-bg0: var(--vscode-editor-background);
    --ob-bg1: var(--vscode-sideBar-background);
    --ob-bg2: var(--vscode-input-background);
    --ob-purple: #b44fff;
    --ob-pink: #ff3fa4;
    --ob-border: var(--vscode-panel-border);
    --ob-text: var(--vscode-foreground);
    --ob-dim: var(--vscode-descriptionForeground);
  }
  body.vscode-dark {
    --ob-bg0: #0d0f1a;
    --ob-bg1: #131629;
    --ob-bg2: #1c1535;
    --ob-border: rgba(180,79,255,0.22);
    --ob-text: #ede8f8;
    --ob-dim: #9080b8;
  }
  body.vscode-light {
    --ob-bg0: #fdfdff;
    --ob-bg1: #f1f3f9;
    --ob-bg2: #ffffff;
    --ob-purple: #7b2cbf;
    --ob-pink: #d81b60;
    --ob-border: #e0e4ef;
    --ob-text: #24292e;
    --ob-dim: #6a737d;
  }
  html,body{background:var(--ob-bg0)!important;color:var(--ob-text)!important}
  input,select,textarea{background:var(--ob-bg2)!important;color:var(--ob-text)!important;border-color:var(--ob-border)!important}
  input:focus,select:focus,textarea:focus{border-color:var(--ob-purple)!important}
  input::placeholder,textarea::placeholder{color:var(--ob-dim)!important}
  .btn-primary{background:linear-gradient(135deg,var(--ob-purple),var(--ob-pink))!important;color:#fff!important;border-radius:4px}
  .btn-primary:hover:not(:disabled){filter:brightness(1.15)}
  .btn-primary:disabled{opacity:.35!important}
  .btn-secondary{background:rgba(180,79,255,.12)!important;color:var(--ob-purple)!important;border:1px solid var(--ob-border);border-radius:4px}
  .btn-secondary:hover{background:rgba(180,79,255,.24)!important}
  .btn-ghost{color:var(--ob-dim)!important}
  .btn-ghost:hover{background:rgba(180,79,255,.12)!important;color:var(--ob-text)!important;opacity:1!important}
  .url-bar{background:var(--ob-bg1)!important;border-bottom:1px solid var(--ob-border)!important}
  .tab-strip{background:var(--ob-bg1)!important;border-bottom:1px solid var(--ob-border)!important}
  .tab:hover{background:rgba(180,79,255,.08)!important}
  .tab.active{border-bottom-color:var(--ob-purple)!important;color:var(--ob-purple)!important}
  .req-section{border-bottom:2px solid var(--ob-border)!important}
  .tab-content{background:var(--ob-bg0)}
  .res-bar{background:var(--ob-bg1)!important;border-bottom:1px solid var(--ob-border)!important}
  .res-body-wrap,.res-headers-wrap{background:var(--ob-bg0)}
  .placeholder-msg{color:var(--ob-dim)!important}
  .spinner{border-color:var(--ob-purple)!important;border-top-color:transparent!important}
  .err-box{background:rgba(255,63,164,.10)!important;border-color:rgba(255,63,164,.35)!important;color:#ff90c0!important}
  .hdr-table th{border-bottom-color:var(--ob-border)!important;color:var(--ob-dim)!important}
  .hdr-table td{border-bottom-color:rgba(180,79,255,.08)!important}
  .hdr-table tr:hover td{background:rgba(180,79,255,.07)!important}
  .hdr-name{color:var(--ob-purple)!important}
  .meta{color:var(--ob-dim)!important}
  .jk{color:#d08fff}.js{color:#ff9fd8}.jn{color:#7dffb8}.jb{color:#8888ff}
  .status-badge.s2xx{background:rgba(80,220,120,.15)!important;color:#6fdc8f!important;border-color:rgba(80,220,120,.25)!important}
  .status-badge.s4xx{background:rgba(255,63,164,.15)!important;color:#ff80c0!important;border-color:rgba(255,63,164,.3)!important}
  .status-badge.s5xx{background:rgba(255,40,40,.15)!important;color:#ff7070!important;border-color:rgba(255,40,40,.3)!important}
  .status-badge.s3xx{background:rgba(255,200,60,.12)!important;color:#ffd060!important;border-color:rgba(255,200,60,.25)!important}
  #copy-btn{background:rgba(180,79,255,.12)!important;color:var(--ob-purple)!important;border:1px solid var(--ob-border)!important}
  #http-history-panel{flex:1;overflow:auto;display:flex;flex-direction:column;background:var(--ob-bg0)}
  .http-hist-toolbar{display:flex;align-items:center;justify-content:space-between;padding:4px 12px;font-size:11px;color:var(--ob-dim);border-bottom:1px solid var(--ob-border);background:var(--ob-bg1);flex-shrink:0}
  #http-history-list{flex:1;overflow:auto}
  .http-hist-item{border-bottom:1px solid rgba(180,79,255,.07)}
  .http-hist-row{display:flex;align-items:center;gap:8px;padding:7px 12px;cursor:pointer}
  .http-hist-row:hover{background:rgba(180,79,255,.07)}
  .http-method-badge{font-size:10px;font-weight:700;padding:1px 5px;border-radius:3px;flex-shrink:0;font-family:monospace}
  .mb-GET{background:rgba(80,220,80,.15);color:#6fdc8f;border:1px solid rgba(80,220,80,.2)}
  .mb-POST{background:rgba(180,140,60,.15);color:#ddb86f;border:1px solid rgba(180,140,60,.25)}
  .mb-PUT{background:rgba(80,150,200,.15);color:#6fbfdc;border:1px solid rgba(80,150,200,.25)}
  .mb-PATCH{background:rgba(160,80,200,.15);color:#c06fdc;border:1px solid rgba(160,80,200,.25)}
  .mb-DELETE{background:rgba(255,63,100,.15);color:#ff7090;border:1px solid rgba(255,63,100,.25)}
  .mb-OTHER{background:rgba(150,150,150,.12);color:#aaa;border:1px solid rgba(150,150,150,.2)}
  .http-hist-url{flex:1;font-size:11px;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ob-text)}
  .http-hist-meta{display:flex;align-items:center;gap:6px;flex-shrink:0}
  .http-hist-time{font-size:10px;color:var(--ob-dim)}
  .http-hist-ts{font-size:10px;color:var(--ob-dim)}
  .http-hist-actions{display:flex;gap:4px;margin-left:2px}
  .http-hist-actions .btn{font-size:10px!important;padding:1px 6px!important}
  .http-hist-expand{background:transparent;border:none;cursor:pointer;color:var(--ob-dim);font-size:11px;padding:0 3px}
  .http-hist-body{padding:8px 12px;border-top:1px solid rgba(180,79,255,.07);background:var(--ob-bg1)}
  .http-hist-body pre{font-size:11px;max-height:180px;overflow:auto;white-space:pre-wrap;word-break:break-all}
  .http-hist-empty{padding:20px;color:var(--ob-dim);font-size:12px;font-style:italic}
  .curl-modal{position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;z-index:1000}
  .curl-modal-inner{background:var(--ob-bg1);border:1px solid var(--ob-border);padding:16px;width:90%;max-width:520px;display:flex;flex-direction:column;gap:10px;border-radius:4px}
  .curl-modal-title{font-size:13px;font-weight:600;color:var(--ob-purple)}
  #curl-input{height:120px;resize:vertical;font-family:monospace;font-size:11px;width:100%}
  .curl-modal-actions{display:flex;gap:8px;justify-content:flex-end}
  .env-bar{display:flex;align-items:center;gap:8px;padding:3px 12px;border-bottom:1px solid var(--ob-border);flex-shrink:0;background:var(--ob-bg1);font-size:11px}
  .env-label{color:var(--ob-dim)}
  #env-select{background:var(--ob-bg2)!important;color:var(--ob-text)!important;border:1px solid var(--ob-border)!important;padding:2px 6px;font-size:11px;border-radius:3px;max-width:160px}
  .env-var-count{font-size:10px;color:var(--ob-dim)}
</style>
</head>
<body>

<!-- URL BAR -->
<div class="url-bar">
  <select id="method">
    <option>GET</option><option>POST</option><option>PUT</option>
    <option>PATCH</option><option>DELETE</option><option>OPTIONS</option><option>HEAD</option>
  </select>
  <input id="url-input" type="text" placeholder="https://localhost:7215/api/...">
  <button id="send-btn" class="btn btn-primary">ÔûÂ Send</button>
  <button id="save-req-btn" class="btn btn-secondary" title="Save request to library">SaveÔÇª</button>
  <button id="import-curl-btn" class="btn btn-secondary" style="font-size:10px;padding:2px 7px" title="Import from cURL command">Ôåô cURL</button>
  <button id="copy-curl-btn" class="btn btn-secondary" style="font-size:10px;padding:2px 7px" title="Copy as cURL">Ôåæ cURL</button>
  <button id="http-history-btn" class="btn btn-secondary" title="Show request history">History</button>
</div>

<!-- ENV BAR -->
<div class="env-bar">
  <span class="env-label">Env</span>
  <select id="env-select">
    <option value="">ÔÇö none ÔÇö</option>
  </select>
  <span id="env-var-count" class="env-var-count"></span>
  <button id="new-env-btn" class="btn btn-secondary" style="margin-left:auto;font-size:10px;padding:1px 8px" title="Create new environment file">+ New Env</button>
</div>

<!-- REQUEST TABS -->
<div class="req-section">
  <div class="tab-strip">
    <div class="tab active" data-tab="headers">Headers</div>
    <div class="tab" data-tab="body">Body</div>
    <div class="tab" data-tab="auth">Auth</div>
  </div>

  <div id="req-headers" class="tab-content">
    <div id="headers-list"></div>
    <button id="add-header-btn" class="btn btn-secondary" style="margin-top:4px">+ Add Header</button>
  </div>

  <div id="req-body" class="tab-content hidden">
    <div class="body-toolbar">
      <span>Body:</span>
      <select id="body-type">
        <option value="none">none</option>
        <option value="json">JSON</option>
        <option value="text">Text</option>
        <option value="form">Form URL-encoded</option>
      </select>
    </div>
    <textarea id="body-text" class="hidden" placeholder='{"key": "value"}'></textarea>
  </div>

  <div id="req-auth" class="tab-content hidden">
    <p class="auth-label">Bearer Token ÔÇö automatically added as Authorization header on send</p>
    <input id="auth-token" type="password" style="width:100%" placeholder="eyJhbGci...">
    <div style="margin-top:8px;display:flex;align-items:center;gap:6px">
      <input id="auth-show" type="checkbox" style="width:auto">
      <label for="auth-show" style="font-size:11px;cursor:pointer">Show token</label>
    </div>
  </div>
</div>

<!-- RESPONSE SECTION -->
<div class="res-section">
  <div class="res-bar" id="res-bar">
    <span class="placeholder-msg">Send a request to see the response</span>
  </div>
  <div class="tab-strip hidden" id="res-tab-strip">
    <div class="tab active" data-tab="body">Body</div>
    <div class="tab" data-tab="headers">Headers</div>
  </div>
  <div class="res-body-wrap" id="res-body-wrap"></div>
  <div class="res-body-wrap hidden" id="res-headers-wrap"></div>
</div>

<div id="curl-modal" class="curl-modal hidden">
  <div class="curl-modal-inner">
    <div class="curl-modal-title">Import cURL</div>
    <textarea id="curl-input" placeholder="curl -X POST https://api.example.com/users \&#10;  -H 'Authorization: Bearer ...' \&#10;  -d '{&quot;key&quot;: &quot;value&quot;}'"></textarea>
    <div class="curl-modal-actions">
      <button id="curl-import-cancel" class="btn btn-secondary">Cancel</button>
      <button id="curl-import-ok" class="btn btn-primary">Import</button>
    </div>
  </div>
</div>


<div id="http-history-panel" class="hidden">
  <div class="http-hist-toolbar">
    <span>Request history</span>
    <button id="http-clear-hist-btn" class="btn btn-secondary" style="font-size:11px;padding:2px 8px">Clear all</button>
  </div>
  <div id="http-history-list"><p class="http-hist-empty">No history yet.</p></div>
</div>

<script nonce="${nonce}">
  window.onerror = function(msg, src, line, col) {
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#c72e0f;color:#fff;padding:6px 10px;font-size:12px;font-family:monospace;z-index:9999;white-space:pre-wrap';
    box.textContent = 'JS ERROR: ' + msg + '\\n' + src + ':' + line + ':' + col;
    document.body.appendChild(box);
  };
  const vscode = acquireVsCodeApi();
  vscode.postMessage({ command: 'ready' });
  let sending = false;
  const BASE_URL = ${safeBase};
  var httpHistory = [];
  var httpHistoryVisible = false;
  var historyExpanded = {};

  // init
  if (BASE_URL) document.getElementById('url-input').value = BASE_URL + '/api/';
  addHeader('Content-Type', 'application/json');
  addHeader('Accept', 'application/json');

  document.getElementById('send-btn').addEventListener('click', sendRequest);
  document.getElementById('save-req-btn').addEventListener('click', function() {
    var headers = [];
    document.getElementById('headers-list').querySelectorAll('.kv-row').forEach(function(r) {
      var ins = r.querySelectorAll('input');
      var k = ins[0].value.trim(), v = ins[1].value.trim();
      if (k) headers.push({ name: k, value: v });
    });
    vscode.postMessage({
      command: 'saveRequest',
      method: document.getElementById('method').value,
      url: document.getElementById('url-input').value.trim(),
      headers: headers,
      bodyType: document.getElementById('body-type').value,
      body: document.getElementById('body-text').value,
      authToken: document.getElementById('auth-token').value.trim()
    });
  });
  document.getElementById('import-curl-btn').addEventListener('click', function() {
    document.getElementById('curl-modal').classList.remove('hidden');
    document.getElementById('curl-input').value = '';
    setTimeout(function() { document.getElementById('curl-input').focus(); }, 50);
  });
  document.getElementById('curl-import-cancel').addEventListener('click', function() {
    document.getElementById('curl-modal').classList.add('hidden');
  });
  document.getElementById('curl-import-ok').addEventListener('click', function() {
    var parsed = parseCurl(document.getElementById('curl-input').value);
    if (parsed && parsed.url) {
      loadHistoryEntry(parsed);
      document.getElementById('curl-modal').classList.add('hidden');
    }
  });
  document.getElementById('copy-curl-btn').addEventListener('click', function() {
    var curl = buildCurl();
    if (!curl) return;
    navigator.clipboard.writeText(curl).then(function() {
      var btn = document.getElementById('copy-curl-btn');
      btn.textContent = 'Ô£ô ok';
      setTimeout(function() { btn.textContent = 'Ôåæ cURL'; }, 1500);
    });
  });
  document.getElementById('env-select').addEventListener('change', function() {
    vscode.postMessage({ command: 'setEnv', filename: this.value });
  });
  document.getElementById('new-env-btn').addEventListener('click', function() {
    vscode.postMessage({ command: 'newEnv' });
  });
  document.getElementById('http-history-btn').addEventListener('click', function() {
    toggleHttpHistory();
  });
  document.getElementById('http-clear-hist-btn').addEventListener('click', function() {
    vscode.postMessage({ command: 'clearHttpHistory' });
  });
  document.getElementById('http-history-list').addEventListener('click', function(e) {
    var loadBtn = e.target.closest('.hist-load-btn');
    if (loadBtn) {
      var idx = parseInt(loadBtn.getAttribute('data-idx'), 10);
      loadHistoryEntry(httpHistory[idx]);
      if (httpHistoryVisible) toggleHttpHistory();
      return;
    }
    var resendBtn = e.target.closest('.hist-resend-btn');
    if (resendBtn) {
      var idx2 = parseInt(resendBtn.getAttribute('data-idx'), 10);
      loadHistoryEntry(httpHistory[idx2]);
      if (httpHistoryVisible) toggleHttpHistory();
      setTimeout(function() { sendRequest(); }, 50);
      return;
    }
    var saveBtn = e.target.closest('.hist-save-btn');
    if (saveBtn) {
      var idx3 = parseInt(saveBtn.getAttribute('data-idx'), 10);
      var entry = httpHistory[idx3];
      if (entry) vscode.postMessage({ command: 'saveRequest', method: entry.method, url: entry.url, headers: entry.headers, bodyType: entry.bodyType, body: entry.body, authToken: entry.authToken });
      return;
    }
    var row = e.target.closest('.http-hist-row');
    if (row) {
      var idx4 = parseInt(row.getAttribute('data-idx'), 10);
      historyExpanded[idx4] = !historyExpanded[idx4];
      renderHttpHistory();
    }
  });
  document.getElementById('url-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') sendRequest();
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'F8') { e.preventDefault(); sendRequest(); }
    if (e.key === 'Escape') document.getElementById('curl-modal').classList.add('hidden');
  });
  document.getElementById('method').addEventListener('change', function() { onMethodChange(this); });
  document.getElementById('body-type').addEventListener('change', function() { onBodyType(); });
  document.getElementById('add-header-btn').addEventListener('click', function() { addHeader('',''); });
  document.getElementById('auth-show').addEventListener('change', function() {
    document.getElementById('auth-token').type = this.checked ? 'text' : 'password';
  });
  document.querySelectorAll('.req-section .tab-strip .tab').forEach(function(tab) {
    tab.addEventListener('click', function() { reqTab(this, this.getAttribute('data-tab')); });
  });
  document.querySelectorAll('#res-tab-strip .tab').forEach(function(tab) {
    tab.addEventListener('click', function() { resTab(this, this.getAttribute('data-tab')); });
  });

  function triggerAutoSave() {
    vscode.postMessage({
      command: 'autoSaveHttp',
      data: {
        method: document.getElementById('method').value,
        url: document.getElementById('url-input').value,
        headers: collectHeadersArray(),
        bodyType: document.getElementById('body-type').value,
        body: document.getElementById('body-text').value,
        authToken: document.getElementById('auth-token').value
      }
    });
  }
  ['url-input', 'method', 'body-type', 'body-text', 'auth-token'].forEach(function(id) {
    document.getElementById(id).addEventListener('input', triggerAutoSave);
  });
  document.getElementById('headers-list').addEventListener('input', triggerAutoSave);
  document.getElementById('headers-list').addEventListener('click', function(e) {
    if (e.target.classList.contains('btn-ghost')) setTimeout(triggerAutoSave, 10);
  });

  var NO_BODY_METHODS = ['GET','HEAD','OPTIONS'];

  function onMethodChange(sel) {
    sel.className = 'm-' + sel.value;
    var noBody = NO_BODY_METHODS.indexOf(sel.value) !== -1;
    document.querySelectorAll('.req-section .tab').forEach(function(t) {
      if (t.textContent === 'Body') t.style.opacity = noBody ? '.35' : '';
    });
    if (noBody) {
      var bodyTab = document.querySelector('.req-section .tab.active');
      if (bodyTab && bodyTab.textContent === 'Body') {
        reqTab(document.querySelector('.req-section .tab'), 'headers');
      }
    }
  }
  onMethodChange(document.getElementById('method'));

  // \u2500\u2500 request tabs \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  function reqTab(el, id) {
    document.querySelectorAll('.req-section .tab').forEach(function(t) { t.classList.remove('active'); });
    ['req-headers','req-body','req-auth'].forEach(function(i) { document.getElementById(i).classList.add('hidden'); });
    el.classList.add('active');
    document.getElementById('req-' + id).classList.remove('hidden');
  }

  function resTab(el, id) {
    document.querySelectorAll('#res-tab-strip .tab').forEach(function(t) { t.classList.remove('active'); });
    document.getElementById('res-body-wrap').classList.add('hidden');
    document.getElementById('res-headers-wrap').classList.add('hidden');
    el.classList.add('active');
    document.getElementById('res-' + id + '-wrap').classList.remove('hidden');
  }

  // \u2500\u2500 headers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  function addHeader(k, v) {
    var row = document.createElement('div');
    row.className = 'kv-row';
    var ki = document.createElement('input'); ki.className = 'key'; ki.type = 'text'; ki.value = k || ''; ki.placeholder = 'Header name';
    var vi = document.createElement('input'); vi.className = 'val'; vi.type = 'text'; vi.value = v || ''; vi.placeholder = 'Value';
    var rm = document.createElement('button'); rm.className = 'btn-ghost'; rm.textContent = '\u00d7'; rm.onclick = function() { row.remove(); };
    row.appendChild(ki); row.appendChild(vi); row.appendChild(rm);
    document.getElementById('headers-list').appendChild(row);
    if (!k) ki.focus();
    return row;
  }

  function collectHeaders() {
    var h = {};
    document.getElementById('headers-list').querySelectorAll('.kv-row').forEach(function(r) {
      var ins = r.querySelectorAll('input');
      var k = ins[0].value.trim(), v = ins[1].value.trim();
      if (k) h[k] = v;
    });
    return h;
  }

  function collectHeadersArray() {
    var h = [];
    document.getElementById('headers-list').querySelectorAll('.kv-row').forEach(function(r) {
      var ins = r.querySelectorAll('input');
      var k = ins[0].value.trim(), v = ins[1].value.trim();
      if (k) h.push({ name: k, value: v });
    });
    return h;
  }

  // \u2500\u2500 body type \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  function onBodyType() {
    var t = document.getElementById('body-type').value;
    var txt = document.getElementById('body-text');
    txt.classList.toggle('hidden', t === 'none');
    if (t === 'json')      txt.placeholder = '{\\n  "key": "value"\\n}';
    else if (t === 'form') txt.placeholder = 'key1=value1&key2=value2';
    else                   txt.placeholder = 'Request body...';
  }

  var sendTimeoutId = null;
  function clearSendTimeout() {
    if (sendTimeoutId) { clearTimeout(sendTimeoutId); sendTimeoutId = null; }
  }

  // \u2500\u2500 send \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  function sendRequest() {
    if (sending) return;
    var url = document.getElementById('url-input').value.trim();
    if (!url) {
      showError('Enter a URL before sending.');
      return;
    }

    var method = document.getElementById('method').value;
    var rawHdrsArr = collectHeadersArray();
    var hdrs = {};
    rawHdrsArr.forEach(function(h) { hdrs[h.name] = h.value; });

    var token = document.getElementById('auth-token').value.trim();
    if (token) hdrs['Authorization'] = 'Bearer ' + token;

    var bodyType = document.getElementById('body-type').value;
    var body = undefined;
    if (bodyType !== 'none' && NO_BODY_METHODS.indexOf(method) === -1) {
      body = document.getElementById('body-text').value;
      if (bodyType === 'json') {
        if (!hdrs['Content-Type']) hdrs['Content-Type'] = 'application/json';
        if (body) {
          try { JSON.parse(body); } catch {
            showError('Invalid JSON body \u2014 fix the syntax before sending.');
            return;
          }
        }
      }
      if (bodyType === 'form') hdrs['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    sending = true;
    document.getElementById('send-btn').disabled = true;
    document.getElementById('res-bar').innerHTML = '<span class="spinner"></span><span class="meta">Sending\u2026</span>';
    document.getElementById('res-tab-strip').classList.add('hidden');
    document.getElementById('res-body-wrap').innerHTML = '';
    document.getElementById('res-headers-wrap').innerHTML = '';
    document.getElementById('res-body-wrap').classList.remove('hidden');
    document.getElementById('res-headers-wrap').classList.add('hidden');

    vscode.postMessage({ command: 'send', method: method, url: url, headers: hdrs, headersArray: rawHdrsArr, bodyType: bodyType, body: body || '', authToken: token });

    sendTimeoutId = setTimeout(function() {
      sending = false;
      document.getElementById('send-btn').disabled = false;
      showError('Extension did not respond after 30s. Check the URL and try again.');
    }, 30000);
  }

  // \u2500\u2500 messages \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  window.addEventListener('message', function(e) {
    var m = e.data;
    if (m.command === 'triggerSend') { sendRequest(); return; }
    if (m.command === 'loadRequest') { loadHistoryEntry(m); return; }
    if (m.command === 'loadEnvs') {
      var sel = document.getElementById('env-select');
      sel.innerHTML = '\x3coption value="">ÔÇö none ÔÇö\x3c/option>';
      (m.envs || []).forEach(function(env) {
        var opt = document.createElement('option');
        opt.value = env.filename;
        opt.textContent = env.name;
        if (env.filename === m.activeFilename) opt.selected = true;
        sel.appendChild(opt);
      });
      var active = (m.envs || []).find(function(e) { return e.filename === m.activeFilename; });
      document.getElementById('env-var-count').textContent = active ? active.varCount + ' var' + (active.varCount !== 1 ? 's' : '') : '';
      return;
    }
    if (m.command === 'loadHttpHistory') {
      httpHistory = m.entries || [];
      historyExpanded = {};
      renderHttpHistory();
      return;
    }
    clearSendTimeout();
    sending = false;
    document.getElementById('send-btn').disabled = false;
    if (m.command === 'response') {
      if (httpHistoryVisible) toggleHttpHistory();
      showResponse(m);
    } else if (m.command === 'error') showError(m.text);
  });

  var lastRawBody = '';

  function copyBody() {
    if (!lastRawBody) return;
    navigator.clipboard.writeText(lastRawBody).then(function() {
      var btn = document.getElementById('copy-btn');
      if (btn) { btn.textContent = 'Copied!'; setTimeout(function() { btn.textContent = 'Copy'; }, 1500); }
    });
  }

  function showResponse(m) {
    lastRawBody = m.body || '';
    var cls = m.status >= 500 ? 's5xx' : m.status >= 400 ? 's4xx' : m.status >= 300 ? 's3xx' : 's2xx';
    var size = m.size >= 1024 ? (m.size / 1024).toFixed(1) + ' KB' : m.size + ' B';
    document.getElementById('res-bar').innerHTML =
      '<span class="status-badge ' + cls + '">' + m.status + ' ' + esc(m.statusText) + '</span>' +
      '<span class="meta">' + m.time + ' ms</span>' +
      '<span class="meta">\u00b7</span>' +
      '<span class="meta">' + size + '</span>' +
      '<button id="copy-btn" class="btn btn-secondary" style="margin-left:auto;font-size:11px;padding:2px 8px">Copy</button>';
    var cpBtn = document.getElementById('copy-btn');
    if (cpBtn) cpBtn.addEventListener('click', copyBody);
    document.getElementById('res-tab-strip').classList.remove('hidden');

    // body
    var ct = flatHeader(m.headers, 'content-type') || '';
    var bodyHtml;
    if (/application\\/json/i.test(ct) || looksLikeJson(m.body)) {
      try { bodyHtml = syntaxHighlight(JSON.stringify(JSON.parse(m.body), null, 2)); }
      catch { bodyHtml = esc(m.body); }
    } else {
      bodyHtml = esc(m.body);
    }
    document.getElementById('res-body-wrap').innerHTML = m.body
      ? '<pre>' + bodyHtml + '</pre>'
      : '<p class="placeholder-msg">Empty response body</p>';

    // headers
    var hdrHtml = '<table class="hdr-table"><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody>';
    var hdrs = m.headers || {};
    Object.keys(hdrs).sort().forEach(function(k) {
      var v = Array.isArray(hdrs[k]) ? hdrs[k].join(', ') : String(hdrs[k] || '');
      hdrHtml += '<tr><td class="hdr-name">' + esc(k) + '</td><td>' + esc(v) + '</td></tr>';
    });
    document.getElementById('res-headers-wrap').innerHTML = hdrHtml + '</tbody></table>';
  }

  function showError(text) {
    document.getElementById('res-bar').innerHTML =
      '<span class="status-badge s5xx">Error</span>';
    document.getElementById('res-tab-strip').classList.add('hidden');
    document.getElementById('res-body-wrap').innerHTML = '<div class="err-box">' + esc(text) + '</div>';
    document.getElementById('res-body-wrap').classList.remove('hidden');
  }

  // \u2500\u2500 helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  function uq(s) {
    if (!s) return '';
    if ((s[0] === "'" && s[s.length-1] === "'") || (s[0] === '"' && s[s.length-1] === '"')) return s.slice(1, -1);
    return s;
  }

  function parseCurl(raw) {
    if (!raw) return null;
    var text = raw.replace(/\\\\\\r?\\n/g, ' ').replace(/\\s+/g, ' ').trim();
    if (!/^curl\\b/i.test(text)) return null;
    var method = 'GET', url = '', headers = [], body = '', bodyType = 'none', authToken = '';
    var tokens = [], re = /(?:'[^']*'|"(?:\\\\.|[^"\\\\])*"|[^\\s]+)/g, m;
    while ((m = re.exec(text)) !== null) tokens.push(m[0]);
    var i = 0;
    while (i < tokens.length) {
      var t = tokens[i];
      if (i === 0 && /^curl$/i.test(t)) { i++; continue; }
      if (t === '-X' || t === '--request') {
        method = uq(tokens[++i] || 'GET').toUpperCase();
      } else if (t === '-H' || t === '--header') {
        var hdr = uq(tokens[++i] || '');
        var col = hdr.indexOf(':');
        if (col > 0) {
          var hn = hdr.slice(0, col).trim(), hv = hdr.slice(col + 1).trim();
          if (hn.toLowerCase() === 'authorization' && hv.toLowerCase().startsWith('bearer ')) {
            authToken = hv.slice(7).trim();
          } else { headers.push({ name: hn, value: hv }); }
        }
      } else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary' || t === '--data-urlencode') {
        body = uq(tokens[++i] || '');
        var tb = body.trim();
        bodyType = (tb[0] === '{' || tb[0] === '[') ? 'json' : (body.indexOf('=') !== -1 ? 'form' : 'text');
        if (method === 'GET') method = 'POST';
      } else if (!t.startsWith('-') && !url) {
        url = uq(t);
      }
      i++;
    }
    return { method: method, url: url, headers: headers, body: body, bodyType: bodyType, authToken: authToken };
  }

  function buildCurl() {
    var url = document.getElementById('url-input').value.trim();
    if (!url) return null;
    var method = document.getElementById('method').value;
    var sq = function(s) { return "'" + s.replace(/'/g, "'\\''") + "'"; };
    var parts = ['curl'];
    if (method !== 'GET') parts.push('-X ' + method);
    parts.push(sq(url));
    collectHeadersArray().forEach(function(h) { parts.push('-H ' + sq(h.name + ': ' + h.value)); });
    var token = document.getElementById('auth-token').value.trim();
    if (token) parts.push('-H ' + sq('Authorization: Bearer ' + token));
    var bodyType = document.getElementById('body-type').value;
    var body = document.getElementById('body-text').value;
    if (bodyType !== 'none' && body) parts.push('-d ' + sq(body));
    return parts.join(' \\\n  ');
  }


  function toggleHttpHistory() {
    httpHistoryVisible = !httpHistoryVisible;
    document.getElementById('http-history-panel').classList.toggle('hidden', !httpHistoryVisible);
    document.querySelector('.req-section').classList.toggle('hidden', httpHistoryVisible);
    document.querySelector('.res-section').classList.toggle('hidden', httpHistoryVisible);
    document.getElementById('http-history-btn').textContent = httpHistoryVisible ? '┬½ Back' : 'History';
  }

  function loadHistoryEntry(entry) {
    if (!entry) return;
    var sel = document.getElementById('method');
    sel.value = entry.method || 'GET';
    onMethodChange(sel);
    document.getElementById('url-input').value = entry.url || '';
    document.getElementById('headers-list').innerHTML = '';
    (entry.headers || []).forEach(function(h) { addHeader(h.name, h.value); });
    var bt = document.getElementById('body-type');
    bt.value = entry.bodyType || 'none';
    onBodyType();
    document.getElementById('body-text').value = entry.body || '';
    document.getElementById('auth-token').value = entry.authToken || '';
  }

  function renderHttpHistory() {
    var list = document.getElementById('http-history-list');
    if (!httpHistory.length) {
      list.innerHTML = '\x3cp class="http-hist-empty">No history yet.\x3c/p>';
      return;
    }
    var html = '';
    for (var i = 0; i < httpHistory.length; i++) {
      var e = httpHistory[i];
      var m = (e.method || 'GET').toUpperCase();
      var mCls = ['GET','POST','PUT','PATCH','DELETE'].indexOf(m) !== -1 ? 'mb-' + m : 'mb-OTHER';
      var sc = e.statusCode || 0;
      var scCls = sc >= 500 ? 's5xx' : sc >= 400 ? 's4xx' : sc >= 300 ? 's3xx' : 's2xx';
      var ts = new Date(e.timestamp).toLocaleTimeString();
      var expanded = !!historyExpanded[i];
      html += '\x3cdiv class="http-hist-item">'
            + '\x3cdiv class="http-hist-row" data-idx="' + i + '">'
            + '\x3cspan class="http-method-badge ' + mCls + '">' + esc(m) + '\x3c/span>'
            + '\x3cspan class="http-hist-url" title="' + esc(e.url || '') + '">' + esc(e.url || '') + '\x3c/span>'
            + '\x3cdiv class="http-hist-meta">'
            + '\x3cspan class="status-badge ' + scCls + '" style="font-size:10px;padding:1px 6px">' + sc + '\x3c/span>'
            + '\x3cspan class="http-hist-time">' + e.responseTimeMs + ' ms\x3c/span>'
            + '\x3cspan class="http-hist-ts">' + esc(ts) + '\x3c/span>'
            + '\x3c/div>'
            + '\x3cdiv class="http-hist-actions">'
            + '\x3cbutton class="btn btn-secondary hist-load-btn" data-idx="' + i + '">Load\x3c/button>'
            + '\x3cbutton class="btn btn-secondary hist-resend-btn" data-idx="' + i + '">Resend\x3c/button>'
            + '\x3cbutton class="btn btn-secondary hist-save-btn" data-idx="' + i + '">Save\x3c/button>'
            + '\x3cbutton class="http-hist-expand">' + (expanded ? 'Ôû╝' : 'ÔûÂ') + '\x3c/button>'
            + '\x3c/div>'
            + '\x3c/div>';
      if (expanded && e.responseBody) {
        html += '\x3cdiv class="http-hist-body">\x3cpre>' + esc(e.responseBody.slice(0, 3000)) + '\x3c/pre>\x3c/div>';
      }
      html += '\x3c/div>';
    }
    list.innerHTML = html;
  }

  function flatHeader(hdrs, name) {
    var v = hdrs[name] || hdrs[name.split('-').map(function(p,i){return i===0?p:p[0].toUpperCase()+p.slice(1);}).join('-')];
    return Array.isArray(v) ? v[0] : (v || '');
  }

  function looksLikeJson(s) {
    if (!s) return false; var t = s.trim(); return t[0] === '{' || t[0] === '[';
  }

  function syntaxHighlight(json) {
    return json.replace(
      /("(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*"(?:\\s*:)?|\\b(?:true|false|null)\\b|-?\\d+(?:\\.\\d*)?(?:[eE][+\\-]?\\d+)?)/g,
      function(m) {
        var c = 'jn';
        if (/^"/.test(m)) c = /:$/.test(m) ? 'jk' : 'js';
        else if (/true|false/.test(m)) c = 'jb';
        else if (/null/.test(m)) c = 'jb';
        return '<span class="' + c + '">' + esc(m) + '</span>';
      }
    );
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/\x3c/g,'&lt;').replace(/\x3e/g,'&gt;').replace(/"/g,'&quot;');
  }
</script>
</body>
</html>`;
}

// ÔöÇÔöÇÔöÇ SQL table browser ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

type TableItemKind = 'schema' | 'table' | 'procedure' | 'message';

class SqlTableItem extends vscode.TreeItem {
    constructor(
        public readonly kind: TableItemKind,
        label: string,
        public readonly schema?: string,
        public readonly dbType?: DbTemplate,
    ) {
        const collapsible = kind === 'schema'
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;
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

    async refresh(schema?: string): Promise<void> {
        this.selectedSchema = schema;
        this.schemas.clear();
        this.state = 'loading';
        if (this.treeView) this.treeView.message = 'Loading tablesÔÇª';
        this._onDidChangeTreeData.fire();

        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const conn = cwd ? findConnection(cwd) : undefined;

        if (!conn) {
            this.state = 'noconn';
            if (this.treeView) this.treeView.message = 'No OpenBase project found in workspace.';
            this._onDidChangeTreeData.fire();
            return;
        }

        try {
            const data = await loadSqlTables(conn, this.selectedSchema);
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
        if (this.state === 'loading') return [new SqlTableItem('message', 'LoadingÔÇª')];
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
}

async function loadSqlTables(conn: DbConnection, targetSchema?: string): Promise<Map<string, { tables: string[]; procedures: string[]; functions: string[]; packages: string[]; dbType: DbTemplate }>> {
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
            case 'pgsql': {
                const schemaFilter = targetSchema ? `AND table_schema = '${targetSchema}'` : `AND table_schema NOT IN ('pg_catalog','information_schema')`;
                const q = `
                    SELECT table_schema, table_name, 'TABLE' AS type FROM information_schema.tables WHERE table_type='BASE TABLE' ${schemaFilter}
                    UNION ALL
                    SELECT routine_schema, routine_name, routine_type FROM information_schema.routines WHERE 1=1 ${schemaFilter.replace(/table_schema/g, 'routine_schema')}
                    ORDER BY table_schema, type, table_name`;
                fs.writeFileSync(tmpFile, q, 'utf-8');
                const port = conn.port ?? '5432';
                const u = encodeURIComponent(conn.user ?? 'postgres');
                const p = encodeURIComponent(conn.password ?? '');
                cmd = `psql "postgresql://${u}:${p}@${conn.server}:${port}/${conn.database}" --csv -f "${tmpFile}"`;
                break;
            }
            case 'oracle': {
                const schema = targetSchema ? targetSchema.toUpperCase() : (conn.user || '').toUpperCase();
                const q = `SET MARKUP CSV ON DELIMITER '|' QUOTE OFF
SET PAGESIZE 50000
SELECT OWNER, TABLE_NAME AS NAME, 'TABLE' AS OBJECT_TYPE FROM ALL_TABLES WHERE OWNER = '${schema}' ORDER BY TABLE_NAME
/
EXIT
`;
                fs.writeFileSync(tmpFile, q, 'utf-8');
                cmd = `sqlplus -S "${conn.user}/${conn.password ?? ''}@${conn.server}" @"${tmpFile}"`;
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

interface TableColumn {
    name: string;
    type: string;
    size: string;
    nullable: string;
    defaultVal: string;
}

interface TableConstraint {
    type: string;
    name: string;
    column: string;
    refSchema: string;
    refTable: string;
    refColumn: string;
}

interface ErTableData {
    schema: string;
    name: string;
    columns: { name: string; type: string; pk: boolean; fk: boolean }[];
    fks: { toSchema: string; toTable: string }[];
}

function tableToPascalCase(name: string): string {
    if (/[_\-]/.test(name)) {
        return name.split(/[_\-]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
    }
    return name.charAt(0).toUpperCase() + name.slice(1);
}

async function detectScaffoldEntity(cwd: string, table: string): Promise<string | undefined> {
    const escaped = table.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return new Promise<string | undefined>(resolve => {
        exec(
            `find "${cwd}/src" -name "*Configuration.cs" -not -path "*/obj/*" -exec grep -l 'ToTable("${escaped}")' {} + 2>/dev/null`,
            { timeout: 5000 },
            (_err, out) => {
                const file = out.trim().split('\n')[0];
                if (!file) { resolve(undefined); return; }
                const m = path.basename(file).match(/^(.+)Configuration\.cs$/);
                resolve(m ? m[1] : undefined);
            },
        );
    });
}

async function loadTableDetails(
    conn: DbConnection,
    schema: string,
    table: string,
): Promise<{ columns: TableColumn[]; constraints: TableConstraint[] }> {
    const extraPath = dotnetToolsPath();
    const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
    const ts = Date.now();
    const colFile = path.join(os.tmpdir(), `ob_cols_${ts}.sql`);
    const conFile = path.join(os.tmpdir(), `ob_cons_${ts}.sql`);
    const s = schema.replace(/'/g, "''");
    const t = table.replace(/'/g, "''");

    let colCmd = '';
    let conCmd = '';
    let sep = '|';

    switch (conn.type) {
        case 'sqlserver': {
            const auth = conn.user ? `-U "${conn.user}" -P "${conn.password ?? ''}"` : '';
            const colQ = `SELECT c.COLUMN_NAME, c.DATA_TYPE, CASE WHEN c.CHARACTER_MAXIMUM_LENGTH IS NOT NULL THEN CAST(c.CHARACTER_MAXIMUM_LENGTH AS VARCHAR) WHEN c.NUMERIC_PRECISION IS NOT NULL THEN CAST(c.NUMERIC_PRECISION AS VARCHAR) ELSE '' END AS SZ, c.IS_NULLABLE, ISNULL(c.COLUMN_DEFAULT,'') FROM INFORMATION_SCHEMA.COLUMNS c WHERE c.TABLE_SCHEMA='${s}' AND c.TABLE_NAME='${t}' ORDER BY c.ORDINAL_POSITION`;
            const conQ = `SELECT tc.CONSTRAINT_TYPE, tc.CONSTRAINT_NAME, kcu.COLUMN_NAME, ISNULL(ccu.TABLE_SCHEMA,'') AS RS, ISNULL(ccu.TABLE_NAME,'') AS RT, ISNULL(ccu.COLUMN_NAME,'') AS RC FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ON tc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA=kcu.TABLE_SCHEMA AND tc.TABLE_NAME=kcu.TABLE_NAME LEFT JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc ON tc.CONSTRAINT_NAME=rc.CONSTRAINT_NAME LEFT JOIN INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE ccu ON rc.UNIQUE_CONSTRAINT_NAME=ccu.CONSTRAINT_NAME WHERE tc.TABLE_SCHEMA='${s}' AND tc.TABLE_NAME='${t}' ORDER BY tc.CONSTRAINT_TYPE, kcu.ORDINAL_POSITION`;
            fs.writeFileSync(colFile, colQ, 'utf-8');
            fs.writeFileSync(conFile, conQ, 'utf-8');
            colCmd = `sqlcmd -S "${conn.server}" -d "${conn.database}" ${auth} -i "${colFile}" -s "|" -W -h -1`;
            conCmd = `sqlcmd -S "${conn.server}" -d "${conn.database}" ${auth} -i "${conFile}" -s "|" -W -h -1`;
            break;
        }
        case 'pgsql': {
            sep = ',';
            const port = conn.port ?? '5432';
            const u = encodeURIComponent(conn.user ?? 'postgres');
            const p = encodeURIComponent(conn.password ?? '');
            const dsn = `postgresql://${u}:${p}@${conn.server}:${port}/${conn.database}`;
            const colQ = `SELECT column_name, data_type, COALESCE(CAST(character_maximum_length AS VARCHAR), CAST(numeric_precision AS VARCHAR), '') AS sz, is_nullable, COALESCE(column_default,'') FROM information_schema.columns WHERE table_schema='${s}' AND table_name='${t}' ORDER BY ordinal_position`;
            const conQ = `SELECT tc.constraint_type, tc.constraint_name, kcu.column_name, COALESCE(ccu.table_schema,'') AS rs, COALESCE(ccu.table_name,'') AS rt, COALESCE(ccu.column_name,'') AS rc FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema AND tc.table_name=kcu.table_name LEFT JOIN information_schema.referential_constraints rfk ON tc.constraint_name=rfk.constraint_name LEFT JOIN information_schema.constraint_column_usage ccu ON rfk.unique_constraint_name=ccu.constraint_name WHERE tc.table_schema='${s}' AND tc.table_name='${t}' ORDER BY tc.constraint_type, kcu.ordinal_position`;
            fs.writeFileSync(colFile, colQ, 'utf-8');
            fs.writeFileSync(conFile, conQ, 'utf-8');
            colCmd = `psql "${dsn}" --csv -f "${colFile}"`;
            conCmd = `psql "${dsn}" --csv -f "${conFile}"`;
            break;
        }
        case 'oracle': {
            const colQ = `SET PAGESIZE 0\nSET FEEDBACK OFF\nSET HEADING OFF\nSELECT COLUMN_NAME || '|' || DATA_TYPE || '|' || CASE WHEN DATA_PRECISION IS NOT NULL THEN TO_CHAR(DATA_PRECISION) ELSE TO_CHAR(DATA_LENGTH) END || '|' || NULLABLE FROM ALL_TAB_COLUMNS WHERE UPPER(OWNER)='${s.toUpperCase()}' AND UPPER(TABLE_NAME)='${t.toUpperCase()}' ORDER BY COLUMN_ID;\nEXIT\n`;
            const conQ = `SET MARKUP CSV ON DELIMITER '|' QUOTE OFF\nSET PAGESIZE 50000\nSELECT uc.CONSTRAINT_TYPE, uc.CONSTRAINT_NAME, ucc.COLUMN_NAME, NVL(rc.OWNER,' ') AS RS, NVL(rc.TABLE_NAME,' ') AS RT, NVL(rcc.COLUMN_NAME,' ') AS RC FROM ALL_CONSTRAINTS uc JOIN ALL_CONS_COLUMNS ucc ON uc.CONSTRAINT_NAME=ucc.CONSTRAINT_NAME AND uc.OWNER=ucc.OWNER LEFT JOIN ALL_CONSTRAINTS rc ON uc.R_CONSTRAINT_NAME=rc.CONSTRAINT_NAME LEFT JOIN ALL_CONS_COLUMNS rcc ON rc.CONSTRAINT_NAME=rcc.CONSTRAINT_NAME AND rcc.POSITION=1 WHERE uc.OWNER='${s.toUpperCase()}' AND uc.TABLE_NAME='${t.toUpperCase()}' AND uc.CONSTRAINT_TYPE IN ('P','R','U') ORDER BY uc.CONSTRAINT_TYPE, ucc.POSITION;\n/\nEXIT\n`;
            fs.writeFileSync(colFile, colQ, 'utf-8');
            fs.writeFileSync(conFile, conQ, 'utf-8');
            colCmd = `sqlplus -S "${conn.user}/${conn.password ?? ''}@${conn.server}" @"${colFile}"`;
            conCmd = `sqlplus -S "${conn.user}/${conn.password ?? ''}@${conn.server}" @"${conFile}"`;
            break;
        }
    }

    const runQ = (cmd: string, type: string) => new Promise<string>((resolve, reject) => {
        console.log(`Executing ${type} command: ${cmd}`);
        exec(cmd, { env, timeout: 15000 }, (err, out, stderr) => {
            if (err) {
                console.error(`Error executing ${type}:`, err);
                console.error(`Stderr:`, stderr);
                reject(new Error(stderr || err.message));
            } else {
                console.log(`${type} output:`, out);
                resolve(out);
            }
        });
    });

    try {
        const [colOut, conOut] = await Promise.all([runQ(colCmd, 'columns'), runQ(conCmd, 'constraints')]);

        const HEADER = new Set(['column_name', 'constraint_type', 'sz', 'owner']);

        const parseRows = (raw: string, minCols: number): string[][] =>
            raw.split('\n')
                .map(l => l.trim())
                .filter(l => l && !l.startsWith('---') && !/^\d+ rows? selected/i.test(l))
                .map(l => l.split(conn.type === 'oracle' ? '|' : sep).map(p => p.replace(/^"|"$/g, '').trim()))
                .filter(p => p.length >= minCols && !HEADER.has(p[0].toLowerCase()));

        const conRows = parseRows(conOut, 3);
        const constraints: TableConstraint[] = conRows.map(r => {
            let type = r[0] ?? '';
            if (type === 'P') type = 'PRIMARY KEY';
            else if (type === 'R') type = 'FOREIGN KEY';
            else if (type === 'U') type = 'UNIQUE';
            else if (type === 'C') type = 'CHECK';
            return {
                type,
                name: r[1] ?? '',
                column: r[2] ?? '',
                refSchema: (r[3] ?? '').trim(),
                refTable: (r[4] ?? '').trim(),
                refColumn: (r[5] ?? '').trim(),
            };
        });
        const columns: TableColumn[] = parseRows(colOut, conn.type === 'oracle' ? 4 : 5).map(r => ({
            name: r[0] ?? '',
            type: r[1] ?? '',
            size: r[2] ?? '',
        
            nullable: conn.type === 'oracle'
                ? (r[3] === 'N' ? 'NO' : 'YES')
                : (r[3] ?? ''),
            defaultVal: r[4] ?? '',
        }));

        return { columns, constraints };
    } finally {
        try { fs.unlinkSync(colFile); } catch { /* ignore */ }
        try { fs.unlinkSync(conFile); } catch { /* ignore */ }
    }
}

function buildTableInspectorHtml(
    nonce: string,
    cspSource: string,
    schema: string,
    table: string,
    dbType: DbTemplate,
    columns: TableColumn[],
    constraints: TableConstraint[],
    entityName: string,
    hasScaffold: boolean,
): string {
    const esc = (s: string) => String(s)
        .replace(/&/g, '&amp;')
        .replace(/\x3c/g, '&lt;')
        .replace(/\x3e/g, '&gt;');

    const pkCols = new Set(constraints.filter(c => c.type === 'PRIMARY KEY').map(c => c.column));
    const fkCols = new Set(constraints.filter(c => c.type === 'FOREIGN KEY').map(c => c.column));

    const badge = (text: string, cls: string) => `<span class="badge ${cls}">${text}</span>`;

    const dbLabel: Record<DbTemplate, string> = {
        sqlserver: 'SQL Server', pgsql: 'PostgreSQL', oracle: 'Oracle',
    };

    const colRows = columns.map(c => {
        const sz = c.size && c.size !== '0' ? `(${esc(c.size)})` : '';
        const badges = (pkCols.has(c.name) ? badge('PK', 'pk') : '')
                     + (fkCols.has(c.name) ? badge('FK', 'fk') : '');
        const nullCell = (c.nullable === 'NO' || c.nullable === 'N')
            ? '<span class="not-null">NOT NULL</span>'
            : '<span class="null">NULL</span>';
        const defCell = c.defaultVal?.trim()
            ? `<code class="def">${esc(c.defaultVal)}</code>`
            : '';
        return `<tr><td><div class="col-name">${badges}<span>${esc(c.name)}</span></div></td><td class="mono">${esc(c.type)}${sz}</td><td>${nullCell}</td><td>${defCell}</td></tr>`;
    }).join('');

    const conRows = constraints.map(c => {
        const typeCell = c.type === 'PRIMARY KEY' ? badge('PK', 'pk') + '&nbsp;Primary Key'
            : c.type === 'FOREIGN KEY' ? badge('FK', 'fk') + '&nbsp;Foreign Key'
            : c.type === 'UNIQUE' ? badge('UQ', 'uq') + '&nbsp;Unique'
            : c.type === 'CHECK' ? badge('CK', 'ck') + '&nbsp;Check'
            : esc(c.type);
        const refsCell = c.refTable?.trim()
            ? `<span class="ref">${esc(c.refSchema)}.${esc(c.refTable)}</span><span class="ref-col">.${esc(c.refColumn)}</span>`
            : '';
        return `<tr><td class="con-type">${typeCell}</td><td class="mono small">${esc(c.name)}</td><td class="mono">${esc(c.column)}</td><td>${refsCell}</td></tr>`;
    }).join('');

    const stats = `${columns.length} column${columns.length !== 1 ? 's' : ''}${
        constraints.length
            ? ' &middot; ' + constraints.length + ' constraint' + (constraints.length !== 1 ? 's' : '')
            : ''}`;

    const conSection = constraints.length > 0 ? `<div class="section">
  <div class="section-title">Constraints</div>
  <table>
    <thead><tr><th>Type</th><th>Name</th><th>Column</th><th>References</th></tr></thead>
    <tbody>${conRows}</tbody>
  </table>
</div>` : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(schema)}.${esc(table)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d0f1a;color:#e8e8f0;font-family:'Segoe UI',-apple-system,sans-serif;font-size:13px}
.header{background:linear-gradient(135deg,#1a0830 0%,#0d0f1a 100%);border-bottom:1px solid rgba(180,79,255,0.25);padding:16px 20px;position:sticky;top:0;z-index:10}
.header-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.tbl-icon{width:34px;height:34px;background:linear-gradient(135deg,#b44fff,#ff3fa4);border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px;line-height:1}
.tbl-meta{flex:1;min-width:0}
.tbl-name{font-size:18px;font-weight:700;background:linear-gradient(90deg,#b44fff,#ff3fa4);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;line-height:1.2}
.tbl-schema{font-size:11px;color:#555;font-family:monospace;margin-top:3px}
.db-badge{background:#1a1040;border:1px solid rgba(180,79,255,0.35);color:#b44fff;font-size:10px;padding:2px 9px;border-radius:10px;white-space:nowrap;flex-shrink:0}
.btn-sel{background:linear-gradient(135deg,#b44fff,#ff3fa4);color:#fff;border:none;padding:6px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;transition:opacity .15s;white-space:nowrap;flex-shrink:0}
.btn-sel:hover{opacity:.82}
.btn-scaffold{background:rgba(180,79,255,.12);color:#b44fff;border:1px solid rgba(180,79,255,.4);padding:6px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s;white-space:nowrap;flex-shrink:0}
.btn-scaffold:hover{background:rgba(180,79,255,.22);border-color:#b44fff}
.stats{font-size:11px;color:#444;margin-top:8px}
.section{padding:0 20px 28px}
.section-title{font-size:10px;font-weight:700;letter-spacing:1.2px;color:#b44fff;text-transform:uppercase;padding:18px 0 10px;border-bottom:1px solid rgba(180,79,255,0.15)}
table{width:100%;border-collapse:collapse}
th{background:#120d2e;color:#555;font-size:11px;font-weight:600;letter-spacing:.5px;text-align:left;padding:8px 10px;border-bottom:1px solid rgba(180,79,255,0.15)}
td{padding:7px 10px;border-bottom:1px solid rgba(255,255,255,0.04);vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(180,79,255,0.05)}
.col-name{display:flex;align-items:center;gap:5px;font-weight:500}
.badge{font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;letter-spacing:.4px;flex-shrink:0}
.badge.pk{background:rgba(255,215,0,.12);color:#ffd700;border:1px solid rgba(255,215,0,.3)}
.badge.fk{background:rgba(79,195,247,.12);color:#4fc3f7;border:1px solid rgba(79,195,247,.3)}
.badge.uq{background:rgba(129,199,132,.12);color:#81c784;border:1px solid rgba(129,199,132,.3)}
.badge.ck{background:rgba(255,183,77,.12);color:#ffb74d;border:1px solid rgba(255,183,77,.3)}
.not-null{color:#ff6b6b;font-size:11px}
.null{color:#333;font-size:11px}
.mono{font-family:'Cascadia Code','Fira Code',Consolas,monospace;font-size:12px}
.small{font-size:11px}
.def{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);padding:1px 5px;border-radius:3px;font-size:11px;font-family:monospace;color:#666;max-width:180px;display:inline-block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}
.con-type{white-space:nowrap}
.ref{color:#b44fff;font-family:monospace;font-size:12px}
.ref-col{color:#ff3fa4;font-family:monospace;font-size:12px}
.empty{color:#444;text-align:center;padding:24px;font-style:italic}
</style>
</head>
<body>
<div class="header">
  <div class="header-top">
    <div class="tbl-icon">&#x1F5C4;</div>
    <div class="tbl-meta">
      <div class="tbl-name">${esc(table)}</div>
      <div class="tbl-schema">${esc(schema)}</div>
    </div>
    <span class="db-badge">${esc(dbLabel[dbType])}</span>
    <button class="btn-scaffold" id="btn-scaffold" data-cmd="${hasScaffold ? 'scaffoldUpdate' : 'scaffold'}" data-entity="${esc(entityName)}">${hasScaffold ? '&#x21BB;&nbsp;Update Scaffold' : '+&nbsp;Scaffold'}</button>
    <button class="btn-sel" id="btn-sel">&#x25B6;&nbsp;SELECT</button>
  </div>
  <div class="stats">${stats}</div>
</div>
<div class="section">
  <div class="section-title">Columns</div>
  <table>
    <thead><tr><th>Name</th><th>Type</th><th>Nullable</th><th>Default</th></tr></thead>
    <tbody>${colRows || '<tr><td colspan="4" class="empty">No columns found</td></tr>'}</tbody>
  </table>
</div>
${conSection}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.getElementById('btn-sel').addEventListener('click', function() {
    vscode.postMessage({ command: 'runSelect' });
});
var scaffoldBtn = document.getElementById('btn-scaffold');
scaffoldBtn.addEventListener('click', function() {
    vscode.postMessage({ command: scaffoldBtn.dataset.cmd, entity: scaffoldBtn.dataset.entity });
});
</script>
</body>
</html>`;
}

function buildTableInspectorLoadingHtml(nonce: string, cspSource: string, schema: string, table: string): string {
    const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/\x3c/g, '&lt;').replace(/\x3e/g, '&gt;');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline';">
<style>
  :root {
    --ob-bg0: var(--vscode-editor-background);
    --ob-purple: #b44fff;
  }
  body.vscode-dark { --ob-bg0: #0d0f1a; }
  body.vscode-light { --ob-bg0: #fdfdff; --ob-purple: #7b2cbf; }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--ob-bg0);color:var(--vscode-foreground);font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:14px}
  .spinner{width:30px;height:30px;border:3px solid rgba(180,79,255,.2);border-top-color:var(--ob-purple);border-radius:50%;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .name{background:linear-gradient(90deg,var(--ob-purple),#ff3fa4);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;font-weight:700;font-size:14px}
  .lbl{color:var(--vscode-descriptionForeground);font-size:11px}
</style>
</head>
<body>
<div class="spinner"></div>
<div class="name">${esc(schema)}.${esc(table)}</div>
<div class="lbl">Loading table details&hellip;</div>
</body>
</html>`;
}

function buildTableInspectorErrorHtml(nonce: string, cspSource: string, schema: string, table: string, error: string): string {
    const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/\x3c/g, '&lt;').replace(/\x3e/g, '&gt;');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline';">
<style>
  :root{
    --ob-bg0: var(--vscode-editor-background);
    --ob-text: var(--vscode-foreground);
    --ob-purple: #b44fff;
    --ob-pink: #ff3fa4;
  }
  body.vscode-dark {
    --ob-bg0: #0d0f1a;
    --ob-text: #e8e8f0;
  }
  body.vscode-light {
    --ob-bg0: #fdfdff;
    --ob-text: #24292e;
    --ob-purple: #7b2cbf;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--ob-bg0);color:var(--ob-text);font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:12px;padding:24px;text-align:center}
  .icon{font-size:30px}
  .name{background:linear-gradient(90deg,var(--ob-purple),var(--ob-pink));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;font-weight:700;font-size:14px}
  .err{background:rgba(255,107,107,0.05);border:1px solid rgba(255,107,107,.3);color:#ff6b6b;padding:12px 16px;border-radius:8px;font-family:monospace;font-size:12px;max-width:480px;word-break:break-word}
</style>
</head>
<body>
<div class="icon">&#x26A0;&#xFE0F;</div>
<div class="name">${esc(schema)}.${esc(table)}</div>
<div class="err">${esc(error)}</div>
</body>
</html>`;
}

// ÔöÇÔöÇÔöÇ ER Diagram ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

function buildErDiagramLoadingHtml(nonce: string, cspSource: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline';">
<style>
  :root {
    --ob-bg0: var(--vscode-editor-background);
    --ob-purple: #b44fff;
  }
  body.vscode-dark { --ob-bg0: #0d0f1a; }
  body.vscode-light { --ob-bg0: #fdfdff; --ob-purple: #7b2cbf; }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--ob-bg0);color:var(--vscode-foreground);font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:14px}
  .spinner{width:32px;height:32px;border:3px solid rgba(180,79,255,.2);border-top-color:var(--ob-purple);border-radius:50%;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .lbl{color:var(--vscode-descriptionForeground);font-size:12px}
</style>
</head>
<body>
<div class="spinner"></div>
<div class="lbl">Loading ER Diagram&hellip;</div>
</body>
</html>`;
}

function buildErDiagramHtml(nonce: string, cspSource: string, tables: ErTableData[]): string {
    const schemas = [...new Set(tables.map(t => t.schema))].sort();
    const schemaOpts = schemas.map(s => `<option value="${s.replace(/"/g, '&quot;')}">${s.replace(/&/g, '&amp;').replace(/\x3c/g, '&lt;')}</option>`).join('');
    const dataJson = JSON.stringify(tables).replace(/\x3c/g, '\\u003c');

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline' https://cdn.jsdelivr.net; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; img-src data: blob:;">
<style>
  :root {
    --ob-bg0: var(--vscode-editor-background);
    --ob-bg1: var(--vscode-sideBar-background);
    --ob-bg2: var(--vscode-input-background);
    --ob-purple: #b44fff;
    --ob-border: var(--vscode-panel-border);
    --ob-text: var(--vscode-foreground);
    --ob-dim: var(--vscode-descriptionForeground);
  }
  body.vscode-dark {
    --ob-bg0: #0d0f1a;
    --ob-bg1: #111328;
    --ob-bg2: #1a1c2e;
    --ob-border: #1e2035;
    --ob-text: #e8e8f0;
    --ob-dim: #888;
  }
  body.vscode-light {
    --ob-bg0: #fdfdff;
    --ob-bg1: #f1f3f9;
    --ob-bg2: #ffffff;
    --ob-purple: #7b2cbf;
    --ob-border: #e0e4ef;
    --ob-text: #24292e;
    --ob-dim: #6a737d;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%;overflow:hidden;background:var(--ob-bg0);color:var(--ob-text);font-family:'Segoe UI',sans-serif;font-size:13px}
  .toolbar{display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--ob-border);flex-shrink:0;background:var(--ob-bg1)}
  .toolbar label{color:var(--ob-dim);font-size:11px}
  select{background:var(--ob-bg2);color:var(--ob-text);border:1px solid var(--ob-border);border-radius:4px;padding:3px 6px;font-size:12px;font-family:inherit;cursor:pointer}
  .btn{padding:3px 10px;border:1px solid var(--ob-border);border-radius:4px;cursor:pointer;font-family:inherit;font-size:12px;background:var(--ob-bg2);color:var(--ob-text)}
  .btn:hover{background:var(--ob-bg1);border-color:var(--ob-purple)}
  .sep{width:1px;height:18px;background:var(--ob-border);margin:0 2px}
  .wrap{flex:1;overflow:hidden;position:relative;cursor:grab}
  .wrap.dragging{cursor:grabbing}
  #diagram{position:absolute;top:0;left:0;transform-origin:0 0;padding:20px}
  #diagram svg{display:block}
  .hint{color:var(--ob-dim);font-size:11px;margin-left:auto}
  .count{color:var(--ob-dim);font-size:11px}
</style>
</head>
<body style="display:flex;flex-direction:column">
<div class="toolbar">
  <label>Schema</label>
  <select id="schema-sel">
    ${schemas.length > 1 ? '<option value="__all__">All schemas</option>' : ''}
    ${schemaOpts}
  </select>
  <div class="sep"></div>
  <button class="btn" id="btn-zi">+</button>
  <button class="btn" id="btn-zo">&minus;</button>
  <button class="btn" id="btn-zr">Reset</button>
  <div class="sep"></div>
  <button class="btn" id="btn-ex">Export SVG</button>
  <span class="count" id="count"></span>
  <span class="hint">Scroll to zoom &middot; Drag to pan &middot; Click table to inspect</span>
</div>
<div class="wrap" id="wrap">
  <div id="diagram"></div>
</div>
<script type="application/json" id="er-data">${dataJson}</script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js" nonce="${nonce}"></script>
<script nonce="${nonce}">
(function() {
  var vscode = acquireVsCodeApi();
  var DATA = JSON.parse(document.getElementById('er-data').textContent || '[]');
  var scale = 1, panX = 20, panY = 20;
  var dragging = false, dx = 0, dy = 0, spx = 0, spy = 0;
  var diagramEl = document.getElementById('diagram');
  var wrap = document.getElementById('wrap');
  var currentTables = [];

  mermaid.initialize({ startOnLoad: false, theme: 'dark', maxTextSize: 200000, er: { diagramPadding: 24, entityPadding: 12, useMaxWidth: false } });

  function sanitize(s) { return String(s || '').replace(/[^a-zA-Z0-9]/g, '_') || '_'; }
  function eid(schema, table) { return sanitize(schema) + '_' + sanitize(table); }

  function buildDiagram(tables) {
    var lines = ['erDiagram'];
    var ids = {};
    for (var i = 0; i < tables.length; i++) { ids[eid(tables[i].schema, tables[i].name)] = true; }

    for (var i = 0; i < tables.length; i++) {
      var t = tables[i];
      var id = eid(t.schema, t.name);
      var seen = {};
      lines.push('  ' + id + ' {');
      if (t.columns.length > 0) {
        for (var j = 0; j < t.columns.length; j++) {
          var col = t.columns[j];
          var ctype = (col.type.split('(')[0] || 'text').replace(/[^a-zA-Z0-9_]/g, '_') || 'text';
          var cname = sanitize(col.name);
          if (/^[0-9]/.test(ctype)) { ctype = 't' + ctype; }
          if (/^[0-9]/.test(cname)) { cname = 'c' + cname; }
          var ukey = ctype + '_' + cname;
          if (seen[ukey]) { continue; }
          seen[ukey] = true;
          var attrs = col.pk ? ' PK' : (col.fk ? ' FK' : '');
          lines.push('    ' + ctype + ' ' + cname + attrs);
        }
      } else {
        lines.push('    string _');
      }
      lines.push('  }');
    }

    var relSeen = {};
    for (var i = 0; i < tables.length; i++) {
      var t = tables[i];
      var fromId = eid(t.schema, t.name);
      for (var j = 0; j < t.fks.length; j++) {
        var fk = t.fks[j];
        var toSchema = fk.toSchema || t.schema;
        var toId = eid(toSchema, fk.toTable);
        if (!ids[toId] || toId === fromId) { continue; }
        var rkey = toId + '|' + fromId;
        if (relSeen[rkey]) { continue; }
        relSeen[rkey] = true;
        lines.push('  ' + toId + ' ||--o{ ' + fromId + ' : "has"');
      }
    }
    return lines.join('\\n');
  }

  function applyT() {
    diagramEl.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')';
  }

  function addClicks(tables) {
    var map = {};
    for (var i = 0; i < tables.length; i++) {
      map[eid(tables[i].schema, tables[i].name)] = { schema: tables[i].schema, table: tables[i].name };
    }
    var svg = diagramEl.querySelector('svg');
    if (!svg) { return; }
    var texts = svg.querySelectorAll('text');
    for (var i = 0; i < texts.length; i++) {
      var txt = texts[i];
      var content = (txt.textContent || '').trim();
      if (!map[content]) { continue; }
      (function(info) {
        var g = txt.parentNode;
        while (g && g.tagName !== 'g' && g !== svg) { g = g.parentNode; }
        if (!g || g === svg) { return; }
        g.style.cursor = 'pointer';
        g.addEventListener('click', function(e) {
          e.stopPropagation();
          vscode.postMessage({ command: 'inspect', schema: info.schema, table: info.table });
        });
      })(map[content]);
    }
  }

  async function render(tables) {
    currentTables = tables;
    document.getElementById('count').textContent = tables.length + ' table' + (tables.length !== 1 ? 's' : '');
    if (tables.length === 0) {
      diagramEl.innerHTML = '\x3cp style="color:#555;padding:40px">No tables to display.\x3c/p>';
      return;
    }
    diagramEl.innerHTML = '';
    try {
      var str = buildDiagram(tables);
      var result = await mermaid.render('er-graph-' + Date.now(), str);
      diagramEl.innerHTML = result.svg;
      addClicks(tables);
    } catch(e) {
      diagramEl.innerHTML = '\x3cp style="color:#c72e0f;padding:40px">Render error: ' + String(e) + '\x3c/p>';
    }
  }

  function filterAndRender() {
    var sel = document.getElementById('schema-sel').value;
    var filtered = sel === '__all__' ? DATA : DATA.filter(function(t) { return t.schema === sel; });
    panX = 20; panY = 20; scale = 1; applyT();
    render(filtered);
  }

  document.getElementById('schema-sel').addEventListener('change', filterAndRender);
  document.getElementById('btn-zi').addEventListener('click', function() { scale = Math.min(4, scale * 1.2); applyT(); });
  document.getElementById('btn-zo').addEventListener('click', function() { scale = Math.max(0.1, scale / 1.2); applyT(); });
  document.getElementById('btn-zr').addEventListener('click', function() { scale = 1; panX = 20; panY = 20; applyT(); });
  document.getElementById('btn-ex').addEventListener('click', function() {
    var svg = diagramEl.querySelector('svg');
    if (!svg) { return; }
    vscode.postMessage({ command: 'exportSvg', svg: svg.outerHTML });
  });

  wrap.addEventListener('wheel', function(e) {
    e.preventDefault();
    var rect = wrap.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    var delta = e.deltaY > 0 ? 0.9 : 1.1;
    var ns = Math.min(4, Math.max(0.1, scale * delta));
    panX = mx - (mx - panX) * (ns / scale);
    panY = my - (my - panY) * (ns / scale);
    scale = ns;
    applyT();
  }, { passive: false });

  wrap.addEventListener('mousedown', function(e) {
    if (e.button !== 0) { return; }
    dragging = true; dx = e.clientX; dy = e.clientY; spx = panX; spy = panY;
    wrap.classList.add('dragging');
  });
  window.addEventListener('mousemove', function(e) {
    if (!dragging) { return; }
    panX = spx + (e.clientX - dx); panY = spy + (e.clientY - dy); applyT();
  });
  window.addEventListener('mouseup', function() { dragging = false; wrap.classList.remove('dragging'); });

  window.addEventListener('message', function(ev) {
    var msg = ev.data;
    if (msg && msg.command === 'refresh') { filterAndRender(); }
  });

  filterAndRender();
})();
</script>
</body>
</html>`;
}

let erDiagramPanel: vscode.WebviewPanel | undefined;

async function openErDiagram(): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const conn = cwd ? findConnection(cwd) : undefined;
    if (!conn) {
        vscode.window.showErrorMessage('No database connection found in workspace.');
        return;
    }

    if (erDiagramPanel) {
        erDiagramPanel.reveal(vscode.ViewColumn.One);
        return;
    }

    const nonce = getNonce();
    erDiagramPanel = vscode.window.createWebviewPanel(
        'openbase.erDiagram', 'ER Diagram',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
    );
    erDiagramPanel.onDidDispose(() => { erDiagramPanel = undefined; });
    erDiagramPanel.webview.html = buildErDiagramLoadingHtml(nonce, erDiagramPanel.webview.cspSource);

    erDiagramPanel.webview.onDidReceiveMessage(async (msg: { command: string; schema?: string; table?: string; svg?: string }) => {
        if (msg.command === 'inspect' && msg.schema && msg.table) {
            await openTableInspector(conn, msg.schema, msg.table, conn.type as DbTemplate);
        } else if (msg.command === 'exportSvg' && msg.svg) {
            const uri = await vscode.window.showSaveDialog({ filters: { 'SVG Image': ['svg'] }, defaultUri: vscode.Uri.file('er-diagram.svg') });
            if (uri) {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(msg.svg, 'utf-8'));
                vscode.window.showInformationMessage(`ER Diagram exported to ${uri.fsPath}`);
            }
        }
    });

    try {
        const schemas = await loadSqlTables(conn);
        const allTables: { schema: string; table: string }[] = [];
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
                    const details = await loadTableDetails(conn, schema, table);
                    const pkCols = new Set(details.constraints.filter(c => c.type === 'PRIMARY KEY').map(c => c.column));
                    const fkCols = new Set(details.constraints.filter(c => c.type === 'FOREIGN KEY').map(c => c.column));
                    return {
                        schema,
                        name: table,
                        columns: details.columns.map(col => ({
                            name: col.name,
                            type: col.type,
                            pk: pkCols.has(col.name),
                            fk: fkCols.has(col.name),
                        })),
                        fks: details.constraints
                            .filter(c => c.type === 'FOREIGN KEY' && c.refTable)
                            .map(c => ({ toSchema: c.refSchema, toTable: c.refTable })),
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
}

// ÔöÇÔöÇÔöÇ Log Viewer ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

let logPanel: vscode.WebviewPanel | undefined;
let logProcess: import('child_process').ChildProcess | undefined;

async function logViewer(): Promise<void> {
    if (logPanel) {
        logPanel.reveal(vscode.ViewColumn.One);
        return;
    }

    const nonce = getNonce();
    logPanel = vscode.window.createWebviewPanel(
        'openbase.logViewer', 'OpenBase Logs',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
    );
    logPanel.onDidDispose(() => {
        logProcess?.kill();
        logProcess = undefined;
        logPanel = undefined;
    });
    logPanel.webview.html = buildLogViewerHtml(nonce, logPanel.webview.cspSource);

    logPanel.webview.onDidReceiveMessage(async (msg: { command: string; config?: string; text?: string }) => {
        if (msg.command === 'start') {
            if (logProcess) { logProcess.kill(); logProcess = undefined; }
            const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!cwd) { vscode.window.showErrorMessage('No workspace folder open.'); return; }
            const config = msg.config ?? 'Debug';
            const extraPath = dotnetToolsPath();
            const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
            logProcess = spawn('openbase', ['run', '-c', config], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
            logPanel?.webview.postMessage({ command: 'processStarted' });
            const onLine = (chunk: Buffer | string) => {
                const text = chunk.toString();
                text.split(/\r?\n/).forEach(line => {
                    if (line) logPanel?.webview.postMessage({ command: 'logLine', text: line });
                });
            };
            logProcess.stdout?.on('data', onLine);
            logProcess.stderr?.on('data', onLine);
            logProcess.on('close', () => {
                logProcess = undefined;
                logPanel?.webview.postMessage({ command: 'processStopped' });
            });
            logProcess.on('error', (err) => {
                logProcess = undefined;
                logPanel?.webview.postMessage({ command: 'processStopped' });
                logPanel?.webview.postMessage({ command: 'logLine', text: `[Error] ${err.message}` });
            });
            return;
        }

        if (msg.command === 'stop') {
            logProcess?.kill();
            logProcess = undefined;
            logPanel?.webview.postMessage({ command: 'processStopped' });
            return;
        }

        if (msg.command === 'export') {
            const defaultUri = vscode.Uri.file(path.join(
                vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(),
                `openbase-logs-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`
            ));
            const uri = await vscode.window.showSaveDialog({ defaultUri, filters: { 'Text': ['txt'] } });
            if (uri && msg.text) {
                fs.writeFileSync(uri.fsPath, msg.text, 'utf-8');
                vscode.window.showInformationMessage(`Logs exported to ${path.basename(uri.fsPath)}`);
            }
            return;
        }
    });
}

function buildLogViewerHtml(nonce: string, cspSource: string): string {
    return /* html */`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root{
    --ob-bg1:var(--vscode-editor-background,#1e1e1e);
    --ob-bg2:var(--vscode-sideBar-background,#252526);
    --ob-border:var(--vscode-panel-border,rgba(128,128,128,.2));
    --ob-text:var(--vscode-editor-foreground,#d4d4d4);
    --ob-dim:var(--vscode-descriptionForeground,#858585);
    --ob-purple:#b44fff;
    --ob-yellow:#e5c07b;
    --ob-red:#e06c75;
    --ob-red2:#ff5555;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:var(--vscode-editor-font-family,Consolas,monospace);font-size:var(--vscode-editor-font-size,12px);color:var(--ob-text);background:var(--ob-bg1);height:100vh;display:flex;flex-direction:column;overflow:hidden}
  .toolbar{display:flex;align-items:center;gap:5px;padding:4px 8px;background:var(--ob-bg2);border-bottom:1px solid var(--ob-border);flex-shrink:0;flex-wrap:wrap}
  .sep{width:1px;height:16px;background:var(--ob-border);flex-shrink:0}
  .btn{padding:2px 8px;font-size:11px;font-family:inherit;cursor:pointer;border:1px solid var(--ob-border);background:var(--ob-bg2);color:var(--ob-text);border-radius:2px;white-space:nowrap}
  .btn:hover{background:var(--ob-purple);color:#fff;border-color:var(--ob-purple)}
  .btn-primary{background:var(--ob-purple);color:#fff;border-color:var(--ob-purple)}
  .btn-primary:hover{opacity:.85}
  .btn-danger{background:#c72e0f;color:#fff;border-color:transparent}
  .btn-danger:hover{opacity:.85;background:#c72e0f}
  .btn.active{background:var(--ob-purple);color:#fff;border-color:var(--ob-purple)}
  select,input[type=text]{background:var(--ob-bg1);color:var(--ob-text);border:1px solid var(--ob-border);padding:2px 5px;font-size:11px;font-family:inherit;border-radius:2px;outline:none}
  input[type=text]{width:120px}
  .badge{font-size:10px;padding:1px 7px;border-radius:10px;font-weight:600;white-space:nowrap}
  .badge-running{background:var(--ob-purple);color:#fff}
  .badge-stopped{background:transparent;color:var(--ob-dim);border:1px solid var(--ob-border)}
  .cnt-err{color:var(--ob-red);font-size:10px;font-weight:600;white-space:nowrap}
  .cnt-warn{color:var(--ob-yellow);font-size:10px;font-weight:600;white-space:nowrap}
  #log-area{flex:1;overflow-y:auto;padding:2px 0}
  .log-line{padding:1px 8px;line-height:1.5;white-space:pre-wrap;word-break:break-all;font-family:inherit}
  .log-line:hover{background:rgba(128,128,128,.07)}
  .log-line.hidden{display:none}
  .ll-trace{color:var(--ob-dim);opacity:.7}
  .ll-debug{color:var(--ob-dim)}
  .ll-info{color:var(--ob-text)}
  .ll-warn{color:var(--ob-yellow)}
  .ll-error{color:var(--ob-red)}
  .ll-critical{color:var(--ob-red2);background:rgba(255,85,85,.08);font-weight:600}
  .hl{background:rgba(180,79,255,.35);border-radius:2px}
  .placeholder{padding:24px;color:var(--ob-dim);font-size:12px;font-style:italic;text-align:center}
  .hidden{display:none!important}
</style>
</head>
<body>
<div class="toolbar">
  <button id="start-btn" class="btn btn-primary">&#x25B6; Run</button>
  <button id="stop-btn" class="btn btn-danger hidden">&#x25A0; Stop</button>
  <select id="config-select"><option value="Debug">Debug</option><option value="Release">Release</option></select>
  <span id="status-badge" class="badge badge-stopped">Stopped</span>
  <div class="sep"></div>
  <select id="level-select" title="Minimum log level">
    <option value="0">TRACE+</option>
    <option value="1">DEBUG+</option>
    <option value="2" selected>INFO+</option>
    <option value="3">WARN+</option>
    <option value="4">ERROR+</option>
  </select>
  <input id="search-input" type="text" placeholder="Filter text&#x2026;" title="Filter by text">
  <input id="ns-input" type="text" placeholder="Hide ns&#x2026;" title="Hide namespace, e.g. Microsoft.*">
  <div class="sep"></div>
  <button id="autoscroll-btn" class="btn active" title="Toggle auto-scroll">&#x21E9; Auto</button>
  <span id="cnt-err" class="cnt-err">0 err</span>
  <span id="cnt-warn" class="cnt-warn">0 warn</span>
  <div class="sep"></div>
  <button id="clear-btn" class="btn">Clear</button>
  <button id="export-btn" class="btn">Export</button>
</div>
<div id="log-area"><p class="placeholder">Start the application to see logs&#x2026;</p></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const MAX_LINES = 5000;
  var buffer = [];
  var errCount = 0, warnCount = 0;
  var autoScroll = true;
  var searchTimer = null;
  var LCLS = ['ll-trace','ll-debug','ll-info','ll-warn','ll-error','ll-critical'];

  function detectLevel(t) {
    var m = t.match(/^\\{"@[Ll]"\\s*:\\s*"(\\w+)"/);
    if (m) {
      var jl = m[1].toLowerCase();
      if (jl==='fatal'||jl==='critical') return 5;
      if (jl==='error') return 4;
      if (jl==='warning') return 3;
      if (jl==='debug') return 1;
      if (jl==='verbose'||jl==='trace') return 0;
      return 2;
    }
    if (/^crit\\s*:/i.test(t)) return 5;
    if (/^(fail|error)\\s*:/i.test(t)) return 4;
    if (/^warn\\s*:/i.test(t)) return 3;
    if (/^info\\s*:/i.test(t)) return 2;
    if (/^(dbug|debug)\\s*:/i.test(t)) return 1;
    if (/^trce\\s*:/i.test(t)) return 0;
    var sm = t.match(/\\[\\d{2}:\\d{2}:\\d{2} (\\w{3})\\]/);
    if (sm) {
      var sl = sm[1].toUpperCase();
      if (sl==='FTL') return 5;
      if (sl==='ERR') return 4;
      if (sl==='WRN') return 3;
      if (sl==='INF') return 2;
      if (sl==='DBG') return 1;
      if (sl==='VRB') return 0;
    }
    if (/\\b(crit|critical|fatal)\\b/i.test(t)) return 5;
    if (/\\b(error|fail|exception)\\b/i.test(t)) return 4;
    if (/\\b(warn|warning)\\b/i.test(t)) return 3;
    if (/\\bdebug\\b/i.test(t)) return 1;
    if (/\\b(trace|verbose)\\b/i.test(t)) return 0;
    return 2;
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/\x3c/g,'&lt;').replace(/>/g,'&gt;');
  }

  function hlText(text, search) {
    if (!search) return esc(text);
    try {
      var re = new RegExp(search.replace(/[.*+?^{}()|[\\]\\\\$]/g,'\\\\$&'),'gi');
      return esc(text).replace(re,function(m){return '\x3cspan class="hl">'+m+'\x3c/span>';});
    } catch(e) { return esc(text); }
  }

  function getMinLvl(){ return parseInt(document.getElementById('level-select').value,10); }
  function getSearch(){ return document.getElementById('search-input').value.trim().toLowerCase(); }
  function getNs(){ return document.getElementById('ns-input').value.trim(); }

  function nsHides(text, pat) {
    if (!pat) return false;
    try {
      var re = new RegExp('^'+pat.replace(/\\./g,'\\\\.').replace(/\\*/g,'.*')+'\\b','i');
      return re.test(text);
    } catch(e){ return false; }
  }

  function passes(entry) {
    if (entry.level < getMinLvl()) return false;
    var s = getSearch();
    if (s && entry.text.toLowerCase().indexOf(s) === -1) return false;
    var ns = getNs();
    if (ns && nsHides(entry.text, ns)) return false;
    return true;
  }

  var logArea = document.getElementById('log-area');
  var placeholder = logArea.querySelector('.placeholder');

  function clearPlaceholder() {
    if (placeholder) { placeholder.remove(); placeholder = null; }
  }

  function mkEl(entry) {
    var div = document.createElement('div');
    div.className = 'log-line ' + LCLS[Math.min(entry.level,5)];
    div.innerHTML = hlText(entry.text, getSearch());
    if (!passes(entry)) div.classList.add('hidden');
    return div;
  }

  function addEntry(text, level) {
    clearPlaceholder();
    var entry = { text: text, level: level };
    if (buffer.length >= MAX_LINES) {
      buffer.shift();
      if (logArea.firstChild) logArea.removeChild(logArea.firstChild);
    }
    buffer.push(entry);
    if (level >= 5) errCount++;
    else if (level >= 4) errCount++;
    else if (level >= 3) warnCount++;
    updateCounters();
    var el = mkEl(entry);
    logArea.appendChild(el);
    if (autoScroll && !el.classList.contains('hidden')) logArea.scrollTop = logArea.scrollHeight;
  }

  function updateCounters() {
    document.getElementById('cnt-err').textContent = errCount + ' err';
    document.getElementById('cnt-warn').textContent = warnCount + ' warn';
  }

  function rebuildView() {
    logArea.innerHTML = '';
    placeholder = null;
    buffer.forEach(function(entry) {
      logArea.appendChild(mkEl(entry));
    });
    if (autoScroll) logArea.scrollTop = logArea.scrollHeight;
  }

  document.getElementById('start-btn').addEventListener('click', function() {
    vscode.postMessage({ command: 'start', config: document.getElementById('config-select').value });
  });
  document.getElementById('stop-btn').addEventListener('click', function() {
    vscode.postMessage({ command: 'stop' });
  });
  document.getElementById('clear-btn').addEventListener('click', function() {
    buffer = []; errCount = 0; warnCount = 0;
    updateCounters();
    logArea.innerHTML = '\x3cp class="placeholder">Cleared.\x3c/p>';
    placeholder = logArea.querySelector('.placeholder');
  });
  document.getElementById('export-btn').addEventListener('click', function() {
    vscode.postMessage({ command: 'export', text: buffer.map(function(e){return e.text;}).join('\\n') });
  });
  document.getElementById('autoscroll-btn').addEventListener('click', function() {
    autoScroll = !autoScroll;
    this.classList.toggle('active', autoScroll);
    if (autoScroll) logArea.scrollTop = logArea.scrollHeight;
  });
  document.getElementById('level-select').addEventListener('change', rebuildView);
  document.getElementById('search-input').addEventListener('input', function() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(rebuildView, 150);
  });
  document.getElementById('ns-input').addEventListener('input', function() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(rebuildView, 150);
  });

  window.addEventListener('message', function(event) {
    var msg = event.data;
    if (msg.command === 'logLine') {
      addEntry(msg.text, detectLevel(msg.text));
    } else if (msg.command === 'processStarted') {
      document.getElementById('start-btn').classList.add('hidden');
      document.getElementById('stop-btn').classList.remove('hidden');
      document.getElementById('config-select').disabled = true;
      var badge = document.getElementById('status-badge');
      badge.textContent = 'Running';
      badge.className = 'badge badge-running';
    } else if (msg.command === 'processStopped') {
      document.getElementById('start-btn').classList.remove('hidden');
      document.getElementById('stop-btn').classList.add('hidden');
      document.getElementById('config-select').disabled = false;
      var badge2 = document.getElementById('status-badge');
      badge2.textContent = 'Stopped';
      badge2.className = 'badge badge-stopped';
    }
  });
</script>
</body></html>`;
}

const tableInspectorPanels = new Map<string, vscode.WebviewPanel>();

async function openTableInspector(
    conn: DbConnection,
    schema: string,
    table: string,
    dbType: DbTemplate,
): Promise<void> {
    const key = `${schema}.${table}`;
    const existing = tableInspectorPanels.get(key);
    if (existing) {
        existing.reveal(vscode.ViewColumn.Two);
        return;
    }

    const nonce = getNonce();
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
        await sqlRunnerProvider?.openScript(sql, '');
            return;
        }
        if (msg.command === 'scaffold' || msg.command === 'scaffoldUpdate') {
            if (!cwd) { vscode.window.showErrorMessage('No workspace folder open.'); return; }
            const isUpdate = msg.command === 'scaffoldUpdate';
            const inputEntity = await vscode.window.showInputBox({
                title: isUpdate ? 'OpenBase: Update Scaffold' : 'OpenBase: Scaffold',
                prompt: 'Entity name (PascalCase)',
                value: msg.entity ?? '',
                validateInput: v => (!v?.trim() ? 'Entity name is required' : !/^[A-Z][a-zA-Z0-9]*$/.test(v.trim()) ? 'Must be PascalCase (e.g. Product)' : undefined),
            });
            if (!inputEntity) return;
            const args = [`-e ${inputEntity}`, `--schema "${schema}"`, `--table "${table}"`];
            if (isUpdate) args.push('--update');
            else args.push('--mode modelfirst');
            openTerminal(isUpdate ? 'Scaffold Update' : 'Scaffold', cwd, `openbase scaffold ${args.join(' ')}`);
        }
    });

    const renderPanel = async (hasScaffold: boolean, entityName: string) => {
        const details = await loadTableDetails(conn, schema, table);
        panel.webview.html = buildTableInspectorHtml(
            nonce, panel.webview.cspSource,
            schema, table, dbType,
            details.columns, details.constraints,
            entityName, hasScaffold,
        );
    };

    try {
        const [details, scaffoldEntity] = await Promise.all([
            loadTableDetails(conn, schema, table),
            cwd ? detectScaffoldEntity(cwd, table) : Promise.resolve(undefined),
        ]);
        const entityName = scaffoldEntity ?? tableToPascalCase(table);
        const hasScaffold = scaffoldEntity !== undefined;
        panel.webview.html = buildTableInspectorHtml(
            nonce, panel.webview.cspSource,
            schema, table, dbType,
            details.columns, details.constraints,
            entityName, hasScaffold,
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
                } catch { /* ignore */ }
            };
            scaffoldWatcher.onDidCreate(checkAndFlip);
            scaffoldWatcher.onDidChange(checkAndFlip);
        }
    } catch (e) {
        panel.webview.html = buildTableInspectorErrorHtml(
            nonce, panel.webview.cspSource,
            schema, table,
            e instanceof Error ? e.message : String(e),
        );
    }
}

// â”€â”€â”€ OpenAPI / Swagger import â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface OApiSchema {
    type?: string;
    properties?: Record<string, OApiSchema>;
    additionalProperties?: OApiSchema | boolean;
    items?: OApiSchema;
    $ref?: string;
    example?: unknown;
    enum?: unknown[];
    format?: string;
    allOf?: OApiSchema[];
    oneOf?: OApiSchema[];
    anyOf?: OApiSchema[];
}

interface OApiOperation {
    operationId?: string;
    summary?: string;
    parameters?: Array<{ name: string; in: string; required?: boolean; schema?: OApiSchema; type?: string }>;
    requestBody?: { content?: Record<string, { schema?: OApiSchema }>; required?: boolean };
    security?: Array<Record<string, string[]>>;
    tags?: string[];
}

interface OApiSpec {
    swagger?: string;
    openapi?: string;
    info?: { title?: string; version?: string };
    servers?: Array<{ url: string }>;
    host?: string;
    basePath?: string;
    schemes?: string[];
    paths?: Record<string, Record<string, OApiOperation>>;
    components?: { schemas?: Record<string, OApiSchema>; securitySchemes?: Record<string, unknown> };
    definitions?: Record<string, OApiSchema>;
    securityDefinitions?: Record<string, unknown>;
}

function oapiSanitizeFilename(name: string): string {
    return name.replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 80) || 'request';
}

function oapiResolveRef(ref: string, spec: OApiSpec): OApiSchema | undefined {
    const parts = ref.replace(/^#\//, '').split('/');
    let cur: Record<string, unknown> = spec as unknown as Record<string, unknown>;
    for (const p of parts) { cur = cur?.[p] as Record<string, unknown>; }
    return cur as OApiSchema | undefined;
}

function oapiSchemaToExample(schema: OApiSchema | undefined, spec: OApiSpec, depth = 0): unknown {
    if (!schema || depth > 4) return null;
    if (schema.$ref) {
        const resolved = oapiResolveRef(schema.$ref, spec);
        return oapiSchemaToExample(resolved, spec, depth + 1);
    }
    if (schema.example !== undefined) return schema.example;
    if (schema.enum?.length) return schema.enum[0];
    const merged: OApiSchema = schema.allOf?.length
        ? schema.allOf.reduce((acc, s) => {
            const r = schema.$ref ? oapiResolveRef(schema.$ref, spec) ?? s : s;
            return { ...acc, properties: { ...acc.properties, ...(r.properties ?? {}) }, type: acc.type ?? r.type };
          }, {} as OApiSchema)
        : (schema.oneOf?.[0] ?? schema.anyOf?.[0] ?? schema);
    const s = merged.$ref ? (oapiResolveRef(merged.$ref, spec) ?? merged) : merged;
    switch (s.type) {
        case 'object': {
            if (!s.properties) return {};
            const obj: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(s.properties)) obj[k] = oapiSchemaToExample(v, spec, depth + 1);
            return obj;
        }
        case 'array': return [oapiSchemaToExample(s.items, spec, depth + 1)];
        case 'integer': return 0;
        case 'number': return 0.0;
        case 'boolean': return false;
        case 'string':
            if (s.format === 'date-time') return new Date().toISOString();
            if (s.format === 'date') return new Date().toISOString().slice(0, 10);
            if (s.format === 'uuid') return '00000000-0000-0000-0000-000000000000';
            return 'string';
        default: return null;
    }
}

async function importSwaggerToHttpRunner(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'OpenAPI / Swagger (JSON)': ['json'] },
        title: 'Select OpenAPI / Swagger JSON file',
    });
    if (!uris?.length) return;

    const reqDir = getRequestsDir();
    if (!reqDir) { vscode.window.showErrorMessage('No workspace folder open.'); return; }

    let spec: OApiSpec;
    try {
        spec = JSON.parse(fs.readFileSync(uris[0].fsPath, 'utf-8'));
    } catch {
        vscode.window.showErrorMessage('Failed to parse JSON. Only JSON format is supported (not YAML).');
        return;
    }

    if (!spec.paths || typeof spec.paths !== 'object') {
        vscode.window.showErrorMessage('No "paths" found in the OpenAPI/Swagger spec.');
        return;
    }

    const isSwagger2 = !!spec.swagger;
    const apiTitle = spec.info?.title ?? 'api';
    const folderName = oapiSanitizeFilename(apiTitle);

    let baseUrl = '';
    if (isSwagger2) {
        const scheme = spec.schemes?.[0] ?? 'https';
        const host = spec.host ?? 'localhost';
        const base = spec.basePath ?? '';
        baseUrl = `${scheme}://${host}${base}`;
    } else {
        baseUrl = spec.servers?.[0]?.url ?? '';
    }
    baseUrl = baseUrl.replace(/\/$/, '');

    const globalSecurity = (spec as unknown as Record<string, unknown>)['security'] as Array<Record<string, string[]>> | undefined;
    const secDefs = spec.components?.securitySchemes ?? spec.securityDefinitions ?? {};
    function hasBearerSecurity(opSecurity?: Array<Record<string, string[]>>): boolean {
        const sec = opSecurity ?? globalSecurity ?? [];
        return sec.some(s => Object.keys(s).some(k => {
            const def = (secDefs as Record<string, unknown>)[k] as Record<string, unknown> | undefined;
            return def && (def['type'] === 'http' && def['scheme'] === 'bearer'
                || def['type'] === 'oauth2'
                || def['type'] === 'apiKey' && def['in'] === 'header' && String(def['name'] ?? '').toLowerCase() === 'authorization');
        }));
    }

    const targetDir = path.join(reqDir, folderName);
    fs.mkdirSync(targetDir, { recursive: true });

    const httpMethods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
    let created = 0;

    for (const [apiPath, pathItem] of Object.entries(spec.paths)) {
        for (const method of httpMethods) {
            const op = pathItem[method] as OApiOperation | undefined;
            if (!op) continue;

            const pathForUrl = apiPath.replace(/\{([^}]+)\}/g, '{{$1}}');
            const url = baseUrl + pathForUrl;

            const headers: Array<{ name: string; value: string }> = [];
            let bodyType = 'none';
            let body = '';
            let authToken = '';

            if (hasBearerSecurity(op.security)) {
                authToken = '{{token}}';
            }

            if (op.requestBody?.content) {
                const contentTypes = Object.keys(op.requestBody.content);
                const jsonType = contentTypes.find(t => t.includes('json')) ?? contentTypes[0];
                if (jsonType) {
                    const schema = op.requestBody.content[jsonType]?.schema;
                    if (jsonType.includes('json')) {
                        bodyType = 'json';
                        const example = oapiSchemaToExample(schema, spec);
                        body = JSON.stringify(example, null, 2);
                        headers.push({ name: 'Content-Type', value: 'application/json' });
                    } else if (jsonType.includes('form')) {
                        bodyType = 'form';
                    } else {
                        bodyType = 'text';
                    }
                }
            }

            const queryParams = (op.parameters ?? []).filter(p => p.in === 'query');
            let finalUrl = url;
            if (queryParams.length) {
                const qs = queryParams.map(p => `${p.name}={{${p.name}}}`).join('&');
                finalUrl = url + '?' + qs;
            }

            const data: HttpRequestData = {
                method: method.toUpperCase(),
                url: finalUrl,
                headers,
                bodyType,
                body,
                authToken,
            };

            const opId = op.operationId?.trim();
            const fallback = `${method.toUpperCase()}_${apiPath.replace(/\//g, '_').replace(/[{}]/g, '').replace(/^_/, '')}`;
            const filename = oapiSanitizeFilename(opId || fallback) + '.json';
            const filePath = path.join(targetDir, filename);

            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
            created++;
        }
    }

    void vscode.commands.executeCommand('openbase.httpRunner.requests.refresh');
    vscode.window.showInformationMessage(`Imported ${created} request${created !== 1 ? 's' : ''} from "${apiTitle}" into "${folderName}".`);
}

// â”€â”€â”€ activate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    setupSqlTableBrowser(context, {
        findConnection,
        loadSqlTables,
        buildSelectQuery,
      openScriptInSqlRunner: async (filePath: string, directContent?: string) => {
        const content = directContent ?? fs.readFileSync(filePath, 'utf-8');
        const name = directContent ? '' : path.basename(filePath);
        await sqlRunnerProvider?.openScript(content, name);
      },
        openTableInspector,
        openErDiagram,
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
        importSwaggerToHttpRunner,
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
        vscode.window.registerWebviewViewProvider('openbase.erdiagram.sidebar', new RunnerSidebarProvider('ER Diagram', 'Open ER Diagram', openErDiagram)),
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





