import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

interface EntryProject {
    csprojPath: string;
    targetFramework: string;
    assemblyName: string;
}

type SolutionNodeKind = 'solution' | 'solutionFolder' | 'project' | 'folder' | 'file';

const SE_SOLUTION_FOLDER_TYPE = '2150E333-8FDC-42A3-9474-1A3956D46DE8';

const SE_IGNORED_DIRS = new Set(['bin', 'obj', 'node_modules', '.git', '.vs', '.idea']);

const SE_FILE_ICONS: Record<string, string> = {
    '.cs': 'symbol-class',
    '.csx': 'symbol-class',
    '.json': 'bracket',
    '.xml': 'code',
    '.http': 'globe',
    '.rest': 'globe',
    '.sql': 'database',
    '.md': 'book',
    '.ts': 'symbol-variable',
    '.js': 'symbol-variable',
    '.yaml': 'list-tree',
    '.yml': 'list-tree',
    '.env': 'lock',
    '.txt': 'file-text',
    '.sh': 'terminal',
    '.ps1': 'terminal',
};

class SolutionNode extends vscode.TreeItem {
    public slnChildren: SolutionNode[] = [];

    constructor(
        public readonly fsPath: string,
        public readonly kind: SolutionNodeKind,
        label?: string
    ) {
        super(
            label ?? path.basename(fsPath),
            kind === 'solution'
                ? vscode.TreeItemCollapsibleState.Expanded
                : kind === 'file'
                    ? vscode.TreeItemCollapsibleState.None
                    : vscode.TreeItemCollapsibleState.Collapsed
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
                this.iconPath = new vscode.ThemeIcon(SE_FILE_ICONS[path.extname(fsPath).toLowerCase()] ?? 'file');
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
    try {
        content = fs.readFileSync(slnPath, 'utf-8');
    } catch {
        return [];
    }
    const slnDir = path.dirname(slnPath);

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

    const nested = new Map<string, string>();
    const nestedMatch = content.match(/GlobalSection\(NestedProjects\)\s*=\s*preSolution([\s\S]*?)EndGlobalSection/);
    if (nestedMatch) {
        const nestedRe = /\{([^}]+)\}\s*=\s*\{([^}]+)\}/g;
        let nm: RegExpExecArray | null;
        while ((nm = nestedRe.exec(nestedMatch[1])) !== null) {
            nested.set(nm[1].toUpperCase(), nm[2].toUpperCase());
        }
    }

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
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    const folders = entries
        .filter((e) => e.isDirectory() && !SE_IGNORED_DIRS.has(e.name))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => new SolutionNode(path.join(dir, e.name), 'folder'));
    const files = entries
        .filter((e) => e.isFile())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => new SolutionNode(path.join(dir, e.name), 'file'));
    return [...folders, ...files];
}

class SolutionExplorerDecorationProvider implements vscode.FileDecorationProvider {
    private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<undefined>();
    readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

    notifyChanged(): void {
        this._onDidChangeFileDecorations.fire(undefined);
    }

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (!uri.fsPath.endsWith('.csproj')) return undefined;

        const projDir = path.dirname(uri.fsPath) + path.sep;
        let errorCount = 0;
        for (const [fileUri, diags] of vscode.languages.getDiagnostics()) {
            if (!fileUri.fsPath.startsWith(projDir)) continue;
            errorCount += diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length;
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

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(e: SolutionNode): vscode.TreeItem {
        return e;
    }

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
            slnFiles = fs
                .readdirSync(this.cwd)
                .filter((f) => f.endsWith('.sln'))
                .sort()
                .map((f) => path.join(this.cwd, f));
        } catch {}

        if (slnFiles.length > 0) {
            return slnFiles.map((s) => new SolutionNode(s, 'solution', path.basename(s, '.sln')));
        }

        return this._findCsprojs(this.cwd);
    }

    private _projectsFromSln(slnPath: string): SolutionNode[] {
        return buildSlnChildren(slnPath);
    }

    private _findCsprojs(dir: string): SolutionNode[] {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return [];
        }
        const results: SolutionNode[] = [];
        for (const e of entries) {
            if (e.isFile() && e.name.endsWith('.csproj')) {
                results.push(new SolutionNode(path.join(dir, e.name), 'project', path.basename(e.name, '.csproj')));
            } else if (e.isDirectory() && !SE_IGNORED_DIRS.has(e.name)) {
                try {
                    const sub = fs.readdirSync(path.join(dir, e.name)).filter((f) => f.endsWith('.csproj'));
                    for (const f of sub) {
                        results.push(new SolutionNode(path.join(dir, e.name, f), 'project', path.basename(f, '.csproj')));
                    }
                } catch {}
            }
        }
        return results;
    }
}

function writePubxml(profilesDir: string, name: string, content: string): void {
    fs.mkdirSync(profilesDir, { recursive: true });
    fs.writeFileSync(path.join(profilesDir, `${name}.pubxml`), content, 'utf-8');
}

