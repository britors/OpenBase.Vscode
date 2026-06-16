import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { execSync, exec, spawn } from 'child_process';

const DB_TEMPLATES = ['sqlserver', 'pgsql', 'oracle'] as const;
const BUILD_CONFIGS = ['Debug', 'Release'] as const;
const EXTENSIONS = ['jwt', 'redis', 'healthchecks', 'mongodb', 'domainevents'] as const;
const SPECIALIST_TYPES = ['query', 'command', 'httpcall'] as const;
const PARAM_TYPES = ['string', 'int', 'bool', 'decimal', 'Guid', 'DateTime', 'long', 'double', 'float', 'short'] as const;
const EXTENSION_PROVIDERS: Partial<Record<string, string[]>> = {};

type DbTemplate = typeof DB_TEMPLATES[number];
type BuildConfig = typeof BUILD_CONFIGS[number];

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
let extContext: vscode.ExtensionContext | undefined;
let diagnosticCollection: vscode.DiagnosticCollection;

// ─── new ────────────────────────────────────────────────────────────────────

async function newProject(uri?: vscode.Uri): Promise<void> {
    if (!await guardInstalled()) return;

    const prefs = extContext?.globalState.get<Record<string, string>>(NEW_PROJECT_PREFS_KEY) ?? {};

    const projectName = await vscode.window.showInputBox({
        title: 'OpenBase: New Project (1/8) — Project name',
        prompt: 'Project name (PascalCase, no spaces)',
        placeHolder: 'MyProject',
        validateInput: (v) => {
            if (!v.trim()) return 'Project name is required';
            if (!/^[a-zA-Z0-9._-]+$/.test(v)) return 'Invalid project name';
        },
    });
    if (!projectName) return;

    const template = await vscode.window.showQuickPick(
        DB_TEMPLATES.map((t): vscode.QuickPickItem => ({
            label: t,
            description: dbTemplateLabel(t),
        })),
        { title: 'OpenBase: New Project (2/8) — Database template', placeHolder: 'Choose a database' }
    );
    if (!template) return;

    const dbServerDefault = prefs.dbServer ?? (template.label === 'sqlserver' ? '.' : 'localhost');
    const dbServer = await vscode.window.showInputBox({
        title: 'OpenBase: New Project (3/8) — Database server',
        prompt: 'Database server address (leave empty for default)',
        placeHolder: template.label === 'sqlserver' ? '.' : 'localhost',
        value: dbServerDefault,
    });
    if (dbServer === undefined) return;

    const dbName = await vscode.window.showInputBox({
        title: 'OpenBase: New Project (4/8) — Database name',
        prompt: 'Database name (leave empty to use project name)',
        placeHolder: projectName,
        value: projectName,
    });
    if (dbName === undefined) return;

    const dbUser = await vscode.window.showInputBox({
        title: 'OpenBase: New Project (5/8) — Database user',
        prompt: template.label === 'sqlserver'
            ? 'Database user (leave empty for Windows Authentication)'
            : 'Database user',
        placeHolder: template.label === 'sqlserver' ? 'Windows Auth' : 'postgres',
        value: prefs.dbUser ?? '',
    });
    if (dbUser === undefined) return;

    const dbPassword = await vscode.window.showInputBox({
        title: 'OpenBase: New Project (6/8) — Database password',
        prompt: template.label === 'sqlserver'
            ? 'Database password (leave empty for Windows Authentication)'
            : 'Database password',
        password: true,
    });
    if (dbPassword === undefined) return;

    const mediatrLicense = await vscode.window.showInputBox({
        title: 'OpenBase: New Project (7/8) — MediatR license',
        prompt: 'MediatR commercial license key (leave empty if none)',
        placeHolder: 'Leave empty if not applicable',
        value: prefs.mediatrLicense ?? '',
    });
    if (mediatrLicense === undefined) return;

    const automapperLicense = await vscode.window.showInputBox({
        title: 'OpenBase: New Project (8/8) — AutoMapper license',
        prompt: 'AutoMapper commercial license key (leave empty if none)',
        placeHolder: 'Leave empty if not applicable',
        value: prefs.automapperLicense ?? '',
    });
    if (automapperLicense === undefined) return;

    const cwd = await resolveWorkingDir(uri);
    if (!cwd) return;

    const args: string[] = [`-n ${projectName}`, `-s ${template.label}`];
    if (dbServer.trim())           args.push(`--db-server "${dbServer.trim()}"`);
    if (dbName.trim())             args.push(`--db-name "${dbName.trim()}"`);
    if (dbUser.trim())             args.push(`--db-user "${dbUser.trim()}"`);
    if (dbPassword.trim())         args.push(`--db-password "${dbPassword.trim()}"`);
    args.push(`--mediatr-license "${mediatrLicense.trim()}"`);
    args.push(`--automapper-license "${automapperLicense.trim()}"`);

    const channel = vscode.window.createOutputChannel('OpenBase: New Project');
    channel.show(true);

    const extraPath = dotnetToolsPath();
    const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };

    const success = await new Promise<boolean>((resolve) => {
        const child = exec(`openbase new ${args.join(' ')}`, { cwd, env });
        child.stdout?.on('data', (d: string) => channel.append(d));
        child.stderr?.on('data', (d: string) => channel.append(d));
        child.on('close', (code) => resolve(code === 0));
        child.on('error', (err) => { channel.appendLine(err.message); resolve(false); });
    });

    if (!success) {
        vscode.window.showErrorMessage(`Failed to create project "${projectName}". Check the output for details.`);
        return;
    }

    await extContext?.globalState.update(NEW_PROJECT_PREFS_KEY, {
        template: template.label,
        dbServer: dbServer.trim(),
        dbUser: dbUser.trim(),
        mediatrLicense: mediatrLicense.trim(),
        automapperLicense: automapperLicense.trim(),
    });

    const projectUri = vscode.Uri.file(path.join(cwd, projectName));
    const action = await vscode.window.showInformationMessage(
        `Project "${projectName}" created successfully!`,
        'Open Folder',
        'Open in New Window'
    );

    if (action === 'Open Folder') {
        vscode.commands.executeCommand('vscode.openFolder', projectUri, false);
    } else if (action === 'Open in New Window') {
        vscode.commands.executeCommand('vscode.openFolder', projectUri, true);
    }
}

// ─── scaffold ───────────────────────────────────────────────────────────────

async function scaffold(uri?: vscode.Uri): Promise<void> {
    if (!await guardInstalled()) return;

    const entity = await vscode.window.showInputBox({
        title: 'OpenBase: Scaffold',
        prompt: 'Entity name (PascalCase)',
        placeHolder: 'Product',
        validateInput: (v) => {
            if (!v.trim()) return 'Entity name is required';
            if (!/^[A-Z][a-zA-Z0-9]*$/.test(v)) return 'Must be PascalCase (e.g. Product)';
        },
    });
    if (!entity) return;

    const cwd = await resolveWorkingDir(uri);
    if (!cwd) return;

    openTerminal('Scaffold', cwd, `openbase scaffold -e ${entity}`);
}

async function scaffoldUpdate(uri?: vscode.Uri): Promise<void> {
    if (!await guardInstalled()) return;

    const entity = await vscode.window.showInputBox({
        title: 'OpenBase: Scaffold Update',
        prompt: 'Entity name to update (PascalCase)',
        placeHolder: 'Product',
        validateInput: (v) => {
            if (!v.trim()) return 'Entity name is required';
            if (!/^[A-Z][a-zA-Z0-9]*$/.test(v)) return 'Must be PascalCase (e.g. Product)';
        },
    });
    if (!entity) return;

    const cwd = await resolveWorkingDir(uri);
    if (!cwd) return;

    openTerminal('Scaffold Update', cwd, `openbase scaffold -e ${entity} --update`);
}

// ─── specialist ─────────────────────────────────────────────────────────────

