import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const SQL_SCRIPTS_SUBDIR = path.join('.openbase', 'sql-runner', 'scripts');

type ScriptItemKind = 'script' | 'folder';

export interface SqlScriptLibraryDeps {
    openScript: (content: string, name: string) => Promise<void>;
}

class SqlScriptItem extends vscode.TreeItem {
    constructor(
        public readonly fsPath: string,
        public readonly kind: ScriptItemKind,
    ) {
        const basename = path.basename(fsPath);
        const label = kind === 'script' ? basename.replace(/\.sql$/i, '') : basename;
        super(
            label,
            kind === 'folder'
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None,
        );
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

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(e: SqlScriptItem): vscode.TreeItem {
        return e;
    }

    getChildren(element?: SqlScriptItem): vscode.ProviderResult<SqlScriptItem[]> {
        const dir = element ? element.fsPath : getScriptsDir();
        if (!dir || !fs.existsSync(dir)) return [];
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            const folders = entries
                .filter((e) => e.isDirectory())
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((e) => new SqlScriptItem(path.join(dir, e.name), 'folder'));
            const scripts = entries
                .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.sql'))
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((e) => new SqlScriptItem(path.join(dir, e.name), 'script'));
            return [...folders, ...scripts];
        } catch {
            return [];
        }
    }
}

export function getScriptsDir(): string | undefined {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return cwd ? path.join(cwd, SQL_SCRIPTS_SUBDIR) : undefined;
}

export async function promptScriptName(prompt: string, initial?: string): Promise<string | undefined> {
    const raw = await vscode.window.showInputBox({
        prompt,
        value: initial,
        placeHolder: 'my-query',
        validateInput: (v) =>
            v?.trim() && /^[^\\/:\*\?"<>\|]+$/.test(v.trim()) ? undefined : 'Invalid name',
    });
    return raw?.trim();
}

export function setupSqlScriptLibrary(context: vscode.ExtensionContext, deps: SqlScriptLibraryDeps): void {
    const sqlScriptProvider = new SqlScriptTreeProvider();

    const openScriptInSqlRunner = async (filePath: string, directContent?: string): Promise<void> => {
        const content = directContent ?? fs.readFileSync(filePath, 'utf-8');
        const name = directContent ? '' : path.basename(filePath);
        await deps.openScript(content, name);
    };

    context.subscriptions.push(
        vscode.window.createTreeView('openbase.sqlrunner.scripts', {
            treeDataProvider: sqlScriptProvider,
            showCollapseAll: true,
        }),

        (() => {
            const w = vscode.workspace.createFileSystemWatcher(`**/${SQL_SCRIPTS_SUBDIR}/**`);
            w.onDidCreate(() => sqlScriptProvider.refresh());
            w.onDidDelete(() => sqlScriptProvider.refresh());
            w.onDidChange(() => sqlScriptProvider.refresh());
            return w;
        })(),

        vscode.workspace.onDidChangeWorkspaceFolders(() => sqlScriptProvider.refresh()),

        vscode.commands.registerCommand('openbase.sqlRunner.scripts.refresh', () => sqlScriptProvider.refresh()),

        vscode.commands.registerCommand('openbase.sqlRunner.scripts.new', async (item?: SqlScriptItem) => {
            const baseDir = (item?.kind === 'folder' ? item.fsPath : undefined) ?? getScriptsDir();
            if (!baseDir) {
                vscode.window.showErrorMessage('No workspace folder open.');
                return;
            }
            const name = await promptScriptName('Script name');
            if (!name) return;
            const file = path.join(baseDir, name.replace(/\.sql$/i, '') + '.sql');
            if (fs.existsSync(file)) {
                vscode.window.showErrorMessage(`"${path.basename(file)}" already exists.`);
                return;
            }
            fs.mkdirSync(baseDir, { recursive: true });
            fs.writeFileSync(file, '', 'utf-8');
            sqlScriptProvider.refresh();
            await openScriptInSqlRunner(file);
        }),

        vscode.commands.registerCommand('openbase.sqlRunner.scripts.newFolder', async (item?: SqlScriptItem) => {
            const baseDir = (item?.kind === 'folder' ? item.fsPath : undefined) ?? getScriptsDir();
            if (!baseDir) {
                vscode.window.showErrorMessage('No workspace folder open.');
                return;
            }
            const name = await promptScriptName('Folder name');
            if (!name) return;
            fs.mkdirSync(path.join(baseDir, name), { recursive: true });
            sqlScriptProvider.refresh();
        }),

        vscode.commands.registerCommand('openbase.sqlRunner.scripts.open', async (item: SqlScriptItem) =>
            openScriptInSqlRunner(item.fsPath),
        ),

        vscode.commands.registerCommand('openbase.sqlRunner.scripts.rename', async (item: SqlScriptItem) => {
            const old = path.basename(item.fsPath);
            const display = item.kind === 'script' ? old.replace(/\.sql$/i, '') : old;
            const name = await promptScriptName('Rename to', display);
            if (!name || name === display) return;
            const newName = item.kind === 'script' ? name.replace(/\.sql$/i, '') + '.sql' : name;
            fs.renameSync(item.fsPath, path.join(path.dirname(item.fsPath), newName));
            sqlScriptProvider.refresh();
        }),

        vscode.commands.registerCommand('openbase.sqlRunner.scripts.delete', async (item: SqlScriptItem) => {
            const name = path.basename(item.fsPath);
            const ans = await vscode.window.showWarningMessage(`Delete "${name}"?`, { modal: true }, 'Delete');
            if (ans !== 'Delete') return;
            if (item.kind === 'folder') fs.rmSync(item.fsPath, { recursive: true, force: true });
            else fs.unlinkSync(item.fsPath);
            sqlScriptProvider.refresh();
        }),
    );
}
