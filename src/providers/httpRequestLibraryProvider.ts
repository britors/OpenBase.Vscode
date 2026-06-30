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
}

interface OApiSchema {
    type?: string;
    properties?: Record<string, OApiSchema>;
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
    parameters?: Array<{ name: string; in: string }>;
    requestBody?: { content?: Record<string, { schema?: OApiSchema }> };
    security?: Array<Record<string, string[]>>;
}

interface OApiSpec {
    swagger?: string;
    info?: { title?: string };
    servers?: Array<{ url: string }>;
    host?: string;
    basePath?: string;
    schemes?: string[];
    paths?: Record<string, Record<string, OApiOperation>>;
    components?: { securitySchemes?: Record<string, unknown> };
    definitions?: Record<string, OApiSchema>;
    securityDefinitions?: Record<string, unknown>;
}

function oapiSanitizeFilename(name: string): string {
    return name.replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 80) || 'request';
}

function oapiResolveRef(ref: string, spec: OApiSpec): OApiSchema | undefined {
    const parts = ref.replace(/^#\//, '').split('/');
    let cur: Record<string, unknown> = spec as unknown as Record<string, unknown>;
    for (const p of parts) {
        cur = cur?.[p] as Record<string, unknown>;
    }
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
        ? schema.allOf.reduce((acc, s) => ({
            ...acc,
            properties: { ...acc.properties, ...(s.properties ?? {}) },
            type: acc.type ?? s.type,
        }), {} as OApiSchema)
        : (schema.oneOf?.[0] ?? schema.anyOf?.[0] ?? schema);
    const s = merged.$ref ? (oapiResolveRef(merged.$ref, spec) ?? merged) : merged;
    switch (s.type) {
        case 'object': {
            if (!s.properties) return {};
            const obj: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(s.properties)) {
                obj[k] = oapiSchemaToExample(v, spec, depth + 1);
            }
            return obj;
        }
        case 'array':
            return [oapiSchemaToExample(s.items, spec, depth + 1)];
        case 'integer':
            return 0;
        case 'number':
            return 0.0;
        case 'boolean':
            return false;
        case 'string':
            if (s.format === 'date-time') return new Date().toISOString();
            if (s.format === 'date') return new Date().toISOString().slice(0, 10);
            if (s.format === 'uuid') return '00000000-0000-0000-0000-000000000000';
            return 'string';
        default:
            return null;
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
    if (!reqDir) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
    }

    let spec: OApiSpec;
    try {
        spec = JSON.parse(fs.readFileSync(uris[0].fsPath, 'utf-8')) as OApiSpec;
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

    const globalSecurity = (spec as unknown as Record<string, unknown>).security as Array<Record<string, string[]>> | undefined;
    const secDefs = spec.components?.securitySchemes ?? spec.securityDefinitions ?? {};
    const hasBearerSecurity = (opSecurity?: Array<Record<string, string[]>>): boolean => {
        const sec = opSecurity ?? globalSecurity ?? [];
        return sec.some((s) =>
            Object.keys(s).some((k) => {
                const def = (secDefs as Record<string, unknown>)[k] as Record<string, unknown> | undefined;
                if (!def) return false;
                return (
                    (def.type === 'http' && def.scheme === 'bearer')
                    || def.type === 'oauth2'
                    || (def.type === 'apiKey' && def.in === 'header' && String(def.name ?? '').toLowerCase() === 'authorization')
                );
            })
        );
    };

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
                const jsonType = contentTypes.find((t) => t.includes('json')) ?? contentTypes[0];
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

            const queryParams = (op.parameters ?? []).filter((p) => p.in === 'query');
            let finalUrl = url;
            if (queryParams.length) {
                const qs = queryParams.map((p) => `${p.name}={{${p.name}}}`).join('&');
                finalUrl = `${url}?${qs}`;
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
            const filename = `${oapiSanitizeFilename(opId || fallback)}.json`;

            fs.writeFileSync(path.join(targetDir, filename), JSON.stringify(data, null, 2), 'utf-8');
            created++;
        }
    }

    void vscode.commands.executeCommand('openbase.httpRunner.requests.refresh');
    vscode.window.showInformationMessage(`Imported ${created} request${created !== 1 ? 's' : ''} from "${apiTitle}" into "${folderName}".`);
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
        vscode.commands.registerCommand('openbase.httpRunner.requests.importSwagger', () => importSwaggerToHttpRunner())
    );
}