async function specialist(uri?: vscode.Uri): Promise<void> {
    if (!await guardInstalled()) return;

    const entity = await vscode.window.showInputBox({
        title: 'OpenBase: Specialist (1/4) — Entity',
        prompt: 'Entity name (PascalCase)',
        placeHolder: 'Product',
        validateInput: (v) => {
            if (!v.trim()) return 'Entity name is required';
            if (!/^[A-Z][a-zA-Z0-9]*$/.test(v)) return 'Must be PascalCase (e.g. Product)';
        },
    });
    if (!entity) return;

    const method = await vscode.window.showInputBox({
        title: 'OpenBase: Specialist (2/4) — Method name',
        prompt: 'Method name (PascalCase)',
        placeHolder: 'GetByCategoria',
        validateInput: (v) => {
            if (!v.trim()) return 'Method name is required';
            if (!/^[A-Z][a-zA-Z0-9]*$/.test(v)) return 'Must be PascalCase (e.g. GetByCategoria)';
        },
    });
    if (!method) return;

    const typeItem = await vscode.window.showQuickPick(
        [
            { label: 'query',    description: 'MediatR query — returns data (SELECT)' },
            { label: 'command',  description: 'MediatR command — modifies data (INSERT/UPDATE/DELETE)' },
            { label: 'httpcall', description: 'External HTTP call — no SQL required' },
        ],
        { title: 'OpenBase: Specialist (3/4) — Type' }
    );
    if (!typeItem) return;

    const needsSql = typeItem.label !== 'httpcall';
    let sql = '';
    if (needsSql) {
        const sqlInput = await vscode.window.showInputBox({
            title: 'OpenBase: Specialist (4/4) — SQL',
            prompt: 'SQL statement (use {{paramName}} for parameters)',
            placeHolder: 'SELECT Nome FROM Produtos WHERE CategoriaId = {{categoriaId}}',
            validateInput: (v) => (!v.trim() ? 'SQL is required' : undefined),
        });
        if (!sqlInput) return;
        sql = sqlInput;
    }

    const validTypes = PARAM_TYPES.join(', ');

    const params: string[] = [];
    while (true) {
        const param = await vscode.window.showInputBox({
            title: `OpenBase: Specialist — Param ${params.length + 1} (leave empty to finish)`,
            prompt: `Parameter in name:Type format — valid types: ${validTypes}`,
            placeHolder: 'paramName:Type  (e.g. categoriaId:Guid)',
            validateInput: (v) => {
                if (!v.trim()) return undefined;
                const parts = v.trim().split(':');
                if (parts.length !== 2) return 'Format: name:Type (e.g. categoriaId:Guid)';
                const [, type] = parts;
                if (!(PARAM_TYPES as readonly string[]).includes(type)) {
                    return `Unknown type "${type}". Valid: ${validTypes}`;
                }
            },
        });
        if (param === undefined) return;
        if (!param.trim()) break;
        params.push(param.trim());
    }

    const columns: string[] = [];
    if (typeItem.label === 'query') {
        while (true) {
            const col = await vscode.window.showInputBox({
                title: `OpenBase: Specialist — Column ${columns.length + 1} (leave empty to finish)`,
                prompt: `Column in name:Type format — valid types: ${validTypes}`,
                placeHolder: 'ColumnName:Type  (e.g. Nome:string)',
                validateInput: (v) => {
                    if (!v.trim()) return undefined;
                    const parts = v.trim().split(':');
                    if (parts.length !== 2) return 'Format: name:Type (e.g. Nome:string)';
                    const [, type] = parts;
                    if (!(PARAM_TYPES as readonly string[]).includes(type)) {
                        return `Unknown type "${type}". Valid: ${validTypes}`;
                    }
                },
            });
            if (col === undefined) return;
            if (!col.trim()) break;
            columns.push(col.trim());
        }
    }

    const cwd = await resolveWorkingDir(uri);
    if (!cwd) return;

    const args: string[] = [
        `-e ${entity}`,
        `--method ${method}`,
        `--type ${typeItem.label}`,
    ];
    if (sql) args.push(`--sql "${sql.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    for (const p of params)  args.push(`--param ${p}`);
    for (const c of columns) args.push(`--column ${c}`);

    openTerminal('Specialist', cwd, `openbase specialist ${args.join(' ')}`);
}

// ─── procedure ──────────────────────────────────────────────────────────────

async function procedure(uri?: vscode.Uri): Promise<void> {
    if (!await guardInstalled()) return;

    const name = await vscode.window.showInputBox({
        title: 'OpenBase: Procedure',
        prompt: 'Procedure name (PascalCase, e.g. GetOrderById)',
        placeHolder: 'GetOrderById',
        validateInput: (v) => {
            if (!v.trim()) return 'Procedure name is required';
            if (!/^[A-Z][a-zA-Z0-9]*$/.test(v)) return 'Must be PascalCase (e.g. GetOrderById)';
        },
    });
    if (!name) return;

    const schema = await vscode.window.showInputBox({
        title: 'OpenBase: Procedure — Schema',
        prompt: 'Schema/owner (leave empty for auto-detect)',
        placeHolder: 'dbo',
    });
    if (schema === undefined) return;

    const cwd = await resolveWorkingDir(uri);
    if (!cwd) return;

    const args = schema?.trim() ? `-n ${name} -s ${schema.trim()}` : `-n ${name}`;
    openTerminal('Procedure', cwd, `openbase procedure ${args}`);
}

// ─── extension ──────────────────────────────────────────────────────────────

async function extensionAdd(uri?: vscode.Uri): Promise<void> {
    if (!await guardInstalled()) return;

    const ext = await vscode.window.showQuickPick(
        EXTENSIONS.map((e): vscode.QuickPickItem => ({
            label: e,
            description: extensionLabel(e),
        })),
        { title: 'OpenBase: Add Extension', placeHolder: 'Choose an extension' }
    );
    if (!ext) return;

    const providers = EXTENSION_PROVIDERS[ext.label];
    let provider: string | undefined;

    if (providers) {
        const picked = await vscode.window.showQuickPick(
            providers.map((p): vscode.QuickPickItem => ({ label: p })),
            { title: `OpenBase: Add Extension — ${ext.label} provider` }
        );
        if (!picked) return;
        provider = picked.label;
    }

    const cwd = await resolveWorkingDir(uri);
    if (!cwd) return;

    const args = provider ? `${ext.label} -p ${provider}` : ext.label;
    openTerminal('Extension Add', cwd, `openbase extension add ${args}`);
}

async function extensionList(uri?: vscode.Uri): Promise<void> {
    if (!await guardInstalled()) return;

    const cwd = await resolveWorkingDir(uri);
    if (!cwd) return;

    openTerminal('Extension List', cwd, 'openbase extension list');
}

// ─── helpers ─────────────────────────────────────────────────────────────────

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

// ─── build ──────────────────────────────────────────────────────────────────

async function build(uri?: vscode.Uri): Promise<void> {
    if (!await guardInstalled()) return;

    const config = await vscode.window.showQuickPick(
        BUILD_CONFIGS.map((c): vscode.QuickPickItem => ({ label: c })),
        { title: 'OpenBase: Build — Configuration' }
    );
    if (!config) return;

    const noRestore = await vscode.window.showQuickPick(
        [{ label: 'No', description: 'Run dotnet restore before build' },
         { label: 'Yes', description: 'Skip dotnet restore' }],
        { title: 'OpenBase: Build — Skip restore?' }
    );
    if (!noRestore) return;

    const cwd = await resolveWorkingDir(uri);
    if (!cwd) return;

    const flags = noRestore.label === 'Yes' ? ' --no-restore' : '';
    openTerminal('Build', cwd, `openbase build -c ${config.label}${flags}`);
}

// ─── run ────────────────────────────────────────────────────────────────────

async function run(uri?: vscode.Uri): Promise<void> {
    if (!await guardInstalled()) return;

    const config = await vscode.window.showQuickPick(
        BUILD_CONFIGS.map((c): vscode.QuickPickItem => ({ label: c })),
        { title: 'OpenBase: Run — Configuration' }
    );
    if (!config) return;

    const noBuild = await vscode.window.showQuickPick(
        [{ label: 'No', description: 'Build before run' },
         { label: 'Yes', description: 'Skip build step' }],
        { title: 'OpenBase: Run — Skip build?' }
    );
    if (!noBuild) return;

    const cwd = await resolveWorkingDir(uri);
    if (!cwd) return;

    const flags = noBuild.label === 'Yes' ? ' --no-build' : '';
    openTerminal('Run', cwd, `openbase run -c ${config.label}${flags}`);
}

// ─── misc ────────────────────────────────────────────────────────────────────

async function update(): Promise<void> {
    if (!await guardInstalled()) return;
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    openTerminal('Update', cwd, 'openbase update');
}

async function history(): Promise<void> {
    if (!await guardInstalled()) return;
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    openTerminal('History', cwd, 'openbase history');
}

async function version(): Promise<void> {
    if (!await guardInstalled()) return;
    const extraPath = dotnetToolsPath();
    const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
    try {
        const output = execSync('openbase version show', { encoding: 'utf-8', env }).trim();
        vscode.window.showInformationMessage(`OpenBase CLI ${output}`);
    } catch {
        vscode.window.showErrorMessage('Could not retrieve OpenBase CLI version.');
    }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function dbTemplateLabel(t: DbTemplate): string {
    switch (t) {
        case 'sqlserver': return 'SQL Server';
        case 'pgsql':     return 'PostgreSQL';
        case 'oracle':    return 'Oracle';
    }
}

function extensionLabel(e: string): string {
    switch (e) {
        case 'jwt':          return 'JWT Authentication';
        case 'redis':        return 'Redis';
        case 'healthchecks': return 'Health Checks';
        case 'mongodb':      return 'MongoDB';
        case 'domainevents': return 'Domain Events';
        default:             return e;
    }
}

// ─── panel ───────────────────────────────────────────────────────────────────

class OpenBasePanelProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'openbase.panel';
    private _view?: vscode.WebviewView;
    private _runProcess?: import('child_process').ChildProcess;
    private _channels = new Map<string, vscode.OutputChannel>();

    private _channel(name: string): vscode.OutputChannel {
        if (!this._channels.has(name)) {
            this._channels.set(name, vscode.window.createOutputChannel(name));
        }
        return this._channels.get(name)!;
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this._view = view;
        view.webview.options = { enableScripts: true };
        view.webview.html = this._html();
        view.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === 'ready') {
                const prefs = extContext?.globalState.get<Record<string, string>>(NEW_PROJECT_PREFS_KEY) ?? {};
                view.webview.postMessage({ command: 'loadNewProjectPrefs', prefs });
                return;
            }
            this._handle(msg, view);
        });
    }

    postNavigateTo(tab: string, query: string): void {
        this._view?.webview.postMessage({ command: 'navigateTo', tab, query });
    }

    postMessage(msg: any): void {
        this._view?.webview.postMessage(msg);
    }

    private async _handle(msg: { command: string; data?: Record<string, string | boolean> }, view: vscode.WebviewView): Promise<void> {
        if (msg.command === 'pickFolder') {
            const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Select folder' });
            if (picked?.[0]) view.webview.postMessage({ command: 'folderPicked', path: picked[0].fsPath });
            return;
        }
        if (!await guardInstalled()) {
            view.webview.postMessage({ command: 'error', ctx: msg.data?.['ctx'] ?? '', text: 'OpenBase CLI not found.' });
            return;
        }
        switch (msg.command) {
            case 'newProject':   await this._new(msg.data as never, view);          break;
            case 'scaffold':       await this._scaffold(msg.data as never, view);       break;
            case 'scaffoldUpdate': await this._scaffoldUpdate(msg.data as never, view); break;
            case 'specialist':   await this._specialist(msg.data as never, view);   break;
            case 'procedure':    await this._procedure(msg.data as never, view);    break;
            case 'extensionAdd': await this._extensionAdd(msg.data as never, view); break;
            case 'build':        await this._build(msg.data as never, view);        break;
            case 'run':          await this._run(msg.data as never, view);          break;
            case 'stopRun': {
                const proc = this._runProcess;
                if (proc?.pid) {
                    try { process.kill(-proc.pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
                }
                break;
            }
            case 'history':      await this._exec('openbase history', await this._cwd() ?? process.cwd(), view, 'history', 'OpenBase: History'); break;
            case 'update':       await this._exec('openbase update',  await this._cwd() ?? process.cwd(), view, 'update',  'OpenBase: Update');  break;
        }
    }

    // ── per-command handlers ────────────────────────────────────────────────

    private async _new(d: { name: string; template: string; dbServer: string; dbName: string; dbUser: string; dbPassword: string; mediatrLicense: string; automapperLicense: string; folder: string }, view: vscode.WebviewView): Promise<void> {
        let cwd = d.folder;
        if (!cwd) {
            const folders = vscode.workspace.workspaceFolders;
            if (folders?.length === 1) {
                cwd = folders[0].uri.fsPath;
            } else {
                const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Select project folder' });
                if (!picked?.[0]) { view.webview.postMessage({ command: 'done', ctx: 'new' }); return; }
                cwd = picked[0].fsPath;
            }
        }
        const args = [`-n ${d.name}`, `-s ${d.template}`];
        if (d.dbServer)   args.push(`--db-server "${d.dbServer}"`);
        if (d.dbName)     args.push(`--db-name "${d.dbName}"`);
        if (d.dbUser)     args.push(`--db-user "${d.dbUser}"`);
        if (d.dbPassword) args.push(`--db-password "${d.dbPassword}"`);
        args.push(`--mediatr-license "${d.mediatrLicense}"`);
        args.push(`--automapper-license "${d.automapperLicense}"`);

        const ok = await this._exec(`openbase new ${args.join(' ')}`, cwd, view, 'new', 'OpenBase: New Project');
        if (!ok) return;

        await extContext?.globalState.update(NEW_PROJECT_PREFS_KEY, {
            template: d.template,
            dbServer: d.dbServer,
            dbUser: d.dbUser,
            mediatrLicense: d.mediatrLicense,
            automapperLicense: d.automapperLicense,
        });

        const projectUri = vscode.Uri.file(path.join(cwd, d.name));
        const action = await vscode.window.showInformationMessage(`Project "${d.name}" created successfully!`, 'Open Folder', 'Open in New Window');
        if (action === 'Open Folder')      vscode.commands.executeCommand('vscode.openFolder', projectUri, false);
        else if (action === 'Open in New Window') vscode.commands.executeCommand('vscode.openFolder', projectUri, true);
    }

    private async _scaffoldUpdate(d: { entity: string }, view: vscode.WebviewView): Promise<void> {
        const cwd = await this._cwd();
        if (!cwd) { view.webview.postMessage({ command: 'done', ctx: 'scu' }); return; }
        openTerminal('Scaffold Update', cwd, `openbase scaffold -e ${d.entity} --update`);
        view.webview.postMessage({ command: 'done', ctx: 'scu' });
    }

    private async _scaffold(d: { entity: string }, view: vscode.WebviewView): Promise<void> {
        const cwd = await this._cwd();
        if (!cwd) { view.webview.postMessage({ command: 'done', ctx: 'sc' }); return; }
        openTerminal('Scaffold', cwd, `openbase scaffold -e ${d.entity}`);
        view.webview.postMessage({ command: 'done', ctx: 'sc' });
    }

    private async _specialist(d: { entity: string; method: string; type: string; sql: string; params: string[]; columns: string[] }, view: vscode.WebviewView): Promise<void> {
        const cwd = await this._cwd();
        if (!cwd) { view.webview.postMessage({ command: 'done', ctx: 'sp' }); return; }

        const args: string[] = [
            `-e ${d.entity}`,
            `--method ${d.method}`,
            `--type ${d.type}`,
        ];
        if (d.sql) args.push(`--sql "${d.sql.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
        for (const p of (d.params ?? []))   args.push(`--param ${p}`);
        for (const c of (d.columns ?? []))  args.push(`--column ${c}`);

        await this._exec(`openbase specialist ${args.join(' ')}`, cwd, view, 'sp', 'OpenBase: Specialist');
    }

    private async _procedure(d: { name: string; schema: string }, view: vscode.WebviewView): Promise<void> {
        const cwd = await this._cwd();
        if (!cwd) { view.webview.postMessage({ command: 'done', ctx: 'pr' }); return; }

        if (!d.name) {
            openTerminal('Procedure', cwd, 'openbase procedure');
            view.webview.postMessage({ command: 'done', ctx: 'pr', text: 'Terminal aberto — selecione a procedure no terminal.' });
            return;
        }
        const args = [`-n ${d.name}`];
        if (d.schema) args.push(`-s "${d.schema}"`);
        await this._exec(`openbase procedure ${args.join(' ')}`, cwd, view, 'pr', 'OpenBase: Procedure');
    }

    private async _extensionAdd(d: { name: string; provider: string }, view: vscode.WebviewView): Promise<void> {
        const cwd = await this._cwd();
        if (!cwd) { view.webview.postMessage({ command: 'done', ctx: 'ext' }); return; }
        const args = d.provider ? `${d.name} -p ${d.provider}` : d.name;
        await this._exec(`openbase extension add ${args}`, cwd, view, 'ext', 'OpenBase: Extension');
    }

    private async _build(d: { configuration: string; noRestore: boolean }, view: vscode.WebviewView): Promise<void> {
        const cwd = await this._cwd();
        if (!cwd) { view.webview.postMessage({ command: 'done', ctx: 'build' }); return; }
        const flags = d.noRestore ? ' --no-restore' : '';
        await this._exec(`openbase build -c ${d.configuration}${flags}`, cwd, view, 'build', 'OpenBase: Build');
    }

    private async _run(d: { configuration: string; noBuild: boolean }, view: vscode.WebviewView): Promise<void> {
        const cwd = await this._cwd();
        if (!cwd) { view.webview.postMessage({ command: 'done', ctx: 'run' }); return; }

        const args = ['run', '-c', d.configuration];
        if (d.noBuild) args.push('--no-build');

        const channel = vscode.window.createOutputChannel('OpenBase: Run');
        channel.show(true);

        const extraPath = dotnetToolsPath();
        const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };

        this._runProcess = spawn('openbase', args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        this._runProcess.stdout?.on('data', (chunk: string) => channel.append(chunk));
        this._runProcess.stderr?.on('data', (chunk: string) => channel.append(chunk));
        view.webview.postMessage({ command: 'runStarted' });

        this._runProcess.on('close', () => {
            this._runProcess = undefined;
            view.webview.postMessage({ command: 'runStopped' });
        });
        this._runProcess.on('error', (err) => {
            channel.appendLine(err.message);
            this._runProcess = undefined;
            view.webview.postMessage({ command: 'runStopped' });
            view.webview.postMessage({ command: 'error', ctx: 'run', text: err.message });
        });
    }

    // ── shared helpers ──────────────────────────────────────────────────────

    private async _cwd(): Promise<string | undefined> {
        const folders = vscode.workspace.workspaceFolders;
        if (folders?.length === 1) return folders[0].uri.fsPath;
        const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Select project folder' });
        return picked?.[0]?.fsPath;
    }

    private _parseDiagnostics(output: string, cwd: string) {
        const diagnostics: { [uri: string]: vscode.Diagnostic[] } = {};
        const regex = /^(.+)\((\d+),(\d+)\): (error|warning) ([\w\d]+): (.*)$/gm;
        let match;

        while ((match = regex.exec(output)) !== null) {
            const [ , file, line, col, severityStr, code, message ] = match;
            const absolutePath = path.isAbsolute(file) ? file : path.resolve(cwd, file);
            const uri = vscode.Uri.file(absolutePath).toString();
            
            const range = new vscode.Range(
                parseInt(line) - 1, 
                parseInt(col) - 1, 
                parseInt(line) - 1, 
                parseInt(col) + 100
            );

            const severity = severityStr === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
            const diagnostic = new vscode.Diagnostic(range, `${code}: ${message}`, severity);
            diagnostic.source = 'OpenBase';
            diagnostic.code = code;

            if (!diagnostics[uri]) diagnostics[uri] = [];
            diagnostics[uri].push(diagnostic);
        }

        for (const uri in diagnostics) {
            diagnosticCollection.set(vscode.Uri.parse(uri), diagnostics[uri]);
        }
    }

    private async _exec(cmd: string, cwd: string, view: vscode.WebviewView, ctx: string, channelName: string): Promise<boolean> {
        const channel = this._channel(channelName);
        channel.clear();
        channel.show(true);
        diagnosticCollection.clear();

        let fullOutput = '';
        const extraPath = dotnetToolsPath();
        const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
        return new Promise<boolean>((resolve) => {
            const child = exec(cmd, { cwd, env, timeout: 60000 });
            child.stdout?.on('data', (chunk: string) => {
                channel.append(chunk);
                fullOutput += chunk;
            });
            child.stderr?.on('data', (chunk: string) => {
                channel.append(chunk);
                fullOutput += chunk;
            });
            child.on('close', (code, signal) => {
                this._parseDiagnostics(fullOutput, cwd);
                if (signal === 'SIGTERM') {
                    view.webview.postMessage({ command: 'error', ctx, text: 'Command timed out after 60s.' });
                    resolve(false);
                } else if (code === 0) {
                    view.webview.postMessage({ command: 'done', ctx, text: 'Completed successfully.' });
                    resolve(true);
                } else {
                    view.webview.postMessage({ command: 'error', ctx, text: `Command failed (exit ${code}). Check the output panel.` });
                    resolve(false);
                }
            });
            child.on('error', (err) => {
                channel.appendLine(err.message);
                view.webview.postMessage({ command: 'error', ctx, text: err.message });
                resolve(false);
            });
        });
    }

    // ── html ────────────────────────────────────────────────────────────────

    private _html(): string {
        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://cdn.jsdelivr.net; script-src 'unsafe-inline' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net data:; worker-src blob: data:;">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground)}
    nav{border-bottom:1px solid var(--vscode-panel-border);margin-bottom:0}
    .nav-item{padding:5px 12px;cursor:pointer;font-size:12px;border-left:2px solid transparent}
    .nav-item:hover{background:var(--vscode-list-hoverBackground)}
    .nav-item.active{border-left-color:var(--vscode-focusBorder);color:var(--vscode-textLink-activeForeground);background:var(--vscode-list-activeSelectionBackground)}
    .page{display:none;padding:12px}
    .page.active{display:block}
    .field{margin-bottom:10px}
    label{display:block;margin-bottom:3px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--vscode-descriptionForeground)}
    .check-label{display:flex;align-items:center;gap:6px;font-size:12px;text-transform:none;letter-spacing:normal;font-weight:normal;color:var(--vscode-foreground);cursor:pointer}
    input,select,textarea{width:100%;padding:4px 7px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);font-family:inherit;font-size:inherit;outline:none}
    textarea{resize:vertical}
    input[type=checkbox]{width:auto}
    input:focus,select:focus,textarea:focus{border-color:var(--vscode-focusBorder)}
    input::placeholder,textarea::placeholder{color:var(--vscode-input-placeholderForeground)}
    .row{display:flex;gap:6px}
    .row input{flex:1;min-width:0}
    hr{border:none;border-top:1px solid var(--vscode-panel-border);margin:10px 0}
    .btn{padding:4px 8px;border:none;cursor:pointer;font-family:inherit;font-size:inherit}
    .btn-sm{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
    .btn-sm:hover{background:var(--vscode-button-secondaryHoverBackground)}
    .btn-primary{width:100%;padding:6px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);margin-top:6px}
    .btn-primary:hover{background:var(--vscode-button-hoverBackground)}
    .btn-primary:disabled{opacity:.5;cursor:not-allowed}
    .btn-danger{width:100%;padding:6px;background:var(--vscode-statusBarItem-errorBackground,#c72e0f);color:#fff;margin-top:6px;border:none;cursor:pointer;font-family:inherit;font-size:inherit}
    .hidden{display:none!important}
    .err{margin-top:8px;padding:5px 7px;font-size:12px;background:var(--vscode-inputValidation-errorBackground);border:1px solid var(--vscode-inputValidation-errorBorder);display:none}
    .ok{margin-top:8px;padding:5px 7px;font-size:12px;background:var(--vscode-inputValidation-infoBackground);border:1px solid var(--vscode-inputValidation-infoBorder);display:none}
    .hint{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:6px}
  </style>
</head>
<body>
  <nav>
    <div class="nav-item active" data-page="new"     onclick="nav(this,'new')">New Project</div>
    <div class="nav-item"        data-page="sc"      onclick="nav(this,'sc')">Scaffold</div>
    <div class="nav-item"        data-page="scu"     onclick="nav(this,'scu')">Scaffold Update</div>
    <div class="nav-item"        data-page="sp"      onclick="nav(this,'sp')">Specialist</div>
    <div class="nav-item"        data-page="pr"      onclick="nav(this,'pr')">Procedure</div>
    <div class="nav-item"        data-page="ext"     onclick="nav(this,'ext')">Extension</div>
    <div class="nav-item"        data-page="build"   onclick="nav(this,'build')">Build</div>
<div class="nav-item"        data-page="run"     onclick="nav(this,'run')">Run</div>
    <div class="nav-item"        data-page="update"  onclick="nav(this,'update')">Update CLI</div>
    <div class="nav-item"        data-page="history" onclick="nav(this,'history')">History</div>
  </nav>

  <!-- NEW PROJECT -->
  <div id="page-new" class="page active">
    <div class="field"><label>Project name *</label><input id="new-name" type="text" placeholder="MyProject"></div>
    <div class="field"><label>Database</label>
      <select id="new-tpl" onchange="onTplChange()">
        <option value="sqlserver">SQL Server</option>
        <option value="pgsql">PostgreSQL</option>
        <option value="oracle">Oracle</option>
      </select>
    </div>
    <hr>
    <div class="field"><label>DB Server</label><input id="new-srv" type="text" placeholder="."></div>
    <div class="field"><label>DB Name</label><input id="new-db" type="text" placeholder="(same as project name)"></div>
    <div class="field"><label>DB User</label><input id="new-usr" type="text" placeholder="Windows Auth / postgres"></div>
    <div class="field"><label>DB Password</label><input id="new-pwd" type="password"></div>
    <hr>
    <div class="field"><label>MediatR License</label><textarea id="new-mediatR" rows="3" placeholder="(optional)" style="resize:vertical;font-family:monospace;font-size:11px;width:100%;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:4px 6px"></textarea></div>
    <div class="field"><label>AutoMapper License</label><textarea id="new-automapper" rows="3" placeholder="(optional)" style="resize:vertical;font-family:monospace;font-size:11px;width:100%;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:4px 6px"></textarea></div>
    <hr>
    <div class="field"><label>Destination folder</label>
      <div class="row">
        <input id="new-folder" type="text" placeholder="(workspace folder)" readonly>
        <button class="btn btn-sm" onclick="pickFolder()">Browse</button>
      </div>
    </div>
    <div id="new-err" class="err"></div>
    <div id="new-ok" class="ok"></div>
    <button id="new-btn" class="btn-primary" onclick="submitNew()" data-label="Create Project">Create Project</button>
  </div>

  <!-- SCAFFOLD -->
  <div id="page-sc" class="page">
    <div class="field"><label>Entity *</label><input id="sc-entity" type="text" placeholder="Product"></div>
    <div id="sc-err" class="err"></div>
    <div id="sc-ok" class="ok"></div>
    <button id="sc-btn" class="btn-primary" onclick="submitScaffold()" data-label="Run Scaffold">Run Scaffold</button>
  </div>

  <!-- SCAFFOLD UPDATE -->
  <div id="page-scu" class="page">
    <p class="hint" style="margin-bottom:10px">Lê o schema do banco, compara com a entidade existente e regera os 16 arquivos dependentes de propriedades.</p>
    <div class="field"><label>Entity *</label><input id="scu-entity" type="text" placeholder="Product"></div>
    <p class="hint">Um terminal será aberto para exibir o diff e confirmar as alterações.</p>
    <div id="scu-err" class="err"></div>
    <div id="scu-ok" class="ok"></div>
    <button id="scu-btn" class="btn-primary" onclick="submitScaffoldUpdate()" data-label="Run Scaffold Update">Run Scaffold Update</button>
  </div>

  <!-- SPECIALIST -->
  <div id="page-sp" class="page">
    <div class="field"><label>Entity *</label><input id="sp-entity" type="text" placeholder="Product"></div>
    <div class="field"><label>Method *</label><input id="sp-method" type="text" placeholder="GetByCategoria"></div>
    <div class="field"><label>Type</label>
      <select id="sp-type" onchange="onSpType()">
        <option value="query">query — MediatR query (SELECT)</option>
        <option value="command">command — MediatR command (INSERT/UPDATE/DELETE)</option>
        <option value="httpcall">httpcall — External HTTP call</option>
      </select>
    </div>
    <div id="sp-sql-field" class="field"><label>SQL *</label><div id="sp-sql-editor" style="height:180px;border:1px solid var(--vscode-input-border,#444);border-radius:3px;overflow:hidden;position:relative"><div id="sp-sql-loading" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:11px;opacity:.4;pointer-events:none">Loading editor…</div></div></div>
    <hr>
    <div class="field">
      <label>Parameters</label>
      <div id="sp-params"></div>
      <button class="btn btn-sm" style="margin-top:4px" onclick="addSpRow('sp-params','paramName:Type','e.g. categoriaId:Guid')">+ Add param</button>
      <p class="hint">Format: name:Type — valid types: string, int, bool, decimal, Guid, DateTime, long, double, float, short</p>
    </div>
    <div id="sp-cols-section" class="field">
      <label>Columns</label>
      <div id="sp-cols"></div>
      <button class="btn btn-sm" style="margin-top:4px" onclick="addSpRow('sp-cols','ColumnName:Type','e.g. Nome:string')">+ Add column</button>
      <p class="hint">Format: name:Type — same type list as above</p>
    </div>
    <div id="sp-err" class="err"></div>
    <div id="sp-ok" class="ok"></div>
    <button id="sp-btn" class="btn-primary" onclick="submitSpecialist()" data-label="Generate Specialist">Generate Specialist</button>
  </div>

  <!-- PROCEDURE -->
  <div id="page-pr" class="page">
    <div class="field"><label>Procedure name</label><input id="pr-name" type="text" placeholder="GetOrderById (leave empty to list from DB)"></div>
    <div class="field"><label>Schema</label><input id="pr-schema" type="text" placeholder="(auto-detect)"></div>
    <p class="hint">Deixe o nome em branco para listar as procedures do banco via terminal.</p>
    <div id="pr-err" class="err"></div>
    <div id="pr-ok" class="ok"></div>
    <button id="pr-btn" class="btn-primary" onclick="submitProcedure()" data-label="Generate Procedure">Generate Procedure</button>
  </div>

  <!-- EXTENSION -->
  <div id="page-ext" class="page">
    <div class="field"><label>Extension</label>
      <select id="ext-name">
        <option value="jwt">JWT Authentication</option>
        <option value="healthchecks">Health Checks</option>
        <option value="redis">Redis</option>
        <option value="mongodb">MongoDB</option>
        <option value="domainevents">Domain Events</option>
      </select>
    </div>
    <div id="ext-err" class="err"></div>
    <div id="ext-ok" class="ok"></div>
    <button id="ext-btn" class="btn-primary" onclick="submitExtension()" data-label="Add Extension">Add Extension</button>
  </div>

  <!-- BUILD -->
  <div id="page-build" class="page">
    <div class="field"><label>Configuration</label>
      <select id="build-cfg"><option value="Debug">Debug</option><option value="Release">Release</option></select>
    </div>
    <div class="field"><label class="check-label"><input id="build-nr" type="checkbox"> Skip restore (--no-restore)</label></div>
    <div id="build-err" class="err"></div>
    <div id="build-ok" class="ok"></div>
    <button id="build-btn" class="btn-primary" onclick="submitBuild()" data-label="Build">Build</button>
  </div>

  <!-- DEBUG -->
  <!-- RUN -->
  <div id="page-run" class="page">
    <div class="field"><label>Configuration</label>
      <select id="run-cfg"><option value="Debug">Debug</option><option value="Release">Release</option></select>
    </div>
    <div class="field"><label class="check-label"><input id="run-nb" type="checkbox"> Skip build (--no-build)</label></div>
    <div id="run-err" class="err"></div>
    <div id="run-ok" class="ok"></div>
    <button id="run-btn" class="btn-primary" onclick="submitRun()" data-label="Run">Run</button>
    <button id="run-stop" class="btn-danger hidden" onclick="stopRun()">Stop</button>
  </div>

  <!-- HISTORY -->
  <div id="page-history" class="page">
    <p class="hint" style="margin-bottom:10px">Exibe o histórico de gerações do projeto OpenBase.</p>
    <div id="history-err" class="err"></div>
    <div id="history-ok" class="ok"></div>
    <button id="history-btn" class="btn-primary" onclick="submitHistory()" data-label="Show History">Show History</button>
  </div>

  <!-- UPDATE -->
  <div id="page-update" class="page">
    <p class="hint" style="margin-bottom:10px">Atualiza o OpenBase CLI e templates para a versão mais recente.</p>
    <div id="update-err" class="err"></div>
    <div id="update-ok" class="ok"></div>
    <button id="update-btn" class="btn-primary" onclick="submitUpdate()" data-label="Update OpenBase CLI">Update OpenBase CLI</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function nav(el, page) {
      document.querySelectorAll('.page').forEach(function(p){ p.classList.remove('active'); });
      document.querySelectorAll('.nav-item').forEach(function(n){ n.classList.remove('active'); });
      document.getElementById('page-' + page).classList.add('active');
      el.classList.add('active');
    }

    function onTplChange() {
      document.getElementById('new-srv').placeholder = document.getElementById('new-tpl').value === 'sqlserver' ? '.' : 'localhost';
    }
    function onScMode() {
      var mf = document.getElementById('sc-mode').value === 'modelfirst';
      document.getElementById('sc-mf').classList.toggle('hidden', !mf);
      document.getElementById('sc-cf-hint').classList.toggle('hidden', mf);
    }
    function onSpType() {
      var type = document.getElementById('sp-type').value;
      document.getElementById('sp-sql-field').classList.toggle('hidden', type === 'httpcall');
      document.getElementById('sp-cols-section').classList.toggle('hidden', type !== 'query');
    }
    function addSpRow(containerId, placeholder, title) {
      var row = document.createElement('div');
      row.className = 'row';
      row.style.marginBottom = '4px';
      var input = document.createElement('input');
      input.type = 'text';
      input.placeholder = placeholder;
      input.title = title;
      var btn = document.createElement('button');
      btn.className = 'btn btn-sm';
      btn.textContent = '\u00d7';
      btn.onclick = function() { row.remove(); };
      row.appendChild(input);
      row.appendChild(btn);
      document.getElementById(containerId).appendChild(row);
      input.focus();
    }
    function getSpRows(containerId) {
      return Array.from(document.getElementById(containerId).querySelectorAll('input'))
        .map(function(i) { return i.value.trim(); })
        .filter(function(v) { return v; });
    }

    function clearFields(ctx) {
      if (ctx === 'sc') {
        document.getElementById('sc-entity').value = '';
      } else if (ctx === 'scu') {
        document.getElementById('scu-entity').value = '';
      } else if (ctx === 'sp') {
        document.getElementById('sp-entity').value = '';
        document.getElementById('sp-method').value = '';
        if (spEditor) spEditor.setValue('');
        document.getElementById('sp-params').innerHTML = '';
        document.getElementById('sp-cols').innerHTML = '';
      } else if (ctx === 'pr') {
        document.getElementById('pr-name').value = '';
        document.getElementById('pr-schema').value = '';
      }
    }

    function pickFolder() { vscode.postMessage({ command: 'pickFolder' }); }

    function err(ctx, msg) {
      var el = document.getElementById(ctx + '-err');
      if (el) { el.textContent = msg; el.style.display = msg ? 'block' : 'none'; }
      if (msg) { var ok = document.getElementById(ctx + '-ok'); if (ok) ok.style.display = 'none'; }
    }
    function ok(ctx, msg) {
      var el = document.getElementById(ctx + '-ok');
      if (el) { el.textContent = msg; el.style.display = msg ? 'block' : 'none'; }
      if (msg) { var er = document.getElementById(ctx + '-err'); if (er) er.style.display = 'none'; }
    }
    function loading(ctx, on) {
      var btn = document.getElementById(ctx + '-btn');
      if (!btn) return;
      btn.disabled = on;
      btn.textContent = on ? 'Running\u2026' : (btn.dataset.label || btn.textContent);
      if (on) { ok(ctx, ''); err(ctx, ''); }
    }

    window.addEventListener('message', function(e) {
      var m = e.data;
      if (m.command === 'navigateTo') {
        var navEl = document.querySelector('.nav-item[data-page="' + m.tab + '"]');
        if (navEl) nav(navEl, m.tab);
        if (m.tab === 'sp' && m.query) {
          if (spEditor) {
            spEditor.setValue(m.query);
            spEditor.focus();
          } else {
            spEditorPending = m.query;
          }
        }
        return;
      }
      if (m.command === 'fillSpecialist') {
        var navEl = document.querySelector('.nav-item[data-page="sp"]');
        if (navEl) nav(navEl, 'sp');
        if (m.entity) document.getElementById('sp-entity').value = m.entity;
        if (m.method) document.getElementById('sp-method').value = m.method;
        return;
      }
      if (m.command === 'loadNewProjectPrefs') {
        var p = m.prefs || {};
        if (p.template) document.getElementById('new-tpl').value = p.template;
        if (p.dbServer)  document.getElementById('new-srv').value = p.dbServer;
        if (p.dbUser)    document.getElementById('new-usr').value = p.dbUser;
        if (p.mediatrLicense)    document.getElementById('new-mediatR').value = p.mediatrLicense;
        if (p.automapperLicense) document.getElementById('new-automapper').value = p.automapperLicense;
      } else if (m.command === 'folderPicked') {
        document.getElementById('new-folder').value = m.path;
      } else if (m.command === 'done') {
        loading(m.ctx, false);
        if (m.text) ok(m.ctx, m.text);
        clearFields(m.ctx);
      } else if (m.command === 'error') {
        loading(m.ctx, false);
        err(m.ctx, m.text);
      } else if (m.command === 'runStarted') {
        document.getElementById('run-btn').classList.add('hidden');
        document.getElementById('run-stop').classList.remove('hidden');
      } else if (m.command === 'runStopped') {
        document.getElementById('run-btn').classList.remove('hidden');
        document.getElementById('run-stop').classList.add('hidden');
        loading('run', false);
      }
    });

    function submitNew() {
      var name = document.getElementById('new-name').value.trim();
      err('new', '');
      if (!name) { err('new', 'Project name is required.'); return; }
      if (!/^[a-zA-Z0-9._-]+$/.test(name)) { err('new', 'Invalid project name.'); return; }
      loading('new', true);
      vscode.postMessage({ command: 'newProject', data: {
        name: name,
        template: document.getElementById('new-tpl').value,
        dbServer: document.getElementById('new-srv').value.trim(),
        dbName: document.getElementById('new-db').value.trim(),
        dbUser: document.getElementById('new-usr').value.trim(),
        dbPassword: document.getElementById('new-pwd').value.trim(),
        mediatrLicense: document.getElementById('new-mediatR').value.trim(),
        automapperLicense: document.getElementById('new-automapper').value.trim(),
        folder: document.getElementById('new-folder').value.trim(),
      }});
    }

    function submitScaffold() {
      var entity = document.getElementById('sc-entity').value.trim();
      err('sc', '');
      if (!entity) { err('sc', 'Entity name is required.'); return; }
      if (!/^[A-Z][a-zA-Z0-9]*$/.test(entity)) { err('sc', 'Must be PascalCase (e.g. Product).'); return; }
      loading('sc', true);
      vscode.postMessage({ command: 'scaffold', data: { entity: entity }});
    }

    function submitScaffoldUpdate() {
      var entity = document.getElementById('scu-entity').value.trim();
      err('scu', '');
      if (!entity) { err('scu', 'Entity name is required.'); return; }
      if (!/^[A-Z][a-zA-Z0-9]*$/.test(entity)) { err('scu', 'Must be PascalCase (e.g. Product).'); return; }
      loading('scu', true);
      vscode.postMessage({ command: 'scaffoldUpdate', data: { entity: entity }});
    }

    function submitSpecialist() {
      var entity = document.getElementById('sp-entity').value.trim();
      var method = document.getElementById('sp-method').value.trim();
      var type   = document.getElementById('sp-type').value;
      var sql    = (spEditor ? spEditor.getValue() : '').trim();
      err('sp', '');
      if (!entity) { err('sp', 'Entity name is required.'); return; }
      if (!/^[A-Z][a-zA-Z0-9]*$/.test(entity)) { err('sp', 'Entity must be PascalCase (e.g. Product).'); return; }
      if (!method) { err('sp', 'Method name is required.'); return; }
      if (!/^[A-Z][a-zA-Z0-9]*$/.test(method)) { err('sp', 'Method must be PascalCase (e.g. GetByCategoria).'); return; }
      if (type !== 'httpcall' && !sql) { err('sp', 'SQL is required for query/command types.'); return; }
      var params  = getSpRows('sp-params');
      var columns = type === 'query' ? getSpRows('sp-cols') : [];
      loading('sp', true);
      vscode.postMessage({ command: 'specialist', data: {
        entity: entity, method: method, type: type, sql: sql,
        params: params, columns: columns,
      }});
    }

    function submitProcedure() {
      var name = document.getElementById('pr-name').value.trim();
      err('pr', '');
      if (name && !/^[A-Z][a-zA-Z0-9]*$/.test(name)) { err('pr', 'Must be PascalCase (e.g. GetOrderById).'); return; }
      loading('pr', true);
      vscode.postMessage({ command: 'procedure', data: {
        name: name,
        schema: document.getElementById('pr-schema').value.trim(),
      }});
    }

    function submitExtension() {
      err('ext', '');
      loading('ext', true);
      var name = document.getElementById('ext-name').value;
      vscode.postMessage({ command: 'extensionAdd', data: { name: name } });
    }

    function submitBuild() {
      err('build', '');
      loading('build', true);
      vscode.postMessage({ command: 'build', data: {
        configuration: document.getElementById('build-cfg').value,
        noRestore: document.getElementById('build-nr').checked,
      }});
    }

    function submitRun() {
      err('run', '');
      loading('run', true);
      vscode.postMessage({ command: 'run', data: {
        configuration: document.getElementById('run-cfg').value,
        noBuild: document.getElementById('run-nb').checked,
      }});
    }

    function stopRun() { vscode.postMessage({ command: 'stopRun' }); }

    function submitHistory() {
      err('history', '');
      loading('history', true);
      vscode.postMessage({ command: 'history' });
    }

    function submitUpdate() {
      err('update', '');
      loading('update', true);
      vscode.postMessage({ command: 'update' });
    }
  </script>
  <script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.47.0/min/vs/loader.js"></script>
  <script>
    var spEditor = null;
    var spEditorPending = null;
    window.MonacoEnvironment = { getWorkerUrl: function() { return 'data:text/javascript;charset=utf-8,' + encodeURIComponent('self.onmessage=function(){};'); } };
    require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.47.0/min/vs' } });
    require(['vs/editor/editor.main'], function() {
      monaco.editor.defineTheme('openbase-dark', {
        base: 'vs-dark', inherit: true,
        rules: [
          { token: 'keyword.sql', foreground: 'c084fc', fontStyle: 'bold' },
          { token: 'keyword',     foreground: 'c084fc', fontStyle: 'bold' },
          { token: 'string.sql',  foreground: 'f472b6' },
          { token: 'string',      foreground: 'f472b6' },
          { token: 'number',      foreground: '67e8f9' },
          { token: 'comment',     foreground: '4b3f6b', fontStyle: 'italic' },
          { token: 'operator',    foreground: 'e879f9' },
          { token: 'identifier',  foreground: 'ede8f8' },
          { token: 'predefined',  foreground: 'a78bfa' },
        ],
        colors: {
          'editor.background':                  '#0d0f1a',
          'editor.foreground':                  '#ede8f8',
          'editor.lineHighlightBackground':     '#1c153528',
          'editor.selectionBackground':         '#b44fff33',
          'editor.inactiveSelectionBackground': '#b44fff1a',
          'editorLineNumber.foreground':        '#3d3060',
          'editorLineNumber.activeForeground':  '#b44fff',
          'editorCursor.foreground':            '#b44fff',
          'editorWidget.background':            '#131629',
          'editorWidget.border':                '#b44fff44',
          'scrollbarSlider.background':         '#b44fff22',
          'scrollbarSlider.hoverBackground':    '#b44fff44',
          'scrollbarSlider.activeBackground':   '#b44fff66',
          'editorGutter.background':            '#0d0f1a',
        }
      });
      spEditor = monaco.editor.create(document.getElementById('sp-sql-editor'), {
        value: '',
        language: 'sql',
        theme: 'openbase-dark',
        minimap: { enabled: false },
        fontSize: 13,
        lineNumbers: 'on',
        automaticLayout: true,
        wordWrap: 'off',
        scrollBeyondLastLine: false,
        renderLineHighlight: 'line',
        padding: { top: 8, bottom: 8 },
        quickSuggestions: true,
        folding: false,
        tabSize: 2,
        insertSpaces: true,
        overviewRulerLanes: 0,
        scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
        contextmenu: false,
        placeholder: 'SELECT Nome FROM Produtos WHERE CategoriaId = {{categoriaId}}',
      });
      document.getElementById('sp-sql-loading').style.display = 'none';
      if (spEditorPending !== null) {
        spEditor.setValue(spEditorPending);
        spEditor.focus();
        spEditorPending = null;
      }
    });
  </script>
</body>
</html>`;
    }
}

// ─── sql runner ──────────────────────────────────────────────────────────────

interface DbConnection {
    type: 'sqlserver' | 'pgsql' | 'oracle';
    label: string;
    server: string;
    database: string;
    user?: string;
    password?: string;
    port?: string;
}

function parseConnectionString(cs: string): DbConnection | undefined {
    const get = (...keys: string[]): string | undefined => {
        for (const k of keys) {
            const m = cs.match(new RegExp(`(?:^|;)\\s*${k.replace(/\s/g, '\\s*')}\\s*=\\s*([^;]+)`, 'i'));
            if (m) return m[1].trim();
        }
    };

    if (/(?:^|;)\s*Host\s*=/i.test(cs) || /(?:^|;)\s*Username\s*=/i.test(cs)) {
        const server   = get('Host', 'Server') ?? 'localhost';
        const database = get('Database') ?? '';
        return { type: 'pgsql', label: `pgsql · ${database}`, server, database,
            user: get('Username', 'User Id'), password: get('Password'), port: get('Port') };
    }

    const ds = get('Data Source', 'DataSource');
    if (ds && /[/@]/.test(ds) && !/^\./.test(ds) && !/\\/.test(ds)) {
        return { type: 'oracle', label: `oracle · ${ds}`, server: ds, database: ds,
            user: get('User Id', 'User', 'UID'), password: get('Password', 'PWD') };
    }

    const server   = get('Server', 'Data Source', 'DataSource') ?? '.';
    const database = get('Database', 'Initial Catalog') ?? '';
    return { type: 'sqlserver', label: `sqlserver · ${database}`, server, database,
        user: get('User Id', 'UID'), password: get('Password', 'PWD') };
}

function findConnection(cwd: string): DbConnection | undefined {
    function scan(dir: string, depth: number): string | undefined {
        if (depth > 4) return undefined;
        for (const name of ['appsettings.Development.json', 'appsettings.json']) {
            const p = path.join(dir, name);
            if (fs.existsSync(p)) return p;
        }
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
    if (!file) return undefined;
    try {
        const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
        const cs = json?.ConnectionStrings?.DefaultConnection
            ?? json?.ConnectionStrings?.Connection
            ?? (Object.values(json?.ConnectionStrings ?? {}) as string[])[0];
        if (typeof cs === 'string') return parseConnectionString(cs);
    } catch { /* ignore */ }
}

function parseSqlOutput(raw: string, type: DbConnection['type']): { columns: string[]; rows: string[][]; message?: string } {
    const lines = raw.split('\n').map(l => l.trimEnd()).filter(Boolean);

    if (type === 'pgsql') {
        if (!lines.length) return { columns: [], rows: [] };
        const nonTable = lines.find(l => /^(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|DO)\b/i.test(l));
        if (nonTable) return { columns: [], rows: [], message: lines.join('\n') };
        const parseCSV = (line: string): string[] => {
            const res: string[] = []; let cur = ''; let inQ = false;
            for (const ch of line) {
                if (ch === '"') { inQ = !inQ; continue; }
                if (ch === ',' && !inQ) { res.push(cur); cur = ''; continue; }
                cur += ch;
            }
            res.push(cur); return res;
        };
        const [header, ...rest] = lines;
        return { columns: parseCSV(header), rows: rest.map(parseCSV) };
    }

    if (type === 'sqlserver') {
        const affected = lines.find(l => /^\(\d+ rows? affected\)/i.test(l));
        const dataLines = lines.filter(l => !/^[-| ]+$/.test(l) && !/^\(\d+ rows? affected\)/i.test(l));
        if (!dataLines.length) return { columns: [], rows: [], message: affected ?? 'Command completed.' };
        const columns = dataLines[0].split('|').map(c => c.trim()).filter(Boolean);
        const rows = dataLines.slice(1).map(l => l.split('|').map(c => c.trim()));
        return { columns, rows, message: affected };
    }

    // oracle
    const dataLines = lines.filter(l => !/^[-]+$/.test(l) && !/^\d+ rows? selected/i.test(l) && !/^Disconnected/.test(l));
    if (!dataLines.length) return { columns: [], rows: [], message: lines.join('\n') };
    if (!dataLines[0].includes('|')) return { columns: [], rows: [], message: lines.join('\n') };
    const columns = dataLines[0].split('|').map(c => c.trim()).filter(Boolean);
    const rows = dataLines.slice(1).map(l => l.split('|').map(c => c.trim()));
    return { columns, rows };
}

function getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
    return text;
}

const NEW_PROJECT_PREFS_KEY = 'newProjectPrefs';
const SQL_HISTORY_KEY = 'sqlQueryHistory';
const SQL_HISTORY_LIMIT = 50;
const SQL_AUTOSAVE_KEY = 'sqlRunnerAutoSave';
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

interface HistoryEntry {
    sql: string;
    timestamp: number;
    connectionLabel: string;
    rowCount: number;
}

interface ExplainNode {
    op: string;
    detail: string;
    cost: number;
    rows: number;
    children: ExplainNode[];
}

function pgPlanToNode(plan: Record<string, unknown>): ExplainNode {
    const nodeType = String(plan['Node Type'] ?? 'Unknown');
    const parts: string[] = [];
    if (plan['Relation Name']) parts.push(String(plan['Relation Name']));
    if (plan['Index Name'])    parts.push(`idx:${plan['Index Name']}`);
    if (plan['Filter'])        parts.push(`filter:${String(plan['Filter']).slice(0, 80)}`);
    if (plan['Join Filter'])   parts.push(`join:${String(plan['Join Filter']).slice(0, 80)}`);
    const children: ExplainNode[] = [];
    if (Array.isArray(plan['Plans'])) {
        for (const child of plan['Plans'] as Record<string, unknown>[]) children.push(pgPlanToNode(child));
    }
    return { op: nodeType, detail: parts.join(' · '), cost: Number(plan['Total Cost'] ?? 0), rows: Number(plan['Plan Rows'] ?? 0), children };
}

function parsePgExplain(output: string): ExplainNode {
    try {
        const s = output.trim();
        const start = s.indexOf('['), end = s.lastIndexOf(']');
        if (start < 0 || end < 0) throw new Error('no json');
        const json = JSON.parse(s.slice(start, end + 1)) as Array<{ Plan: Record<string, unknown> }>;
        const plan = json[0]?.Plan;
        if (!plan) throw new Error('no plan');
        return pgPlanToNode(plan);
    } catch {
        return { op: 'Parse error', detail: output.slice(0, 300), cost: 0, rows: 0, children: [] };
    }
}

function parseSsTextPlan(output: string): ExplainNode {
    const nodeLines = output.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.includes('|--'));
    if (!nodeLines.length) return { op: 'No plan', detail: output.replace(/\r?\n/g, ' ').slice(0, 200), cost: 0, rows: 0, children: [] };
    const items = nodeLines.map(l => {
        const idx = l.indexOf('|--');
        const level = Math.round(idx / 3);
        const text = l.slice(idx + 3).trim();
        const rowM = text.match(/EstimateRows[=\s]+([0-9.]+)/i);
        const opEnd = text.indexOf('(');
        return {
            level,
            op: opEnd > 0 ? text.slice(0, opEnd).trim() : text,
            detail: opEnd > 0 ? text.slice(opEnd + 1).replace(/\)$/, '').slice(0, 120) : '',
            cost: 0,
            rows: rowM ? Number(rowM[1]) : 0,
        };
    });
    const stack: Array<ExplainNode & { level: number }> = [];
    let root: (ExplainNode & { level: number }) | undefined;
    for (const item of items) {
        const node = { ...item, children: [] as ExplainNode[] };
        while (stack.length && stack[stack.length - 1].level >= item.level) stack.pop();
        if (!stack.length) root = node; else stack[stack.length - 1].children.push(node);
        stack.push(node);
    }
    return root ?? { op: 'No plan', detail: '', cost: 0, rows: 0, children: [] };
}

function parseOraclePlan(output: string): ExplainNode {
    const dataLines = output.split('\n').map(l => l.replace(/\r$/, '')).filter(l => /^\|\s*\d/.test(l));
    if (!dataLines.length) return { op: 'No plan', detail: output.slice(0, 200), cost: 0, rows: 0, children: [] };
    const items = dataLines.map(l => {
        const cols = l.split('|').map(c => c.trim()).filter((_, i) => i > 0);
        const rawOp = cols[1] ?? '';
        return {
            level: Math.floor((rawOp.length - rawOp.trimStart().length) / 2),
            op: rawOp.trim(),
            detail: cols[2] ?? '',
            cost: parseInt((cols[5] ?? '').replace(/\s*\(.*/, ''), 10) || 0,
            rows: parseInt(cols[3] ?? '0', 10) || 0,
        };
    });
    const stack: Array<ExplainNode & { level: number }> = [];
    let root: (ExplainNode & { level: number }) | undefined;
    for (const item of items) {
        const node = { ...item, children: [] as ExplainNode[] };
        while (stack.length && stack[stack.length - 1].level >= item.level) stack.pop();
        if (!stack.length) root = node; else stack[stack.length - 1].children.push(node);
        stack.push(node);
    }
    return root ?? { op: 'No plan', detail: '', cost: 0, rows: 0, children: [] };
}

function parseExplainPlan(output: string, dbType: string): ExplainNode {
    if (dbType === 'pgsql')   return parsePgExplain(output);
    if (dbType === 'oracle')  return parseOraclePlan(output);
    return parseSsTextPlan(output);
}

let sqlPanel: vscode.WebviewPanel | undefined;
let sqlProcess: import('child_process').ChildProcess | undefined;
let sqlLog: vscode.OutputChannel | undefined;

function sqlOut(): vscode.OutputChannel {
    if (!sqlLog) sqlLog = vscode.window.createOutputChannel('OpenBase SQL Runner (Debug)');
    return sqlLog;
}

async function sqlRunner(): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const conn = cwd ? findConnection(cwd) : undefined;

    if (sqlPanel) {
        sqlPanel.reveal(vscode.ViewColumn.One);
        return;
    }

    sqlOut().appendLine(`[SQL Runner] Opening panel. cwd=${cwd ?? '(none)'}`);
    sqlOut().appendLine(`[SQL Runner] Connection detected: ${conn ? conn.label : '(none)'}`);

    sqlPanel = vscode.window.createWebviewPanel(
        'openbase.sqlRunner', 'OpenBase SQL', vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    sqlPanel.onDidDispose(() => { sqlPanel = undefined; sqlOut().appendLine('[SQL Runner] Panel disposed.'); });
    const sqlNonce = getNonce();
    sqlPanel.webview.html = buildSqlRunnerHtml(conn, sqlNonce, sqlPanel.webview.cspSource);

    const savedSql = extContext?.globalState.get<string>(SQL_AUTOSAVE_KEY);
    if (savedSql && !sqlPendingScript) {
        sqlPendingScript = { content: savedSql, name: 'autosave' };
    }

    sqlPanel.webview.onDidReceiveMessage(async (msg: { command: string; sql?: string; csvData?: string; csvName?: string; table?: string; keyColumn?: string; keyValue?: string; column?: string; newValue?: string }) => {
        sqlOut().appendLine(`[SQL Runner] Message received: ${msg.command}`);

        if (msg.command === 'autoSave' && msg.sql) {
            const autoSaveEnabled = vscode.workspace.getConfiguration('openbase').get('editor.autoSave', true);
            if (autoSaveEnabled) {
                await extContext?.globalState.update(SQL_AUTOSAVE_KEY, msg.sql);
            }
            return;
        }

        if (msg.command === 'ready') {
            if (sqlPendingScript) {
                const pending = sqlPendingScript;
                sqlPendingScript = undefined;
                sqlPanel?.webview.postMessage({ command: 'loadScript', content: pending.content, name: pending.name });
            }
            const historyEntries = extContext?.globalState.get<HistoryEntry[]>(SQL_HISTORY_KEY) ?? [];
            sqlPanel?.webview.postMessage({ command: 'loadHistory', entries: historyEntries });
            return;
        }

        if (msg.command === 'saveScript') {
            const scriptsDir = getScriptsDir();
            if (!scriptsDir) { vscode.window.showErrorMessage('No workspace folder open.'); return; }
            if (!msg.sql?.trim()) return;
            const name = await vscode.window.showInputBox({
                prompt: 'Save script as',
                placeHolder: 'my-query',
                validateInput: v => v?.trim() && /^[^\\/:\*\?"<>\|]+$/.test(v.trim()) ? undefined : 'Invalid name',
            });
            if (!name?.trim()) return;
            const safeName = name.trim().replace(/\.sql$/i, '') + '.sql';
            fs.mkdirSync(scriptsDir, { recursive: true });
            fs.writeFileSync(path.join(scriptsDir, safeName), msg.sql, 'utf-8');
            vscode.window.showInformationMessage(`Script saved: ${safeName}`);
            sqlScriptProvider?.refresh();
            return;
        }

        if (msg.command === 'clearHistory') {
            await extContext?.globalState.update(SQL_HISTORY_KEY, []);
            sqlPanel?.webview.postMessage({ command: 'loadHistory', entries: [] });
            return;
        }

        if (msg.command === 'cancel') {
            sqlProcess?.kill();
            sqlProcess = undefined;
            sqlPanel?.webview.postMessage({ command: 'cancelled' });
            return;
        }

        if (msg.command === 'saveCsv') {
            const activeCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(activeCwd ?? os.homedir(), msg.csvName ?? 'query.csv')),
                filters: { 'CSV': ['csv'] },
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
            sqlPanel?.webview.postMessage({ command: 'loadScript', content: updateSql, name: 'update' });
            return;
        }

        if (msg.command === 'sendToSpecialist') {
            await vscode.commands.executeCommand('openbase.panel.focus');
            panelProvider?.postNavigateTo('sp', msg.sql ?? '');
            return;
        }

        if (msg.command === 'explain') {
            if (!msg.sql?.trim()) return;
            const sql = msg.sql.trim();
            const activeCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const activeConn = activeCwd ? findConnection(activeCwd) : undefined;
            if (!activeConn) {
                sqlPanel?.webview.postMessage({ command: 'explainError', text: 'No connection configured.' });
                return;
            }
            sqlPanel?.webview.postMessage({ command: 'explainRunning' });
            const tmpFile = path.join(os.tmpdir(), `ob_explain_${Date.now()}.sql`);
            const extraPath = dotnetToolsPath();
            const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
            try {
                let explainSql = '';
                let cmd = '';
                switch (activeConn.type) {
                    case 'sqlserver': {
                        explainSql = `SET SHOWPLAN_TEXT ON\nGO\n${sql}\nGO\nSET SHOWPLAN_TEXT OFF\nGO\n`;
                        fs.writeFileSync(tmpFile, explainSql, 'utf-8');
                        const p = ['sqlcmd', `-S "${activeConn.server}"`, `-d "${activeConn.database}"`];
                        if (activeConn.user)     p.push(`-U "${activeConn.user}"`);
                        if (activeConn.password) p.push(`-P "${activeConn.password}"`);
                        p.push(`-i "${tmpFile}"`);
                        cmd = p.join(' ');
                        break;
                    }
                    case 'pgsql': {
                        explainSql = `EXPLAIN (FORMAT JSON)\n${sql}`;
                        fs.writeFileSync(tmpFile, explainSql, 'utf-8');
                        const port = activeConn.port ?? '5432';
                        const user = encodeURIComponent(activeConn.user ?? 'postgres');
                        const pass = encodeURIComponent(activeConn.password ?? '');
                        const url  = `postgresql://${user}:${pass}@${activeConn.server}:${port}/${activeConn.database}`;
                        cmd = `psql "${url}" -X -t -A -f "${tmpFile}"`;
                        break;
                    }
                    case 'oracle': {
                        explainSql = `EXPLAIN PLAN FOR\n${sql};\nSELECT * FROM TABLE(DBMS_XPLAN.DISPLAY);\nEXIT\n`;
                        fs.writeFileSync(tmpFile, explainSql, 'utf-8');
                        cmd = `sqlplus -S "${activeConn.user}/${activeConn.password ?? ''}@${activeConn.server}" @"${tmpFile}"`;
                        break;
                    }
                }
                const output = await new Promise<string>((resolve, reject) => {
                    exec(cmd, { env, timeout: 30000 }, (err, stdout, stderr) => {
                        if (err && !stdout) reject(new Error(stderr || err.message));
                        else resolve(stdout + (stderr ? '\n' + stderr : ''));
                    });
                });
                const tree = parseExplainPlan(output, activeConn.type);
                sqlPanel?.webview.postMessage({ command: 'explainResult', tree, dbType: activeConn.type });
            } catch (e: unknown) {
                const text = e instanceof Error ? e.message : String(e);
                sqlPanel?.webview.postMessage({ command: 'explainError', text });
            } finally {
                try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
            }
            return;
        }

        if (msg.command !== 'run' || !msg.sql?.trim()) {
            sqlOut().appendLine(`[SQL Runner] Ignored message: command=${msg.command}, sql empty=${!msg.sql?.trim()}`);
            return;
        }
        const sql = msg.sql.trim();

        const activeCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        sqlOut().appendLine(`[SQL Runner] Run requested. activeCwd=${activeCwd ?? '(none)'}`);

        const activeConn = activeCwd ? findConnection(activeCwd) : undefined;
        sqlOut().appendLine(`[SQL Runner] Active connection: ${activeConn ? activeConn.label + ' type=' + activeConn.type : '(none)'}`);

        if (!activeConn) {
            sqlOut().appendLine('[SQL Runner] No connection — sending error to webview.');
            sqlPanel?.webview.postMessage({ command: 'error', text: 'No OpenBase project found in workspace.\nappsettings.json with ConnectionStrings is required.' });
            return;
        }

        sqlPanel?.webview.postMessage({ command: 'running' });
        sqlOut().appendLine('[SQL Runner] Sent "running" to webview.');

        const tmpFile = path.join(os.tmpdir(), `ob_sql_${Date.now()}.sql`);
        const extraPath = dotnetToolsPath();
        const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
        let cmd = '';

        try {
            switch (activeConn.type) {
                case 'sqlserver': {
                    fs.writeFileSync(tmpFile, sql, 'utf-8');
                    const parts = ['sqlcmd', `-S "${activeConn.server}"`, `-d "${activeConn.database}"`];
                    if (activeConn.user)     parts.push(`-U "${activeConn.user}"`);
                    if (activeConn.password) parts.push(`-P "${activeConn.password}"`);
                    parts.push(`-i "${tmpFile}" -s "|" -W`);
                    cmd = parts.join(' ');
                    break;
                }
                case 'pgsql': {
                    fs.writeFileSync(tmpFile, sql, 'utf-8');
                    const port = activeConn.port ?? '5432';
                    const user = encodeURIComponent(activeConn.user ?? 'postgres');
                    const pass = encodeURIComponent(activeConn.password ?? '');
                    const url  = `postgresql://${user}:${pass}@${activeConn.server}:${port}/${activeConn.database}`;
                    cmd = `psql "${url}" --csv -f "${tmpFile}"`;
                    break;
                }
                case 'oracle': {
                    const script = `SET MARKUP CSV ON DELIMITER '|' QUOTE OFF\nSET PAGESIZE 50000\nSET FEEDBACK ON\n${sql}\n/\nEXIT\n`;
                    fs.writeFileSync(tmpFile, script, 'utf-8');
                    cmd = `sqlplus -S "${activeConn.user}/${activeConn.password ?? ''}@${activeConn.server}" @"${tmpFile}"`;
                    break;
                }
            }

            sqlOut().appendLine(`[SQL Runner] Executing: ${cmd.replace(/(-P\s*")[^"]*"/, '-P "***"')}`);

            const output = await new Promise<string>((resolve, reject) => {
                const child = exec(cmd, { env, timeout: 30000 }, (err, stdout, stderr) => {
                    sqlProcess = undefined;
                    sqlOut().appendLine(`[SQL Runner] exec done. err=${err?.message ?? 'none'} stdout=${stdout.length}b stderr=${stderr.length}b`);
                    if (err && !stdout) reject(new Error(stderr || err.message));
                    else resolve(stdout + (stderr ? '\n' + stderr : ''));
                });
                sqlProcess = child;
            });

            const result = parseSqlOutput(output, activeConn.type);
            sqlOut().appendLine(`[SQL Runner] Result: ${result.columns.length} cols, ${result.rows.length} rows.`);
            sqlPanel?.webview.postMessage({ command: 'result', ...result });

            const prevEntries = extContext?.globalState.get<HistoryEntry[]>(SQL_HISTORY_KEY) ?? [];
            const newEntry: HistoryEntry = { sql, timestamp: Date.now(), connectionLabel: activeConn.label, rowCount: result.rows.length };
            const updatedEntries = [newEntry, ...prevEntries].slice(0, SQL_HISTORY_LIMIT);
            await extContext?.globalState.update(SQL_HISTORY_KEY, updatedEntries);
            sqlPanel?.webview.postMessage({ command: 'loadHistory', entries: updatedEntries });
        } catch (e: unknown) {
            const text = e instanceof Error ? e.message : String(e);
            sqlOut().appendLine(`[SQL Runner] Error: ${text}`);
            sqlPanel?.webview.postMessage({ command: 'error', text });
        } finally {
            try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        }
    });
}

