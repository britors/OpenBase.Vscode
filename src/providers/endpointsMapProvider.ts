import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { HttpRequestData } from './httpRequestLibraryProvider';

const HTTP_METHODS = ['Get', 'Post', 'Put', 'Delete', 'Patch', 'Head', 'Options'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

interface EndpointInfo {
    method: HttpMethod;
    route: string;
    action: string;
    controller: string;
}

const METHOD_BADGE: Record<HttpMethod, string> = {
    Get: 'GET',
    Post: 'POST',
    Put: 'PUT',
    Delete: 'DEL',
    Patch: 'PATCH',
    Head: 'HEAD',
    Options: 'OPT',
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
            Get: 'arrow-down',
            Post: 'arrow-up',
            Put: 'edit',
            Delete: 'trash',
            Patch: 'diff-modified',
            Head: 'eye',
            Options: 'settings-gear',
        };
        this.iconPath = new vscode.ThemeIcon(iconMap[endpoint.method]);
    }
}

function scanEndpoints(cwd: string): EndpointInfo[] {
    const results: EndpointInfo[] = [];

    const csFiles: string[] = [];
    const walk = (dir: string): void => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (e.isDirectory()) {
                if (['bin', 'obj', 'node_modules', '.git'].includes(e.name)) continue;
                walk(path.join(dir, e.name));
            } else if (e.isFile() && e.name.endsWith('.cs')) {
                csFiles.push(path.join(dir, e.name));
            }
        }
    };
    walk(cwd);

    for (const file of csFiles) {
        let src: string;
        try {
            src = fs.readFileSync(file, 'utf-8');
        } catch {
            continue;
        }

        const classMatch = src.match(/\bclass\s+(\w+Controller)\b/);
        if (classMatch) {
            const controllerName = classMatch[1].replace(/Controller$/, '');
            const baseRouteMatch = src.match(/\[Route\(\s*["']([^"']+)["']/);
            const baseRoute = baseRouteMatch
                ? baseRouteMatch[1].replace('[controller]', controllerName.toLowerCase())
                : controllerName.toLowerCase();

            for (const m of HTTP_METHODS) {
                const re = new RegExp(
                    `\\[Http${m}(?:\\(\\s*["']([^"']*)["']\\s*\\))?\\]\\s*(?:\\[[^\\]]*\\]\\s*)*(?:public\\s+[\\w<>\\[\\],\\s]+\\s+(\\w+)\\s*\\()`,
                    'g'
                );
                let match: RegExpExecArray | null;
                while ((match = re.exec(src)) !== null) {
                    const sub = match[1] ?? '';
                    const action = match[2] ?? '';
                    const route = ('/' + [baseRoute, sub].filter(Boolean).join('/')).replace(/\/+/g, '/');
                    results.push({ method: m, route, action, controller: controllerName });
                }
            }
        }

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

class EndpointsMapProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private data: EndpointInfo[] = [];

    constructor(private readonly cwd: string) {}

    refresh(): void {
        this.data = scanEndpoints(this.cwd);
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(e: vscode.TreeItem): vscode.TreeItem {
        return e;
    }

    getChildren(element?: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem[]> {
        if (!element) {
            if (!this.data.length) {
                return [new vscode.TreeItem('No endpoints found - open a .NET workspace')];
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
            return element.endpoints.map((ep) => new EndpointItem(ep));
        }
        return [];
    }
}

export interface EndpointsMapProviderDeps {
    getHttpPanel: () => vscode.WebviewPanel | undefined;
    setPendingRequest: (data: HttpRequestData) => void;
    openHttpRunner: () => Promise<void>;
}

export function setupEndpointsMap(context: vscode.ExtensionContext, deps: EndpointsMapProviderDeps): void {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return;

    const endpointsProvider = new EndpointsMapProvider(cwd);

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.cs');
    context.subscriptions.push(
        watcher,
        watcher.onDidChange(() => endpointsProvider.refresh()),
        watcher.onDidCreate(() => endpointsProvider.refresh()),
        watcher.onDidDelete(() => endpointsProvider.refresh())
    );

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('openbase.httprunner.endpoints', endpointsProvider),
        vscode.commands.registerCommand('openbase.endpointsMap.refresh', () => endpointsProvider.refresh()),
        vscode.commands.registerCommand('openbase.endpointsMap.open', async (item: EndpointItem) => {
            if (!(item instanceof EndpointItem)) return;
            const { method, route } = item.endpoint;
            const data: HttpRequestData = { method: method.toUpperCase(), url: '{{LOCAL_URL}}' + route };
            const panel = deps.getHttpPanel();
            if (panel) {
                panel.reveal(vscode.ViewColumn.One);
                panel.webview.postMessage({ command: 'loadRequest', ...data });
            } else {
                deps.setPendingRequest(data);
                await deps.openHttpRunner();
            }
        })
    );

    endpointsProvider.refresh();
}
