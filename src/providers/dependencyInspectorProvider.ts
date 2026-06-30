import * as path from 'path';
import * as vscode from 'vscode';
import { exec } from 'child_process';

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

export interface DependencyInspectorProviderDeps {
    dotnetToolsPath: () => string;
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
        const outdatedCount = proj.packages.filter((p) => p.latest).length;
        this.contextValue = outdatedCount > 0 ? 'dep-project-outdated' : 'dep-project';
        this.description = outdatedCount > 0 ? `${outdatedCount} outdated` : `${proj.packages.length} up to date`;
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

    private depData: ProjectPackages[] = [];
    private depShowOnlyOutdated = false;

    constructor(
        private readonly cwd: string,
        private readonly deps: DependencyInspectorProviderDeps,
    ) {}

    refresh(): void {
        this.loading = true;
        this._onDidChangeTreeData.fire(undefined);
        this.loadDependencies(this.cwd).then((data) => {
            this.depData = data;
            this.loading = false;
            this._onDidChangeTreeData.fire(undefined);
        });
    }

    toggleFilter(): void {
        this.depShowOnlyOutdated = !this.depShowOnlyOutdated;
        this._onDidChangeTreeData.fire(undefined);
    }

    updatePackage(item: DepPackageItem): void {
        if (!(item instanceof DepPackageItem) || !item.pkg.latest) return;
        const projDir = path.isAbsolute(item.projectPath)
            ? path.dirname(item.projectPath)
            : path.dirname(path.join(this.cwd, item.projectPath));
        const extraPath = this.deps.dotnetToolsPath();
        const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
        const out = vscode.window.createOutputChannel('OpenBase Dependencies');
        out.show(true);
        out.appendLine(`Updating ${item.pkg.name} → ${item.pkg.latest}…`);
        exec(
            `dotnet add package "${item.pkg.name}" --version "${item.pkg.latest}"`,
            { cwd: projDir, env, timeout: 120000 },
            (err, stdout, stderr) => {
                if (err) out.appendLine(`Error: ${stderr || err.message}`);
                else {
                    out.appendLine(stdout.trim());
                    out.appendLine('Done.');
                }
                this.refresh();
            }
        );
    }

    async updateAllPackages(): Promise<void> {
        const outdated = this.depData.flatMap((proj) =>
            proj.packages.filter((p) => p.latest).map((p) => ({ pkg: p, projectPath: proj.projectPath }))
        );
        if (!outdated.length) {
            vscode.window.showInformationMessage('All packages are up to date!');
            return;
        }
        const confirm = await vscode.window.showWarningMessage(
            `Update ${outdated.length} outdated package(s)?`,
            { modal: true },
            'Update All',
        );
        if (confirm !== 'Update All') return;

        const extraPath = this.deps.dotnetToolsPath();
        const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
        const out = vscode.window.createOutputChannel('OpenBase Dependencies');
        out.show(true);

        for (const { pkg, projectPath } of outdated) {
            if (!pkg.latest) continue;
            const projDir = path.isAbsolute(projectPath)
                ? path.dirname(projectPath)
                : path.dirname(path.join(this.cwd, projectPath));
            out.appendLine(`\nUpdating ${pkg.name} → ${pkg.latest}…`);
            await new Promise<void>((resolve) => {
                exec(
                    `dotnet add package "${pkg.name}" --version "${pkg.latest}"`,
                    { cwd: projDir, env, timeout: 120000 },
                    (err, stdout, stderr) => {
                        if (err) out.appendLine(`Error: ${stderr || err.message}`);
                        else out.appendLine(stdout.trim());
                        resolve();
                    }
                );
            });
        }

        out.appendLine('\nAll updates complete.');
        this.refresh();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem[]> {
        if (!element) {
            if (this.loading) {
                const item = new vscode.TreeItem('Loading packages…');
                item.iconPath = new vscode.ThemeIcon('loading~spin');
                return [item];
            }
            if (!this.depData.length) {
                return [new vscode.TreeItem('No packages found — open a .NET workspace')];
            }
            return this.depData
                .filter((p) => !this.depShowOnlyOutdated || p.packages.some((pkg) => pkg.latest))
                .map((p) => new DepProjectItem(p));
        }

        if (element instanceof DepProjectItem) {
            const pkgs = this.depShowOnlyOutdated
                ? element.proj.packages.filter((p) => p.latest)
                : element.proj.packages;
            return pkgs.map((p) => new DepPackageItem(p, element.proj.projectPath));
        }

        return [];
    }

    private async loadDependencies(cwd: string): Promise<ProjectPackages[]> {
        const extraPath = this.deps.dotnetToolsPath();
        const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
        const run = (args: string) =>
            new Promise<string>((resolve) => {
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
}

export function setupDepInspector(context: vscode.ExtensionContext, deps: DependencyInspectorProviderDeps): void {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return;

    const depProvider = new DepInspectorProvider(cwd, deps);

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('openbase.depinspector.packages', depProvider),
        vscode.commands.registerCommand('openbase.dependencyInspector.refresh', () => depProvider.refresh()),
        vscode.commands.registerCommand('openbase.dependencyInspector.toggleFilter', () => depProvider.toggleFilter()),
        vscode.commands.registerCommand('openbase.dependencyInspector.update', (item: DepPackageItem) => depProvider.updatePackage(item)),
        vscode.commands.registerCommand('openbase.dependencyInspector.updateAll', () => depProvider.updateAllPackages()),
    );

    depProvider.refresh();
}