function buildSqlRunnerHtml(conn: DbConnection | undefined, nonce: string, cspSource: string): string {
    const connLabel = (conn?.label ?? 'No connection')
        .replace(/&/g, '&amp;').replace(/\x3c/g, '&lt;').replace(/\x3e/g, '&gt;');
    const monacoBase = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.47.0/min/vs';
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline' https://cdn.jsdelivr.net; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net data:; worker-src blob: data:;">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%;overflow:hidden}
  body{display:flex;flex-direction:column;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background)}
  .header{display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}
  .header-title{font-weight:600;font-size:13px}
  .badge{padding:2px 8px;border-radius:3px;font-size:11px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
  .badge.warn{background:var(--vscode-inputValidation-warningBackground);color:var(--vscode-inputValidation-warningForeground,#000)}
  .editor-wrap{flex:0 0 220px;position:relative;border-bottom:1px solid var(--vscode-panel-border)}
  #editor{position:absolute;top:0;left:0;right:0;bottom:0}
  .editor-loading{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:11px;opacity:.4;pointer-events:none}
  .toolbar{display:flex;align-items:center;gap:8px;padding:5px 12px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;background:var(--vscode-sideBar-background)}
  .btn{padding:4px 10px;border:none;cursor:pointer;font-family:inherit;font-size:inherit}
  .btn-primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
  .btn-primary:hover{background:var(--vscode-button-hoverBackground)}
  .btn-primary:disabled{opacity:.5;cursor:not-allowed}
  .btn-secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
  .btn-secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}
  .btn-cancel{background:var(--vscode-statusBarItem-errorBackground,#c72e0f);color:#fff}
  .btn-cancel:hover{opacity:.85}
  .hidden{display:none!important}
  .hint{font-size:11px;color:var(--vscode-descriptionForeground)}
  .status{margin-left:auto;font-size:11px;color:var(--vscode-descriptionForeground);display:flex;align-items:center;gap:5px}
  .spinner{display:inline-block;width:10px;height:10px;border:2px solid var(--vscode-foreground);border-top-color:transparent;border-radius:50%;animation:spin .6s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .results{flex:1;overflow:auto}
  .placeholder{padding:20px;color:var(--vscode-descriptionForeground);font-size:12px;font-style:italic}
  .err-box{margin:12px;padding:8px 12px;background:var(--vscode-inputValidation-errorBackground);border:1px solid var(--vscode-inputValidation-errorBorder);font-size:12px;white-space:pre-wrap;font-family:monospace}
  .msg-box{margin:12px;padding:8px 12px;background:var(--vscode-inputValidation-infoBackground);border:1px solid var(--vscode-inputValidation-infoBorder);font-size:12px;white-space:pre-wrap;font-family:monospace}
  .result-header{display:flex;align-items:center;justify-content:space-between;padding:4px 12px;font-size:11px;color:var(--vscode-descriptionForeground);border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);flex-shrink:0}
  table{width:100%;border-collapse:collapse;font-size:12px}
  thead{position:sticky;top:0;background:var(--vscode-editor-background);z-index:1}
  th{text-align:left;padding:5px 10px;border-bottom:2px solid var(--vscode-panel-border);font-weight:600;white-space:nowrap}
  td{padding:4px 10px;border-bottom:1px solid color-mix(in srgb,var(--vscode-panel-border) 40%,transparent);white-space:nowrap;max-width:360px;overflow:hidden;text-overflow:ellipsis}
  tr:hover td{background:var(--vscode-list-hoverBackground)}
  td.null{color:var(--vscode-descriptionForeground);font-style:italic}
  td.editing{padding:0!important}
  .cell-edit-input{width:100%;height:100%;background:var(--ob-bg2,#1c1535);color:var(--ob-text,#ede8f8);border:1px solid var(--ob-purple,#b44fff)!important;font-size:12px;font-family:inherit;padding:3px 8px;outline:none}
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
  .header{background:linear-gradient(135deg,rgba(180,79,255,.18),rgba(255,63,164,.10))!important;border-bottom:1px solid var(--ob-border)!important}
  .header-title{background:linear-gradient(90deg,var(--ob-purple),var(--ob-pink));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
  .badge{background:rgba(180,79,255,.2)!important;color:var(--ob-purple)!important;border:1px solid var(--ob-border)}
  .badge.warn{background:rgba(255,63,164,.15)!important;color:var(--ob-pink)!important;border-color:rgba(255,63,164,.35)!important}
  .editor-wrap{border-bottom:1px solid var(--ob-border)!important}
  .toolbar{background:var(--ob-bg1)!important;border-bottom:1px solid var(--ob-border)!important}
  .btn-primary{background:linear-gradient(135deg,var(--ob-purple),var(--ob-pink))!important;color:#fff!important;border-radius:4px}
  .btn-primary:hover:not(:disabled){filter:brightness(1.15)}
  .btn-primary:disabled{opacity:.35!important}
  .btn-secondary{background:rgba(180,79,255,.12)!important;color:var(--ob-purple)!important;border:1px solid var(--ob-border);border-radius:4px}
  .btn-secondary:hover{background:rgba(180,79,255,.24)!important}
  .btn-cancel{border-radius:4px}
  .hint{color:var(--ob-dim)!important}
  .status{color:var(--ob-dim)!important}
  .results{background:var(--ob-bg0)!important}
  .placeholder{color:var(--ob-dim)!important}
  .result-header{background:var(--ob-bg1)!important;border-bottom:1px solid var(--ob-border)!important;color:var(--ob-dim)!important}
  thead{background:var(--ob-bg1)!important}
  th{border-bottom-color:var(--ob-border)!important;color:var(--ob-purple)!important}
  td{border-bottom:1px solid rgba(180,79,255,.07)!important}
  tr:hover td{background:rgba(180,79,255,.07)!important}
  .err-box{background:rgba(255,63,164,.10)!important;border-color:rgba(255,63,164,.35)!important;color:#ff90c0!important}
  .msg-box{background:rgba(180,79,255,.10)!important;border-color:var(--ob-border)!important;color:var(--ob-purple)!important}
  .spinner{border-color:var(--ob-purple)!important;border-top-color:transparent!important}
  .editor-loading{color:var(--ob-dim)!important}
  #history-panel{flex:1;overflow:auto;display:flex;flex-direction:column;background:var(--ob-bg0)}
  .history-toolbar{display:flex;align-items:center;justify-content:space-between;padding:4px 12px;font-size:11px;color:var(--ob-dim);border-bottom:1px solid var(--ob-border);background:var(--ob-bg1);flex-shrink:0}
  #history-list{flex:1;overflow:auto}
  .history-item{padding:8px 12px;border-bottom:1px solid rgba(180,79,255,.07);cursor:pointer;display:flex;flex-direction:column;gap:4px}
  .history-item:hover{background:rgba(180,79,255,.07)}
  .history-preview{font-family:monospace;font-size:11px;color:var(--ob-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .history-meta{font-size:10px;color:var(--ob-dim);display:flex;gap:8px;align-items:center}
  .history-pin{margin-left:auto;font-size:10px!important;padding:1px 6px!important;opacity:0;transition:opacity .15s}
  .history-item:hover .history-pin{opacity:1}
  .history-empty{padding:20px;color:var(--ob-dim);font-size:12px;font-style:italic}
  #explain-panel{flex:1;overflow:auto;display:flex;flex-direction:column;background:var(--ob-bg0)}
  .explain-toolbar{display:flex;align-items:center;justify-content:space-between;padding:4px 12px;font-size:11px;color:var(--ob-dim);border-bottom:1px solid var(--ob-border);background:var(--ob-bg1);flex-shrink:0}
  .explain-tree{padding:12px;overflow:auto;flex:1}
  .explain-node{margin-left:14px;border-left:2px solid rgba(180,79,255,.2);padding-left:10px;margin-top:6px}
  .explain-root{margin-left:0!important;border-left:none!important;padding-left:0!important;margin-top:0!important}
  #result-tabs{display:flex;flex-shrink:0;border-bottom:1px solid var(--ob-border);background:var(--ob-bg1);overflow-x:auto;overflow-y:hidden;min-height:28px}
  .result-tab{display:flex;align-items:center;gap:5px;padding:3px 10px;cursor:pointer;font-size:11px;border-right:1px solid var(--ob-border);white-space:nowrap;user-select:none;color:var(--ob-dim);border-top:2px solid transparent}
  .result-tab.active{color:var(--ob-text);background:var(--ob-bg0);border-top-color:var(--ob-purple)}
  .result-tab:hover:not(.active){background:rgba(180,79,255,.07)}
  .result-tab-label{max-width:160px;overflow:hidden;text-overflow:ellipsis}
  .result-tab-close{opacity:0;font-size:10px;line-height:1;padding:1px 3px;border-radius:2px;flex-shrink:0}
  .result-tab-close:hover{background:rgba(255,63,164,.25);opacity:1!important;color:var(--ob-pink)}
  .result-tab:hover .result-tab-close{opacity:.5}
  .node-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:3px 0}
  .node-op{font-weight:600;font-size:12px;color:var(--ob-text)}
  .node-detail{font-size:11px;color:var(--ob-dim);font-style:italic}
  .cost-badge{font-size:10px;padding:1px 5px;border-radius:3px;font-family:monospace}
  .rows-badge{font-size:10px;color:var(--ob-dim);font-family:monospace}
  .cost-low{background:rgba(52,211,153,.15);color:#34d399;border:1px solid rgba(52,211,153,.3)}
  .cost-med{background:rgba(251,191,36,.15);color:#fbbf24;border:1px solid rgba(251,191,36,.3)}
  .cost-high{background:rgba(248,113,113,.15);color:#f87171;border:1px solid rgba(248,113,113,.3)}
</style>
</head>
<body>
<div class="header">
  <span class="header-title">OpenBase SQL</span>
  <span class="badge ${conn ? '' : 'warn'}">${connLabel}</span>
</div>
<div class="editor-wrap">
  <div id="editor"></div>
  <div class="editor-loading" id="editor-loading">Loading editor&hellip;</div>
</div>
<div class="toolbar">
  <button id="run-btn" class="btn btn-primary">&#x25B6; Run</button>
  <button id="cancel-btn" class="btn btn-cancel hidden">&#x2715; Cancel</button>
  <button id="explain-btn" class="btn btn-secondary" title="Show execution plan (Explain)">&#x26A1; Explain</button>
  <button id="save-btn" class="btn btn-secondary" title="Save script to library">Save&hellip;</button>
  <button id="history-btn" class="btn btn-secondary" title="Show query history">History</button>
  <button id="specialist-btn" class="btn btn-secondary" title="Send query to Specialist">&#x2192; Specialist</button>
  <span class="hint">F8 to run</span>
  <span id="status" class="status"></span>
</div>
<div id="result-tabs" class="hidden"></div>
<div id="results" class="results">
  <p class="placeholder">Write a query above and press Run or F8</p>
</div>
<div id="history-panel" class="hidden">
  <div class="history-toolbar">
    <span>Query history</span>
    <button id="clear-history-btn" class="btn btn-secondary" style="font-size:11px;padding:2px 8px">Clear all</button>
  </div>
  <div id="history-list"><p class="history-empty">No history yet.</p></div>
</div>
<div id="explain-panel" class="hidden">
  <div class="explain-toolbar">
    <span>Execution plan</span>
    <button id="back-from-explain-btn" class="btn btn-secondary" style="font-size:11px;padding:2px 8px">&#xAB; Results</button>
  </div>
  <div id="explain-tree" class="explain-tree"><p class="placeholder">Loading…</p></div>
</div>
<script src="${monacoBase}/loader.js"></script>
<script nonce="${nonce}">
  window.onerror = function(msg, src, line, col) {
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#c72e0f;color:#fff;padding:6px 10px;font-size:12px;font-family:monospace;z-index:9999;white-space:pre-wrap';
    box.textContent = 'JS ERROR: ' + msg + '\\n' + src + ':' + line + ':' + col;
    document.body.appendChild(box);
  };
  var vscode = acquireVsCodeApi();
  var running = false, t0 = 0;
  var lastColumns = [], lastRows = [];
  var runTimeoutId = null;
  var editor = null;
  var pendingLoad = null;
  var historyEntries = [];
  var historyVisible = false;
  var activePanel = 'results'; // 'results' | 'history' | 'explain'
  var resultTabs = [];
  var activeTabId = null;
  var tabCounter = 0;
  var lastRunSql = '';

  document.getElementById('run-btn').addEventListener('click', run);
  document.getElementById('cancel-btn').addEventListener('click', function() {
    clearRunTimeout();
    vscode.postMessage({ command: 'cancel' });
  });
  document.getElementById('save-btn').addEventListener('click', function() {
    var sql = editor ? editor.getValue() : '';
    if (sql.trim()) vscode.postMessage({ command: 'saveScript', sql: sql });
  });
  document.getElementById('history-btn').addEventListener('click', function() {
    toggleHistory();
  });
  document.getElementById('clear-history-btn').addEventListener('click', function() {
    vscode.postMessage({ command: 'clearHistory' });
  });
  document.getElementById('history-list').addEventListener('click', function(e) {
    var pin = e.target.closest('.history-pin');
    if (pin) {
      var idx = parseInt(pin.getAttribute('data-idx'), 10);
      var entry = historyEntries[idx];
      if (entry) vscode.postMessage({ command: 'saveScript', sql: entry.sql });
      return;
    }
    var item = e.target.closest('.history-item');
    if (item) {
      var idx2 = parseInt(item.getAttribute('data-idx'), 10);
      var entry2 = historyEntries[idx2];
      if (entry2) {
        if (editor) {
          editor.setValue(entry2.sql);
          editor.setPosition({ lineNumber: 1, column: 1 });
        } else {
          pendingLoad = entry2.sql;
        }
        if (historyVisible) toggleHistory();
      }
    }
  });
  document.getElementById('specialist-btn').addEventListener('click', function() {
    var sql = editor ? editor.getValue() : '';
    var sel = editor ? editor.getSelection() : null;
    if (sel && !sel.isEmpty()) sql = editor.getModel().getValueInRange(sel);
    if (sql.trim()) vscode.postMessage({ command: 'sendToSpecialist', sql: sql });
  });
  document.getElementById('explain-btn').addEventListener('click', function() {
    var sql = editor ? editor.getValue() : '';
    var sel = editor ? editor.getSelection() : null;
    if (sel && !sel.isEmpty()) sql = editor.getModel().getValueInRange(sel);
    if (!sql.trim()) return;
    vscode.postMessage({ command: 'explain', sql: sql });
  });
  document.getElementById('back-from-explain-btn').addEventListener('click', function() {
    showPanel('results');
  });
  document.getElementById('result-tabs').addEventListener('click', function(e) {
    var closeBtn = e.target.closest('[data-close-id]');
    if (closeBtn) { closeTab(parseInt(closeBtn.getAttribute('data-close-id'), 10)); return; }
    var tabEl = e.target.closest('[data-tab-id]');
    if (tabEl) activateTab(parseInt(tabEl.getAttribute('data-tab-id'), 10));
  });
  document.getElementById('results').addEventListener('click', function(e) {
    if (e.target && e.target.id === 'export-csv-btn') exportCsv();
  });
  document.getElementById('results').addEventListener('dblclick', function(e) {
    var td = e.target.closest('td');
    if (!td) return;
    var c = parseInt(td.getAttribute('data-c'), 10);
    if (isNaN(c) || c === 0) return;
    var r = parseInt(td.getAttribute('data-r'), 10);
    if (isNaN(r)) return;
    var sql = editor ? editor.getValue() : '';
    var tableMatch = sql.match(/\\bFROM\\s+([\\w\\."\`\\[\\]]+)/i);
    if (!tableMatch) return;
    var tableName = tableMatch[1].replace(/["\`\\[\\]]/g, '');
    var keyCol = lastColumns[0];
    var keyVal = lastRows[r] ? String(lastRows[r][0]) : '';
    var colName = lastColumns[c];
    var origVal = td.textContent;
    td.classList.add('editing');
    td.innerHTML = '';
    var inp = document.createElement('input');
    inp.className = 'cell-edit-input';
    inp.value = origVal === 'NULL' ? '' : origVal;
    td.appendChild(inp);
    inp.focus();
    inp.select();
    function commit() {
      var newVal = inp.value;
      td.classList.remove('editing');
      td.textContent = newVal;
      vscode.postMessage({ command: 'editCell', table: tableName, keyColumn: keyCol, keyValue: keyVal, column: colName, newValue: newVal });
    }
    function cancel() {
      td.classList.remove('editing');
      td.textContent = origVal;
    }
    inp.addEventListener('keydown', function(ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
      else if (ev.key === 'Tab') { ev.preventDefault(); commit(); }
    });
    inp.addEventListener('blur', function() { cancel(); });
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'F8') { e.preventDefault(); run(); }
  });

  window.MonacoEnvironment = {
    getWorkerUrl: function() {
      return 'data:text/javascript;charset=utf-8,' + encodeURIComponent('self.onmessage=function(){};');
    }
  };
  require.config({ paths: { vs: '${monacoBase}' } });
  require(['vs/editor/editor.main'], function() {
    monaco.editor.defineTheme('openbase-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'keyword.sql',  foreground: 'c084fc', fontStyle: 'bold' },
        { token: 'keyword',      foreground: 'c084fc', fontStyle: 'bold' },
        { token: 'string.sql',   foreground: 'f472b6' },
        { token: 'string',       foreground: 'f472b6' },
        { token: 'number',       foreground: '67e8f9' },
        { token: 'comment',      foreground: '4b3f6b', fontStyle: 'italic' },
        { token: 'operator',     foreground: 'e879f9' },
        { token: 'identifier',   foreground: 'ede8f8' },
        { token: 'predefined',   foreground: 'a78bfa' },
      ],
      colors: {
        'editor.background':                   '#0d0f1a',
        'editor.foreground':                   '#ede8f8',
        'editor.lineHighlightBackground':      '#1c153528',
        'editor.selectionBackground':          '#b44fff33',
        'editor.inactiveSelectionBackground':  '#b44fff1a',
        'editorLineNumber.foreground':         '#3d3060',
        'editorLineNumber.activeForeground':   '#b44fff',
        'editorCursor.foreground':             '#b44fff',
        'editorIndentGuide.background1':       '#1c1535',
        'editorIndentGuide.activeBackground1': '#b44fff44',
        'editorWidget.background':             '#131629',
        'editorWidget.border':                 '#b44fff44',
        'editorSuggestWidget.background':      '#131629',
        'editorSuggestWidget.border':          '#b44fff44',
        'editorSuggestWidget.selectedBackground': '#1c1535',
        'editorSuggestWidget.foreground':      '#ede8f8',
        'scrollbarSlider.background':          '#b44fff22',
        'scrollbarSlider.hoverBackground':     '#b44fff44',
        'scrollbarSlider.activeBackground':    '#b44fff66',
        'editorGutter.background':             '#0d0f1a',
      }
    });
    editor = monaco.editor.create(document.getElementById('editor'), {
      value: '',
      language: 'sql',
      theme: 'openbase-dark',
      minimap: { enabled: false },
      fontSize: 13,
      lineNumbers: 'on',
      automaticLayout: true,
      wordWrap: 'off',
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      padding: { top: 10, bottom: 10 },
      quickSuggestions: true,
      suggestOnTriggerCharacters: true,
      folding: true,
      tabSize: 2,
      insertSpaces: true,
      overviewRulerLanes: 0,
      scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
      contextmenu: false,
    });
    editor.addCommand(monaco.KeyCode.F8, function() { run(); });
    editor.onDidChangeModelContent(function() {
      vscode.postMessage({ command: 'autoSave', sql: editor.getValue() });
    });
    document.getElementById('editor-loading').style.display = 'none';
    if (pendingLoad !== null) {
      editor.setValue(pendingLoad);
      editor.setPosition({ lineNumber: 1, column: 1 });
      pendingLoad = null;
    }
    vscode.postMessage({ command: 'ready' });
  });

  function clearRunTimeout() {
    if (runTimeoutId) { clearTimeout(runTimeoutId); runTimeoutId = null; }
  }

  function run() {
    if (running) return;
    var sql = editor ? editor.getValue().trim() : '';
    if (!sql) {
      document.getElementById('results').innerHTML = '<p class="placeholder">Enter a SQL query above before running.</p>';
      return;
    }
    lastRunSql = sql;
    running = true;
    t0 = Date.now();
    document.getElementById('run-btn').classList.add('hidden');
    document.getElementById('cancel-btn').classList.remove('hidden');
    document.getElementById('results').innerHTML = '';
    setStatus('<span class="spinner"></span> Sending…');
    runTimeoutId = setTimeout(function() {
      running = false;
      document.getElementById('run-btn').classList.remove('hidden');
      document.getElementById('cancel-btn').classList.add('hidden');
      setStatus('');
      document.getElementById('results').innerHTML =
        '<div class="err-box">Extension did not respond after 10s.\\nMake sure an OpenBase project with appsettings.json is open in the workspace.</div>';
    }, 10000);
    vscode.postMessage({ command: 'run', sql: sql });
  }

  function exportCsv() {
    if (!lastColumns.length) return;
    var lines = [lastColumns.map(csvCell).join(',')];
    for (var r = 0; r < lastRows.length; r++) lines.push(lastRows[r].map(csvCell).join(','));
    var csv = lines.join('\\r\\n');
    var name = 'query_' + new Date().toISOString().slice(0,19).replace(/[T:]/g,'-') + '.csv';
    vscode.postMessage({ command: 'saveCsv', csvData: csv, csvName: name });
  }

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\\n')) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  window.addEventListener('message', function(e) {
    var m = e.data;
    if (m.command === 'triggerRun') { run(); return; }
    if (m.command === 'loadHistory') {
      historyEntries = m.entries || [];
      renderHistory();
      return;
    }
    if (m.command === 'loadScript') {
      if (editor) {
        editor.setValue(m.content || '');
        editor.setPosition({ lineNumber: 1, column: 1 });
      } else {
        pendingLoad = m.content || '';
      }
      document.getElementById('results').innerHTML = '<p class="placeholder">Write a query above and press Run or F8</p>';
      lastColumns = []; lastRows = [];
      return;
    }
    if (m.command === 'reset') {
      running = false; clearRunTimeout();
      document.getElementById('run-btn').classList.remove('hidden');
      document.getElementById('cancel-btn').classList.add('hidden');
      setStatus('');
      return;
    }
    clearRunTimeout();
    if (m.command === 'running') {
      running = true; t0 = Date.now();
      setStatus('<span class="spinner"></span> Running…');
    } else if (m.command === 'result') {
      running = false;
      document.getElementById('run-btn').classList.remove('hidden');
      document.getElementById('cancel-btn').classList.add('hidden');
      if (historyVisible) toggleHistory();
      var elapsed = ((Date.now() - t0) / 1000).toFixed(2) + 's';
      renderResult(m.columns, m.rows, m.message, elapsed);
    } else if (m.command === 'error') {
      running = false;
      document.getElementById('run-btn').classList.remove('hidden');
      document.getElementById('cancel-btn').classList.add('hidden');
      setStatus('');
      lastColumns = []; lastRows = [];
      document.getElementById('results').innerHTML = '<div class="err-box">' + esc(m.text) + '</div>';
    } else if (m.command === 'cancelled') {
      running = false;
      document.getElementById('run-btn').classList.remove('hidden');
      document.getElementById('cancel-btn').classList.add('hidden');
      setStatus('');
      lastColumns = []; lastRows = [];
      document.getElementById('results').innerHTML = '<div class="msg-box">Query cancelled.\x3c/div>';
    } else if (m.command === 'explainRunning') {
      showPanel('explain');
      document.getElementById('explain-tree').innerHTML = '\x3cdiv style="padding:20px;display:flex;align-items:center;gap:8px">\x3cspan class="spinner">\x3c/span>\x3cspan style="color:var(--ob-dim);font-size:12px">Generating execution plan…\x3c/span>\x3c/div>';
    } else if (m.command === 'explainResult') {
      showPanel('explain');
      var maxC = calcMaxCost(m.tree);
      document.getElementById('explain-tree').innerHTML = renderExplainNode(m.tree, maxC, true);
    } else if (m.command === 'explainError') {
      showPanel('explain');
      document.getElementById('explain-tree').innerHTML = '\x3cdiv class="err-box">' + esc(m.text) + '\x3c/div>';
    }
  });

  function renderResult(columns, rows, message, elapsed) {
    setStatus('');
    if (!columns || !columns.length) {
      document.getElementById('results').innerHTML =
        '<div class="msg-box">' + esc(message || 'Command completed.') + '</div>';
      return;
    }
    tabCounter++;
    var firstLine = lastRunSql.trim().split('\\n')[0].trim();
    var label = '#' + tabCounter + ' ' + (firstLine.length > 24 ? firstLine.slice(0, 23) + '…' : firstLine);
    var tab = { id: tabCounter, label: label, columns: columns || [], rows: rows || [], message: message, elapsed: elapsed };
    resultTabs.push(tab);
    if (resultTabs.length > 10) resultTabs.shift();
    activateTab(tab.id);
    showPanel('results');
  }

  function activateTab(id) {
    var tab = null;
    for (var i = 0; i < resultTabs.length; i++) { if (resultTabs[i].id === id) { tab = resultTabs[i]; break; } }
    if (!tab) return;
    activeTabId = id;
    lastColumns = tab.columns;
    lastRows = tab.rows;
    renderTabBar();
    renderResultContent(tab.columns, tab.rows, tab.message, tab.elapsed);
  }

  function closeTab(id) {
    var idx = -1;
    for (var i = 0; i < resultTabs.length; i++) { if (resultTabs[i].id === id) { idx = i; break; } }
    if (idx === -1) return;
    resultTabs.splice(idx, 1);
    if (activeTabId === id) {
      if (resultTabs.length > 0) {
        activateTab(resultTabs[Math.min(idx, resultTabs.length - 1)].id);
      } else {
        activeTabId = null; lastColumns = []; lastRows = [];
        document.getElementById('results').innerHTML = '<p class="placeholder">Write a query above and press Run or F8</p>';
        renderTabBar();
      }
    } else {
      renderTabBar();
    }
  }

  function renderTabBar() {
    var bar = document.getElementById('result-tabs');
    if (!resultTabs.length) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
    bar.classList.remove('hidden');
    var html = '';
    for (var i = 0; i < resultTabs.length; i++) {
      var t = resultTabs[i];
      html += '<div class="result-tab' + (t.id === activeTabId ? ' active' : '') + '" data-tab-id="' + t.id + '">'
            + '<span class="result-tab-label" title="' + esc(t.label) + '">' + esc(t.label) + '</span>'
            + '<span class="result-tab-close" data-close-id="' + t.id + '">✕</span>'
            + '</div>';
    }
    bar.innerHTML = html;
  }

  function renderResultContent(columns, rows, message, elapsed) {
    if (!columns || !columns.length) {
      document.getElementById('results').innerHTML =
        '<div class="msg-box">' + esc(message || 'Command completed.') + '</div>';
      return;
    }
    var rowCount = rows ? rows.length : 0;
    var infoMsg = message ? ' \xB7 ' + esc(message) : '';
    var hdr = '<div class="result-header">'
            + '<span>' + rowCount + ' row' + (rowCount !== 1 ? 's' : '') + ' \xB7 ' + elapsed + infoMsg + '</span>'
            + '<button id="export-csv-btn" class="btn btn-secondary" style="font-size:11px;padding:2px 8px">Export CSV</button>'
            + '</div>';
    var tbl = '<table><thead><tr>';
    for (var i = 0; i < columns.length; i++) tbl += '<th>' + esc(columns[i]) + '</th>';
    tbl += '</tr></thead><tbody>';
    for (var r = 0; r < rowCount; r++) {
      tbl += '<tr>';
      for (var c = 0; c < columns.length; c++) {
        var val = (rows[r] && rows[r][c] != null) ? rows[r][c] : '';
        var isNull = val === 'NULL';
        tbl += '<td' + (isNull ? ' class="null"' : '') + ' title="' + esc(val) + '" data-r="' + r + '" data-c="' + c + '">'
             + (isNull ? 'NULL' : esc(val)) + '</td>';
      }
      tbl += '</tr>';
    }
    tbl += '</tbody></table>';
    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;height:100%';
    wrap.innerHTML = hdr + '<div style="flex:1;overflow:auto">' + tbl + '</div>';
    var res = document.getElementById('results');
    res.innerHTML = '';
    res.appendChild(wrap);
  }

  function showPanel(which) {
    activePanel = which;
    var showResults = which === 'results';
    document.getElementById('result-tabs').classList.toggle('hidden', !showResults || !resultTabs.length);
    document.getElementById('results').classList.toggle('hidden', !showResults);
    document.getElementById('history-panel').classList.toggle('hidden', which !== 'history');
    document.getElementById('explain-panel').classList.toggle('hidden', which !== 'explain');
    historyVisible = (which === 'history');
    document.getElementById('history-btn').textContent = historyVisible ? '\xAB Results' : 'History';
  }

  function toggleHistory() {
    showPanel(historyVisible ? 'results' : 'history');
  }

  function calcMaxCost(node) {
    if (!node) return 0;
    var max = node.cost || 0;
    for (var i = 0; i < (node.children || []).length; i++) {
      var c = calcMaxCost(node.children[i]);
      if (c > max) max = c;
    }
    return max;
  }

  function renderExplainNode(node, maxCost, isRoot) {
    if (!node) return '';
    var pct = (maxCost > 0 && node.cost > 0) ? (node.cost / maxCost * 100) : -1;
    var costHtml = node.cost > 0
      ? '\x3cspan class="cost-badge ' + (pct > 66 ? 'cost-high' : pct > 33 ? 'cost-med' : 'cost-low') + '">cost ' + node.cost.toFixed(2) + '\x3c/span>'
      : '';
    var rowsHtml = node.rows > 0 ? '\x3cspan class="rows-badge">' + node.rows + ' rows\x3c/span>' : '';
    var detailHtml = node.detail ? '\x3cspan class="node-detail">' + esc(node.detail) + '\x3c/span>' : '';
    var kids = '';
    for (var i = 0; i < (node.children || []).length; i++) kids += renderExplainNode(node.children[i], maxCost, false);
    return '\x3cdiv class="explain-node' + (isRoot ? ' explain-root' : '') + '">'
      + '\x3cdiv class="node-row">\x3cspan class="node-op">' + esc(node.op) + '\x3c/span>' + detailHtml + costHtml + rowsHtml + '\x3c/div>'
      + (kids ? '\x3cdiv class="node-children">' + kids + '\x3c/div>' : '')
      + '\x3c/div>';
  }

  function renderHistory() {
    var list = document.getElementById('history-list');
    if (!historyEntries.length) {
      list.innerHTML = '\x3cp class="history-empty">No history yet.\x3c/p>';
      return;
    }
    var html = '';
    for (var i = 0; i < historyEntries.length; i++) {
      var e = historyEntries[i];
      var preview = e.sql.replace(/\\s+/g, ' ').slice(0, 80);
      var ts = new Date(e.timestamp).toLocaleString();
      var rows = e.rowCount + ' row' + (e.rowCount !== 1 ? 's' : '');
      html += '\x3cdiv class="history-item" data-idx="' + i + '">'
            + '\x3cdiv class="history-preview">' + esc(preview) + '\x3c/div>'
            + '\x3cdiv class="history-meta">'
            + '\x3cspan>' + esc(ts) + '\x3c/span>'
            + '\x3cspan>' + esc(e.connectionLabel) + '\x3c/span>'
            + '\x3cspan>' + rows + '\x3c/span>'
            + '\x3cbutton class="btn btn-secondary history-pin" data-idx="' + i + '" title="Save to script library">Pin\x3c/button>'
            + '\x3c/div>'
            + '\x3c/div>';
    }
    list.innerHTML = html;
  }

  function setStatus(html) { document.getElementById('status').innerHTML = html; }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/\x3c/g,'&lt;').replace(/\x3e/g,'&gt;').replace(/"/g,'&quot;');
  }
</script>
</body>
</html>`;
}

// ─── http runner ─────────────────────────────────────────────────────────────

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

function ensureLocalEnv(baseUrl: string): void {
    const dir = getEnvsDir();
    if (!dir) return;
    const url = baseUrl || 'https://localhost:5000';
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
            fs.writeFileSync(filepath, JSON.stringify({ name: name.trim(), variables: { baseUrl: 'http://localhost:5000', token: '' } }, null, 2), 'utf-8');
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
            httpRequestProvider?.refresh();
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

  /* ── OpenBase brand theme ── */
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
  <input id="url-input" type="text" placeholder="https://localhost:5000/api/...">
  <button id="send-btn" class="btn btn-primary">▶ Send</button>
  <button id="save-req-btn" class="btn btn-secondary" title="Save request to library">Save…</button>
  <button id="import-curl-btn" class="btn btn-secondary" style="font-size:10px;padding:2px 7px" title="Import from cURL command">↓ cURL</button>
  <button id="copy-curl-btn" class="btn btn-secondary" style="font-size:10px;padding:2px 7px" title="Copy as cURL">↑ cURL</button>
  <button id="http-history-btn" class="btn btn-secondary" title="Show request history">History</button>
</div>

<!-- ENV BAR -->
<div class="env-bar">
  <span class="env-label">Env</span>
  <select id="env-select">
    <option value="">— none —</option>
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
    <p class="auth-label">Bearer Token — automatically added as Authorization header on send</p>
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
      btn.textContent = '✓ ok';
      setTimeout(function() { btn.textContent = '↑ cURL'; }, 1500);
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
      sel.innerHTML = '\x3coption value="">— none —\x3c/option>';
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
    document.getElementById('http-history-btn').textContent = httpHistoryVisible ? '« Back' : 'History';
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
            + '\x3cbutton class="http-hist-expand">' + (expanded ? '▼' : '▶') + '\x3c/button>'
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

// ─── runner sidebar (shared) ──────────────────────────────────────────────────

class RunnerSidebarProvider implements vscode.WebviewViewProvider {
    constructor(
        private readonly label: string,
        private readonly btnLabel: string,
        private readonly open: () => void
    ) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        view.webview.options = { enableScripts: true };
        view.webview.html = this._html();
        view.onDidChangeVisibility(() => { if (view.visible) this.open(); });
        view.webview.onDidReceiveMessage((msg) => { if (msg.command === 'open') this.open(); });
    }

    private _html(): string {
        return /* html */`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:16px;text-align:center}
  p{color:var(--vscode-descriptionForeground);font-size:12px;margin-bottom:12px}
  button{padding:6px 12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;cursor:pointer;font-family:inherit;font-size:inherit;width:100%}
  button:hover{background:var(--vscode-button-hoverBackground)}
</style></head>
<body>
  <p>Click below to open ${this.label} in the editor.</p>
  <button onclick="vscode.postMessage({command:'open'})">${this.btnLabel}</button>
  <script>const vscode = acquireVsCodeApi();</script>
</body></html>`;
    }
}

// ─── SQL table browser ───────────────────────────────────────────────────────

type TableItemKind = 'schema' | 'table' | 'message';

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

    async refresh(): Promise<void> {
        this.schemas.clear();
        this.state = 'loading';
        if (this.treeView) this.treeView.message = 'Loading tables…';
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
            const data = await loadSqlTables(conn);
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
}

async function loadSqlTables(conn: DbConnection): Promise<Map<string, { tables: string[]; dbType: DbTemplate }>> {
    const extraPath = dotnetToolsPath();
    const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
    const tmpFile = path.join(os.tmpdir(), `ob_tables_${Date.now()}.sql`);
    let cmd = '';

    const HEADER_COLS = new Set(['table_schema', 'table_name', 'owner', 'tablename', 'tableschema']);

    try {
        switch (conn.type) {
            case 'sqlserver': {
                const q = "SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' ORDER BY TABLE_SCHEMA, TABLE_NAME";
                fs.writeFileSync(tmpFile, q, 'utf-8');
                const parts = ['sqlcmd', `-S "${conn.server}"`, `-d "${conn.database}"`];
                if (conn.user)     parts.push(`-U "${conn.user}"`);
                if (conn.password) parts.push(`-P "${conn.password}"`);
                parts.push(`-i "${tmpFile}" -s "|" -W -h -1`);
                cmd = parts.join(' ');
                break;
            }
            case 'pgsql': {
                const q = "SELECT table_schema, table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_name";
                fs.writeFileSync(tmpFile, q, 'utf-8');
                const port = conn.port ?? '5432';
                const u = encodeURIComponent(conn.user ?? 'postgres');
                const p = encodeURIComponent(conn.password ?? '');
                cmd = `psql "postgresql://${u}:${p}@${conn.server}:${port}/${conn.database}" --csv -f "${tmpFile}"`;
                break;
            }
            case 'oracle': {
                const sysTables = `'SYS','SYSTEM','DBSNMP','APPQOSSYS','AUDSYS','CTXSYS','DVSYS','GSMADMIN_INTERNAL','LBACSYS','MDSYS','OLAPSYS','OUTLN','WMSYS','XDB'`;
                const q = `SET MARKUP CSV ON DELIMITER '|' QUOTE OFF\nSET PAGESIZE 50000\nSELECT OWNER, TABLE_NAME FROM ALL_TABLES WHERE OWNER NOT IN (${sysTables}) ORDER BY OWNER, TABLE_NAME;\n/\nEXIT\n`;
                fs.writeFileSync(tmpFile, q, 'utf-8');
                cmd = `sqlplus -S "${conn.user}/${conn.password ?? ''}@${conn.server}" @"${tmpFile}"`;
                break;
            }
        }

        const stdout = await new Promise<string>((resolve, reject) => {
            exec(cmd, { env, timeout: 15000 }, (err, out, stderr) => {
                if (err && !out) reject(new Error(stderr || err.message));
                else resolve(out);
            });
        });

        const result = new Map<string, { tables: string[]; dbType: DbTemplate }>();
        const sep = conn.type === 'pgsql' ? ',' : '|';

        for (const raw of stdout.split('\n')) {
            const line = raw.trim();
            if (!line || line.startsWith('---') || /^\d+ rows? selected/i.test(line)) continue;
            const parts = line.split(sep).map(p => p.replace(/^"|"$/g, '').trim());
            if (parts.length < 2 || !parts[0] || !parts[1]) continue;
            if (HEADER_COLS.has(parts[0].toLowerCase())) continue;
            const schema = parts[0];
            const table = parts[1];
            if (!result.has(schema)) result.set(schema, { tables: [], dbType: conn.type });
            result.get(schema)!.tables.push(table);
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
        case 'oracle':    return `SELECT *\nFROM ${schema}.${table}\nWHERE ROWNUM <= 100`;
    }
}

// ─── SQL Table Inspector ──────────────────────────────────────────────────────

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
            const colQ = `SET MARKUP CSV ON DELIMITER '|' QUOTE OFF\nSET PAGESIZE 50000\nSELECT COLUMN_NAME, DATA_TYPE, CASE WHEN DATA_PRECISION IS NOT NULL THEN TO_CHAR(DATA_PRECISION) ELSE TO_CHAR(DATA_LENGTH) END AS SZ, NULLABLE, NVL(TO_CHAR(SUBSTR(DATA_DEFAULT,1,50)),' ') FROM ALL_TAB_COLUMNS WHERE OWNER='${s}' AND TABLE_NAME='${t}' ORDER BY COLUMN_ID;\n/\nEXIT\n`;
            const conQ = `SET MARKUP CSV ON DELIMITER '|' QUOTE OFF\nSET PAGESIZE 50000\nSELECT uc.CONSTRAINT_TYPE, uc.CONSTRAINT_NAME, ucc.COLUMN_NAME, NVL(rc.OWNER,' ') AS RS, NVL(rc.TABLE_NAME,' ') AS RT, NVL(rcc.COLUMN_NAME,' ') AS RC FROM ALL_CONSTRAINTS uc JOIN ALL_CONS_COLUMNS ucc ON uc.CONSTRAINT_NAME=ucc.CONSTRAINT_NAME AND uc.OWNER=ucc.OWNER LEFT JOIN ALL_CONSTRAINTS rc ON uc.R_CONSTRAINT_NAME=rc.CONSTRAINT_NAME LEFT JOIN ALL_CONS_COLUMNS rcc ON rc.CONSTRAINT_NAME=rcc.CONSTRAINT_NAME AND rcc.POSITION=1 WHERE uc.OWNER='${s}' AND uc.TABLE_NAME='${t}' AND uc.CONSTRAINT_TYPE IN ('P','R','U') ORDER BY uc.CONSTRAINT_TYPE, ucc.POSITION;\n/\nEXIT\n`;
            fs.writeFileSync(colFile, colQ, 'utf-8');
            fs.writeFileSync(conFile, conQ, 'utf-8');
            colCmd = `sqlplus -S "${conn.user}/${conn.password ?? ''}@${conn.server}" @"${colFile}"`;
            conCmd = `sqlplus -S "${conn.user}/${conn.password ?? ''}@${conn.server}" @"${conFile}"`;
            break;
        }
    }

    const runQ = (cmd: string) => new Promise<string>((resolve, reject) => {
        exec(cmd, { env, timeout: 15000 }, (err, out, stderr) => {
            if (err && !out) reject(new Error(stderr || err.message));
            else resolve(out);
        });
    });

    try {
        const [colOut, conOut] = await Promise.all([runQ(colCmd), runQ(conCmd)]);

        const HEADER = new Set(['column_name', 'constraint_type', 'sz', 'owner']);

        const parseRows = (raw: string, minCols: number): string[][] =>
            raw.split('\n')
                .map(l => l.trim())
                .filter(l => l && !l.startsWith('---') && !/^\d+ rows? selected/i.test(l))
                .map(l => l.split(sep).map(p => p.replace(/^"|"$/g, '').trim()))
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

        const columns: TableColumn[] = parseRows(colOut, 5).map(r => ({
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

// ─── ER Diagram ───────────────────────────────────────────────────────────────

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

// ─── Log Viewer ──────────────────────────────────────────────────────────────

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
            await openScriptInSqlRunner('', sql);
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

let sqlTableProvider: SqlTableTreeProvider | undefined;

function setupSqlTableBrowser(context: vscode.ExtensionContext): void {
    sqlTableProvider = new SqlTableTreeProvider();

    const treeView = vscode.window.createTreeView('openbase.sqlrunner.tables', {
        treeDataProvider: sqlTableProvider,
        showCollapseAll: true,
    });
    sqlTableProvider.setTreeView(treeView);
    context.subscriptions.push(treeView);

    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => sqlTableProvider?.refresh()),

        vscode.commands.registerCommand('openbase.sqlRunner.tables.refresh',
            () => sqlTableProvider?.refresh()),

        vscode.commands.registerCommand('openbase.sqlRunner.tables.select',
            async (item: SqlTableItem) => {
                if (item.kind !== 'table' || !item.schema || !item.dbType) return;
                const sql = buildSelectQuery(item.schema, item.label as string, item.dbType);
                await openScriptInSqlRunner('', sql);
            }),

        vscode.commands.registerCommand('openbase.sqlRunner.tables.inspect',
            async (item: SqlTableItem) => {
                if (item.kind !== 'table' || !item.schema || !item.dbType) return;
                const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                const conn = cwd ? findConnection(cwd) : undefined;
                if (!conn) {
                    vscode.window.showErrorMessage('No database connection found in workspace.');
                    return;
                }
                await openTableInspector(conn, item.schema, item.label as string, item.dbType);
            }),

        vscode.commands.registerCommand('openbase.sqlRunner.erDiagram', () => openErDiagram()),

        vscode.commands.registerCommand('openbase.sqlRunner.tables.filter', () => {
            const inputBox = vscode.window.createInputBox();
            inputBox.placeholder = 'Filter tables...';
            inputBox.value = sqlTableProvider?.filterText ?? '';
            inputBox.onDidChangeValue(text => sqlTableProvider?.setFilter(text));
            inputBox.onDidAccept(() => inputBox.hide());
            inputBox.onDidHide(() => inputBox.dispose());
            inputBox.show();
        }),

        vscode.commands.registerCommand('openbase.sqlRunner.tables.clearFilter', () => {
            sqlTableProvider?.setFilter('');
        }),
    );

    sqlTableProvider.refresh();
}

// ─── SQL script library ───────────────────────────────────────────────────────

const SQL_SCRIPTS_SUBDIR = path.join('.openbase', 'sql-runner', 'scripts');

function getScriptsDir(): string | undefined {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return cwd ? path.join(cwd, SQL_SCRIPTS_SUBDIR) : undefined;
}

let sqlPendingScript: { content: string; name: string } | undefined;
let sqlScriptProvider: SqlScriptTreeProvider | undefined;

type ScriptItemKind = 'script' | 'folder';

class SqlScriptItem extends vscode.TreeItem {
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
        if (kind === 'script') {
            this.command = {
                command: 'openbase.sqlRunner.scripts.open',
                title: 'Open in SQL Runner',
                arguments: [this],
            };
            this.iconPath = new vscode.ThemeIcon('file-code');
        } else {
            this.iconPath = vscode.ThemeIcon.Folder;
        }
    }
}

class SqlScriptTreeProvider implements vscode.TreeDataProvider<SqlScriptItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SqlScriptItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh(): void { this._onDidChangeTreeData.fire(); }

    getTreeItem(e: SqlScriptItem): vscode.TreeItem { return e; }

    getChildren(element?: SqlScriptItem): vscode.ProviderResult<SqlScriptItem[]> {
        const dir = element ? element.fsPath : getScriptsDir();
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

async function openScriptInSqlRunner(filePath: string, directContent?: string): Promise<void> {
    const content = directContent ?? fs.readFileSync(filePath, 'utf-8');
    const name = directContent ? '' : path.basename(filePath);
    if (sqlPanel) {
        sqlPanel.reveal(vscode.ViewColumn.One);
        sqlPanel.webview.postMessage({ command: 'loadScript', content, name });
    } else {
        sqlPendingScript = { content, name };
        await sqlRunner();
    }
}

async function promptScriptName(prompt: string, initial?: string): Promise<string | undefined> {
    const raw = await vscode.window.showInputBox({
        prompt,
        value: initial,
        placeHolder: 'my-query',
        validateInput: v => v?.trim() && /^[^\\/:\*\?"<>\|]+$/.test(v.trim()) ? undefined : 'Invalid name',
    });
    return raw?.trim();
}

function setupSqlScriptLibrary(context: vscode.ExtensionContext): void {
    sqlScriptProvider = new SqlScriptTreeProvider();

    context.subscriptions.push(
        vscode.window.createTreeView('openbase.sqlrunner.scripts', {
            treeDataProvider: sqlScriptProvider,
            showCollapseAll: true,
        }),

        (() => {
            const w = vscode.workspace.createFileSystemWatcher(`**/${SQL_SCRIPTS_SUBDIR}/**`);
            w.onDidCreate(() => sqlScriptProvider?.refresh());
            w.onDidDelete(() => sqlScriptProvider?.refresh());
            w.onDidChange(() => sqlScriptProvider?.refresh());
            return w;
        })(),

        vscode.workspace.onDidChangeWorkspaceFolders(() => sqlScriptProvider?.refresh()),

        vscode.commands.registerCommand('openbase.sqlRunner.scripts.refresh',
            () => sqlScriptProvider?.refresh()),

        vscode.commands.registerCommand('openbase.sqlRunner.scripts.new',
            async (item?: SqlScriptItem) => {
                const baseDir = (item?.kind === 'folder' ? item.fsPath : undefined) ?? getScriptsDir();
                if (!baseDir) { vscode.window.showErrorMessage('No workspace folder open.'); return; }
                const name = await promptScriptName('Script name');
                if (!name) return;
                const file = path.join(baseDir, name.replace(/\.sql$/i, '') + '.sql');
                if (fs.existsSync(file)) { vscode.window.showErrorMessage(`"${path.basename(file)}" already exists.`); return; }
                fs.mkdirSync(baseDir, { recursive: true });
                fs.writeFileSync(file, '', 'utf-8');
                sqlScriptProvider?.refresh();
                await openScriptInSqlRunner(file);
            }),

        vscode.commands.registerCommand('openbase.sqlRunner.scripts.newFolder',
            async (item?: SqlScriptItem) => {
                const baseDir = (item?.kind === 'folder' ? item.fsPath : undefined) ?? getScriptsDir();
                if (!baseDir) { vscode.window.showErrorMessage('No workspace folder open.'); return; }
                const name = await promptScriptName('Folder name');
                if (!name) return;
                fs.mkdirSync(path.join(baseDir, name), { recursive: true });
                sqlScriptProvider?.refresh();
            }),

        vscode.commands.registerCommand('openbase.sqlRunner.scripts.open',
            async (item: SqlScriptItem) => openScriptInSqlRunner(item.fsPath)),

        vscode.commands.registerCommand('openbase.sqlRunner.scripts.rename',
            async (item: SqlScriptItem) => {
                const old = path.basename(item.fsPath);
                const display = item.kind === 'script' ? old.replace(/\.sql$/i, '') : old;
                const name = await promptScriptName('Rename to', display);
                if (!name || name === display) return;
                const newName = item.kind === 'script' ? name.replace(/\.sql$/i, '') + '.sql' : name;
                fs.renameSync(item.fsPath, path.join(path.dirname(item.fsPath), newName));
                sqlScriptProvider?.refresh();
            }),

        vscode.commands.registerCommand('openbase.sqlRunner.scripts.delete',
            async (item: SqlScriptItem) => {
                const name = path.basename(item.fsPath);
                const ans = await vscode.window.showWarningMessage(`Delete "${name}"?`, { modal: true }, 'Delete');
                if (ans !== 'Delete') return;
                if (item.kind === 'folder') fs.rmSync(item.fsPath, { recursive: true, force: true });
                else fs.unlinkSync(item.fsPath);
                sqlScriptProvider?.refresh();
            }),
    );
}

// ─── OpenAPI / Swagger import ─────────────────────────────────────────────────

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

    httpRequestProvider?.refresh();
    vscode.window.showInformationMessage(`Imported ${created} request${created !== 1 ? 's' : ''} from "${apiTitle}" into "${folderName}".`);
}

// ─── HTTP request library ─────────────────────────────────────────────────────

const HTTP_REQUESTS_SUBDIR = path.join('.openbase', 'http-runner', 'requests');

function getRequestsDir(): string | undefined {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return cwd ? path.join(cwd, HTTP_REQUESTS_SUBDIR) : undefined;
}

interface HttpRequestData {
    method?: string;
    url?: string;
    headers?: Array<{name: string; value: string}>;
    bodyType?: string;
    body?: string;
    authToken?: string;
}

let httpPendingRequest: HttpRequestData | undefined;
let httpRequestProvider: HttpRequestTreeProvider | undefined;

class HttpRequestItem extends vscode.TreeItem {
    constructor(
        public readonly fsPath: string,
        public readonly kind: ScriptItemKind,
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

class HttpRequestTreeProvider implements vscode.TreeDataProvider<HttpRequestItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<HttpRequestItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh(): void { this._onDidChangeTreeData.fire(); }

    getTreeItem(e: HttpRequestItem): vscode.TreeItem { return e; }

    getChildren(element?: HttpRequestItem): vscode.ProviderResult<HttpRequestItem[]> {
        const dir = element ? element.fsPath : getRequestsDir();
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

async function openRequestInHttpRunner(filePath: string): Promise<void> {
    let data: HttpRequestData = {};
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { /* use defaults */ }
    if (httpPanel) {
        httpPanel.reveal(vscode.ViewColumn.One);
        httpPanel.webview.postMessage({ command: 'loadRequest', ...data });
    } else {
        httpPendingRequest = data;
        await httpRunner();
    }
}

function setupHttpRequestLibrary(context: vscode.ExtensionContext): void {
    httpRequestProvider = new HttpRequestTreeProvider();

    context.subscriptions.push(
        vscode.window.createTreeView('openbase.httprunner.requests', {
            treeDataProvider: httpRequestProvider,
            showCollapseAll: true,
        }),

        (() => {
            const w = vscode.workspace.createFileSystemWatcher(`**/${HTTP_REQUESTS_SUBDIR}/**`);
            w.onDidCreate(() => httpRequestProvider?.refresh());
            w.onDidDelete(() => httpRequestProvider?.refresh());
            w.onDidChange(() => httpRequestProvider?.refresh());
            return w;
        })(),

        vscode.workspace.onDidChangeWorkspaceFolders(() => httpRequestProvider?.refresh()),

        vscode.commands.registerCommand('openbase.httpRunner.requests.refresh',
            () => httpRequestProvider?.refresh()),

        vscode.commands.registerCommand('openbase.httpRunner.requests.new',
            async (item?: HttpRequestItem) => {
                const baseDir = (item?.kind === 'folder' ? item.fsPath : undefined) ?? getRequestsDir();
                if (!baseDir) { vscode.window.showErrorMessage('No workspace folder open.'); return; }
                const name = await promptScriptName('Request name');
                if (!name) return;
                const file = path.join(baseDir, name.replace(/\.json$/i, '') + '.json');
                if (fs.existsSync(file)) { vscode.window.showErrorMessage(`"${path.basename(file)}" already exists.`); return; }
                fs.mkdirSync(baseDir, { recursive: true });
                fs.writeFileSync(file, JSON.stringify({ method: 'GET', url: '', headers: [], bodyType: 'none', body: '', authToken: '' }, null, 2), 'utf-8');
                httpRequestProvider?.refresh();
                await openRequestInHttpRunner(file);
            }),

        vscode.commands.registerCommand('openbase.httpRunner.requests.newFolder',
            async (item?: HttpRequestItem) => {
                const baseDir = (item?.kind === 'folder' ? item.fsPath : undefined) ?? getRequestsDir();
                if (!baseDir) { vscode.window.showErrorMessage('No workspace folder open.'); return; }
                const name = await promptScriptName('Folder name');
                if (!name) return;
                fs.mkdirSync(path.join(baseDir, name), { recursive: true });
                httpRequestProvider?.refresh();
            }),

        vscode.commands.registerCommand('openbase.httpRunner.requests.open',
            async (item: HttpRequestItem) => openRequestInHttpRunner(item.fsPath)),

        vscode.commands.registerCommand('openbase.httpRunner.requests.rename',
            async (item: HttpRequestItem) => {
                const old = path.basename(item.fsPath);
                const display = item.kind === 'script' ? old.replace(/\.json$/i, '') : old;
                const name = await promptScriptName('Rename to', display);
                if (!name || name === display) return;
                const newName = item.kind === 'script' ? name.replace(/\.json$/i, '') + '.json' : name;
                fs.renameSync(item.fsPath, path.join(path.dirname(item.fsPath), newName));
                httpRequestProvider?.refresh();
            }),

        vscode.commands.registerCommand('openbase.httpRunner.requests.delete',
            async (item: HttpRequestItem) => {
                const name = path.basename(item.fsPath);
                const ans = await vscode.window.showWarningMessage(`Delete "${name}"?`, { modal: true }, 'Delete');
                if (ans !== 'Delete') return;
                if (item.kind === 'folder') fs.rmSync(item.fsPath, { recursive: true, force: true });
                else fs.unlinkSync(item.fsPath);
                httpRequestProvider?.refresh();
            }),

        vscode.commands.registerCommand('openbase.httpRunner.requests.importSwagger',
            () => importSwaggerToHttpRunner()),
    );
}

// ─── monitor ─────────────────────────────────────────────────────────────────

let monitorPanel: vscode.WebviewPanel | undefined;
let monitorTimer: ReturnType<typeof setInterval> | undefined;
let monPrevCpu: { idle: number; total: number } | undefined;
let monPrevDisk: { r: number; w: number; ts: number } | undefined;
let monPrevNet: { rx: number; tx: number; ts: number } | undefined;
let monCountersProcess: ReturnType<typeof spawn> | undefined;
let monSelectedPid: number | undefined;

function parseDotnetCounters(line: string): Record<string, number> | null {
    try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const events = (obj['Events'] ?? obj['events'] ?? obj['metrics'] ?? []) as Array<Record<string, unknown>>;
        if (!Array.isArray(events)) return null;
        const result: Record<string, number> = {};
        for (const e of events) {
            const provider = String(e['Provider'] ?? e['provider'] ?? '');
            if (provider !== 'System.Runtime') continue;
            const name = String(e['Name'] ?? e['name'] ?? '');
            const val = Number(e['Mean'] ?? e['mean'] ?? e['value'] ?? 0);
            if (name && !isNaN(val)) result[name] = val;
        }
        return Object.keys(result).length > 0 ? result : null;
    } catch { return null; }
}

function stopMonCounters(): void {
    if (monCountersProcess) { monCountersProcess.kill(); monCountersProcess = undefined; }
}

function startMonCounters(pid: number): void {
    stopMonCounters();
    const extraPath = dotnetToolsPath();
    const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };

    // Check availability first
    exec('dotnet-counters --version', { env }, (err) => {
        if (err) {
            monitorPanel?.webview.postMessage({
                command: 'dotnetCountersUnavailable',
                pid,
                installCmd: 'dotnet tool install --global dotnet-counters',
            });
            return;
        }
        const child = spawn('dotnet-counters', [
            'monitor', '--process-id', String(pid),
            '--format', 'json',
            '--counters', 'System.Runtime',
        ], { env });
        monCountersProcess = child;
        let buf = '';
        child.stdout?.on('data', (data: Buffer) => {
            buf += data.toString();
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
                const t = line.trim();
                if (!t.startsWith('{')) continue;
                const metrics = parseDotnetCounters(t);
                if (metrics) monitorPanel?.webview.postMessage({ command: 'dotnetCounters', pid, metrics });
            }
        });
        child.on('exit', () => {
            monCountersProcess = undefined;
            if (monSelectedPid === pid) monitorPanel?.webview.postMessage({ command: 'dotnetCountersStopped', pid });
        });
        child.on('error', () => {
            monitorPanel?.webview.postMessage({
                command: 'dotnetCountersUnavailable',
                pid,
                installCmd: 'dotnet tool install --global dotnet-counters',
            });
        });
    });
}

function monReadCpu(): { idle: number; total: number } | undefined {
    try {
        const fields = fs.readFileSync('/proc/stat', 'utf-8').split('\n')[0]
            .trim().split(/\s+/).slice(1).map(Number);
        const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
        return { idle, total: fields.reduce((s, v) => s + v, 0) };
    } catch { return undefined; }
}

function monReadMem(): { totalMB: number; usedMB: number } {
    try {
        const t = fs.readFileSync('/proc/meminfo', 'utf-8');
        const n = (k: string) => parseInt(t.match(new RegExp(k + ':\\s*(\\d+)'))?.[1] ?? '0', 10);
        return { totalMB: Math.round(n('MemTotal') / 1024), usedMB: Math.round((n('MemTotal') - n('MemAvailable')) / 1024) };
    } catch { return { totalMB: 0, usedMB: 0 }; }
}

function monReadDisk(): { r: number; w: number } {
    try {
        let r = 0, w = 0;
        for (const line of fs.readFileSync('/proc/diskstats', 'utf-8').split('\n')) {
            const p = line.trim().split(/\s+/);
            if (p.length < 14 || !/^(sd[a-z]|nvme\d+n\d+|vd[a-z]|hd[a-z])$/.test(p[2])) continue;
            r += parseInt(p[5], 10);
            w += parseInt(p[9], 10);
        }
        return { r: r * 512, w: w * 512 };
    } catch { return { r: 0, w: 0 }; }
}

function monReadNet(): { rx: number; tx: number } {
    try {
        let rx = 0, tx = 0;
        for (const line of fs.readFileSync('/proc/net/dev', 'utf-8').split('\n').slice(2)) {
            const colon = line.indexOf(':');
            if (colon < 0) continue;
            const iface = line.slice(0, colon).trim();
            if (iface === 'lo') continue;
            const parts = line.slice(colon + 1).trim().split(/\s+/);
            rx += parseInt(parts[0], 10) || 0;
            tx += parseInt(parts[8], 10) || 0;
        }
        return { rx, tx };
    } catch { return { rx: 0, tx: 0 }; }
}

function monCollectOs() {
    const now = Date.now();

    const cpu = monReadCpu();
    let cpuPct = -1;
    if (cpu && monPrevCpu) {
        const dt = cpu.total - monPrevCpu.total;
        const di = cpu.idle - monPrevCpu.idle;
        cpuPct = dt > 0 ? Math.max(0, Math.min(100, Math.round(100 * (dt - di) / dt))) : 0;
    }
    if (cpu) monPrevCpu = cpu;

    const mem = monReadMem();
    const memPct = mem.totalMB > 0 ? Math.round(100 * mem.usedMB / mem.totalMB) : -1;

    const disk = monReadDisk();
    let diskR = -1, diskW = -1;
    if (monPrevDisk) {
        const dt = (now - monPrevDisk.ts) / 1000;
        if (dt > 0) {
            diskR = Math.max(0, (disk.r - monPrevDisk.r) / 1024 / 1024 / dt);
            diskW = Math.max(0, (disk.w - monPrevDisk.w) / 1024 / 1024 / dt);
        }
    }
    monPrevDisk = { r: disk.r, w: disk.w, ts: now };

    const net = monReadNet();
    let netRx = -1, netTx = -1;
    if (monPrevNet) {
        const dt = (now - monPrevNet.ts) / 1000;
        if (dt > 0) {
            netRx = Math.max(0, (net.rx - monPrevNet.rx) / 1024 / 1024 / dt);
            netTx = Math.max(0, (net.tx - monPrevNet.tx) / 1024 / 1024 / dt);
        }
    }
    monPrevNet = { rx: net.rx, tx: net.tx, ts: now };

    return { cpuPct, memUsedMB: mem.usedMB, memTotalMB: mem.totalMB, memPct, diskR, diskW, netRx, netTx };
}

function monCollectDotnet(): Array<{ pid: number; name: string; memMB: number; threads: number }> {
    const result: Array<{ pid: number; name: string; memMB: number; threads: number }> = [];
    try {
        for (const e of fs.readdirSync('/proc', { withFileTypes: true })) {
            if (!e.isDirectory() || !/^\d+$/.test(e.name)) continue;
            const pid = parseInt(e.name, 10);
            try {
                const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim();
                if (!cmd.toLowerCase().includes('dotnet')) continue;
                const dll = cmd.split(' ').find(p => p.endsWith('.dll'));
                const name = dll ? path.basename(dll, '.dll') : 'dotnet';
                const status = fs.readFileSync(`/proc/${pid}/status`, 'utf-8');
                const vmRss  = parseInt(status.match(/VmRSS:\s*(\d+)/)?.[1]  ?? '0', 10);
                const threads = parseInt(status.match(/Threads:\s*(\d+)/)?.[1] ?? '0', 10);
                result.push({ pid, name, memMB: Math.round(vmRss / 1024), threads });
            } catch { /* process exited or no perms */ }
        }
    } catch { /* /proc not available */ }
    return result.sort((a, b) => b.memMB - a.memMB);
}

function monStartPolling(intervalMs: number): void {
    if (monitorTimer) clearInterval(monitorTimer);
    monitorTimer = setInterval(() => {
        if (!monitorPanel) { if (monitorTimer) clearInterval(monitorTimer); return; }
        monitorPanel.webview.postMessage({ command: 'metrics', os: monCollectOs(), dotnet: monCollectDotnet() });
    }, intervalMs);
}

async function monitor(): Promise<void> {
    if (monitorPanel) { monitorPanel.reveal(vscode.ViewColumn.One); return; }

    const nonce = getNonce();
    monitorPanel = vscode.window.createWebviewPanel(
        'openbase.monitor', 'Monitor',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
    );
    monitorPanel.onDidDispose(() => {
        if (monitorTimer) clearInterval(monitorTimer);
        monitorTimer = undefined;
        monPrevCpu = undefined; monPrevDisk = undefined; monPrevNet = undefined;
        stopMonCounters();
        monSelectedPid = undefined;
        monitorPanel = undefined;
    });
    monitorPanel.webview.html = buildMonitorHtml(nonce, monitorPanel.webview.cspSource);

    let intervalMs = 2000;
    monitorPanel.webview.onDidReceiveMessage((msg: { command: string; interval?: number; pid?: number }) => {
        if (msg.command === 'setInterval' && msg.interval) {
            intervalMs = msg.interval;
            if (monitorTimer !== undefined) monStartPolling(intervalMs);
        } else if (msg.command === 'pause') {
            if (monitorTimer) clearInterval(monitorTimer);
            monitorTimer = undefined;
        } else if (msg.command === 'resume') {
            monStartPolling(intervalMs);
        } else if (msg.command === 'selectProcess') {
            if (msg.pid === monSelectedPid) {
                stopMonCounters();
                monSelectedPid = undefined;
            } else if (msg.pid !== undefined) {
                monSelectedPid = msg.pid;
                startMonCounters(msg.pid);
            }
        }
    });

    monCollectOs(); // seed delta state
    monStartPolling(intervalMs);
}

function buildMonitorHtml(nonce: string, cspSource: string): string {
    void cspSource;
    return /* html */`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root{--bg1:var(--vscode-editor-background,#1e1e1e);--bg2:var(--vscode-sideBar-background,#252526);--border:var(--vscode-panel-border,rgba(128,128,128,.2));--text:var(--vscode-editor-foreground,#d4d4d4);--dim:var(--vscode-descriptionForeground,#858585);--purple:#b44fff;--green:#4ec994;--yellow:#e5c07b}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:var(--vscode-font-family,sans-serif);font-size:var(--vscode-font-size,13px);color:var(--text);background:var(--bg1);display:flex;flex-direction:column;height:100vh;overflow:hidden}
  .toolbar{display:flex;align-items:center;gap:6px;padding:5px 10px;background:var(--bg2);border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap}
  .btn{padding:2px 8px;font-size:11px;font-family:inherit;cursor:pointer;border:1px solid var(--border);background:var(--bg2);color:var(--text);border-radius:2px}
  .btn:hover{background:var(--purple);color:#fff;border-color:var(--purple)}
  select{background:var(--bg1);color:var(--text);border:1px solid var(--border);padding:2px 5px;font-size:11px;font-family:inherit;border-radius:2px;outline:none}
  .lbl{font-size:11px;color:var(--dim)}
  .badge-run{display:inline-block;font-size:10px;padding:1px 7px;border-radius:10px;background:var(--purple);color:#fff}
  .badge-pause{display:inline-block;font-size:10px;padding:1px 7px;border-radius:10px;border:1px solid var(--border);color:var(--dim)}
  .content{flex:1;overflow-y:auto;padding:10px}
  .section{margin-bottom:16px}
  .section-hdr{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:var(--dim);margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid var(--border)}
  .metric{display:flex;align-items:center;gap:8px;margin-bottom:7px}
  .m-lbl{font-size:11px;color:var(--dim);width:58px;flex-shrink:0}
  .bar-track{flex:1;height:6px;background:rgba(255,255,255,.08);border-radius:3px;overflow:hidden}
  .bar-fill{height:100%;border-radius:3px;transition:width .5s ease}
  .bar-cpu{background:var(--purple)}
  .bar-mem{background:var(--green)}
  .m-val{font-size:11px;min-width:90px;text-align:right;color:var(--text)}
  .io-row{display:flex;gap:6px;margin-top:4px}
  .io-box{flex:1;background:var(--bg2);border:1px solid var(--border);border-radius:3px;padding:5px 8px}
  .io-title{font-size:10px;color:var(--dim);margin-bottom:3px}
  .io-vals{display:flex;gap:8px;font-size:11px}
  .io-up::before{content:'↑ ';color:var(--purple)}
  .io-dn::before{content:'↓ ';color:var(--green)}
  .proc-row{display:flex;align-items:center;gap:6px;padding:5px 8px;margin-bottom:3px;background:var(--bg2);border:1px solid var(--border);border-radius:3px;cursor:pointer}
  .proc-row:hover{border-color:var(--purple)}
  .proc-row.selected{border-color:var(--purple);background:rgba(180,79,255,.08)}
  .proc-name{flex:1;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .proc-pid{font-size:10px;color:var(--dim)}
  .proc-tag{font-size:10px;padding:1px 5px;border-radius:3px;background:rgba(180,79,255,.15);color:var(--purple);white-space:nowrap}
  .empty{font-size:11px;color:var(--dim);font-style:italic}
  .gc-section{margin-top:10px;padding:10px;background:var(--bg2);border:1px solid var(--border);border-radius:4px}
  .gc-hdr{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:var(--dim);margin-bottom:8px}
  .gc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:6px}
  .gc-card{background:var(--bg1);border:1px solid var(--border);border-radius:3px;padding:6px 8px}
  .gc-name{font-size:10px;color:var(--dim);margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .gc-val{font-size:13px;font-weight:600;color:var(--text)}
  .gc-unavail{font-size:11px;color:var(--dim);font-style:italic}
  .gc-unavail code{font-family:var(--vscode-editor-font-family,monospace);font-size:10px;color:var(--purple)}
</style>
</head>
<body>
<div class="toolbar">
  <button id="tog" class="btn" onclick="toggle()">&#9646;&#9646; Pause</button>
  <span class="lbl">Every</span>
  <select id="ivl" onchange="chgInterval()">
    <option value="1000">1s</option>
    <option value="2000" selected>2s</option>
    <option value="5000">5s</option>
  </select>
  <span id="badge" class="badge-run">Running</span>
</div>
<div class="content">
  <div class="section">
    <div class="section-hdr">System</div>
    <div class="metric">
      <span class="m-lbl">CPU</span>
      <div class="bar-track"><div id="cpu-fill" class="bar-fill bar-cpu" style="width:0%"></div></div>
      <span id="cpu-val" class="m-val">--</span>
    </div>
    <div class="metric">
      <span class="m-lbl">Memory</span>
      <div class="bar-track"><div id="mem-fill" class="bar-fill bar-mem" style="width:0%"></div></div>
      <span id="mem-val" class="m-val">--</span>
    </div>
    <div class="io-row">
      <div class="io-box">
        <div class="io-title">Disk</div>
        <div class="io-vals"><span class="io-up" id="disk-w">--</span><span class="io-dn" id="disk-r">--</span></div>
      </div>
      <div class="io-box">
        <div class="io-title">Network</div>
        <div class="io-vals"><span class="io-up" id="net-tx">--</span><span class="io-dn" id="net-rx">--</span></div>
      </div>
    </div>
  </div>
  <div class="section">
    <div class="section-hdr">.NET Processes <span style="font-size:10px;font-weight:400;text-transform:none;letter-spacing:0;color:var(--dim)">(click to monitor GC)</span></div>
    <div id="dotnet-list"><span class="empty">No .NET processes detected</span></div>
    <div id="gc-section" style="display:none"></div>
  </div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  var paused = false;
  var selectedPid = null;

  function toggle() {
    paused = !paused;
    document.getElementById('tog').innerHTML = paused ? '&#9654; Resume' : '&#9646;&#9646; Pause';
    var b = document.getElementById('badge');
    b.className = paused ? 'badge-pause' : 'badge-run';
    b.textContent = paused ? 'Paused' : 'Running';
    vscode.postMessage({ command: paused ? 'pause' : 'resume' });
  }

  function chgInterval() {
    vscode.postMessage({ command: 'setInterval', interval: parseInt(document.getElementById('ivl').value, 10) });
  }

  function fmtMbs(v) {
    if (v < 0) return '--';
    if (v < 0.1) return (v * 1024).toFixed(0) + ' KB/s';
    return v.toFixed(1) + ' MB/s';
  }
  function fmtMb(v) {
    if (v < 0) return '--';
    return v >= 1024 ? (v / 1024).toFixed(1) + ' GB' : v + ' MB';
  }
  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/\x3c/g,'&lt;').replace(/>/g,'&gt;');
  }
  function fmtGcVal(name, v) {
    var n = name.toLowerCase();
    if (n.indexOf('memory') !== -1 || n.indexOf('bytes') !== -1) {
      var mb = v / 1048576;
      return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(1) + ' MB';
    }
    if (n.indexOf('ratio') !== -1 || n.indexOf('percent') !== -1) return v.toFixed(1) + '%';
    if (n.indexOf('time') !== -1 && v > 1000) return (v / 1000).toFixed(2) + ' s';
    if (Number.isInteger(v) || v > 100) return v.toFixed(0);
    return v.toFixed(2);
  }

  document.getElementById('dotnet-list').addEventListener('click', function(e) {
    var row = e.target.closest('.proc-row');
    if (!row) return;
    var pid = parseInt(row.dataset.pid, 10);
    vscode.postMessage({ command: 'selectProcess', pid: pid });
    if (selectedPid === pid) {
      selectedPid = null;
      row.classList.remove('selected');
      document.getElementById('gc-section').style.display = 'none';
    } else {
      selectedPid = pid;
      document.querySelectorAll('.proc-row').forEach(function(r) { r.classList.remove('selected'); });
      row.classList.add('selected');
      var gcSec = document.getElementById('gc-section');
      gcSec.style.display = 'block';
      gcSec.innerHTML = '<div class="gc-section"><div class="gc-hdr">GC / Runtime Metrics</div><span class="gc-unavail">Connecting…</span></div>';
    }
  });

  function renderGcMetrics(metrics) {
    var gcSec = document.getElementById('gc-section');
    gcSec.style.display = 'block';
    var keys = Object.keys(metrics).sort();
    var cards = keys.map(function(k) {
      return '<div class="gc-card"><div class="gc-name">' + esc(k) + '</div>' +
        '<div class="gc-val">' + esc(fmtGcVal(k, metrics[k])) + '</div></div>';
    }).join('');
    gcSec.innerHTML = '<div class="gc-section"><div class="gc-hdr">GC / Runtime Metrics (PID ' + selectedPid + ')</div><div class="gc-grid">' + cards + '</div></div>';
  }

  window.addEventListener('message', function(e) {
    var m = e.data;
    if (m.command === 'dotnetCounters') {
      if (m.pid === selectedPid) renderGcMetrics(m.metrics);
      return;
    }
    if (m.command === 'dotnetCountersUnavailable') {
      if (m.pid === selectedPid) {
        var gcSec = document.getElementById('gc-section');
        gcSec.style.display = 'block';
        gcSec.innerHTML = '<div class="gc-section"><div class="gc-hdr">GC / Runtime Metrics</div>' +
          '<span class="gc-unavail">dotnet-counters not found. Install: <code>' + esc(m.installCmd) + '</code></span></div>';
      }
      return;
    }
    if (m.command === 'dotnetCountersStopped') {
      if (m.pid === selectedPid) {
        var gcSec2 = document.getElementById('gc-section');
        if (gcSec2.style.display !== 'none') {
          gcSec2.innerHTML += '<span class="gc-unavail" style="display:block;margin-top:6px">Process exited</span>';
        }
        selectedPid = null;
      }
      return;
    }
    if (m.command !== 'metrics') return;
    var o = m.os;

    var cpuPct = o.cpuPct;
    document.getElementById('cpu-fill').style.width = (cpuPct >= 0 ? cpuPct : 0) + '%';
    document.getElementById('cpu-val').textContent = cpuPct >= 0 ? cpuPct + '%' : '--';

    var memPct = o.memPct;
    document.getElementById('mem-fill').style.width = (memPct >= 0 ? memPct : 0) + '%';
    document.getElementById('mem-val').textContent = memPct >= 0 ? fmtMb(o.memUsedMB) + ' / ' + fmtMb(o.memTotalMB) : '--';

    document.getElementById('disk-w').textContent = fmtMbs(o.diskW);
    document.getElementById('disk-r').textContent = fmtMbs(o.diskR);
    document.getElementById('net-tx').textContent = fmtMbs(o.netTx);
    document.getElementById('net-rx').textContent = fmtMbs(o.netRx);

    var procs = m.dotnet;
    var el = document.getElementById('dotnet-list');
    if (!procs || !procs.length) {
      el.innerHTML = '<span class="empty">No .NET processes detected</span>';
      return;
    }
    el.innerHTML = procs.map(function(p) {
      var sel = p.pid === selectedPid ? ' selected' : '';
      return '<div class="proc-row' + sel + '" data-pid="' + p.pid + '">' +
        '<span class="proc-name">' + esc(p.name) + '</span>' +
        '<span class="proc-pid">PID ' + p.pid + '</span>' +
        '<span class="proc-tag">' + p.memMB + ' MB</span>' +
        '<span class="proc-tag">' + p.threads + ' thr</span>' +
        '</div>';
    }).join('');
  });
</script>
</body></html>`;
}

// ─── migration runner ────────────────────────────────────────────────────────

type MigrationEngineType = 'efcore' | 'fluentmigrator';

interface MigrationInfo {
    id: string;
    applied: boolean | null; // null = no DB connection, status unknown
    label?: string;          // display name (FM uses class name, EF uses id)
    engine?: MigrationEngineType;
}

type MigrationStatus = 'migration-applied' | 'migration-pending' | 'migration-unknown' | 'migration-message';

let migrationScriptPanel: vscode.WebviewPanel | undefined;
let migrationRunnerEngine: MigrationEngineType = 'efcore';
let lastMigrations: MigrationInfo[] = [];

class MigrationItem extends vscode.TreeItem {
    constructor(
        public readonly info: MigrationInfo | null,
        public readonly status: MigrationStatus,
        label: string,
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.contextValue = status;
        if (status === 'migration-applied') {
            this.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
            this.description = info?.engine === 'fluentmigrator' ? `applied · FM` : 'applied';
        } else if (status === 'migration-pending') {
            this.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('list.warningForeground'));
            this.description = info?.engine === 'fluentmigrator' ? `pending · FM` : 'pending';
        } else if (status === 'migration-unknown') {
            this.iconPath = new vscode.ThemeIcon('question');
            this.description = 'no db connection';
        } else {
            this.iconPath = new vscode.ThemeIcon('info');
        }
    }
}

let migrationProvider: MigrationTreeProvider | undefined;

class MigrationTreeProvider implements vscode.TreeDataProvider<MigrationItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private items: MigrationItem[] = [];
    private treeView?: vscode.TreeView<MigrationItem>;
    private loading = false;

    setTreeView(tv: vscode.TreeView<MigrationItem>): void { this.treeView = tv; }

    getTreeItem(e: MigrationItem): vscode.TreeItem { return e; }

    getChildren(): MigrationItem[] { return this.items; }

    async refresh(): Promise<void> {
        if (this.loading) return;
        this.loading = true;
        if (this.treeView) this.treeView.message = 'Loading migrations…';
        this._onDidChangeTreeData.fire();

        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!cwd) {
            this.items = [new MigrationItem(null, 'migration-message', 'No workspace folder open')];
            if (this.treeView) { this.treeView.message = undefined; this.treeView.description = undefined; }
            this.loading = false;
            this._onDidChangeTreeData.fire();
            return;
        }

        try {
            const migrations = await listMigrations(cwd);
            lastMigrations = migrations;
            if (migrations.length === 0) {
                this.items = [new MigrationItem(null, 'migration-message', 'No migrations found')];
                if (this.treeView) this.treeView.description = undefined;
            } else {
                migrationRunnerEngine = migrations[0]?.engine ?? 'efcore';
                this.items = migrations.map(m => {
                    const status: MigrationStatus = m.applied === null
                        ? 'migration-unknown'
                        : m.applied ? 'migration-applied' : 'migration-pending';
                    return new MigrationItem(m, status, m.label ?? m.id);
                });
                const pending = migrations.filter(m => m.applied === false).length;
                if (this.treeView) {
                    const engineBadge = migrations[0]?.engine === 'fluentmigrator' ? ' · Fluent Migrator' : '';
                    this.treeView.description = pending > 0 ? `${pending} pending${engineBadge}` : engineBadge || undefined;
                }
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.items = [new MigrationItem(null, 'migration-message', `Error: ${msg}`)];
            if (this.treeView) this.treeView.description = undefined;
        }

        if (this.treeView) this.treeView.message = undefined;
        this.loading = false;
        this._onDidChangeTreeData.fire();
    }
}

function findMigrationsDir(cwd: string): string | undefined {
    function scan(dir: string, depth: number): string | undefined {
        if (depth > 6) return undefined;
        try {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'bin' || e.name === 'obj') continue;
                if (e.name === 'Migrations') {
                    const full = path.join(dir, e.name);
                    try {
                        if (fs.readdirSync(full).some(f => /^\d{14}_/.test(f) && f.endsWith('.cs') && !f.endsWith('Designer.cs'))) {
                            return full;
                        }
                    } catch { /* ignore */ }
                }
                const found = scan(path.join(dir, e.name), depth + 1);
                if (found) return found;
            }
        } catch { /* ignore */ }
    }
    return scan(cwd, 0);
}

function findMigrationProject(migrationsDir: string): string | undefined {
    const projectDir = path.dirname(migrationsDir);
    try {
        const csproj = fs.readdirSync(projectDir).find(f => f.endsWith('.csproj'));
        return csproj ? path.join(projectDir, csproj) : undefined;
    } catch { return undefined; }
}

function findEfStartupProject(cwd: string): string | undefined {
    function scan(dir: string, depth: number): string | undefined {
        if (depth > 5) return undefined;
        try {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (e.isFile() && e.name.endsWith('.csproj')) {
                    try {
                        const content = fs.readFileSync(path.join(dir, e.name), 'utf-8');
                        if (content.includes('Microsoft.EntityFrameworkCore.Design')) return path.join(dir, e.name);
                    } catch { /* ignore */ }
                }
                if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'bin' && e.name !== 'obj') {
                    const found = scan(path.join(dir, e.name), depth + 1);
                    if (found) return found;
                }
            }
        } catch { /* ignore */ }
    }
    return scan(cwd, 0);
}