async function sePublishLocal(
    proj: EntryProject,
    projDir: string,
    profilesDir: string,
    openTerminal: (name: string, cwd: string, command: string) => void
): Promise<void> {
    const name = await vscode.window.showInputBox({ title: 'Publicar Local (1/2) - Nome do perfil', value: 'FolderPublish' });
    if (!name) return;

    const outPath = await vscode.window.showInputBox({
        title: 'Publicar Local (2/2) - Pasta de saida',
        value: path.join(projDir, 'bin', 'publish'),
    });
    if (outPath === undefined) return;

    writePubxml(
        profilesDir,
        name,
        `<?xml version="1.0" encoding="utf-8"?>
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
</Project>`
    );

    openTerminal('Publish', projDir, `dotnet publish "${proj.csprojPath}" -c Release /p:PublishProfile="${name}"`);
}

async function sePublishFtp(
    proj: EntryProject,
    projDir: string,
    profilesDir: string,
    openTerminal: (name: string, cwd: string, command: string) => void
): Promise<void> {
    const name = await vscode.window.showInputBox({ title: 'Publicar FTP (1/5) - Nome do perfil', value: 'FtpPublish' });
    if (!name) return;
    const host = await vscode.window.showInputBox({ title: 'Publicar FTP (2/5) - Servidor', placeHolder: 'ftp.exemplo.com' });
    if (!host) return;
    const remotePath = await vscode.window.showInputBox({ title: 'Publicar FTP (3/5) - Caminho remoto', value: '/' });
    if (remotePath === undefined) return;
    const user = await vscode.window.showInputBox({ title: 'Publicar FTP (4/5) - Usuario' });
    if (user === undefined) return;
    const password = await vscode.window.showInputBox({ title: 'Publicar FTP (5/5) - Senha', password: true });
    if (password === undefined) return;

    writePubxml(
        profilesDir,
        name,
        `<?xml version="1.0" encoding="utf-8"?>
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
</Project>`
    );

    openTerminal(
        'Publish FTP',
        projDir,
        `dotnet publish "${proj.csprojPath}" -c Release /p:PublishProfile="${name}" /p:Password="${password.replace(/"/g, '\\"')}"`
    );
}

async function sePublishWebDeploy(
    proj: EntryProject,
    projDir: string,
    profilesDir: string,
    openTerminal: (name: string, cwd: string, command: string) => void
): Promise<void> {
    const name = await vscode.window.showInputBox({ title: 'Web Deploy (1/5) - Nome do perfil', value: 'WebDeployPublish' });
    if (!name) return;
    const serverUrl = await vscode.window.showInputBox({ title: 'Web Deploy (2/5) - URL do servidor', placeHolder: 'https://meuservidor.com:8172' });
    if (!serverUrl) return;
    const sitePath = await vscode.window.showInputBox({ title: 'Web Deploy (3/5) - Caminho IIS', placeHolder: 'Default Web Site/meuapp', value: 'Default Web Site' });
    if (sitePath === undefined) return;
    const user = await vscode.window.showInputBox({ title: 'Web Deploy (4/5) - Usuario' });
    if (user === undefined) return;
    const password = await vscode.window.showInputBox({ title: 'Web Deploy (5/5) - Senha', password: true });
    if (password === undefined) return;

    writePubxml(
        profilesDir,
        name,
        `<?xml version="1.0" encoding="utf-8"?>
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
</Project>`
    );

    openTerminal(
        'Publish Web Deploy',
        projDir,
        `dotnet publish "${proj.csprojPath}" -c Release /p:PublishProfile="${name}" /p:Password="${password.replace(/"/g, '\\"')}"`
    );
}

export interface SolutionExplorerProviderDeps {
    findEntryProject: (workspaceRoot: string) => EntryProject | undefined;
    openTerminal: (name: string, cwd: string, command: string) => void;
    dotnetToolsPath: () => string;
}

