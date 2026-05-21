import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

const DB_TEMPLATES = ['sqlserver', 'pgsql', 'oracle'] as const;
const BUILD_CONFIGS = ['Debug', 'Release'] as const;
const EXTENSIONS = ['jwt', 'cache', 'healthchecks'] as const;
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
        title: 'OpenBase: New Project',
        prompt: 'Project name',
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
        { title: 'OpenBase: Select database template', placeHolder: 'Choose a database' }
    );
    if (!template) return;

    const cwd = await resolveWorkingDir(uri);
    if (!cwd) return;

    openTerminal('New Project', cwd, `openbase new -n ${projectName} -s ${template.label}`);
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
        title: 'OpenBase: Specialist',
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

    openTerminal('Specialist', cwd, `openbase specialist -e ${entity}`);
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
    try {
        const output = execSync('openbase version show', { encoding: 'utf-8' }).trim();
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

// ─── activate ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
    const reg = (id: string, fn: (uri?: vscode.Uri) => Promise<void>) =>
        vscode.commands.registerCommand(id, fn);

    context.subscriptions.push(
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