function listMigrationsFromFs(migrationsDir: string): string[] {
    try {
        return fs.readdirSync(migrationsDir)
            .filter(f => /^\d{14}_/.test(f) && f.endsWith('.cs') && !f.endsWith('Designer.cs') && !f.endsWith('Snapshot.cs'))
            .sort()
            .map(f => f.replace(/\.cs$/, ''));
    } catch { return []; }
}

async function getAppliedMigrations(conn: DbConnection): Promise<Set<string>> {
    const extraPath = dotnetToolsPath();
    const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
    const tmpFile = path.join(os.tmpdir(), `ob_efmig_${Date.now()}.sql`);
    let cmd = '';
    try {
        switch (conn.type) {
            case 'sqlserver': {
                fs.writeFileSync(tmpFile, 'SELECT MigrationId FROM [dbo].[__EFMigrationsHistory]', 'utf-8');
                const parts = ['sqlcmd', `-S "${conn.server}"`, `-d "${conn.database}"`];
                if (conn.user)     parts.push(`-U "${conn.user}"`);
                if (conn.password) parts.push(`-P "${conn.password}"`);
                parts.push(`-i "${tmpFile}" -s "|" -W -h -1`);
                cmd = parts.join(' ');
                break;
            }
            case 'pgsql': {
                fs.writeFileSync(tmpFile, 'SELECT "MigrationId" FROM "__EFMigrationsHistory"', 'utf-8');
                const port = conn.port ?? '5432';
                const u = encodeURIComponent(conn.user ?? 'postgres');
                const p = encodeURIComponent(conn.password ?? '');
                cmd = `psql "postgresql://${u}:${p}@${conn.server}:${port}/${conn.database}" --csv -f "${tmpFile}"`;
                break;
            }
            default:
                return new Set();
        }
        const stdout = await new Promise<string>((resolve, reject) => {
            exec(cmd, { env, timeout: 10000 }, (err, out, stderr) => {
                if (err && !out) reject(new Error(stderr || err.message));
                else resolve(out);
            });
        });
        const applied = new Set<string>();
        for (const line of stdout.split('\n')) {
            const id = line.trim().replace(/^"|"$/g, '');
            if (id && !/^(MigrationId|-{2,}|\d+ rows?)/i.test(id)) applied.add(id);
        }
        return applied;
    } finally {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
}

async function listMigrations(cwd: string): Promise<MigrationInfo[]> {
    // Try EF Core first
    const migrationsDir = findMigrationsDir(cwd);
    if (migrationsDir) {
        const ids = listMigrationsFromFs(migrationsDir);
        if (ids.length === 0) return [];
        const conn = findConnection(cwd);
        if (!conn) return ids.map(id => ({ id, applied: null, engine: 'efcore' as MigrationEngineType }));
        try {
            const applied = await getAppliedMigrations(conn);
            return ids.map(id => ({ id, applied: applied.has(id), engine: 'efcore' as MigrationEngineType }));
        } catch {
            return ids.map(id => ({ id, applied: null, engine: 'efcore' as MigrationEngineType }));
        }
    }

    // Fallback: Fluent Migrator
    const fmDir = findFluentMigrationsDir(cwd);
    if (fmDir) {
        const fmMigs = listFmMigrationsFromFs(fmDir);
        if (fmMigs.length === 0) return [];
        const conn = findConnection(cwd);
        if (!conn) return fmMigs.map(m => ({ id: m.version, label: m.label, applied: null, engine: 'fluentmigrator' as MigrationEngineType }));
        try {
            const applied = await getAppliedFmMigrations(conn);
            return fmMigs.map(m => ({ id: m.version, label: m.label, applied: applied.has(m.version), engine: 'fluentmigrator' as MigrationEngineType }));
        } catch {
            return fmMigs.map(m => ({ id: m.version, label: m.label, applied: null, engine: 'fluentmigrator' as MigrationEngineType }));
        }
    }

    throw new Error('Nenhuma migration encontrada (EF Core ou Fluent Migrator).');
}

// ── Fluent Migrator helpers ──────────────────────────────────────────────────

function findFluentMigrationsDir(cwd: string): string | undefined {
    function scan(dir: string, depth: number): string | undefined {
        if (depth > 6) return undefined;
        try {
            const files = fs.readdirSync(dir, { withFileTypes: true });
            const hasAttr = files.some(e => {
                if (!e.isFile() || !e.name.endsWith('.cs')) return false;
                try { return /\[Migration\s*\(\s*\d+/.test(fs.readFileSync(path.join(dir, e.name), 'utf-8')); }
                catch { return false; }
            });
            if (hasAttr) return dir;
            for (const e of files) {
                if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'bin' && e.name !== 'obj') {
                    const found = scan(path.join(dir, e.name), depth + 1);
                    if (found) return found;
                }
            }
        } catch { /* ignore */ }
    }
    return scan(cwd, 0);
}

function listFmMigrationsFromFs(dir: string): Array<{ version: string; label: string }> {
    const result: Array<{ version: string; label: string; n: bigint }> = [];
    try {
        for (const file of fs.readdirSync(dir)) {
            if (!file.endsWith('.cs')) continue;
            try {
                const content = fs.readFileSync(path.join(dir, file), 'utf-8');
                const m = content.match(/\[Migration\s*\(\s*(\d+)/);
                if (m) result.push({ version: m[1], label: file.replace(/\.cs$/, ''), n: BigInt(m[1]) });
            } catch { /* ignore */ }
        }
    } catch { /* ignore */ }
    return result.sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0)).map(({ version, label }) => ({ version, label }));
}

async function getAppliedFmMigrations(conn: DbConnection): Promise<Set<string>> {
    const extraPath = dotnetToolsPath();
    const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
    const tmpFile = path.join(os.tmpdir(), `ob_fmmig_${Date.now()}.sql`);
    try {
        let cmd = '';
        switch (conn.type) {
            case 'sqlserver': {
                fs.writeFileSync(tmpFile, 'SELECT CAST(Version AS VARCHAR(50)) FROM VersionInfo', 'utf-8');
                const p = ['sqlcmd', `-S "${conn.server}"`, `-d "${conn.database}"`];
                if (conn.user)     p.push(`-U "${conn.user}"`);
                if (conn.password) p.push(`-P "${conn.password}"`);
                p.push(`-i "${tmpFile}" -s "|" -W -h -1`);
                cmd = p.join(' ');
                break;
            }
            case 'pgsql': {
                fs.writeFileSync(tmpFile, 'SELECT CAST("Version" AS VARCHAR) FROM "VersionInfo"', 'utf-8');
                const port = conn.port ?? '5432';
                const u = encodeURIComponent(conn.user ?? 'postgres');
                const p = encodeURIComponent(conn.password ?? '');
                cmd = `psql "postgresql://${u}:${p}@${conn.server}:${port}/${conn.database}" --csv -f "${tmpFile}"`;
                break;
            }
            default:
                return new Set();
        }
        const stdout = await new Promise<string>((resolve, reject) => {
            exec(cmd, { env, timeout: 10000 }, (err, out, stderr) => {
                if (err && !out) reject(new Error(stderr || err.message));
                else resolve(out);
            });
        });
        const applied = new Set<string>();
        for (const line of stdout.split('\n')) {
            const id = line.trim().replace(/^"|"$/g, '');
            if (id && !/^(Version|-{2,}|\d+ rows?)/i.test(id) && /^\d+$/.test(id)) applied.add(id);
        }
        return applied;
    } finally {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
}

function buildFmConnString(conn: DbConnection): string {
    switch (conn.type) {
        case 'sqlserver': return `Server=${conn.server};Database=${conn.database};${conn.user ? `User Id=${conn.user};Password=${conn.password ?? ''};` : 'Trusted_Connection=True;'}`;
        case 'pgsql':     return `Host=${conn.server};Port=${conn.port ?? '5432'};Database=${conn.database};Username=${conn.user ?? 'postgres'};Password=${conn.password ?? ''};`;
        case 'oracle':    return `Data Source=${conn.server};User Id=${conn.user};Password=${conn.password ?? ''};`;
    }
}

function fmProcessorName(conn: DbConnection): string {
    switch (conn.type) {
        case 'sqlserver': return 'SqlServer2016';
        case 'pgsql':     return 'Postgres';
        case 'oracle':    return 'Oracle';
    }
}

function findFmAssembly(fmDir: string): string | undefined {
    let dir = fmDir;
    for (let i = 0; i < 4; i++) {
        try {
            const csproj = fs.readdirSync(dir).find(f => f.endsWith('.csproj'));
            if (csproj) {
                const projName = path.basename(csproj, '.csproj');
                const binDir = path.join(dir, 'bin');
                const dll = findDllInDir(binDir, projName + '.dll', 0);
                if (dll) return dll;
            }
        } catch { /* ignore */ }
        dir = path.dirname(dir);
    }
}

function findDllInDir(dir: string, name: string, depth: number): string | undefined {
    if (depth > 4) return undefined;
    try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.isFile() && e.name === name) return path.join(dir, e.name);
            if (e.isDirectory()) {
                const found = findDllInDir(path.join(dir, e.name), name, depth + 1);
                if (found) return found;
            }
        }
    } catch { /* ignore */ }
}