export function setupSolutionExplorer(context: vscode.ExtensionContext, deps: SolutionExplorerProviderDeps): void {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return;

    const solutionExplorerProvider = new SolutionExplorerProvider(cwd);

    const treeView = vscode.window.createTreeView('openbase.solutionexplorer.tree', {
        treeDataProvider: solutionExplorerProvider,
        showCollapseAll: true,
    });

    const watcher = vscode.workspace.createFileSystemWatcher('**/{*.sln,*.csproj}');
    watcher.onDidCreate(() => solutionExplorerProvider.refresh());
    watcher.onDidDelete(() => solutionExplorerProvider.refresh());
    watcher.onDidChange(() => solutionExplorerProvider.refresh());

    const decorationProvider = new SolutionExplorerDecorationProvider();

    context.subscriptions.push(
        treeView,
        watcher,
        vscode.window.registerFileDecorationProvider(decorationProvider),
        vscode.languages.onDidChangeDiagnostics(() => decorationProvider.notifyChanged()),
        vscode.workspace.onDidChangeWorkspaceFolders(() => solutionExplorerProvider.refresh()),
        vscode.commands.registerCommand('openbase.solutionExplorer.refresh', () => solutionExplorerProvider.refresh()),
        vscode.commands.registerCommand('openbase.solutionExplorer.buildAll', () => {
            const slnFiles = fs.readdirSync(cwd).filter((f) => f.endsWith('.sln'));
            const target = slnFiles.length > 0 ? `"${path.join(cwd, slnFiles[0])}"` : '.';
            deps.openTerminal('Build Solution', cwd, `dotnet build ${target}`);
        }),
        vscode.commands.registerCommand('openbase.solutionExplorer.runAll', () => {
            const proj = deps.findEntryProject(cwd);
            const target = proj ? `"${proj.csprojPath}"` : '.';
            deps.openTerminal('Run Solution', cwd, `dotnet run --project ${target}`);
        }),
        vscode.commands.registerCommand('openbase.solutionExplorer.debug', async () => {
            const folder = vscode.workspace.workspaceFolders?.[0];
            if (!folder) return;

            const serverReadyAction = {
                action: 'openExternally',
                pattern: '\\bNow listening on:\\s+(https?://\\S+)',
            };

            const launchConfigs: vscode.DebugConfiguration[] | undefined = vscode.workspace
                .getConfiguration('launch', folder.uri)
                .get('configurations');

            if (launchConfigs && launchConfigs.length > 0) {
                const config = { ...launchConfigs[0] } as vscode.DebugConfiguration;
                if (!config.serverReadyAction) config.serverReadyAction = serverReadyAction;
                await vscode.debug.startDebugging(folder, config);
            } else {
                const proj = deps.findEntryProject(cwd);
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
            const slnFiles = fs.readdirSync(cwd).filter((f) => f.endsWith('.sln'));
            const target = slnFiles.length > 0 ? `"${path.join(cwd, slnFiles[0])}"` : '.';
            deps.openTerminal('Run Tests', cwd, `dotnet test ${target}`);
        }),
        vscode.commands.registerCommand('openbase.solutionExplorer.publish', async () => {
            const proj = deps.findEntryProject(cwd);
            if (!proj) {
                vscode.window.showErrorMessage('Nenhum projeto encontrado para publicar.');
                return;
            }

            const projDir = path.dirname(proj.csprojPath);
            const profilesDir = path.join(projDir, 'Properties', 'PublishProfiles');

            let existing: string[] = [];
            try {
                existing = fs
                    .readdirSync(profilesDir)
                    .filter((f) => f.endsWith('.pubxml'))
                    .map((f) => path.basename(f, '.pubxml'));
            } catch {}

            const items: vscode.QuickPickItem[] = [
                ...existing.map((p) => ({ label: p, description: 'perfil salvo', iconPath: new vscode.ThemeIcon('file-code') })),
                ...(existing.length ? [{ label: '', kind: vscode.QuickPickItemKind.Separator }] : []),
                { label: '$(folder)  Pasta local', description: 'Publicar em uma pasta local' },
                { label: '$(globe)   FTP', description: 'Publicar via FTP' },
                { label: '$(server)  Web Deploy (IIS)', description: 'Publicar via Web Deploy no IIS' },
            ];

            const picked = await vscode.window.showQuickPick(items, { title: 'OpenBase: Publicar - Destino' });
            if (!picked || picked.kind === vscode.QuickPickItemKind.Separator) return;

            if (existing.includes(picked.label)) {
                deps.openTerminal('Publish', projDir, `dotnet publish "${proj.csprojPath}" -c Release /p:PublishProfile="${picked.label}"`);
                return;
            }

            if (picked.label.includes('Pasta local')) {
                await sePublishLocal(proj, projDir, profilesDir, deps.openTerminal);
                return;
            }
            if (picked.label.includes('FTP')) {
                await sePublishFtp(proj, projDir, profilesDir, deps.openTerminal);
                return;
            }
            if (picked.label.includes('Web Deploy')) {
                await sePublishWebDeploy(proj, projDir, profilesDir, deps.openTerminal);
            }
        }),
        vscode.commands.registerCommand('openbase.solutionExplorer.build', (item: SolutionNode) => {
            if (!(item instanceof SolutionNode) || item.kind !== 'project') return;
            deps.openTerminal('Build', path.dirname(item.fsPath), `dotnet build "${item.fsPath}"`);
        }),
        vscode.commands.registerCommand('openbase.solutionExplorer.run', (item: SolutionNode) => {
            if (!(item instanceof SolutionNode) || item.kind !== 'project') return;
            deps.openTerminal('Run', path.dirname(item.fsPath), `dotnet run --project "${item.fsPath}"`);
        }),
        vscode.commands.registerCommand('openbase.solutionExplorer.openTerminal', (item: SolutionNode) => {
            if (!(item instanceof SolutionNode) || item.kind !== 'project') return;
            const projDir = path.dirname(item.fsPath);
            const projName = path.basename(item.fsPath, '.csproj');
            const terminal = vscode.window.createTerminal({
                name: `OpenBase: ${projName}`,
                cwd: projDir,
                env: { PATH: `${deps.dotnetToolsPath()}${path.delimiter}${process.env.PATH ?? ''}` },
            });
            terminal.show();
        })
    );
}
