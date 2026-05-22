import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { execSync, exec } from 'child_process';

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
    private _runProcess?: import('child_process').ChildProcess;

    resolveWebviewView(view: vscode.WebviewView): void {
        view.webview.options = { enableScripts: true };
        view.webview.html = this._html();
        view.webview.onDidReceiveMessage(async (msg) => this._handle(msg, view));
    }

    private async _handle(msg: { command: string; data?: Record<string, string | boolean> }, view: vscode.WebviewView): Promise<void> {
        if (!await guardInstalled()) {
            view.webview.postMessage({ command: 'error', ctx: msg.data?.['ctx'] ?? '', text: 'OpenBase CLI not found.' });
            return;
        }
        switch (msg.command) {
            case 'pickFolder': {
                const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Select folder' });
                if (picked?.[0]) view.webview.postMessage({ command: 'folderPicked', path: picked[0].fsPath });
                break;
            }
            case 'newProject':   await this._new(msg.data as never, view);          break;
            case 'scaffold':     await this._scaffold(msg.data as never, view);     break;
            case 'specialist':   await this._specialist(msg.data as never, view);   break;
            case 'procedure':    await this._procedure(msg.data as never, view);    break;
            case 'extensionAdd': await this._extensionAdd(msg.data as never, view); break;
            case 'build':        await this._build(msg.data as never, view);        break;
            case 'run':          await this._run(msg.data as never, view);          break;
            case 'stopRun':      this._runProcess?.kill(); break;
            case 'update':       await this._exec('openbase update', await this._cwd() ?? process.cwd(), view, 'update', 'OpenBase: Update'); break;
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

    private async _scaffold(d: { entity: string; mode: string; schema: string; table: string; runMigrations: boolean }, view: vscode.WebviewView): Promise<void> {
        const cwd = await this._cwd();
        if (!cwd) { view.webview.postMessage({ command: 'done', ctx: 'sc' }); return; }

        if (d.mode === 'codefirst') {
            openTerminal('Scaffold', cwd, `openbase scaffold -e ${d.entity}`);
            view.webview.postMessage({ command: 'done', ctx: 'sc' });
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
            view.webview.postMessage({ command: 'done', ctx: 'pr' });
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

        const flags = d.noBuild ? ' --no-build' : '';
        const channel = vscode.window.createOutputChannel('OpenBase: Run');
        channel.show(true);

        const extraPath = dotnetToolsPath();
        const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };

        this._runProcess = exec(`openbase run -c ${d.configuration}${flags}`, { cwd, env });
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
        const channel = vscode.window.createOutputChannel(channelName);
        channel.show(true);
        const extraPath = dotnetToolsPath();
        const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
        return new Promise<boolean>((resolve) => {
            const child = exec(cmd, { cwd, env });
            child.stdout?.on('data', (chunk: string) => channel.append(chunk));
            child.stderr?.on('data', (chunk: string) => channel.append(chunk));
            child.on('close', (code) => {
                if (code === 0) {
                    view.webview.postMessage({ command: 'done', ctx });
                } else {
                    view.webview.postMessage({ command: 'error', ctx, text: `Command failed (exit ${code}). Check the output panel.` });
                }
                resolve(code === 0);
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
    input,select{width:100%;padding:4px 7px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);font-family:inherit;font-size:inherit;outline:none}
    input[type=checkbox]{width:auto}
    input:focus,select:focus{border-color:var(--vscode-focusBorder)}
    input::placeholder{color:var(--vscode-input-placeholderForeground)}
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
    .hint{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:6px}
  </style>
</head>
<body>
  <nav>
    <div class="nav-item active" data-page="new"    onclick="nav(this,'new')">New Project</div>
    <div class="nav-item"        data-page="sc"     onclick="nav(this,'sc')">Scaffold</div>
    <div class="nav-item"        data-page="sp"     onclick="nav(this,'sp')">Specialist</div>
    <div class="nav-item"        data-page="pr"     onclick="nav(this,'pr')">Procedure</div>
    <div class="nav-item"        data-page="ext"    onclick="nav(this,'ext')">Extension</div>
    <div class="nav-item"        data-page="build"  onclick="nav(this,'build')">Build</div>
    <div class="nav-item"        data-page="run"    onclick="nav(this,'run')">Run</div>
    <div class="nav-item"        data-page="update" onclick="nav(this,'update')">Update CLI</div>
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
    <button id="sc-btn" class="btn-primary" onclick="submitScaffold()" data-label="Run Scaffold">Run Scaffold</button>
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
    <div id="sp-sql-field" class="field"><label>SQL *</label><input id="sp-sql" type="text" placeholder="SELECT Nome FROM Produtos WHERE CategoriaId = {{categoriaId}}"></div>
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
    <button id="sp-btn" class="btn-primary" onclick="submitSpecialist()" data-label="Generate Specialist">Generate Specialist</button>
  </div>

  <!-- PROCEDURE -->
  <div id="page-pr" class="page">
    <div class="field"><label>Procedure name</label><input id="pr-name" type="text" placeholder="GetOrderById (leave empty to list from DB)"></div>
    <div class="field"><label>Schema</label><input id="pr-schema" type="text" placeholder="(auto-detect)"></div>
    <p class="hint">Deixe o nome em branco para listar as procedures do banco via terminal.</p>
    <div id="pr-err" class="err"></div>
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
    <button id="ext-btn" class="btn-primary" onclick="submitExtension()" data-label="Add Extension">Add Extension</button>
  </div>

  <!-- BUILD -->
  <div id="page-build" class="page">
    <div class="field"><label>Configuration</label>
      <select id="build-cfg"><option value="Debug">Debug</option><option value="Release">Release</option></select>
    </div>
    <div class="field"><label class="check-label"><input id="build-nr" type="checkbox"> Skip restore (--no-restore)</label></div>
    <div id="build-err" class="err"></div>
    <button id="build-btn" class="btn-primary" onclick="submitBuild()" data-label="Build">Build</button>
  </div>

  <!-- RUN -->
  <div id="page-run" class="page">
    <div class="field"><label>Configuration</label>
      <select id="run-cfg"><option value="Debug">Debug</option><option value="Release">Release</option></select>
    </div>
    <div class="field"><label class="check-label"><input id="run-nb" type="checkbox"> Skip build (--no-build)</label></div>
    <div id="run-err" class="err"></div>
    <button id="run-btn" class="btn-primary" onclick="submitRun()" data-label="Run">Run</button>
    <button id="run-stop" class="btn-danger hidden" onclick="stopRun()">Stop</button>
  </div>

  <!-- UPDATE -->
  <div id="page-update" class="page">
    <p class="hint" style="margin-bottom:10px">Atualiza o OpenBase CLI e templates para a versão mais recente.</p>
    <div id="update-err" class="err"></div>
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
      if (!el) return;
      el.textContent = msg;
      el.style.display = msg ? 'block' : 'none';
    }
    function loading(ctx, on) {
      var btn = document.getElementById(ctx + '-btn');
      if (!btn) return;
      btn.disabled = on;
      btn.textContent = on ? 'Running…' : (btn.dataset.label || btn.textContent);
    }

    window.addEventListener('message', function(e) {
      var m = e.data;
      if (m.command === 'folderPicked') {
        document.getElementById('new-folder').value = m.path;
      } else if (m.command === 'done') {
        loading(m.ctx, false);
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

// ─── activate ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
    const reg = (id: string, fn: (uri?: vscode.Uri) => Promise<void>) =>
        vscode.commands.registerCommand(id, fn);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(OpenBasePanelProvider.viewType, new OpenBasePanelProvider()),
        reg('openbase.newProject',    newProject),
        reg('openbase.scaffold',      scaffold),
        reg('openbase.scaffoldUpdate', scaffoldUpdate),
        reg('openbase.specialist',    specialist),
        reg('openbase.procedure',     procedure),
        reg('openbase.extensionAdd',  extensionAdd),
        reg('openbase.extensionList', extensionList),
        reg('openbase.build',         build),
        reg('openbase.run',           run),
        reg('openbase.update',        update),
        reg('openbase.history',       history),
        reg('openbase.version',       version),
    );
}

export function deactivate(): void {}