function runFmMigrationCommand(cwd: string, targetVersion?: string, isDown = false): void {
    const conn = findConnection(cwd);
    if (!conn) { vscode.window.showErrorMessage('No database connection found.'); return; }
    const fmDir = findFluentMigrationsDir(cwd);
    const assembly = fmDir ? findFmAssembly(fmDir) : undefined;
    if (!assembly) {
        vscode.window.showErrorMessage('Could not find Fluent Migrator assembly. Build the project first.');
        return;
    }
    const connStr = buildFmConnString(conn);
    const processor = fmProcessorName(conn);
    const extraPath = dotnetToolsPath();
    const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
    const title = isDown ? `FM Rollback to ${targetVersion ?? '0'}` : `FM Migrate Up${targetVersion ? ` to ${targetVersion}` : ''}`;
    const channel = vscode.window.createOutputChannel(`OpenBase: ${title}`);
    channel.show(true);
    const args = ['fm', 'migrate',
        `--processor "${processor}"`,
        `--connectionString "${connStr.replace(/"/g, '\\"')}"`,
        `--assembly "${assembly}"`,
    ];
    if (targetVersion) args.push(`--target ${targetVersion}`);
    if (isDown) args.push('--task rollback');
    const child = exec(`dotnet ${args.join(' ')}`, { cwd, env, timeout: 120000 });
    child.stdout?.on('data', (d: string) => channel.append(d));
    child.stderr?.on('data', (d: string) => channel.append(d));
    child.on('close', (code) => {
        if (code === 0) {
            channel.appendLine('\nCompleted successfully.');
            vscode.window.showInformationMessage(`${title} completed.`);
        } else {
            channel.appendLine(`\nFailed (exit ${code}).`);
            vscode.window.showErrorMessage(`${title} failed. Check the output panel.`);
        }
        migrationProvider?.refresh();
    });
    child.on('error', (err) => {
        channel.appendLine(err.message);
        vscode.window.showErrorMessage(err.message);
        migrationProvider?.refresh();
    });
}

