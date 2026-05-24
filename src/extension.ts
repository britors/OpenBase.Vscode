import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { execSync, exec, spawn } from 'child_process';

const DB_TEMPLATES = ['sqlserver', 'pgsql', 'oracle'] as const;
const BUILD_CONFIGS = ['Debug', 'Release'] as const;
const EXTENSIONS = ['jwt', 'cache', 'healthchecks'] as const;
const SPECIALIST_TYPES = ['query', 'command', 'httpcall'] as const;
const PARAM_TYPES = ['string', 'int', 'bool', 'decimal', 'Guid', 'DateTime', 'long', 'double', 'float', 'short'] as const;
const EXTENSION_PROVIDERS: Partial<Record<string, string[]>> = {
    cache: ['redis', 'azure'],
};

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

// ─── new ────────────────────────────────────────────────────────────────────

async function newProject(uri?: vscode.Uri): Promise<void> {
    if (!await guardInstalled()) return;

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

    const dbServerDefault = template.label === 'sqlserver' ? '.' : 'localhost';
    const dbServer = await vscode.window.showInputBox({
        title: 'OpenBase: New Project (3/8) — Database server',
        prompt: 'Database server address (leave empty for default)',
        placeHolder: dbServerDefault,
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
    });
    if (mediatrLicense === undefined) return;

    const automapperLicense = await vscode.window.showInputBox({
        title: 'OpenBase: New Project (8/8) — AutoMapper license',
        prompt: 'AutoMapper commercial license key (leave empty if none)',
        placeHolder: 'Leave empty if not applicable',
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
        case 'cache':        return 'Distributed Cache';
        case 'healthchecks': return 'Health Checks';
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
        view.webview.onDidReceiveMessage(async (msg) => this._handle(msg, view));
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

        const projectUri = vscode.Uri.file(path.join(cwd, d.name));
        const action = await vscode.window.showInformationMessage(`Project "${d.name}" created successfully!`, 'Open Folder', 'Open in New Window');
        if (action === 'Open Folder')      vscode.commands.executeCommand('vscode.openFolder', projectUri, false);
        else if (action === 'Open in New Window') vscode.commands.executeCommand('vscode.openFolder', projectUri, true);
    }

    private async _scaffoldUpdate(d: { entity: string; schema: string; table: string; runMigrations: boolean }, view: vscode.WebviewView): Promise<void> {
        const cwd = await this._cwd();
        if (!cwd) { view.webview.postMessage({ command: 'done', ctx: 'scu' }); return; }

        const args = [`-e ${d.entity}`, '--update'];
        if (d.schema)        args.push(`--schema "${d.schema}"`);
        if (d.table)         args.push(`--table "${d.table}"`);
        if (d.runMigrations) args.push('--run-migrations');

        openTerminal('Scaffold Update', cwd, `openbase scaffold ${args.join(' ')}`);
        view.webview.postMessage({ command: 'done', ctx: 'scu', text: 'Terminal aberto — confirme o diff e as alterações no terminal.' });
    }

    private async _scaffold(d: { entity: string; mode: string; schema: string; table: string; runMigrations: boolean }, view: vscode.WebviewView): Promise<void> {
        const cwd = await this._cwd();
        if (!cwd) { view.webview.postMessage({ command: 'done', ctx: 'sc' }); return; }

        if (d.mode === 'codefirst') {
            openTerminal('Scaffold', cwd, `openbase scaffold -e ${d.entity}`);
            view.webview.postMessage({ command: 'done', ctx: 'sc', text: 'Terminal aberto — preencha as propriedades da entidade no terminal.' });
            return;
        }
        const args = [`-e ${d.entity}`, '--mode modelfirst'];
        if (d.schema)         args.push(`--schema "${d.schema}"`);
        if (d.table)          args.push(`--table "${d.table}"`);
        if (d.runMigrations)  args.push('--run-migrations');
        await this._exec(`openbase scaffold ${args.join(' ')}`, cwd, view, 'sc', 'OpenBase: Scaffold');
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

    private async _exec(cmd: string, cwd: string, view: vscode.WebviewView, ctx: string, channelName: string): Promise<boolean> {
        const channel = this._channel(channelName);
        channel.clear();
        channel.show(true);
        const extraPath = dotnetToolsPath();
        const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
        return new Promise<boolean>((resolve) => {
            const child = exec(cmd, { cwd, env, timeout: 60000 });
            child.stdout?.on('data', (chunk: string) => channel.append(chunk));
            child.stderr?.on('data', (chunk: string) => channel.append(chunk));
            child.on('close', (code, signal) => {
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
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
    <div class="field"><label>MediatR License</label><input id="new-mediatR" type="text" placeholder="(optional)"></div>
    <div class="field"><label>AutoMapper License</label><input id="new-automapper" type="text" placeholder="(optional)"></div>
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
    <div class="field"><label>Mode</label>
      <select id="sc-mode" onchange="onScMode()">
        <option value="modelfirst">Model First — reads from DB</option>
        <option value="codefirst">Code First — interactive terminal</option>
      </select>
    </div>
    <div id="sc-mf">
      <div class="field"><label>Schema</label><input id="sc-schema" type="text" placeholder="dbo"></div>
      <div class="field"><label>Table</label><input id="sc-table" type="text" placeholder="(auto-detect from entity name)"></div>
      <div class="field"><label class="check-label"><input id="sc-mig" type="checkbox"> Run migrations after scaffold</label></div>
    </div>
    <p id="sc-cf-hint" class="hint hidden">Um terminal será aberto para a coleta interativa de propriedades.</p>
    <div id="sc-err" class="err"></div>
    <div id="sc-ok" class="ok"></div>
    <button id="sc-btn" class="btn-primary" onclick="submitScaffold()" data-label="Run Scaffold">Run Scaffold</button>
  </div>

  <!-- SCAFFOLD UPDATE -->
  <div id="page-scu" class="page">
    <p class="hint" style="margin-bottom:10px">Lê o schema do banco, compara com a entidade existente e regera os 16 arquivos dependentes de propriedades.</p>
    <div class="field"><label>Entity *</label><input id="scu-entity" type="text" placeholder="Product"></div>
    <div class="field"><label>Schema</label><input id="scu-schema" type="text" placeholder="dbo (auto-detect)"></div>
    <div class="field"><label>Table</label><input id="scu-table" type="text" placeholder="(auto-detect from entity name)"></div>
    <div class="field"><label class="check-label"><input id="scu-mig" type="checkbox"> Run migrations after update</label></div>
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
    <div id="sp-sql-field" class="field"><label>SQL *</label><textarea id="sp-sql" rows="8" placeholder="SELECT Nome FROM Produtos WHERE CategoriaId = {{categoriaId}}"></textarea></div>
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
      <select id="ext-name" onchange="onExtChange()">
        <option value="jwt">JWT Authentication</option>
        <option value="healthchecks">Health Checks</option>
        <option value="cache">Distributed Cache</option>
      </select>
    </div>
    <div id="ext-prov-field" class="field hidden"><label>Provider</label>
      <select id="ext-prov">
        <option value="redis">Redis</option>
        <option value="azure">Azure Cache</option>
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
    function onExtChange() {
      document.getElementById('ext-prov-field').classList.toggle('hidden', document.getElementById('ext-name').value !== 'cache');
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
        document.getElementById('sc-schema').value = '';
        document.getElementById('sc-table').value = '';
        document.getElementById('sc-mig').checked = false;
      } else if (ctx === 'sp') {
        document.getElementById('sp-entity').value = '';
        document.getElementById('sp-method').value = '';
        document.getElementById('sp-sql').value = '';
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
      if (m.command === 'folderPicked') {
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
      vscode.postMessage({ command: 'scaffold', data: {
        entity: entity,
        mode: document.getElementById('sc-mode').value,
        schema: document.getElementById('sc-schema').value.trim(),
        table: document.getElementById('sc-table').value.trim(),
        runMigrations: document.getElementById('sc-mig').checked,
      }});
    }

    function submitScaffoldUpdate() {
      var entity = document.getElementById('scu-entity').value.trim();
      err('scu', '');
      if (!entity) { err('scu', 'Entity name is required.'); return; }
      if (!/^[A-Z][a-zA-Z0-9]*$/.test(entity)) { err('scu', 'Must be PascalCase (e.g. Product).'); return; }
      loading('scu', true);
      vscode.postMessage({ command: 'scaffoldUpdate', data: {
        entity: entity,
        schema: document.getElementById('scu-schema').value.trim(),
        table: document.getElementById('scu-table').value.trim(),
        runMigrations: document.getElementById('scu-mig').checked,
      }});
    }

    function submitSpecialist() {
      var entity = document.getElementById('sp-entity').value.trim();
      var method = document.getElementById('sp-method').value.trim();
      var type   = document.getElementById('sp-type').value;
      var sql    = document.getElementById('sp-sql').value.trim();
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
      vscode.postMessage({ command: 'extensionAdd', data: {
        name: name,
        provider: name === 'cache' ? document.getElementById('ext-prov').value : '',
      }});
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

    sqlPanel.webview.onDidReceiveMessage(async (msg: { command: string; sql?: string; csvData?: string; csvName?: string }) => {
        sqlOut().appendLine(`[SQL Runner] Message received: ${msg.command}`);

        if (msg.command === 'ready') {
            if (sqlPendingScript) {
                const pending = sqlPendingScript;
                sqlPendingScript = undefined;
                sqlPanel?.webview.postMessage({ command: 'loadScript', content: pending.content, name: pending.name });
            }
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
  :root{--ob-bg0:#0d0f1a;--ob-bg1:#131629;--ob-bg2:#1c1535;--ob-purple:#b44fff;--ob-pink:#ff3fa4;--ob-border:rgba(180,79,255,.22);--ob-text:#ede8f8;--ob-dim:#9080b8}
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
  <button id="save-btn" class="btn btn-secondary" title="Save script to library">Save&hellip;</button>
  <span class="hint">F8 to run</span>
  <span id="status" class="status"></span>
</div>
<div id="results" class="results">
  <p class="placeholder">Write a query above and press Run or F8</p>
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

  document.getElementById('run-btn').addEventListener('click', run);
  document.getElementById('cancel-btn').addEventListener('click', function() {
    clearRunTimeout();
    vscode.postMessage({ command: 'cancel' });
  });
  document.getElementById('save-btn').addEventListener('click', function() {
    var sql = editor ? editor.getValue() : '';
    if (sql.trim()) vscode.postMessage({ command: 'saveScript', sql: sql });
  });
  document.getElementById('results').addEventListener('click', function(e) {
    if (e.target && e.target.id === 'export-csv-btn') exportCsv();
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
      document.getElementById('results').innerHTML = '<div class="msg-box">Query cancelled.</div>';
    }
  });

  function renderResult(columns, rows, message, elapsed) {
    setStatus('');
    lastColumns = columns || [];
    lastRows = rows || [];
    if (!columns || !columns.length) {
      lastColumns = []; lastRows = [];
      document.getElementById('results').innerHTML =
        '<div class="msg-box">' + esc(message || 'Command completed.') + '</div>';
      return;
    }
    var rowCount = rows ? rows.length : 0;
    var infoMsg = message ? ' · ' + esc(message) : '';
    var hdr = '<div class="result-header">'
            + '<span>' + rowCount + ' row' + (rowCount !== 1 ? 's' : '') + ' · ' + elapsed + infoMsg + '</span>'
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
        tbl += '<td' + (isNull ? ' class="null"' : '') + ' title="' + esc(val) + '">'
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

async function httpRunner(): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const baseUrl = cwd ? detectApiUrl(cwd) : '';

    if (httpPanel) {
        httpPanel.reveal(vscode.ViewColumn.One);
        return;
    }

    httpPanel = vscode.window.createWebviewPanel(
        'openbase.httpRunner', 'OpenBase HTTP', vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    httpPanel.onDidDispose(() => { httpPanel = undefined; });
    const httpNonce = getNonce();
    httpPanel.webview.html = buildHttpRunnerHtml(baseUrl, httpNonce, httpPanel.webview.cspSource);

    httpPanel.webview.onDidReceiveMessage(async (msg: {
        command: string;
        method?: string;
        url?: string;
        headers?: Array<{name: string; value: string}> | Record<string, string>;
        bodyType?: string;
        body?: string;
        authToken?: string;
    }) => {
        if (msg.command === 'ready') {
            if (httpPendingRequest) {
                const pending = httpPendingRequest;
                httpPendingRequest = undefined;
                httpPanel?.webview.postMessage({ command: 'loadRequest', ...pending });
            }
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
        try {
            const result = await doHttpRequest(method, url, headers as Record<string, string>, body);
            httpPanel?.webview.postMessage({ command: 'response', ...result });
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
  :root{--ob-bg0:#0d0f1a;--ob-bg1:#131629;--ob-bg2:#1c1535;--ob-purple:#b44fff;--ob-pink:#ff3fa4;--ob-border:rgba(180,79,255,.22);--ob-text:#ede8f8;--ob-dim:#9080b8}
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
</style>
</head>
<body>

<!-- URL BAR -->
<div class="url-bar">
  <select id="method" onchange="onMethodChange(this)">
    <option>GET</option><option>POST</option><option>PUT</option>
    <option>PATCH</option><option>DELETE</option><option>OPTIONS</option><option>HEAD</option>
  </select>
  <input id="url-input" type="text" placeholder="https://localhost:5000/api/...">
  <button id="send-btn" class="btn btn-primary">▶ Send</button>
  <button id="save-req-btn" class="btn btn-secondary" title="Save request to library">Save…</button>
</div>

<!-- REQUEST TABS -->
<div class="req-section">
  <div class="tab-strip">
    <div class="tab active" onclick="reqTab(this,'headers')">Headers</div>
    <div class="tab" onclick="reqTab(this,'body')">Body</div>
    <div class="tab" onclick="reqTab(this,'auth')">Auth</div>
  </div>

  <div id="req-headers" class="tab-content">
    <div id="headers-list"></div>
    <button class="btn btn-secondary" style="margin-top:4px" onclick="addHeader('','')">+ Add Header</button>
  </div>

  <div id="req-body" class="tab-content hidden">
    <div class="body-toolbar">
      <span>Body:</span>
      <select id="body-type" onchange="onBodyType()">
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
      <input id="auth-show" type="checkbox" style="width:auto" onchange="document.getElementById('auth-token').type=this.checked?'text':'password'">
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
    <div class="tab active" onclick="resTab(this,'body')">Body</div>
    <div class="tab" onclick="resTab(this,'headers')">Headers</div>
  </div>
  <div class="res-body-wrap" id="res-body-wrap"></div>
  <div class="res-body-wrap hidden" id="res-headers-wrap"></div>
</div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  vscode.postMessage({ command: 'ready' });
  let sending = false;
  const BASE_URL = ${safeBase};

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
  document.getElementById('url-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') sendRequest();
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'F8') { e.preventDefault(); sendRequest(); }
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
    var hdrs = collectHeaders();

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

    vscode.postMessage({ command: 'send', method: method, url: url, headers: hdrs, body: body });

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
    if (m.command === 'loadRequest') {
      var sel = document.getElementById('method');
      sel.value = m.method || 'GET';
      onMethodChange(sel);
      document.getElementById('url-input').value = m.url || '';
      document.getElementById('headers-list').innerHTML = '';
      (m.headers || []).forEach(function(h) { addHeader(h.name, h.value); });
      var bt = document.getElementById('body-type');
      bt.value = m.bodyType || 'none';
      onBodyType();
      document.getElementById('body-text').value = m.body || '';
      document.getElementById('auth-token').value = m.authToken || '';
      return;
    }
    clearSendTimeout();
    sending = false;
    document.getElementById('send-btn').disabled = false;
    if (m.command === 'response') showResponse(m);
    else if (m.command === 'error') showError(m.text);
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
      '<button id="copy-btn" class="btn btn-secondary" style="margin-left:auto;font-size:11px;padding:2px 8px" onclick="copyBody()">Copy</button>';
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

    setTreeView(tv: vscode.TreeView<SqlTableItem>): void { this.treeView = tv; }

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
            return Array.from(this.schemas.entries())
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([schema, { tables }]) => {
                    const item = new SqlTableItem('schema', `${schema}  (${tables.length})`);
                    (item as SqlTableItem & { _schema: string })._schema = schema;
                    return item;
                });
        }

        if (element.kind === 'schema') {
            const schemaName = (element.label as string).replace(/\s+\(\d+\)$/, '');
            const entry = this.schemas.get(schemaName);
            if (!entry) return [];
            return entry.tables.map(t => new SqlTableItem('table', t, schemaName, entry.dbType));
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
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d0f1a;color:#e8e8f0;font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:14px}
.spinner{width:30px;height:30px;border:3px solid rgba(180,79,255,.2);border-top-color:#b44fff;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.name{background:linear-gradient(90deg,#b44fff,#ff3fa4);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;font-weight:700;font-size:14px}
.lbl{color:#444;font-size:11px}
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
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d0f1a;color:#e8e8f0;font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:12px;padding:24px;text-align:center}
.icon{font-size:30px}
.name{background:linear-gradient(90deg,#b44fff,#ff3fa4);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;font-weight:700;font-size:14px}
.err{background:#150a0a;border:1px solid rgba(255,107,107,.3);color:#ff6b6b;padding:12px 16px;border-radius:8px;font-family:monospace;font-size:12px;max-width:480px;word-break:break-word}
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
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d0f1a;color:#e8e8f0;font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:14px}
.spinner{width:32px;height:32px;border:3px solid rgba(180,79,255,.2);border-top-color:#b44fff;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.lbl{color:#666;font-size:12px}
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
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden;background:#0d0f1a;color:#e8e8f0;font-family:'Segoe UI',sans-serif;font-size:13px}
.toolbar{display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid #1e2035;flex-shrink:0;background:#111328}
.toolbar label{color:#888;font-size:11px}
select{background:#1a1c2e;color:#e8e8f0;border:1px solid #2a2d45;border-radius:4px;padding:3px 6px;font-size:12px;font-family:inherit;cursor:pointer}
.btn{padding:3px 10px;border:1px solid #2a2d45;border-radius:4px;cursor:pointer;font-family:inherit;font-size:12px;background:#1a1c2e;color:#e8e8f0}
.btn:hover{background:#23263d;border-color:#b44fff}
.sep{width:1px;height:18px;background:#1e2035;margin:0 2px}
.wrap{flex:1;overflow:hidden;position:relative;cursor:grab}
.wrap.dragging{cursor:grabbing}
#diagram{position:absolute;top:0;left:0;transform-origin:0 0;padding:20px}
#diagram svg{display:block}
.hint{color:#444;font-size:11px;margin-left:auto}
.count{color:#666;font-size:11px}
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
    panel.onDidDispose(() => tableInspectorPanels.delete(key));

    panel.webview.html = buildTableInspectorLoadingHtml(nonce, panel.webview.cspSource, schema, table);

    panel.webview.onDidReceiveMessage(async (msg: { command: string }) => {
        if (msg.command === 'runSelect') {
            const sql = buildSelectQuery(schema, table, dbType);
            await openScriptInSqlRunner('', sql);
        }
    });

    try {
        const details = await loadTableDetails(conn, schema, table);
        panel.webview.html = buildTableInspectorHtml(
            nonce, panel.webview.cspSource,
            schema, table, dbType,
            details.columns, details.constraints,
        );
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
    );
}

// ─── status bar ──────────────────────────────────────────────────────────────

function setupStatusBar(context: vscode.ExtensionContext): void {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    item.command = 'openbase.sqlRunner';
    context.subscriptions.push(item);

    function refresh(): void {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) { item.hide(); return; }
        const conn = findConnection(folder.uri.fsPath);
        if (!conn) { item.hide(); return; }
        item.text = `$(database) ${conn.label}`;
        item.tooltip = `OpenBase — ${conn.type} · Clique para abrir o SQL Runner`;
        item.show();
    }

    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(refresh),
        vscode.window.onDidChangeActiveTextEditor(refresh),
    );

    refresh();
}

// ─── activate ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
    panelProvider = new OpenBasePanelProvider();
    setupStatusBar(context);
    setupSqlTableBrowser(context);
    setupSqlScriptLibrary(context);
    setupHttpRequestLibrary(context);

    const reg = (id: string, fn: (uri?: vscode.Uri) => Promise<void>) =>
        vscode.commands.registerCommand(id, fn);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(OpenBasePanelProvider.viewType, panelProvider),
        vscode.window.registerWebviewViewProvider('openbase.sqlrunner.sidebar', new RunnerSidebarProvider('SQL Runner', 'Open SQL Runner', sqlRunner)),
        vscode.window.registerWebviewViewProvider('openbase.httprunner.sidebar', new RunnerSidebarProvider('HTTP Runner', 'Open HTTP Runner', httpRunner)),
        vscode.window.registerWebviewViewProvider('openbase.erdiagram.sidebar', new RunnerSidebarProvider('ER Diagram', 'Open ER Diagram', openErDiagram)),
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
