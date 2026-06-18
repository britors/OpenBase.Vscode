import * as vscode from 'vscode';
import { Utils } from '../utils';

export type MigrationEngineType = 'efcore' | 'fluentmigrator';

export interface MigrationInfo {
    id: string;
    applied: boolean | null;
    label?: string;
    engine?: MigrationEngineType;
}

export type MigrationStatus = 'migration-applied' | 'migration-pending' | 'migration-unknown' | 'migration-message';

export class MigrationItem extends vscode.TreeItem {
    constructor(
        public readonly info: MigrationInfo | null,
        public readonly status: MigrationStatus,
        label: string,
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.contextValue = status;
        if (status === 'migration-applied') {
            this.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
            this.description = info?.engine === 'fluentmigrator' ? `applied · FM` : 'applied';
        } else if (status === 'migration-pending') {
            this.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('list.warningForeground'));
            this.description = info?.engine === 'fluentmigrator' ? `pending · FM` : 'pending';
        } else if (status === 'migration-unknown') {
            this.iconPath = new vscode.ThemeIcon('question');
            this.description = 'no db connection';
        } else {
            this.iconPath = new vscode.ThemeIcon('info');
        }
    }
}

export class MigrationTreeProvider implements vscode.TreeDataProvider<MigrationItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    public items: MigrationItem[] = [];
    private treeView?: vscode.TreeView<MigrationItem>;
    private loading = false;

    setTreeView(tv: vscode.TreeView<MigrationItem>): void { this.treeView = tv; }

    getTreeItem(e: MigrationItem): vscode.TreeItem { return e; }

    getChildren(): MigrationItem[] { return this.items; }

    async refresh(listMigrations: (cwd: string) => Promise<MigrationInfo[]>): Promise<void> {
        if (this.loading) return;
        this.loading = true;
        if (this.treeView) this.treeView.message = 'Loading migrations…';
        this._onDidChangeTreeData.fire();

        const cwd = await Utils.getInstance().resolveWorkingDir();
        if (!cwd) {
            this.items = [new MigrationItem(null, 'migration-message', 'No workspace folder open')];
            if (this.treeView) { this.treeView.message = undefined; this.treeView.description = undefined; }
            this.loading = false;
            this._onDidChangeTreeData.fire();
            return;
        }

        try {
            const migrations = await listMigrations(cwd);
            if (migrations.length === 0) {
                this.items = [new MigrationItem(null, 'migration-message', 'No migrations found')];
                if (this.treeView) this.treeView.description = undefined;
            } else {
                this.items = migrations.map(m => {
                    const status: MigrationStatus = m.applied === null
                        ? 'migration-unknown'
                        : m.applied ? 'migration-applied' : 'migration-pending';
                    return new MigrationItem(m, status, m.label ?? m.id);
                });
                const pending = migrations.filter(m => m.applied === false).length;
                if (this.treeView) {
                    const engineBadge = migrations[0]?.engine === 'fluentmigrator' ? ' · Fluent Migrator' : '';
                    this.treeView.description = pending > 0 ? `${pending} pending${engineBadge}` : engineBadge || undefined;
                }
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.items = [new MigrationItem(null, 'migration-message', `Error: ${msg}`)];
            if (this.treeView) this.treeView.description = undefined;
        }
        this.loading = false;
        this._onDidChangeTreeData.fire();
    }
}