// ── Dry Run helpers ──────────────────────────────────────────────────────────

function buildMigrationScriptHtml(nonce: string, cspSource: string): string {
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%;display:flex;flex-direction:column;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);background:var(--vscode-editor-background);color:var(--vscode-foreground)}
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
  .header{display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--ob-border);background:linear-gradient(135deg,rgba(180,79,255,.18),rgba(255,63,164,.10));flex-shrink:0}
  .header-title{font-weight:600;font-size:13px;background:linear-gradient(90deg,var(--ob-purple),var(--ob-pink));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
  .header-sub{font-size:11px;color:var(--ob-dim)}
  .toolbar{display:flex;align-items:center;gap:8px;padding:5px 12px;border-bottom:1px solid var(--ob-border);background:var(--ob-bg1);flex-shrink:0}
  .btn{padding:4px 10px;border:none;cursor:pointer;font-family:inherit;font-size:inherit;border-radius:4px}
  .btn-secondary{background:rgba(180,79,255,.12);color:var(--ob-purple);border:1px solid var(--ob-border)}
  .btn-secondary:hover{background:rgba(180,79,255,.24)}
  .hint{font-size:11px;color:var(--ob-dim);margin-left:auto}
  .sql-wrap{flex:1;overflow:auto;padding:16px}
  pre{font-family:var(--vscode-editor-font-family,monospace);font-size:12px;line-height:1.6;white-space:pre;tab-size:2;color:var(--ob-text)}
  .kw{color:#c084fc;font-weight:600}
  .cmt{color:#4b3f6b;font-style:italic}
  .str{color:#f472b6}
  .num{color:#67e8f9}
  .loading{padding:20px;color:var(--ob-dim);font-size:12px;font-style:italic}
  .err-box{padding:12px;background:rgba(255,63,164,.10);border:1px solid rgba(255,63,164,.35);color:#ff90c0;font-size:12px;white-space:pre-wrap;font-family:monospace}
</style>
</head>
<body>
<div class="header">
  <span class="header-title">Migration Dry Run</span>
  <span id="subtitle" class="header-sub"></span>
</div>
<div class="toolbar">
  <button id="copy-btn" class="btn btn-secondary">Copy SQL</button>
  <button id="save-btn" class="btn btn-secondary">Save as Script&hellip;</button>
  <span id="line-count" class="hint"></span>
</div>
<div class="sql-wrap">
  <div class="loading" id="loading">Generating script&hellip;</div>
  <pre id="sql-view" style="display:none"></pre>
  <div id="err-view" class="err-box" style="display:none"></div>
</div>
<script nonce="${nonce}">
  var vscode = acquireVsCodeApi();
  var rawSql = '';
  document.getElementById('copy-btn').onclick = function() { if (rawSql) vscode.postMessage({ command: 'copy', sql: rawSql }); };
  document.getElementById('save-btn').onclick = function() { if (rawSql) vscode.postMessage({ command: 'save', sql: rawSql }); };
  window.addEventListener('message', function(e) {
    var m = e.data;
    if (m.command === 'load') {
      rawSql = m.sql || '';
      document.getElementById('loading').style.display = 'none';
      if (m.subtitle) document.getElementById('subtitle').textContent = m.subtitle;
      var pre = document.getElementById('sql-view');
      pre.innerHTML = highlight(rawSql);
      pre.style.display = '';
      document.getElementById('line-count').textContent = rawSql.split('\\n').length + ' lines';
    } else if (m.command === 'error') {
      document.getElementById('loading').style.display = 'none';
      var err = document.getElementById('err-view');
      err.textContent = m.text;
      err.style.display = '';
    }
  });
  function highlight(sql) {
    var s = esc(sql);
    s = s.replace(/(--[^\\n]*)/g, '\\x01$1\\x02');
    s = s.replace(/('[^']*')/g, '\\x03$1\\x04');
    s = s.replace(/\\b(GO|USE|BEGIN|COMMIT|ROLLBACK|EXEC|EXECUTE|CREATE|ALTER|DROP|TABLE|INDEX|VIEW|PROCEDURE|FUNCTION|TRIGGER|CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|KEY|DEFAULT|CHECK|REFERENCES|NOT|NULL|IF|ELSE|END|SET|ON|OFF|WITH|AS|SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|AND|OR|IN|EXISTS|CASE|WHEN|DECLARE|PRINT|ADD|COLUMN|IDENTITY|INT|BIGINT|VARCHAR|NVARCHAR|DATETIME|BIT|FLOAT|DECIMAL|NUMERIC|CHAR|TEXT|DATE|SMALLINT)\\b/gi, '\\x05$1\\x06');
    s = s.replace(/\\b(\\d+)\\b/g, '\\x07$1\\x08');
    return s
      .replace(/\\x01([\\s\\S]*?)\\x02/g, '\\x3cspan class="cmt">$1\\x3c/span>')
      .replace(/\\x03([\\s\\S]*?)\\x04/g, '\\x3cspan class="str">$1\\x3c/span>')
      .replace(/\\x05([\\s\\S]*?)\\x06/g, '\\x3cspan class="kw">$1\\x3c/span>')
      .replace(/\\x07([\\s\\S]*?)\\x08/g, '\\x3cspan class="num">$1\\x3c/span>');
  }
  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/\\x3c/g,'&lt;').replace(/\\x3e/g,'&gt;');
  }
</script>
</body>
</html>`;
}

async function showMigrationScript(cwd: string, fromId?: string, toId?: string): Promise<void> {
    const migrationsDir = findMigrationsDir(cwd);
    const project = migrationsDir ? findMigrationProject(migrationsDir) : undefined;
    const extraPath = dotnetToolsPath();
    const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };

    const nonce = getNonce();

    if (migrationScriptPanel) {
        migrationScriptPanel.reveal(vscode.ViewColumn.Beside);
    } else {
        migrationScriptPanel = vscode.window.createWebviewPanel(
            'openbase.migrationScript', 'Migration Dry Run', vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        migrationScriptPanel.onDidDispose(() => { migrationScriptPanel = undefined; });
        migrationScriptPanel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === 'copy') {
                await vscode.env.clipboard.writeText(msg.sql);
                vscode.window.showInformationMessage('SQL copied to clipboard.');
            }
            if (msg.command === 'save') {
                const scriptsDir = getScriptsDir();
                if (!scriptsDir) { vscode.window.showErrorMessage('No workspace folder open.'); return; }
                const name = await vscode.window.showInputBox({
                    prompt: 'Save migration script as',
                    placeHolder: 'migration-script',
                    validateInput: v => v?.trim() && /^[^\\/:\*\?"<>\|]+$/.test(v.trim()) ? undefined : 'Invalid name',
                });
                if (!name?.trim()) return;
                const safeName = name.trim().replace(/\.sql$/i, '') + '.sql';
                fs.mkdirSync(scriptsDir, { recursive: true });
                fs.writeFileSync(path.join(scriptsDir, safeName), msg.sql, 'utf-8');
                vscode.window.showInformationMessage(`Saved: ${safeName}`);
                sqlScriptProvider?.refresh();
            }
        });
    }

    migrationScriptPanel.webview.html = buildMigrationScriptHtml(nonce, migrationScriptPanel.webview.cspSource);

    const startupProject = findEfStartupProject(cwd);
    const args: string[] = ['ef', 'migrations', 'script'];
    let subtitle = 'all pending (idempotent)';
    if (fromId !== undefined && toId !== undefined) {
        args.push(fromId, toId);
        subtitle = `${fromId || '0'} → ${toId}`;
    } else {
        args.push('--idempotent');
    }
    if (project) args.push('--project', `"${project}"`);
    if (startupProject) args.push('--startup-project', `"${startupProject}"`);

    exec(`dotnet ${args.join(' ')}`, { cwd, env, timeout: 60000 }, (err, stdout, stderr) => {
        if (err && !stdout) {
            migrationScriptPanel?.webview.postMessage({ command: 'error', text: stderr || err.message });
        } else {
            migrationScriptPanel?.webview.postMessage({ command: 'load', sql: stdout, subtitle });
        }
    });
}

function runMigrationCommand(cwd: string, efArgs: string[], title: string): void {
    const channel = vscode.window.createOutputChannel(`OpenBase: ${title}`);
    channel.show(true);
    const extraPath = dotnetToolsPath();
    const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
    const migrationsDir = findMigrationsDir(cwd);
    const project = migrationsDir ? findMigrationProject(migrationsDir) : undefined;
    const startupProject = findEfStartupProject(cwd);
    const args = [...efArgs];
    if (project) args.push('--project', `"${project}"`);
    if (startupProject) args.push('--startup-project', `"${startupProject}"`);
    const child = exec(`dotnet ${args.join(' ')}`, { cwd, env, timeout: 120000 });
    child.stdout?.on('data', (d: string) => channel.append(d));
    child.stderr?.on('data', (d: string) => channel.append(d));
    child.on('close', (code) => {
        if (code === 0) {
            channel.appendLine('\nCompleted successfully.');
            vscode.window.showInformationMessage(`${title} completed.`);
        } else {
            channel.appendLine(`\nFailed (exit ${code}).`);
            vscode.window.showErrorMessage(`${title} failed. Check the output panel.`);
        }
        migrationProvider?.refresh();
    });
    child.on('error', (err) => {
        channel.appendLine(err.message);
        vscode.window.showErrorMessage(err.message);
        migrationProvider?.refresh();
    });
}

function setupMigrationRunner(context: vscode.ExtensionContext): void {
    migrationProvider = new MigrationTreeProvider();

    const tv = vscode.window.createTreeView('openbase.migrationrunner.migrations', {
        treeDataProvider: migrationProvider,
        showCollapseAll: false,
    });
    migrationProvider.setTreeView(tv);
    context.subscriptions.push(tv);

    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => migrationProvider?.refresh()),

        vscode.commands.registerCommand('openbase.migrationRunner.refresh',
            () => migrationProvider?.refresh()),

        vscode.commands.registerCommand('openbase.migrationRunner.migrateUp', async () => {
            const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!cwd) { vscode.window.showErrorMessage('No workspace folder open.'); return; }
            const confirmed = await vscode.window.showWarningMessage(
                'Apply all pending migrations?', { modal: true }, 'Apply');
            if (confirmed !== 'Apply') return;
            if (migrationRunnerEngine === 'fluentmigrator') {
                runFmMigrationCommand(cwd);
            } else {
                runMigrationCommand(cwd, ['ef', 'database', 'update'], 'Migrate Up');
            }
        }),

        vscode.commands.registerCommand('openbase.migrationRunner.migrateTo',
            async (item: MigrationItem) => {
                if (!item.info) return;
                const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!cwd) return;
                const isDown = item.status === 'migration-applied';
                const label = item.info.label ?? item.info.id;
                const action = isDown
                    ? await vscode.window.showWarningMessage(
                        `Revert to "${label}"?`,
                        { modal: true, detail: 'Down() migrations will run for every version applied after this point. This may cause irreversible data loss.' },
                        'Revert')
                    : await vscode.window.showInformationMessage(
                        `Apply migrations up to "${label}"?`, { modal: true }, 'Apply');
                if (!action) return;
                const verb = isDown ? 'Migrate Down to' : 'Migrate Up to';
                if (migrationRunnerEngine === 'fluentmigrator') {
                    runFmMigrationCommand(cwd, item.info.id, isDown);
                } else {
                    runMigrationCommand(cwd, ['ef', 'database', 'update', item.info.id], `${verb} ${label}`);
                }
            }),

        vscode.commands.registerCommand('openbase.migrationRunner.dryRun', async () => {
            const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!cwd) { vscode.window.showErrorMessage('No workspace folder open.'); return; }
            if (migrationRunnerEngine === 'fluentmigrator') {
                vscode.window.showInformationMessage('Dry Run not supported for Fluent Migrator.');
                return;
            }
            await showMigrationScript(cwd);
        }),

        vscode.commands.registerCommand('openbase.migrationRunner.dryRunTo',
            async (item: MigrationItem) => {
                if (!item.info) return;
                const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!cwd) return;
                if (migrationRunnerEngine === 'fluentmigrator') {
                    vscode.window.showInformationMessage('Dry Run not supported for Fluent Migrator.');
                    return;
                }
                const idx = lastMigrations.findIndex(m => m.id === item.info!.id);
                const prevId = idx > 0 ? lastMigrations[idx - 1].id : '0';
                const isDown = item.status === 'migration-applied';
                if (isDown) {
                    // Show Down script: from this to previous
                    const nextIdx = lastMigrations.findIndex(m => m.id === item.info!.id);
                    const nextId = nextIdx < lastMigrations.length - 1 ? lastMigrations[nextIdx + 1].id : item.info.id;
                    await showMigrationScript(cwd, nextId, item.info.id);
                } else {
                    await showMigrationScript(cwd, prevId, item.info.id);
                }
            }),
    );
}

// ─── dependency inspector ────────────────────────────────────────────────────

interface PackageRef {
    name: string;
    version: string;
    latest?: string;
}

interface ProjectPackages {
    project: string;
    projectPath: string;
    packages: PackageRef[];
}

function parseDotnetListJson(stdout: string): ProjectPackages[] {
    if (!stdout.trim()) return [];
    try {
        const json = JSON.parse(stdout) as {
            projects?: Array<{
                path: string;
                frameworks?: Array<{
                    topLevelPackages?: Array<{
                        id: string;
                        resolvedVersion?: string;
                        requestedVersion?: string;
                        latestVersion?: string;
                    }>;
                }>;
            }>;
        };
        const result: ProjectPackages[] = [];
        for (const proj of json.projects ?? []) {
            const pkgMap = new Map<string, PackageRef>();
            for (const fw of proj.frameworks ?? []) {
                for (const pkg of fw.topLevelPackages ?? []) {
                    if (!pkgMap.has(pkg.id)) {
                        pkgMap.set(pkg.id, {
                            name: pkg.id,
                            version: pkg.resolvedVersion ?? pkg.requestedVersion ?? '?',
                            latest: pkg.latestVersion,
                        });
                    } else if (pkg.latestVersion && !pkgMap.get(pkg.id)!.latest) {
                        pkgMap.get(pkg.id)!.latest = pkg.latestVersion;
                    }
                }
            }
            if (pkgMap.size > 0) {
                result.push({
                    project: path.basename(proj.path, '.csproj'),
                    projectPath: proj.path,
                    packages: [...pkgMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
                });
            }
        }
        return result;
    } catch {
        return [];
    }
}

let depData: ProjectPackages[] = [];
let depShowOnlyOutdated = false;
let depProvider: DepInspectorProvider | undefined;

async function loadDependencies(cwd: string): Promise<ProjectPackages[]> {
    const extraPath = dotnetToolsPath();
    const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
    const run = (args: string) => new Promise<string>(resolve => {
        exec(`dotnet list package ${args} --format json`, { cwd, env, timeout: 60000 }, (err, stdout) => {
            resolve(err && !stdout ? '' : stdout);
        });
    });
    const [allOut, outdatedOut] = await Promise.all([run(''), run('--outdated')]);
    const allPkgs = parseDotnetListJson(allOut);
    const outdatedPkgs = parseDotnetListJson(outdatedOut);
    const outdatedMap = new Map<string, string>();
    for (const proj of outdatedPkgs) {
        for (const pkg of proj.packages) {
            if (pkg.latest) outdatedMap.set(`${proj.project}::${pkg.name}`, pkg.latest);
        }
    }
    for (const proj of allPkgs) {
        for (const pkg of proj.packages) {
            const latest = outdatedMap.get(`${proj.project}::${pkg.name}`);
            if (latest) pkg.latest = latest;
        }
    }
    return allPkgs;
}

class DepPackageItem extends vscode.TreeItem {
    constructor(
        public readonly pkg: PackageRef,
        public readonly projectPath: string,
    ) {
        super(pkg.name, vscode.TreeItemCollapsibleState.None);
        const outdated = !!pkg.latest;
        this.contextValue = outdated ? 'dep-outdated' : 'dep-uptodate';
        this.description = outdated ? `${pkg.version}  →  ${pkg.latest}` : pkg.version;
        this.iconPath = new vscode.ThemeIcon(
            outdated ? 'arrow-circle-up' : 'pass-filled',
            new vscode.ThemeColor(outdated ? 'list.warningForeground' : 'testing.iconPassed'),
        );
        this.tooltip = outdated
            ? `Update available: ${pkg.version} → ${pkg.latest}`
            : `Up to date: ${pkg.version}`;
    }
}

class DepProjectItem extends vscode.TreeItem {
    constructor(public readonly proj: ProjectPackages) {
        super(proj.project, vscode.TreeItemCollapsibleState.Expanded);
        const outdatedCount = proj.packages.filter(p => p.latest).length;
        this.contextValue = outdatedCount > 0 ? 'dep-project-outdated' : 'dep-project';
        this.description = outdatedCount > 0
            ? `${outdatedCount} outdated`
            : `${proj.packages.length} up to date`;
        this.iconPath = new vscode.ThemeIcon(
            outdatedCount > 0 ? 'warning' : 'pass',
            new vscode.ThemeColor(outdatedCount > 0 ? 'list.warningForeground' : 'testing.iconPassed'),
        );
        this.tooltip = proj.projectPath;
    }
}

class DepInspectorProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private loading = false;

    constructor(private readonly cwd: string) {}

    refresh(): void {
        this.loading = true;
        this._onDidChangeTreeData.fire(undefined);
        loadDependencies(this.cwd).then(data => {
            depData = data;
            this.loading = false;
            this._onDidChangeTreeData.fire(undefined);
        });
    }

    refreshView(): void { this._onDidChangeTreeData.fire(undefined); }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

    getChildren(element?: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem[]> {
        if (!element) {
            if (this.loading) {
                const item = new vscode.TreeItem('Loading packages…');
                item.iconPath = new vscode.ThemeIcon('loading~spin');
                return [item];
            }
            if (!depData.length) {
                return [new vscode.TreeItem('No packages found — open a .NET workspace')];
            }
            return depData
                .filter(p => !depShowOnlyOutdated || p.packages.some(pkg => pkg.latest))
                .map(p => new DepProjectItem(p));
        }
        if (element instanceof DepProjectItem) {
            const pkgs = depShowOnlyOutdated
                ? element.proj.packages.filter(p => p.latest)
                : element.proj.packages;
            return pkgs.map(p => new DepPackageItem(p, element.proj.projectPath));
        }
        return [];
    }
}

function setupDepInspector(context: vscode.ExtensionContext): void {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return;

    depProvider = new DepInspectorProvider(cwd);

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('openbase.depinspector.packages', depProvider),

        vscode.commands.registerCommand('openbase.dependencyInspector.refresh', () =>
            depProvider?.refresh()),

        vscode.commands.registerCommand('openbase.dependencyInspector.toggleFilter', () => {
            depShowOnlyOutdated = !depShowOnlyOutdated;
            depProvider?.refreshView();
        }),

        vscode.commands.registerCommand('openbase.dependencyInspector.update', (item: DepPackageItem) => {
            if (!(item instanceof DepPackageItem) || !item.pkg.latest) return;
            const projDir = path.isAbsolute(item.projectPath)
                ? path.dirname(item.projectPath)
                : path.dirname(path.join(cwd, item.projectPath));
            const extraPath = dotnetToolsPath();
            const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
            const out = vscode.window.createOutputChannel('OpenBase Dependencies');
            out.show(true);
            out.appendLine(`Updating ${item.pkg.name} → ${item.pkg.latest}…`);
            exec(`dotnet add package "${item.pkg.name}" --version "${item.pkg.latest}"`,
                { cwd: projDir, env, timeout: 120000 },
                (err, stdout, stderr) => {
                    if (err) out.appendLine(`Error: ${stderr || err.message}`);
                    else { out.appendLine(stdout.trim()); out.appendLine('Done.'); }
                    depProvider?.refresh();
                });
        }),

        vscode.commands.registerCommand('openbase.dependencyInspector.updateAll', async () => {
            const outdated = depData.flatMap(proj =>
                proj.packages.filter(p => p.latest).map(p => ({ pkg: p, projectPath: proj.projectPath }))
            );
            if (!outdated.length) {
                vscode.window.showInformationMessage('All packages are up to date!');
                return;
            }
            const confirm = await vscode.window.showWarningMessage(
                `Update ${outdated.length} outdated package(s)?`,
                { modal: true }, 'Update All',
            );
            if (confirm !== 'Update All') return;
            const extraPath = dotnetToolsPath();
            const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
            const out = vscode.window.createOutputChannel('OpenBase Dependencies');
            out.show(true);
            for (const { pkg, projectPath } of outdated) {
                if (!pkg.latest) continue;
                const projDir = path.isAbsolute(projectPath)
                    ? path.dirname(projectPath)
                    : path.dirname(path.join(cwd, projectPath));
                out.appendLine(`\nUpdating ${pkg.name} → ${pkg.latest}…`);
                await new Promise<void>(resolve => {
                    exec(`dotnet add package "${pkg.name}" --version "${pkg.latest}"`,
                        { cwd: projDir, env, timeout: 120000 },
                        (err, stdout, stderr) => {
                            if (err) out.appendLine(`Error: ${stderr || err.message}`);
                            else out.appendLine(stdout.trim());
                            resolve();
                        });
                });
            }
            out.appendLine('\nAll updates complete.');
            depProvider?.refresh();
        }),
    );

    depProvider.refresh();
}

// ─── endpoints map ───────────────────────────────────────────────────────────

const HTTP_METHODS = ['Get', 'Post', 'Put', 'Delete', 'Patch', 'Head', 'Options'] as const;
type HttpMethod = typeof HTTP_METHODS[number];

interface EndpointInfo {
    method: HttpMethod;
    route: string;
    action: string;
    controller: string;
}

const METHOD_BADGE: Record<HttpMethod, string> = {
    Get: 'GET', Post: 'POST', Put: 'PUT', Delete: 'DEL',
    Patch: 'PATCH', Head: 'HEAD', Options: 'OPT',
};

class EndpointGroupItem extends vscode.TreeItem {
    constructor(readonly label: string, readonly endpoints: EndpointInfo[]) {
        super(label, vscode.TreeItemCollapsibleState.Expanded);
        this.iconPath = new vscode.ThemeIcon('symbol-class');
        this.contextValue = 'endpointGroup';
    }
}

class EndpointItem extends vscode.TreeItem {
    constructor(readonly endpoint: EndpointInfo) {
        super(`[${METHOD_BADGE[endpoint.method]}] ${endpoint.route}`, vscode.TreeItemCollapsibleState.None);
        this.description = endpoint.action;
        this.tooltip = `${endpoint.method} ${endpoint.route}`;
        this.contextValue = 'endpoint';
        this.command = {
            command: 'openbase.endpointsMap.open',
            title: 'Open in HTTP Runner',
            arguments: [this],
        };
        const iconMap: Record<HttpMethod, string> = {
            Get: 'arrow-down', Post: 'arrow-up', Put: 'edit', Delete: 'trash',
            Patch: 'diff-modified', Head: 'eye', Options: 'settings-gear',
        };
        this.iconPath = new vscode.ThemeIcon(iconMap[endpoint.method]);
    }
}

function scanEndpoints(cwd: string): EndpointInfo[] {
    const results: EndpointInfo[] = [];

    const csFiles: string[] = [];
    function walk(dir: string): void {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.isDirectory()) {
                if (['bin', 'obj', 'node_modules', '.git'].includes(e.name)) continue;
                walk(path.join(dir, e.name));
            } else if (e.isFile() && e.name.endsWith('.cs')) {
                csFiles.push(path.join(dir, e.name));
            }
        }
    }
    walk(cwd);

    for (const file of csFiles) {
        let src: string;
        try { src = fs.readFileSync(file, 'utf-8'); } catch { continue; }

        // MVC Controllers
        const classMatch = src.match(/\bclass\s+(\w+Controller)\b/);
        if (classMatch) {
            const controllerName = classMatch[1].replace(/Controller$/, '');
            const baseRouteMatch = src.match(/\[Route\(\s*["']([^"']+)["']/);
            const baseRoute = baseRouteMatch
                ? baseRouteMatch[1].replace('[controller]', controllerName.toLowerCase())
                : controllerName.toLowerCase();

            for (const m of HTTP_METHODS) {
                const re = new RegExp(`\\[Http${m}(?:\\(\\s*["']([^"']*)["']\\s*\\))?\\]\\s*(?:\\[[^\\]]*\\]\\s*)*(?:public\\s+[\\w<>\\[\\],\\s]+\\s+(\\w+)\\s*\\()`, 'g');
                let match: RegExpExecArray | null;
                while ((match = re.exec(src)) !== null) {
                    const sub = match[1] ?? '';
                    const action = match[2] ?? '';
                    const route = ('/' + [baseRoute, sub].filter(Boolean).join('/')).replace(/\/+/g, '/');
                    results.push({ method: m, route, action, controller: controllerName });
                }
            }
        }

        // Minimal APIs
        const minimalRe = /app\.Map(Get|Post|Put|Delete|Patch)\(\s*["']([^"']+)["']/g;
        let mm: RegExpExecArray | null;
        while ((mm = minimalRe.exec(src)) !== null) {
            const method = mm[1] as HttpMethod;
            const route = mm[2].startsWith('/') ? mm[2] : '/' + mm[2];
            const fileName = path.basename(file, '.cs');
            results.push({ method, route, action: '', controller: fileName });
        }
    }

    return results;
}

let endpointsProvider: EndpointsMapProvider | undefined;

class EndpointsMapProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private data: EndpointInfo[] = [];

    constructor(private readonly cwd: string) {}

    refresh(): void {
        this.data = scanEndpoints(this.cwd);
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(e: vscode.TreeItem): vscode.TreeItem { return e; }

    getChildren(element?: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem[]> {
        if (!element) {
            if (!this.data.length) {
                return [new vscode.TreeItem('No endpoints found — open a .NET workspace')];
            }
            const groups = new Map<string, EndpointInfo[]>();
            for (const ep of this.data) {
                const list = groups.get(ep.controller) ?? [];
                list.push(ep);
                groups.set(ep.controller, list);
            }
            return [...groups.entries()].map(([name, eps]) => new EndpointGroupItem(name, eps));
        }
        if (element instanceof EndpointGroupItem) {
            return element.endpoints.map(ep => new EndpointItem(ep));
        }
        return [];
    }
}

function setupEndpointsMap(context: vscode.ExtensionContext): void {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return;

    endpointsProvider = new EndpointsMapProvider(cwd);

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.cs');
    context.subscriptions.push(
        watcher,
        watcher.onDidChange(() => endpointsProvider?.refresh()),
        watcher.onDidCreate(() => endpointsProvider?.refresh()),
        watcher.onDidDelete(() => endpointsProvider?.refresh()),
    );

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('openbase.httprunner.endpoints', endpointsProvider),

        vscode.commands.registerCommand('openbase.endpointsMap.refresh', () =>
            endpointsProvider?.refresh()),

        vscode.commands.registerCommand('openbase.endpointsMap.open', async (item: EndpointItem) => {
            if (!(item instanceof EndpointItem)) return;
            const { method, route } = item.endpoint;
            const data: HttpRequestData = { method: method.toUpperCase(), url: '{{LOCAL_URL}}' + route };
            if (httpPanel) {
                httpPanel.reveal(vscode.ViewColumn.One);
                httpPanel.webview.postMessage({ command: 'loadRequest', ...data });
            } else {
                httpPendingRequest = data;
                await httpRunner();
            }
        }),
    );

    endpointsProvider.refresh();
}

// ─── solution explorer ───────────────────────────────────────────────────────

type SolutionNodeKind = 'solution' | 'solutionFolder' | 'project' | 'folder' | 'file';

const SE_SOLUTION_FOLDER_TYPE = '2150E333-8FDC-42A3-9474-1A3956D46DE8';

const SE_IGNORED_DIRS = new Set(['bin', 'obj', 'node_modules', '.git', '.vs', '.idea']);

const SE_FILE_ICONS: Record<string, string> = {
    '.cs':   'symbol-class',
    '.csx':  'symbol-class',
    '.json': 'bracket',
    '.xml':  'code',
    '.http': 'globe',
    '.rest': 'globe',
    '.sql':  'database',
    '.md':   'book',
    '.ts':   'symbol-variable',
    '.js':   'symbol-variable',
    '.yaml': 'list-tree',
    '.yml':  'list-tree',
    '.env':  'lock',
    '.txt':  'file-text',
    '.sh':   'terminal',
    '.ps1':  'terminal',
};

class SolutionNode extends vscode.TreeItem {
    public slnChildren: SolutionNode[] = [];

    constructor(
        public readonly fsPath: string,
        public readonly kind: SolutionNodeKind,
        label?: string,
    ) {
        super(
            label ?? path.basename(fsPath),
            kind === 'solution' ? vscode.TreeItemCollapsibleState.Expanded
                : kind === 'file' ? vscode.TreeItemCollapsibleState.None
                : vscode.TreeItemCollapsibleState.Collapsed,
        );
        this.contextValue = kind;

        switch (kind) {
            case 'solution':
                this.iconPath = new vscode.ThemeIcon('layers');
                this.tooltip = fsPath;
                this.resourceUri = vscode.Uri.file(fsPath);
                break;
            case 'solutionFolder':
                this.iconPath = vscode.ThemeIcon.Folder;
                this.tooltip = label;
                break;
            case 'project':
                this.iconPath = new vscode.ThemeIcon('symbol-namespace');
                this.description = '.csproj';
                this.tooltip = fsPath;
                this.resourceUri = vscode.Uri.file(fsPath);
                break;
            case 'folder':
                this.iconPath = vscode.ThemeIcon.Folder;
                this.tooltip = fsPath;
                this.resourceUri = vscode.Uri.file(fsPath);
                break;
            case 'file':
                this.iconPath = new vscode.ThemeIcon(
                    SE_FILE_ICONS[path.extname(fsPath).toLowerCase()] ?? 'file',
                );
                this.tooltip = fsPath;
                this.resourceUri = vscode.Uri.file(fsPath);
                this.command = {
                    command: 'vscode.open',
                    title: 'Open File',
                    arguments: [vscode.Uri.file(fsPath)],
                };
                break;
        }
    }
}

function buildSlnChildren(slnPath: string): SolutionNode[] {
    let content: string;
    try { content = fs.readFileSync(slnPath, 'utf-8'); } catch { return []; }
    const slnDir = path.dirname(slnPath);

    // Parse all Project(...) = "name", "path", "{guid}" entries
    const nodeMap = new Map<string, SolutionNode>();
    const order: string[] = [];
    const re = /^Project\("\{([^}]+)\}"\)\s*=\s*"([^"]+)",\s*"([^"]+)",\s*"\{([^}]+)\}"/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        const typeGuid = m[1].toUpperCase();
        const name = m[2];
        const entryPath = m[3];
        const guid = m[4].toUpperCase();
        let node: SolutionNode;
        if (typeGuid === SE_SOLUTION_FOLDER_TYPE) {
            node = new SolutionNode('', 'solutionFolder', name);
        } else {
            const csprojPath = path.resolve(slnDir, entryPath.replace(/\\/g, path.sep));
            if (!fs.existsSync(csprojPath)) continue;
            node = new SolutionNode(csprojPath, 'project', name);
        }
        nodeMap.set(guid, node);
        order.push(guid);
    }

    // Parse GlobalSection(NestedProjects): child GUID = parent GUID
    const nested = new Map<string, string>();
    const nestedMatch = content.match(/GlobalSection\(NestedProjects\)\s*=\s*preSolution([\s\S]*?)EndGlobalSection/);
    if (nestedMatch) {
        const nestedRe = /\{([^}]+)\}\s*=\s*\{([^}]+)\}/g;
        let nm: RegExpExecArray | null;
        while ((nm = nestedRe.exec(nestedMatch[1])) !== null) {
            nested.set(nm[1].toUpperCase(), nm[2].toUpperCase());
        }
    }

    // Attach children to solution folder nodes; collect top-level nodes
    const topLevel: SolutionNode[] = [];
    for (const guid of order) {
        const node = nodeMap.get(guid);
        if (!node) continue;
        const parentGuid = nested.get(guid);
        const parent = parentGuid ? nodeMap.get(parentGuid) : undefined;
        if (parent) {
            parent.slnChildren.push(node);
        } else {
            topLevel.push(node);
        }
    }
    return topLevel;
}

function seWalkDir(dir: string): SolutionNode[] {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    const folders = entries
        .filter(e => e.isDirectory() && !SE_IGNORED_DIRS.has(e.name))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(e => new SolutionNode(path.join(dir, e.name), 'folder'));
    const files = entries
        .filter(e => e.isFile())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(e => new SolutionNode(path.join(dir, e.name), 'file'));
    return [...folders, ...files];
}

let solutionExplorerProvider: SolutionExplorerProvider | undefined;

class SolutionExplorerDecorationProvider implements vscode.FileDecorationProvider {
    private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<undefined>();
    readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

    notifyChanged(): void { this._onDidChangeFileDecorations.fire(undefined); }

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (!uri.fsPath.endsWith('.csproj')) return undefined;

        const projDir = path.dirname(uri.fsPath) + path.sep;
        let errorCount = 0;
        for (const [fileUri, diags] of vscode.languages.getDiagnostics()) {
            if (!fileUri.fsPath.startsWith(projDir)) continue;
            errorCount += diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
        }

        if (errorCount === 0) return undefined;

        return {
            badge: errorCount >= 100 ? '!!' : String(errorCount),
            tooltip: `${errorCount} erro${errorCount !== 1 ? 's' : ''} de build`,
            color: new vscode.ThemeColor('list.errorForeground'),
        };
    }
}

class SolutionExplorerProvider implements vscode.TreeDataProvider<SolutionNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SolutionNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly cwd: string) {}

    refresh(): void { this._onDidChangeTreeData.fire(); }

    getTreeItem(e: SolutionNode): vscode.TreeItem { return e; }

    getChildren(element?: SolutionNode): vscode.ProviderResult<SolutionNode[]> {
        if (!element) return this._roots();
        if (element.kind === 'solution') return this._projectsFromSln(element.fsPath);
        if (element.kind === 'solutionFolder') return element.slnChildren;
        if (element.kind === 'project') return seWalkDir(path.dirname(element.fsPath));
        if (element.kind === 'folder') return seWalkDir(element.fsPath);
        return [];
    }

    private _roots(): SolutionNode[] {
        let slnFiles: string[] = [];
        try {
            slnFiles = fs.readdirSync(this.cwd)
                .filter(f => f.endsWith('.sln'))
                .sort()
                .map(f => path.join(this.cwd, f));
        } catch {}

        if (slnFiles.length > 0) {
            return slnFiles.map(s => new SolutionNode(s, 'solution', path.basename(s, '.sln')));
        }

        return this._findCsprojs(this.cwd);
    }

    private _projectsFromSln(slnPath: string): SolutionNode[] {
        return buildSlnChildren(slnPath);
    }

    private _findCsprojs(dir: string): SolutionNode[] {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
        const results: SolutionNode[] = [];
        for (const e of entries) {
            if (e.isFile() && e.name.endsWith('.csproj')) {
                results.push(new SolutionNode(path.join(dir, e.name), 'project', path.basename(e.name, '.csproj')));
            } else if (e.isDirectory() && !SE_IGNORED_DIRS.has(e.name)) {
                try {
                    const sub = fs.readdirSync(path.join(dir, e.name)).filter(f => f.endsWith('.csproj'));
                    for (const f of sub) {
                        results.push(new SolutionNode(path.join(dir, e.name, f), 'project', path.basename(f, '.csproj')));
                    }
                } catch {}
            }
        }
        return results;
    }
}

function seReadLaunchUrl(projDir: string): string | undefined {
    try {
        const raw = fs.readFileSync(path.join(projDir, 'Properties', 'launchSettings.json'), 'utf-8');
        const json = JSON.parse(raw);
        for (const profile of Object.values(json?.profiles ?? {}) as Record<string, string>[]) {
            if (profile.applicationUrl) {
                const urls = profile.applicationUrl.split(';');
                return urls.find(u => u.startsWith('https')) ?? urls[0];
            }
        }
    } catch {}
    return undefined;
}

function writePubxml(profilesDir: string, name: string, content: string): void {
    fs.mkdirSync(profilesDir, { recursive: true });
    fs.writeFileSync(path.join(profilesDir, `${name}.pubxml`), content, 'utf-8');
}

async function sePublishProject(cwd: string): Promise<void> {
    const proj = findEntryProject(cwd);
    if (!proj) { vscode.window.showErrorMessage('Nenhum projeto encontrado para publicar.'); return; }

    const projDir   = path.dirname(proj.csprojPath);
    const profilesDir = path.join(projDir, 'Properties', 'PublishProfiles');

    let existing: string[] = [];
    try { existing = fs.readdirSync(profilesDir).filter(f => f.endsWith('.pubxml')).map(f => path.basename(f, '.pubxml')); } catch {}

    const items: vscode.QuickPickItem[] = [
        ...existing.map(p => ({ label: p, description: 'perfil salvo', iconPath: new vscode.ThemeIcon('file-code') })),
        ...(existing.length ? [{ label: '', kind: vscode.QuickPickItemKind.Separator }] : []),
        { label: '$(folder)  Pasta local',       description: 'Publicar em uma pasta local' },
        { label: '$(globe)   FTP',                description: 'Publicar via FTP' },
        { label: '$(server)  Web Deploy (IIS)',   description: 'Publicar via Web Deploy no IIS' },
    ];

    const picked = await vscode.window.showQuickPick(items, { title: 'OpenBase: Publicar — Destino' });
    if (!picked || picked.kind === vscode.QuickPickItemKind.Separator) return;

    if (existing.includes(picked.label)) {
        openTerminal('Publish', projDir, `dotnet publish "${proj.csprojPath}" -c Release /p:PublishProfile="${picked.label}"`);
        return;
    }

    if (picked.label.includes('Pasta local'))    { await sePublishLocal(proj, projDir, profilesDir); return; }
    if (picked.label.includes('FTP'))            { await sePublishFtp(proj, projDir, profilesDir);   return; }
    if (picked.label.includes('Web Deploy'))     { await sePublishWebDeploy(proj, projDir, profilesDir); }
}

async function sePublishLocal(
    proj: NonNullable<ReturnType<typeof findEntryProject>>,
    projDir: string,
    profilesDir: string,
): Promise<void> {
    const name = await vscode.window.showInputBox({ title: 'Publicar Local (1/2) — Nome do perfil', value: 'FolderPublish' });
    if (!name) return;

    const outPath = await vscode.window.showInputBox({
        title: 'Publicar Local (2/2) — Pasta de saída',
        value: path.join(projDir, 'bin', 'publish'),
    });
    if (outPath === undefined) return;

    writePubxml(profilesDir, name, `<?xml version="1.0" encoding="utf-8"?>
<Project>
  <PropertyGroup>
    <DeleteExistingFiles>true</DeleteExistingFiles>
    <LaunchSiteAfterPublish>True</LaunchSiteAfterPublish>
    <LastUsedBuildConfiguration>Release</LastUsedBuildConfiguration>
    <PublishProvider>FileSystem</PublishProvider>
    <PublishUrl>${outPath}</PublishUrl>
    <WebPublishMethod>FileSystem</WebPublishMethod>
    <TargetFramework>${proj.targetFramework}</TargetFramework>
    <SelfContained>false</SelfContained>
  </PropertyGroup>
</Project>`);

    openTerminal('Publish', projDir, `dotnet publish "${proj.csprojPath}" -c Release /p:PublishProfile="${name}"`);
}

async function sePublishFtp(
    proj: NonNullable<ReturnType<typeof findEntryProject>>,
    projDir: string,
    profilesDir: string,
): Promise<void> {
    const name = await vscode.window.showInputBox({ title: 'Publicar FTP (1/5) — Nome do perfil', value: 'FtpPublish' });
    if (!name) return;
    const host = await vscode.window.showInputBox({ title: 'Publicar FTP (2/5) — Servidor', placeHolder: 'ftp.exemplo.com' });
    if (!host) return;
    const remotePath = await vscode.window.showInputBox({ title: 'Publicar FTP (3/5) — Caminho remoto', value: '/' });
    if (remotePath === undefined) return;
    const user = await vscode.window.showInputBox({ title: 'Publicar FTP (4/5) — Usuário' });
    if (user === undefined) return;
    const password = await vscode.window.showInputBox({ title: 'Publicar FTP (5/5) — Senha', password: true });
    if (password === undefined) return;

    writePubxml(profilesDir, name, `<?xml version="1.0" encoding="utf-8"?>
<Project>
  <PropertyGroup>
    <WebPublishMethod>FTP</WebPublishMethod>
    <PublishProtocol>FTP</PublishProtocol>
    <PublishUrl>ftp://${host}${remotePath.startsWith('/') ? remotePath : '/' + remotePath}</PublishUrl>
    <UserName>${user}</UserName>
    <FTPPassiveMode>True</FTPPassiveMode>
    <LastUsedBuildConfiguration>Release</LastUsedBuildConfiguration>
    <TargetFramework>${proj.targetFramework}</TargetFramework>
    <SelfContained>false</SelfContained>
  </PropertyGroup>
</Project>`);

    openTerminal('Publish FTP', projDir,
        `dotnet publish "${proj.csprojPath}" -c Release /p:PublishProfile="${name}" /p:Password="${password.replace(/"/g, '\\"')}"`);
}

async function sePublishWebDeploy(
    proj: NonNullable<ReturnType<typeof findEntryProject>>,
    projDir: string,
    profilesDir: string,
): Promise<void> {
    const name = await vscode.window.showInputBox({ title: 'Web Deploy (1/5) — Nome do perfil', value: 'WebDeployPublish' });
    if (!name) return;
    const serverUrl = await vscode.window.showInputBox({ title: 'Web Deploy (2/5) — URL do servidor', placeHolder: 'https://meuservidor.com:8172' });
    if (!serverUrl) return;
    const sitePath = await vscode.window.showInputBox({ title: 'Web Deploy (3/5) — Caminho IIS', placeHolder: 'Default Web Site/meuapp', value: 'Default Web Site' });
    if (sitePath === undefined) return;
    const user = await vscode.window.showInputBox({ title: 'Web Deploy (4/5) — Usuário' });
    if (user === undefined) return;
    const password = await vscode.window.showInputBox({ title: 'Web Deploy (5/5) — Senha', password: true });
    if (password === undefined) return;

    writePubxml(profilesDir, name, `<?xml version="1.0" encoding="utf-8"?>
<Project>
  <PropertyGroup>
    <WebPublishMethod>MSDeploy</WebPublishMethod>
    <PublishProtocol>MSDeploy</PublishProtocol>
    <MSDeployServiceURL>${serverUrl}</MSDeployServiceURL>
    <DeployIisAppPath>${sitePath}</DeployIisAppPath>
    <SkipExtraFilesOnServer>True</SkipExtraFilesOnServer>
    <MSDeployPublishMethod>RemoteAgent</MSDeployPublishMethod>
    <EnableMSDeployBackup>True</EnableMSDeployBackup>
    <UserName>${user}</UserName>
    <LastUsedBuildConfiguration>Release</LastUsedBuildConfiguration>
    <TargetFramework>${proj.targetFramework}</TargetFramework>
    <SelfContained>false</SelfContained>
  </PropertyGroup>
</Project>`);

    openTerminal('Publish Web Deploy', projDir,
        `dotnet publish "${proj.csprojPath}" -c Release /p:PublishProfile="${name}" /p:Password="${password.replace(/"/g, '\\"')}"`);
}

function setupSolutionExplorer(context: vscode.ExtensionContext): void {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return;

    solutionExplorerProvider = new SolutionExplorerProvider(cwd);

    const treeView = vscode.window.createTreeView('openbase.solutionexplorer.tree', {
        treeDataProvider: solutionExplorerProvider,
        showCollapseAll: true,
    });

    const watcher = vscode.workspace.createFileSystemWatcher('**/{*.sln,*.csproj}');
    watcher.onDidCreate(() => solutionExplorerProvider?.refresh());
    watcher.onDidDelete(() => solutionExplorerProvider?.refresh());
    watcher.onDidChange(() => solutionExplorerProvider?.refresh());

    const decorationProvider = new SolutionExplorerDecorationProvider();

    context.subscriptions.push(
        treeView,
        watcher,
        vscode.window.registerFileDecorationProvider(decorationProvider),
        vscode.languages.onDidChangeDiagnostics(() => decorationProvider.notifyChanged()),

        vscode.workspace.onDidChangeWorkspaceFolders(() => solutionExplorerProvider?.refresh()),

        vscode.commands.registerCommand('openbase.solutionExplorer.refresh',
            () => solutionExplorerProvider?.refresh()),

        vscode.commands.registerCommand('openbase.solutionExplorer.buildAll', () => {
            const slnFiles = fs.readdirSync(cwd).filter(f => f.endsWith('.sln'));
            const target = slnFiles.length > 0 ? `"${path.join(cwd, slnFiles[0])}"` : '.';
            openTerminal('Build Solution', cwd, `dotnet build ${target}`);
        }),

        vscode.commands.registerCommand('openbase.solutionExplorer.runAll', () => {
            const proj = findEntryProject(cwd);
            const target = proj ? `"${proj.csprojPath}"` : '.';
            openTerminal('Run Solution', cwd, `dotnet run --project ${target}`);
        }),

        vscode.commands.registerCommand('openbase.solutionExplorer.debug', async () => {
            const folder = vscode.workspace.workspaceFolders?.[0];
            if (!folder) return;

            const serverReadyAction = {
                action: 'openExternally',
                pattern: '\\bNow listening on:\\s+(https?://\\S+)',
            };

            const launchConfigs: vscode.DebugConfiguration[] | undefined =
                vscode.workspace.getConfiguration('launch', folder.uri).get('configurations');

            if (launchConfigs && launchConfigs.length > 0) {
                const config = { ...launchConfigs[0] };
                if (!config.serverReadyAction) config.serverReadyAction = serverReadyAction;
                await vscode.debug.startDebugging(folder, config);
            } else {
                const proj = findEntryProject(cwd);
                if (!proj) {
                    vscode.window.showErrorMessage('Nenhum projeto encontrado para depurar.');
                    return;
                }
                const projDir = path.dirname(proj.csprojPath);
                const config: vscode.DebugConfiguration = {
                    name: proj.assemblyName,
                    type: 'coreclr',
                    request: 'launch',
                    program: path.join(projDir, 'bin', 'Debug', proj.targetFramework, `${proj.assemblyName}.dll`),
                    args: [],
                    cwd: projDir,
                    stopAtEntry: false,
                    env: { ASPNETCORE_ENVIRONMENT: 'Development' },
                    serverReadyAction,
                };
                await vscode.debug.startDebugging(folder, config);
            }
        }),

        vscode.commands.registerCommand('openbase.solutionExplorer.test', () => {
            const slnFiles = fs.readdirSync(cwd).filter(f => f.endsWith('.sln'));
            const target = slnFiles.length > 0 ? `"${path.join(cwd, slnFiles[0])}"` : '.';
            openTerminal('Run Tests', cwd, `dotnet test ${target}`);
        }),

        vscode.commands.registerCommand('openbase.solutionExplorer.publish',
            () => sePublishProject(cwd)),

        vscode.commands.registerCommand('openbase.solutionExplorer.build',
            (item: SolutionNode) => {
                if (!(item instanceof SolutionNode) || item.kind !== 'project') return;
                openTerminal('Build', path.dirname(item.fsPath), `dotnet build "${item.fsPath}"`);
            }),

        vscode.commands.registerCommand('openbase.solutionExplorer.run',
            (item: SolutionNode) => {
                if (!(item instanceof SolutionNode) || item.kind !== 'project') return;
                openTerminal('Run', path.dirname(item.fsPath), `dotnet run --project "${item.fsPath}"`);
            }),

        vscode.commands.registerCommand('openbase.solutionExplorer.openTerminal',
            (item: SolutionNode) => {
                if (!(item instanceof SolutionNode) || item.kind !== 'project') return;
                const projDir = path.dirname(item.fsPath);
                const projName = path.basename(item.fsPath, '.csproj');
                const terminal = vscode.window.createTerminal({
                    name: `OpenBase: ${projName}`,
                    cwd: projDir,
                    env: { PATH: `${dotnetToolsPath()}${path.delimiter}${process.env.PATH ?? ''}` },
                });
                terminal.show();
            }),
    );
}

// ─── task runner ─────────────────────────────────────────────────────────────

class TaskItem extends vscode.TreeItem {
    constructor(
        public readonly number: number,
        public readonly title: string,
        public readonly labels: string[],
        public readonly milestone: string | null,
        public readonly assignees: string[]
    ) {
        super(`[#${number}] ${title}`, vscode.TreeItemCollapsibleState.None);
        this.tooltip = `Issue #${number}: ${title}\nLabels: ${labels.join(', ')}\nMilestone: ${milestone ?? 'None'}\nAssignees: ${assignees.join(', ')}`;
        this.contextValue = 'task';
        this.iconPath = new vscode.ThemeIcon('issues');
    }
}

class TaskProvider implements vscode.TreeDataProvider<TaskItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TaskItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly cwd: string) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TaskItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TaskItem): Promise<TaskItem[]> {
        if (element) return [];

