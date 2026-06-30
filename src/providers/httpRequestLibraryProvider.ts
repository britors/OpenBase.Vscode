import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const HTTP_REQUESTS_SUBDIR = path.join('.openbase', 'http-runner', 'requests');

type RequestItemKind = 'script' | 'folder';

export interface HttpRequestData {
    method?: string;
    url?: string;
    headers?: Array<{ name: string; value: string }>;
    bodyType?: string;
    body?: string;
    authToken?: string;
}

class HttpRequestItem extends vscode.TreeItem {
    constructor(
        public readonly fsPath: string,
        public readonly kind: RequestItemKind
    ) {
        const basename = path.basename(fsPath);
        const label = kind === 'script' ? basename.replace(/\.json$/i, '') : basename;
        super(label, kind === 'folder' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
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

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(e: HttpRequestItem): vscode.TreeItem {
        return e;
    }

    getChildren(element?: HttpRequestItem): vscode.ProviderResult<HttpRequestItem[]> {
        const dir = element ? element.fsPath : getRequestsDir();
        if (!dir || !fs.existsSync(dir)) return [];
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            const folders = entries
                .filter((e) => e.isDirectory())
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((e) => new HttpRequestItem(path.join(dir, e.name), 'folder'));
            const files = entries
                .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json'))
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((e) => new HttpRequestItem(path.join(dir, e.name), 'script'));
            return [...folders, ...files];
        } catch {
            return [];
        }
    }
}

export function getRequestsDir(): string | undefined {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return cwd ? path.join(cwd, HTTP_REQUESTS_SUBDIR) : undefined;
}

export interface HttpRequestLibraryProviderDeps {
    getHttpPanel: () => vscode.WebviewPanel | undefined;
    openHttpRunner: () => Promise<void>;
    setPendingRequest: (data: HttpRequestData) => void;
    promptScriptName: (prompt: string, initial?: string) => Promise<string | undefined>;
    importSwaggerToHttpRunner: () => Promise<void>;
}

export function setupHttpRequestLibrary(context: vscode.ExtensionContext, deps: HttpRequestLibraryProviderDeps): void {
    const httpRequestProvider = new HttpRequestTreeProvider();

    const openRequestInHttpRunner = async (filePath: string): Promise<void> => {
        let data: HttpRequestData = {};
        try {
            data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as HttpRequestData;
        } catch {
            // use defaults
        }

        const panel = deps.getHttpPanel();
        if (panel) {
            panel.reveal(vscode.ViewColumn.One);
            panel.webview.postMessage({ command: 'loadRequest', ...data });
        } else {
            deps.setPendingRequest(data);
            await deps.openHttpRunner();
        }
    };

    context.subscriptions.push(
        vscode.window.createTreeView('openbase.httprunner.requests', {
            treeDataProvider: httpRequestProvider,
            showCollapseAll: true,
        }),
        (() => {
            const w = vscode.workspace.createFileSystemWatcher(`**/${HTTP_REQUESTS_SUBDIR}/**`);
            w.onDidCreate(() => httpRequestProvider.refresh());
            w.onDidDelete(() => httpRequestProvider.refresh());
            w.onDidChange(() => httpRequestProvider.refresh());
            return w;
        })(),
        vscode.workspace.onDidChangeWorkspaceFolders(() => httpRequestProvider.refresh()),
        vscode.commands.registerCommand('openbase.httpRunner.requests.refresh', () => httpRequestProvider.refresh()),
        vscode.commands.registerCommand('openbase.httpRunner.requests.new', async (item?: HttpRequestItem) => {
            const baseDir = (item?.kind === 'folder' ? item.fsPath : undefined) ?? getRequestsDir();
            if (!baseDir) {
                vscode.window.showErrorMessage('No workspace folder open.');
                return;
            }
            const name = await deps.promptScriptName('Request name');
            if (!name) return;
            const file = path.join(baseDir, name.replace(/\.json$/i, '') + '.json');
            if (fs.existsSync(file)) {
                vscode.window.showErrorMessage(`"${path.basename(file)}" already exists.`);
                return;
            }
            fs.mkdirSync(baseDir, { recursive: true });
            fs.writeFileSync(
                file,
                JSON.stringify({ method: 'GET', url: '', headers: [], bodyType: 'none', body: '', authToken: '' }, null, 2),
                'utf-8'
            );
            httpRequestProvider.refresh();
            await openRequestInHttpRunner(file);
        }),
        vscode.commands.registerCommand('openbase.httpRunner.requests.newFolder', async (item?: HttpRequestItem) => {
            const baseDir = (item?.kind === 'folder' ? item.fsPath : undefined) ?? getRequestsDir();
            if (!baseDir) {
                vscode.window.showErrorMessage('No workspace folder open.');
                return;
            }
            const name = await deps.promptScriptName('Folder name');
            if (!name) return;
            fs.mkdirSync(path.join(baseDir, name), { recursive: true });
            httpRequestProvider.refresh();
        }),
        vscode.commands.registerCommand('openbase.httpRunner.requests.open', async (item: HttpRequestItem) => openRequestInHttpRunner(item.fsPath)),
        vscode.commands.registerCommand('openbase.httpRunner.requests.rename', async (item: HttpRequestItem) => {
            const old = path.basename(item.fsPath);
            const display = item.kind === 'script' ? old.replace(/\.json$/i, '') : old;
            const name = await deps.promptScriptName('Rename to', display);
            if (!name || name === display) return;
            const newName = item.kind === 'script' ? name.replace(/\.json$/i, '') + '.json' : name;
            fs.renameSync(item.fsPath, path.join(path.dirname(item.fsPath), newName));
            httpRequestProvider.refresh();
        }),
        vscode.commands.registerCommand('openbase.httpRunner.requests.delete', async (item: HttpRequestItem) => {
            const name = path.basename(item.fsPath);
            const ans = await vscode.window.showWarningMessage(`Delete "${name}"?`, { modal: true }, 'Delete');
            if (ans !== 'Delete') return;
            if (item.kind === 'folder') fs.rmSync(item.fsPath, { recursive: true, force: true });
            else fs.unlinkSync(item.fsPath);
            httpRequestProvider.refresh();
        }),
        vscode.commands.registerCommand('openbase.httpRunner.requests.importSwagger', () => deps.importSwaggerToHttpRunner())
    );
}
