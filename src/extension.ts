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

// ─── debug ──────────────────────────────────────────────────────────────────

async function debugRun(uri?: vscode.Uri): Promise<void> {
    if (!await guardInstalled()) return;

    const config = await vscode.window.showQuickPick(
        BUILD_CONFIGS.map((c): vscode.QuickPickItem => ({ label: c })),
        { title: 'OpenBase: Debug — Configuration' }
    );
    if (!config) return;

    const noBuild = await vscode.window.showQuickPick(
        [{ label: 'No', description: 'Build before debug' },
         { label: 'Yes', description: 'Skip build step' }],
        { title: 'OpenBase: Debug — Skip build?' }
    );
    if (!noBuild) return;

    const cwd = await resolveWorkingDir(uri);
    if (!cwd) return;

    if (noBuild.label === 'No') {
        const channel = vscode.window.createOutputChannel('OpenBase: Debug Build');
        channel.show(true);
        const extraPath = dotnetToolsPath();
        const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
        const ok = await new Promise<boolean>((resolve) => {
            const child = exec(`openbase build -c ${config.label}`, { cwd, env });
            child.stdout?.on('data', (d: string) => channel.append(d));
            child.stderr?.on('data', (d: string) => channel.append(d));
            child.on('close', (code) => resolve(code === 0));
            child.on('error', (err) => { channel.appendLine(err.message); resolve(false); });
        });
        if (!ok) {
            vscode.window.showErrorMessage('Build failed. Check the output panel.');
            return;
        }
    }

    const project = findEntryProject(cwd);
    if (!project) {
        vscode.window.showErrorMessage('No .csproj found in workspace.');
        return;
    }

    const dllPath = path.join(path.dirname(project.csprojPath), 'bin', config.label, project.targetFramework, `${project.assemblyName}.dll`);
    if (!fs.existsSync(dllPath)) {
        vscode.window.showErrorMessage(`Built output not found: ${dllPath}`);
        return;
    }

    const folder = vscode.workspace.workspaceFolders?.[0];
    const started = await vscode.debug.startDebugging(folder, {
        type: 'coreclr',
        request: 'launch',
        name: 'OpenBase Debug',
        program: dllPath,
        cwd: path.dirname(project.csprojPath),
        stopAtEntry: false,
        env: { ASPNETCORE_ENVIRONMENT: 'Development' },
        serverReadyAction: { action: 'openExternally', pattern: '\\bNow listening on:\\s+(https?://\\S+)' },
    });

    if (!started) {
        vscode.window.showErrorMessage('Failed to start debugger. Is the C# extension installed?');
    }
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
            case 'debug':        await this._debug(msg.data as never, view);        break;
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

    private async _debug(d: { configuration: string; noBuild: boolean }, view: vscode.WebviewView): Promise<void> {
        const cwd = await this._cwd();
        if (!cwd) { view.webview.postMessage({ command: 'done', ctx: 'debug' }); return; }

        if (!d.noBuild) {
            const ok = await this._exec(`openbase build -c ${d.configuration}`, cwd, view, 'debug', 'OpenBase: Debug Build');
            if (!ok) return;
        }

        const project = findEntryProject(cwd);
        if (!project) {
            view.webview.postMessage({ command: 'error', ctx: 'debug', text: 'No .csproj found in workspace.' });
            return;
        }

        const dllPath = path.join(path.dirname(project.csprojPath), 'bin', d.configuration, project.targetFramework, `${project.assemblyName}.dll`);
        if (!fs.existsSync(dllPath)) {
            view.webview.postMessage({ command: 'error', ctx: 'debug', text: `Built output not found: ${dllPath}` });
            return;
        }

        const folder = vscode.workspace.workspaceFolders?.[0];
        const started = await vscode.debug.startDebugging(folder, {
            type: 'coreclr',
            request: 'launch',
            name: 'OpenBase Debug',
            program: dllPath,
            cwd: path.dirname(project.csprojPath),
            stopAtEntry: false,
            env: { ASPNETCORE_ENVIRONMENT: 'Development' },
            serverReadyAction: { action: 'openExternally', pattern: '\\bNow listening on:\\s+(https?://\\S+)' },
        });

        if (started) {
            view.webview.postMessage({ command: 'done', ctx: 'debug', text: 'Debugger launched.' });
        } else {
            view.webview.postMessage({ command: 'error', ctx: 'debug', text: 'Failed to start debugger. Is the C# extension installed?' });
        }
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
    <div class="nav-item"        data-page="debug"   onclick="nav(this,'debug')">Debug</div>
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
  <div id="page-debug" class="page">
    <div class="field"><label>Configuration</label>
      <select id="debug-cfg"><option value="Debug">Debug</option><option value="Release">Release</option></select>
    </div>
    <div class="field"><label class="check-label"><input id="debug-nb" type="checkbox"> Skip build (--no-build)</label></div>
    <p class="hint" style="margin-top:6px">Requer a extensão C# (coreclr) instalada no VS Code.</p>
    <div id="debug-err" class="err"></div>
    <div id="debug-ok" class="ok"></div>
    <button id="debug-btn" class="btn-primary" onclick="submitDebug()" data-label="Build &amp; Debug">Build &amp; Debug</button>
  </div>

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
      btn.textContent = '×';
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
      btn.textContent = on ? 'Running…' : (btn.dataset.label || btn.textContent);
      if (on) { ok(ctx, ''); err(ctx, ''); }
    }

    window.addEventListener('message', function(e) {
      var m = e.data;
      if (m.command === 'folderPicked') {
        document.getElementById('new-folder').value = m.path;
      } else if (m.command === 'done') {
        loading(m.ctx, false);
        if (m.text) ok(m.ctx, m.text);
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

    function submitDebug() {
      err('debug', '');
      loading('debug', true);
      vscode.postMessage({ command: 'debug', data: {
        configuration: document.getElementById('debug-cfg').value,
        noBuild: document.getElementById('debug-nb').checked,
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

let sqlPanel: vscode.WebviewPanel | undefined;
let sqlProcess: import('child_process').ChildProcess | undefined;

async function sqlRunner(): Promise<void> {
    if (sqlPanel) { sqlPanel.reveal(vscode.ViewColumn.One); return; }

    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const conn = cwd ? findConnection(cwd) : undefined;

    sqlPanel = vscode.window.createWebviewPanel(
        'openbase.sqlRunner', 'OpenBase SQL', vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    sqlPanel.onDidDispose(() => { sqlPanel = undefined; });
    sqlPanel.webview.html = buildSqlRunnerHtml(conn);

    sqlPanel.webview.onDidReceiveMessage(async (msg: { command: string; sql?: string; csvData?: string; csvName?: string }) => {
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

        if (msg.command !== 'run' || !msg.sql?.trim()) return;
        const sql = msg.sql.trim();

        // Re-detect connection at query time so workspace changes are picked up
        const activeCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const activeConn = activeCwd ? findConnection(activeCwd) : undefined;

        if (!activeConn) {
            sqlPanel?.webview.postMessage({ command: 'error', text: 'No OpenBase project found in workspace.\nappsettings.json with ConnectionStrings is required.' });
            return;
        }

        sqlPanel?.webview.postMessage({ command: 'running' });

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

            const output = await new Promise<string>((resolve, reject) => {
                const child = exec(cmd, { env, timeout: 30000 }, (err, stdout, stderr) => {
                    sqlProcess = undefined;
                    if (err && !stdout) reject(new Error(stderr || err.message));
                    else resolve(stdout + (stderr ? '\n' + stderr : ''));
                });
                sqlProcess = child;
            });

            const result = parseSqlOutput(output, activeConn.type);
            sqlPanel?.webview.postMessage({ command: 'result', ...result });
        } catch (e: unknown) {
            const text = e instanceof Error ? e.message : String(e);
            sqlPanel?.webview.postMessage({ command: 'error', text });
        } finally {
            try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        }
    });
}

function buildSqlRunnerHtml(conn: DbConnection | undefined): string {
    const connLabel = (conn?.label ?? 'No connection')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%;overflow:hidden}
  body{display:flex;flex-direction:column;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background)}

  .header{display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}
  .header-title{font-weight:600;font-size:13px}
  .badge{padding:2px 8px;border-radius:3px;font-size:11px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
  .badge.warn{background:var(--vscode-inputValidation-warningBackground);color:var(--vscode-inputValidation-warningForeground,#000)}

  .editor-wrap{flex:0 0 200px;display:flex;flex-direction:column;border-bottom:1px solid var(--vscode-panel-border)}
  textarea{flex:1;width:100%;resize:none;border:none;outline:none;padding:10px 12px;font-family:var(--vscode-editor-font-family,monospace);font-size:var(--vscode-editor-font-size,13px);line-height:1.5;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);tab-size:2}
  textarea::placeholder{color:var(--vscode-input-placeholderForeground)}

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
</style>
</head>
<body>
<div class="header">
  <span class="header-title">OpenBase SQL</span>
  <span class="badge ${conn ? '' : 'warn'}">${connLabel}</span>
</div>
<div class="editor-wrap">
  <textarea id="sql" placeholder="SELECT * FROM ..." spellcheck="false" autofocus></textarea>
</div>
<div class="toolbar">
  <button id="run-btn" class="btn btn-primary">▶ Run</button>
  <button id="cancel-btn" class="btn btn-cancel hidden">✕ Cancel</button>
  <span class="hint">F8 to run</span>
  <span id="status" class="status"></span>
</div>
<div id="results" class="results">
  <p class="placeholder">Write a query above and press Run or F8</p>
</div>

<script>
  const vscode = acquireVsCodeApi();
  let running = false, t0 = 0;
  let lastColumns = [], lastRows = [];
  let runTimeoutId = null;

  document.getElementById('run-btn').addEventListener('click', run);
  document.getElementById('cancel-btn').addEventListener('click', function() {
    clearRunTimeout();
    vscode.postMessage({ command: 'cancel' });
  });
  document.getElementById('results').addEventListener('click', function(e) {
    if (e.target && e.target.id === 'export-csv-btn') exportCsv();
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'F8') { e.preventDefault(); run(); }
  });

  document.getElementById('sql').addEventListener('keydown', function(e) {
    if (e.key === 'Tab') {
      e.preventDefault();
      var s = this.selectionStart, end = this.selectionEnd;
      this.value = this.value.substring(0, s) + '  ' + this.value.substring(end);
      this.selectionStart = this.selectionEnd = s + 2;
    }
  });

  function clearRunTimeout() {
    if (runTimeoutId) { clearTimeout(runTimeoutId); runTimeoutId = null; }
  }

  function run() {
    if (running) return;
    var sqlEl = document.getElementById('sql');
    var sql = sqlEl ? sqlEl.value.trim() : '';
    if (!sql) {
      document.getElementById('results').innerHTML = '<p class="placeholder">Enter a SQL query above before running.</p>';
      return;
    }

    // Immediate feedback — don't wait for extension to respond
    running = true;
    t0 = Date.now();
    document.getElementById('run-btn').classList.add('hidden');
    document.getElementById('cancel-btn').classList.remove('hidden');
    document.getElementById('results').innerHTML = '';
    setStatus('<span class="spinner"></span> Sending…');

    // Client-side safety timeout in case extension never responds
    runTimeoutId = setTimeout(function() {
      running = false;
      document.getElementById('run-btn').classList.remove('hidden');
      document.getElementById('cancel-btn').classList.add('hidden');
      setStatus('');
      document.getElementById('results').innerHTML =
        '<div class="err-box">Extension did not respond after 10s.\nMake sure an OpenBase project with appsettings.json is open in the workspace.</div>';
    }, 10000);

    vscode.postMessage({ command: 'run', sql: sql });
  }

  function exportCsv() {
    if (!lastColumns.length) return;
    var lines = [lastColumns.map(csvCell).join(',')];
    for (var r = 0; r < lastRows.length; r++) {
      lines.push(lastRows[r].map(csvCell).join(','));
    }
    var csv = lines.join('\r\n');
    var name = 'query_' + new Date().toISOString().slice(0,19).replace(/[T:]/g,'-') + '.csv';
    vscode.postMessage({ command: 'saveCsv', csvData: csv, csvName: name });
  }

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  window.addEventListener('message', function(e) {
    var m = e.data;
    if (m.command === 'triggerRun') { run(); return; }
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
    var infoMsg  = message ? ' · ' + esc(message) : '';
    var hdr  = '<div class="result-header">'
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
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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

    if (httpPanel) { httpPanel.reveal(vscode.ViewColumn.One); return; }

    httpPanel = vscode.window.createWebviewPanel(
        'openbase.httpRunner', 'OpenBase HTTP', vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    httpPanel.onDidDispose(() => { httpPanel = undefined; });
    httpPanel.webview.html = buildHttpRunnerHtml(baseUrl);

    httpPanel.webview.onDidReceiveMessage(async (msg: {
        command: string;
        method?: string;
        url?: string;
        headers?: Record<string, string>;
        body?: string;
    }) => {
        if (msg.command !== 'send') return;
        const { method = 'GET', url = '', headers = {}, body } = msg;
        try {
            const result = await doHttpRequest(method, url, headers, body);
            httpPanel?.webview.postMessage({ command: 'response', ...result });
        } catch (e: unknown) {
            httpPanel?.webview.postMessage({ command: 'error', text: e instanceof Error ? e.message : String(e) });
        }
    });
}

function buildHttpRunnerHtml(baseUrl: string): string {
    const safeBase = JSON.stringify(baseUrl);
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
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

<script>
  const vscode = acquireVsCodeApi();
  let sending = false;
  const BASE_URL = ${safeBase};

  // init
  if (BASE_URL) document.getElementById('url-input').value = BASE_URL + '/api/';
  addHeader('Content-Type', 'application/json');
  addHeader('Accept', 'application/json');

  document.getElementById('send-btn').addEventListener('click', sendRequest);
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

  // ── request tabs ───────────────────────────────────────────────────
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

  // ── headers ────────────────────────────────────────────────────────
  function addHeader(k, v) {
    var row = document.createElement('div');
    row.className = 'kv-row';
    var ki = document.createElement('input'); ki.className = 'key'; ki.type = 'text'; ki.value = k || ''; ki.placeholder = 'Header name';
    var vi = document.createElement('input'); vi.className = 'val'; vi.type = 'text'; vi.value = v || ''; vi.placeholder = 'Value';
    var rm = document.createElement('button'); rm.className = 'btn-ghost'; rm.textContent = '×'; rm.onclick = function() { row.remove(); };
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

  // ── body type ──────────────────────────────────────────────────────
  function onBodyType() {
    var t = document.getElementById('body-type').value;
    var txt = document.getElementById('body-text');
    txt.classList.toggle('hidden', t === 'none');
    if (t === 'json')      txt.placeholder = '{\n  "key": "value"\n}';
    else if (t === 'form') txt.placeholder = 'key1=value1&key2=value2';
    else                   txt.placeholder = 'Request body...';
  }

  var sendTimeoutId = null;
  function clearSendTimeout() {
    if (sendTimeoutId) { clearTimeout(sendTimeoutId); sendTimeoutId = null; }
  }

  // ── send ───────────────────────────────────────────────────────────
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
            showError('Invalid JSON body — fix the syntax before sending.');
            return;
          }
        }
      }
      if (bodyType === 'form') hdrs['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    sending = true;
    document.getElementById('send-btn').disabled = true;
    document.getElementById('res-bar').innerHTML = '<span class="spinner"></span><span class="meta">Sending…</span>';
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

  // ── messages ───────────────────────────────────────────────────────
  window.addEventListener('message', function(e) {
    var m = e.data;
    if (m.command === 'triggerSend') { sendRequest(); return; }
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
      '<span class="meta">·</span>' +
      '<span class="meta">' + size + '</span>' +
      '<button id="copy-btn" class="btn btn-secondary" style="margin-left:auto;font-size:11px;padding:2px 8px" onclick="copyBody()">Copy</button>';
    document.getElementById('res-tab-strip').classList.remove('hidden');

    // body
    var ct = flatHeader(m.headers, 'content-type') || '';
    var bodyHtml;
    if (/application\/json/i.test(ct) || looksLikeJson(m.body)) {
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

  // ── helpers ────────────────────────────────────────────────────────
  function flatHeader(hdrs, name) {
    var v = hdrs[name] || hdrs[name.split('-').map(function(p,i){return i===0?p:p[0].toUpperCase()+p.slice(1);}).join('-')];
    return Array.isArray(v) ? v[0] : (v || '');
  }

  function looksLikeJson(s) {
    if (!s) return false; var t = s.trim(); return t[0] === '{' || t[0] === '[';
  }

  function syntaxHighlight(json) {
    return json.replace(
      /("(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\\b(?:true|false|null)\\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
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
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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

    const reg = (id: string, fn: (uri?: vscode.Uri) => Promise<void>) =>
        vscode.commands.registerCommand(id, fn);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(OpenBasePanelProvider.viewType, panelProvider),
        vscode.window.registerWebviewViewProvider('openbase.sqlrunner.sidebar', new RunnerSidebarProvider('SQL Runner', 'Open SQL Runner', sqlRunner)),
        vscode.window.registerWebviewViewProvider('openbase.httprunner.sidebar', new RunnerSidebarProvider('HTTP Runner', 'Open HTTP Runner', httpRunner)),
        reg('openbase.newProject',     newProject),
        reg('openbase.scaffold',       scaffold),
        reg('openbase.scaffoldUpdate', scaffoldUpdate),
        reg('openbase.specialist',     specialist),
        reg('openbase.procedure',      procedure),
        reg('openbase.extensionAdd',   extensionAdd),
        reg('openbase.extensionList',  extensionList),
        reg('openbase.build',          build),
        reg('openbase.debug',          debugRun),
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