        return new Promise((resolve) => {
            const extraPath = dotnetToolsPath();
            const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
            exec('gh issue list --json number,title,labels,assignees,milestone', { cwd: this.cwd, env }, (err, stdout) => {
                if (err) {
                    console.error('Error fetching issues:', err);
                    resolve([]);
                    return;
                }
                try {
                    const issues = JSON.parse(stdout);
                    resolve(issues.map((i: any) => new TaskItem(
                        i.number,
                        i.title,
                        i.labels.map((l: any) => l.name),
                        i.milestone?.title || null,
                        i.assignees.map((a: any) => a.login)
                    )));
                } catch (e) {
                    console.error('Error parsing issues:', e);
                    resolve([]);
                }
            });
        });
    }
}

let taskProvider: TaskProvider | undefined;

function setupTaskRunner(context: vscode.ExtensionContext): void {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootPath) return;

    taskProvider = new TaskProvider(rootPath);
    vscode.window.registerTreeDataProvider('openbase.taskrunner.tree', taskProvider);

    const reg = (id: string, fn: (...args: any[]) => any) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

    reg('openbase.taskRunner.refresh', () => taskProvider?.refresh());

    reg('openbase.taskRunner.openInBrowser', (item: TaskItem) => {
        if (!item) return;
        const extraPath = dotnetToolsPath();
        const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
        exec(`gh issue view ${item.number} --web`, { cwd: rootPath, env });
    });

    reg('openbase.taskRunner.develop', (item: TaskItem) => {
        if (!item) return;
        const terminal = vscode.window.createTerminal({
            name: `OpenBase: Issue #${item.number}`,
            cwd: rootPath,
            env: { PATH: `${dotnetToolsPath()}${path.delimiter}${process.env.PATH ?? ''}` },
        });
        terminal.show();
        terminal.sendText(`gh issue develop ${item.number}`);
    });

    reg('openbase.taskRunner.toSpecialist', (item: TaskItem) => {
        if (!item) return;
        
        let entity = '';
        let method = '';
        
        const m1 = item.title.match(/Add\s+(\w+)\s+to\s+(\w+)/i);
        if (m1) {
            method = m1[1];
            entity = m1[2];
        } else {
            const words = item.title.split(' ');
            if (words.length >= 2) {
                method = words[0];
                entity = words[words.length - 1];
            }
        }

        vscode.commands.executeCommand('openbase.specialist');
        
        setTimeout(() => {
            panelProvider?.postMessage({
                command: 'fillSpecialist',
                entity,
                method
            });
        }, 1000);
    });
}

// ─── status bar ──────────────────────────────────────────────────────────────

function setupStatusBar(context: vscode.ExtensionContext): void {
    const connItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    connItem.command = 'openbase.sqlRunner';
    
    const activeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    activeItem.text = '$(rocket) OpenBase';
    activeItem.tooltip = 'OpenBase CLI is active';
    activeItem.show();

    context.subscriptions.push(connItem, activeItem);

    function refresh(): void {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) { connItem.hide(); return; }
        const conn = findConnection(folder.uri.fsPath);
        if (!conn) { connItem.hide(); return; }
        connItem.text = `$(database) ${conn.label}`;
        connItem.tooltip = undefined;
        connItem.show();
    }

    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(refresh),
        vscode.window.onDidChangeActiveTextEditor(refresh),
    );

    refresh();
}

// ─── activate ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
    extContext = context;
    diagnosticCollection = vscode.languages.createDiagnosticCollection('openbase');
    context.subscriptions.push(diagnosticCollection);
    panelProvider = new OpenBasePanelProvider();
    setupStatusBar(context);
    setupSqlTableBrowser(context);
    setupSqlScriptLibrary(context);
    setupHttpRequestLibrary(context);
    setupMigrationRunner(context);
    setupDepInspector(context);
    setupEndpointsMap(context);
    setupSolutionExplorer(context);
    setupTaskRunner(context);

    // Helper to execute commands
    const execute = async (command: string, message: string, stream: any) => {
        stream.markdown(message + '\n\n*Running command...*');
        try {
            await vscode.commands.executeCommand(command);
            stream.markdown(`\n\n✅ Command \`${command}\` executed successfully.`);
        } catch (error) {
            stream.markdown(`\n\n❌ Error executing \`${command}\`: ${error}`);
        }
    };

    // Chat Participant
    const chatParticipant = vscode.chat.createChatParticipant('openbase.participant', async (request, context, stream, token) => {
        const prompt = request.prompt.toLowerCase();

        // Regex para capturar: implemente a issue #tipo/numero
        const issueMatch = prompt.match(/implemente a issue\s+#([a-z]+)\/(\d+)/);
        if (issueMatch) {
            const type = issueMatch[1];
            const id = issueMatch[2];
            await handleIssueImplementation(type, id, stream);
            return;
        }

        if (prompt.includes('migrate') || prompt.includes('run migrations')) {
            await execute('openbase.migrationRunner.migrateUp', 'Running database migrations...', stream);
        } else if (prompt.includes('build')) {
            await execute('openbase.solutionExplorer.buildAll', 'Building solution...', stream);
        } else if (prompt.includes('run solution') || prompt.includes('run')) {
            await execute('openbase.solutionExplorer.runAll', 'Running solution...', stream);
        } else if (prompt.includes('test')) {
            await execute('openbase.solutionExplorer.test', 'Executing tests...', stream);
        } else if (prompt.includes('sql') || prompt.includes('database')) {
            await execute('openbase.sqlRunner', 'Opening SQL Runner...', stream);
        } else if (prompt.includes('http') || prompt.includes('api')) {
            await execute('openbase.httpRunner', 'Opening HTTP Runner...', stream);
        } else if (prompt.includes('log')) {
            await execute('openbase.logViewer', 'Opening Log Viewer...', stream);
        } else if (prompt.includes('monitor')) {
            await execute('openbase.monitor', 'Opening System Monitor...', stream);
        } else if (prompt.includes('new project')) {
            await execute('openbase.newProject', 'Starting new project wizard...', stream);
        } else if (prompt.includes('scaffold')) {
            await execute('openbase.scaffold', 'Starting scaffold wizard...', stream);
        } else if (prompt.includes('history')) {
            await execute('openbase.history', 'Showing project history...', stream);
        } else if (prompt.includes('version')) {
            await execute('openbase.version', 'Checking CLI version...', stream);
        } else if (prompt.includes('add extension')) {
            await execute('openbase.extensionAdd', 'Adding new extension...', stream);
        } else if (prompt.includes('context')) {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const doc = editor.document;
                stream.markdown(`Your current context is the file: \`${doc.fileName}\` (${doc.languageId}).`);
            } else {
                stream.markdown('No active editor found. Please open a file to see its context.');
            }
        } else if (prompt.includes('help')) {
            stream.markdown('I can help you interact with OpenBase tools. Try commands like:\n\n' +
                '- `migrate`: Run database migrations\n' +
                '- `build`: Build the solution\n' +
                '- `run`: Run the solution\n' +
                '- `test`: Execute tests\n' +
                '- `sql`: Open SQL Runner\n' +
                '- `http`: Open HTTP Runner\n' +
                '- `log`: Open Log Viewer\n' +
                '- `monitor`: Open System Monitor\n' +
                '- `new project`: Start new project wizard\n' +
                '- `scaffold`: Start scaffold wizard\n' +
                '- `context`: Show current file context\n' +
                '- `implemente a issue #tipo/id`: Automated issue workflow');
        } else {
            stream.markdown("I'm sorry, I don't recognize that command. Try `@openbase help` to see what I can do.");
        }
    });

    // Handler para implementação de issue
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
                message = `Fix #${id} detectado. Preparando atualização de scaffold...`;
                command = 'openbase.scaffoldUpdate';
                break;
            case 'api':
                message = `API #${id} detectada. Preparando specialist...`;
                command = 'openbase.specialist';
                break;
            default:
                stream.markdown(`Tipo de issue \`${type}\` não mapeado para um fluxo automático.`);
                return;
        }

        stream.markdown(`\n\n${message}`);
        try {
            await vscode.commands.executeCommand(command);
            stream.markdown(`\n\n✅ Fluxo para \`#${type}/${id}\` iniciado com sucesso.`);
        } catch (error) {
            stream.markdown(`\n\n❌ Erro ao iniciar fluxo para \`#${type}/${id}\`: ${error}`);
        }
    }
    const reg = (id: string, fn: (uri?: vscode.Uri) => Promise<void>) =>
        vscode.commands.registerCommand(id, fn);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(OpenBasePanelProvider.viewType, panelProvider),
        vscode.window.registerWebviewViewProvider('openbase.sqlrunner.sidebar', new RunnerSidebarProvider('SQL Runner', 'Open SQL Runner', sqlRunner)),
        vscode.window.registerWebviewViewProvider('openbase.httprunner.sidebar', new RunnerSidebarProvider('HTTP Runner', 'Open HTTP Runner', httpRunner)),
        vscode.window.registerWebviewViewProvider('openbase.erdiagram.sidebar', new RunnerSidebarProvider('ER Diagram', 'Open ER Diagram', openErDiagram)),
        vscode.window.registerWebviewViewProvider('openbase.logviewer.sidebar', new RunnerSidebarProvider('Log Viewer', 'Open Log Viewer', logViewer)),
        vscode.window.registerWebviewViewProvider('openbase.migrationrunner.sidebar', new RunnerSidebarProvider('Migration Runner', 'Refresh Migrations', () => migrationProvider?.refresh())),
        vscode.window.registerWebviewViewProvider('openbase.monitor.sidebar', new RunnerSidebarProvider('Monitor', 'Open Monitor', () => { monitor(); })),
        vscode.window.registerWebviewViewProvider('openbase.depinspector.sidebar', new RunnerSidebarProvider('Dependency Inspector', 'Refresh Packages', () => depProvider?.refresh())),
        vscode.commands.registerCommand('openbase.monitor', () => monitor()),
        vscode.commands.registerCommand('openbase.logViewer', () => logViewer()),
        vscode.commands.registerCommand('openbase.migrationRunner', () => migrationProvider?.refresh()),
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
        reg('openbase.newProject',     newProject),
        reg('openbase.scaffold',       scaffold),
        reg('openbase.scaffoldUpdate', scaffoldUpdate),
        reg('openbase.specialist',     specialist),
        reg('openbase.procedure',      procedure),
        reg('openbase.extensionAdd',   extensionAdd),
        reg('openbase.extensionList',  extensionList),
        reg('openbase.build',          build),
        reg('openbase.run',            run),
        reg('openbase.update',         update),
        reg('openbase.history',        history),
        reg('openbase.version',        version),
        vscode.commands.registerCommand('openbase.sqlRunner', () => sqlRunner()),
        vscode.commands.registerCommand('openbase.httpRunner', () => httpRunner()),
        vscode.commands.registerCommand('openbase.sqlRunner.run', () => sqlPanel?.webview.postMessage({ command: 'triggerRun' })),
        vscode.commands.registerCommand('openbase.httpRunner.send', () => httpPanel?.webview.postMessage({ command: 'triggerSend' })),
    );
}

export function deactivate(): void {}
