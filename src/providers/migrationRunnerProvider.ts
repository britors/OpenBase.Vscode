import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { exec } from 'child_process';
import { DbConnection } from '../models/dbConnection';
import { DbNativeClientService } from '../services/dbNativeClient.service';

const dbNativeClientService = new DbNativeClientService();

type MigrationEngineType = 'efcore' | 'fluentmigrator';

type MigrationStatus = 'migration-applied' | 'migration-pending' | 'migration-unknown' | 'migration-message';

interface MigrationInfo {
    id: string;
    applied: boolean | null; // null = no DB connection, status unknown
    label?: string; // display name (FM uses class name, EF uses id)
    engine?: MigrationEngineType;
}

export interface MigrationRunnerProviderDeps {
    dotnetToolsPath: () => string;
    findConnection: (cwd: string) => DbConnection | undefined;
    getNonce: () => string;
    getScriptsDir: () => string | undefined;
    refreshSqlScripts: () => void;
}

class MigrationItem extends vscode.TreeItem {
    constructor(
        public readonly info: MigrationInfo | null,
        public readonly status: MigrationStatus,
        label: string,
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.contextValue = status;
        if (status === 'migration-applied') {
            this.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
            this.description = info?.engine === 'fluentmigrator' ? 'applied · FM' : 'applied';
        } else if (status === 'migration-pending') {
            this.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('list.warningForeground'));
            this.description = info?.engine === 'fluentmigrator' ? 'pending · FM' : 'pending';
        } else if (status === 'migration-unknown') {
            this.iconPath = new vscode.ThemeIcon('question');
            this.description = 'no db connection';
        } else {
            this.iconPath = new vscode.ThemeIcon('info');
        }
    }
}

class MigrationTreeProvider implements vscode.TreeDataProvider<MigrationItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private items: MigrationItem[] = [];
    private treeView?: vscode.TreeView<MigrationItem>;
    private loading = false;

    private migrationRunnerEngine: MigrationEngineType = 'efcore';
    private lastMigrations: MigrationInfo[] = [];
    private migrationScriptPanel: vscode.WebviewPanel | undefined;

    constructor(private readonly deps: MigrationRunnerProviderDeps) {}

    setTreeView(tv: vscode.TreeView<MigrationItem>): void {
        this.treeView = tv;
    }

    getTreeItem(e: MigrationItem): vscode.TreeItem {
        return e;
    }

    getChildren(): MigrationItem[] {
        return this.items;
    }

    async refresh(): Promise<void> {
        if (this.loading) return;
        this.loading = true;
        if (this.treeView) this.treeView.message = 'Loading migrations…';
        this._onDidChangeTreeData.fire();

        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!cwd) {
            this.items = [new MigrationItem(null, 'migration-message', 'No workspace folder open')];
            if (this.treeView) {
                this.treeView.message = undefined;
                this.treeView.description = undefined;
            }
            this.loading = false;
            this._onDidChangeTreeData.fire();
            return;
        }

        try {
            const migrations = await this.listMigrations(cwd);
            this.lastMigrations = migrations;
            if (migrations.length === 0) {
                this.items = [new MigrationItem(null, 'migration-message', 'No migrations found')];
                if (this.treeView) this.treeView.description = undefined;
            } else {
                this.migrationRunnerEngine = migrations[0]?.engine ?? 'efcore';
                this.items = migrations.map((m) => {
                    const status: MigrationStatus =
                        m.applied === null
                            ? 'migration-unknown'
                            : m.applied
                              ? 'migration-applied'
                              : 'migration-pending';
                    return new MigrationItem(m, status, m.label ?? m.id);
                });
                const pending = migrations.filter((m) => m.applied === false).length;
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

        if (this.treeView) this.treeView.message = undefined;
        this.loading = false;
        this._onDidChangeTreeData.fire();
    }

    migrateUp(): void {
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!cwd) {
            vscode.window.showErrorMessage('No workspace folder open.');
            return;
        }
        void vscode.window
            .showWarningMessage('Apply all pending migrations?', { modal: true }, 'Apply')
            .then((confirmed) => {
                if (confirmed !== 'Apply') return;
                if (this.migrationRunnerEngine === 'fluentmigrator') {
                    this.runFmMigrationCommand(cwd);
                } else {
                    this.runMigrationCommand(cwd, ['ef', 'database', 'update'], 'Migrate Up');
                }
            });
    }

    migrateTo(item: MigrationItem): void {
        if (!item.info) return;
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!cwd) return;
        const isDown = item.status === 'migration-applied';
        const label = item.info.label ?? item.info.id;
        const question = isDown
            ? vscode.window.showWarningMessage(
                  `Revert to "${label}"?`,
                  {
                      modal: true,
                      detail:
                          'Down() migrations will run for every version applied after this point. This may cause irreversible data loss.',
                  },
                  'Revert'
              )
            : vscode.window.showInformationMessage(`Apply migrations up to "${label}"?`, { modal: true }, 'Apply');

        void question.then((action) => {
            if (!action) return;
            const verb = isDown ? 'Migrate Down to' : 'Migrate Up to';
            if (this.migrationRunnerEngine === 'fluentmigrator') {
                this.runFmMigrationCommand(cwd, item.info!.id, isDown);
            } else {
                this.runMigrationCommand(cwd, ['ef', 'database', 'update', item.info!.id], `${verb} ${label}`);
            }
        });
    }

    dryRun(): void {
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!cwd) {
            vscode.window.showErrorMessage('No workspace folder open.');
            return;
        }
        if (this.migrationRunnerEngine === 'fluentmigrator') {
            vscode.window.showInformationMessage('Dry Run not supported for Fluent Migrator.');
            return;
        }
        void this.showMigrationScript(cwd);
    }

    dryRunTo(item: MigrationItem): void {
        if (!item.info) return;
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!cwd) return;
        if (this.migrationRunnerEngine === 'fluentmigrator') {
            vscode.window.showInformationMessage('Dry Run not supported for Fluent Migrator.');
            return;
        }
        const idx = this.lastMigrations.findIndex((m) => m.id === item.info!.id);
        const prevId = idx > 0 ? this.lastMigrations[idx - 1].id : '0';
        const isDown = item.status === 'migration-applied';

        if (isDown) {
            const nextIdx = this.lastMigrations.findIndex((m) => m.id === item.info!.id);
            const nextId = nextIdx < this.lastMigrations.length - 1 ? this.lastMigrations[nextIdx + 1].id : item.info.id;
            void this.showMigrationScript(cwd, nextId, item.info.id);
        } else {
            void this.showMigrationScript(cwd, prevId, item.info.id);
        }
    }

    private findMigrationsDir(cwd: string): string | undefined {
        function scan(dir: string, depth: number): string | undefined {
            if (depth > 6) return undefined;
            try {
                for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'bin' || e.name === 'obj') continue;
                    if (e.name === 'Migrations') {
                        const full = path.join(dir, e.name);
                        try {
                            if (fs.readdirSync(full).some((f) => /^\d{14}_/.test(f) && f.endsWith('.cs') && !f.endsWith('Designer.cs'))) {
                                return full;
                            }
                        } catch {
                            // ignore
                        }
                    }
                    const found = scan(path.join(dir, e.name), depth + 1);
                    if (found) return found;
                }
            } catch {
                // ignore
            }
        }
        return scan(cwd, 0);
    }

    private findMigrationProject(migrationsDir: string): string | undefined {
        const projectDir = path.dirname(migrationsDir);
        try {
            const csproj = fs.readdirSync(projectDir).find((f) => f.endsWith('.csproj'));
            return csproj ? path.join(projectDir, csproj) : undefined;
        } catch {
            return undefined;
        }
    }

    private findEfStartupProject(cwd: string): string | undefined {
        function scan(dir: string, depth: number): string | undefined {
            if (depth > 5) return undefined;
            try {
                for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (e.isFile() && e.name.endsWith('.csproj')) {
                        try {
                            const content = fs.readFileSync(path.join(dir, e.name), 'utf-8');
                            if (content.includes('Microsoft.EntityFrameworkCore.Design')) return path.join(dir, e.name);
                        } catch {
                            // ignore
                        }
                    }
                    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'bin' && e.name !== 'obj') {
                        const found = scan(path.join(dir, e.name), depth + 1);
                        if (found) return found;
                    }
                }
            } catch {
                // ignore
            }
        }
        return scan(cwd, 0);
    }

    private listMigrationsFromFs(migrationsDir: string): string[] {
        try {
            return fs
                .readdirSync(migrationsDir)
                .filter((f) => /^\d{14}_/.test(f) && f.endsWith('.cs') && !f.endsWith('Designer.cs') && !f.endsWith('Snapshot.cs'))
                .sort()
                .map((f) => f.replace(/\.cs$/, ''));
        } catch {
            return [];
        }
    }

    private async getAppliedMigrations(conn: DbConnection): Promise<Set<string>> {
        if (conn.type === 'pgsql') {
            try {
                const nativeSql = 'SELECT "MigrationId" FROM "__EFMigrationsHistory"';
                const nativeResult = await dbNativeClientService.executeQuery(conn, nativeSql);
                if (nativeResult) {
                    const applied = new Set<string>();
                    for (const row of nativeResult.rows) {
                        const id = Array.isArray(row)
                            ? String(row[0] ?? '').trim()
                            : String((row as Record<string, unknown>).MigrationId ?? '').trim();
                        if (id && !/^(MigrationId|-{2,}|\d+ rows?)/i.test(id)) applied.add(id);
                    }
                    return applied;
                }
                throw new Error('Native PostgreSQL query returned no result.');
            } catch {
                throw new Error('Failed to load applied EF migrations from PostgreSQL via native driver.');
            }
        }

        if (conn.type === 'sqlserver' && conn.user && conn.password) {
            try {
                const nativeSql = 'SELECT [MigrationId] FROM [dbo].[__EFMigrationsHistory]';
                const nativeResult = await dbNativeClientService.executeQuery(conn, nativeSql);
                if (nativeResult) {
                    const applied = new Set<string>();
                    for (const row of nativeResult.rows) {
                        const id = Array.isArray(row)
                            ? String(row[0] ?? '').trim()
                            : String((row as Record<string, unknown>).MigrationId ?? '').trim();
                        if (id && !/^(MigrationId|-{2,}|\d+ rows?)/i.test(id)) applied.add(id);
                    }
                    return applied;
                }
                throw new Error('Native SQL Server query returned no result.');
            } catch {
                throw new Error('Failed to load applied EF migrations from SQL Server via native driver.');
            }
        }

        if (conn.type === 'oracle') {
            try {
                const nativeSql = 'SELECT "MigrationId" FROM "__EFMigrationsHistory"';
                const nativeResult = await dbNativeClientService.executeQuery(conn, nativeSql);
                if (nativeResult) {
                    const applied = new Set<string>();
                    for (const row of nativeResult.rows) {
                        const id = Array.isArray(row)
                            ? String(row[0] ?? '').trim()
                            : String((row as Record<string, unknown>).MigrationId ?? '').trim();
                        if (id && !/^(MigrationId|-{2,}|\d+ rows?)/i.test(id)) applied.add(id);
                    }
                    return applied;
                }
                throw new Error('Native Oracle query returned no result.');
            } catch {
                throw new Error('Failed to load applied EF migrations from Oracle via native driver.');
            }
        }

        const extraPath = this.deps.dotnetToolsPath();
        const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
        const tmpFile = path.join(os.tmpdir(), `ob_efmig_${Date.now()}.sql`);
        let cmd = '';
        try {
            switch (conn.type) {
                case 'sqlserver': {
                    fs.writeFileSync(tmpFile, 'SELECT MigrationId FROM [dbo].[__EFMigrationsHistory]', 'utf-8');
                    const parts = ['sqlcmd', `-S "${conn.server}"`, `-d "${conn.database}"`];
                    if (conn.user) parts.push(`-U "${conn.user}"`);
                    if (conn.password) parts.push(`-P "${conn.password}"`);
                    parts.push(`-i "${tmpFile}" -s "|" -W -h -1`);
                    cmd = parts.join(' ');
                    break;
                }
                default:
                    return new Set();
            }
            const stdout = await new Promise<string>((resolve, reject) => {
                exec(cmd, { env, timeout: 10000 }, (err, out, stderr) => {
                    if (err && !out) reject(new Error(stderr || err.message));
                    else resolve(out);
                });
            });
            const applied = new Set<string>();
            for (const line of stdout.split('\n')) {
                const id = line.trim().replace(/^"|"$/g, '');
                if (id && !/^(MigrationId|-{2,}|\d+ rows?)/i.test(id)) applied.add(id);
            }
            return applied;
        } finally {
            try {
                fs.unlinkSync(tmpFile);
            } catch {
                // ignore
            }
        }
    }

    private async listMigrations(cwd: string): Promise<MigrationInfo[]> {
        const migrationsDir = this.findMigrationsDir(cwd);
        if (migrationsDir) {
            const ids = this.listMigrationsFromFs(migrationsDir);
            if (ids.length === 0) return [];
            const conn = this.deps.findConnection(cwd);
            if (!conn) return ids.map((id) => ({ id, applied: null, engine: 'efcore' as MigrationEngineType }));
            try {
                const applied = await this.getAppliedMigrations(conn);
                return ids.map((id) => ({ id, applied: applied.has(id), engine: 'efcore' as MigrationEngineType }));
            } catch {
                return ids.map((id) => ({ id, applied: null, engine: 'efcore' as MigrationEngineType }));
            }
        }

        const fmDir = this.findFluentMigrationsDir(cwd);
        if (fmDir) {
            const fmMigs = this.listFmMigrationsFromFs(fmDir);
            if (fmMigs.length === 0) return [];
            const conn = this.deps.findConnection(cwd);
            if (!conn) {
                return fmMigs.map((m) => ({
                    id: m.version,
                    label: m.label,
                    applied: null,
                    engine: 'fluentmigrator' as MigrationEngineType,
                }));
            }
            try {
                const applied = await this.getAppliedFmMigrations(conn);
                return fmMigs.map((m) => ({
                    id: m.version,
                    label: m.label,
                    applied: applied.has(m.version),
                    engine: 'fluentmigrator' as MigrationEngineType,
                }));
            } catch {
                return fmMigs.map((m) => ({
                    id: m.version,
                    label: m.label,
                    applied: null,
                    engine: 'fluentmigrator' as MigrationEngineType,
                }));
            }
        }

        throw new Error('Nenhuma migration encontrada (EF Core ou Fluent Migrator).');
    }

    private findFluentMigrationsDir(cwd: string): string | undefined {
        function scan(dir: string, depth: number): string | undefined {
            if (depth > 6) return undefined;
            try {
                const files = fs.readdirSync(dir, { withFileTypes: true });
                const hasAttr = files.some((e) => {
                    if (!e.isFile() || !e.name.endsWith('.cs')) return false;
                    try {
                        return /\[Migration\s*\(\s*\d+/.test(fs.readFileSync(path.join(dir, e.name), 'utf-8'));
                    } catch {
                        return false;
                    }
                });
                if (hasAttr) return dir;
                for (const e of files) {
                    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'bin' && e.name !== 'obj') {
                        const found = scan(path.join(dir, e.name), depth + 1);
                        if (found) return found;
                    }
                }
            } catch {
                // ignore
            }
        }
        return scan(cwd, 0);
    }

    private listFmMigrationsFromFs(dir: string): Array<{ version: string; label: string }> {
        const result: Array<{ version: string; label: string; n: bigint }> = [];
        try {
            for (const file of fs.readdirSync(dir)) {
                if (!file.endsWith('.cs')) continue;
                try {
                    const content = fs.readFileSync(path.join(dir, file), 'utf-8');
                    const m = content.match(/\[Migration\s*\(\s*(\d+)/);
                    if (m) result.push({ version: m[1], label: file.replace(/\.cs$/, ''), n: BigInt(m[1]) });
                } catch {
                    // ignore
                }
            }
        } catch {
            // ignore
        }
        return result
            .sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0))
            .map(({ version, label }) => ({ version, label }));
    }

    private async getAppliedFmMigrations(conn: DbConnection): Promise<Set<string>> {
        if (conn.type === 'pgsql') {
            try {
                const nativeSql = 'SELECT CAST("Version" AS VARCHAR) AS "Version" FROM "VersionInfo"';
                const nativeResult = await dbNativeClientService.executeQuery(conn, nativeSql);
                if (nativeResult) {
                    const applied = new Set<string>();
                    for (const row of nativeResult.rows) {
                        const id = Array.isArray(row)
                            ? String(row[0] ?? '').trim()
                            : String((row as Record<string, unknown>).Version ?? '').trim();
                        if (id && !/^(Version|-{2,}|\d+ rows?)/i.test(id) && /^\d+$/.test(id)) applied.add(id);
                    }
                    return applied;
                }
                throw new Error('Native PostgreSQL query returned no result.');
            } catch {
                throw new Error('Failed to load applied Fluent migrations from PostgreSQL via native driver.');
            }
        }

        if (conn.type === 'sqlserver' && conn.user && conn.password) {
            try {
                const nativeSql = 'SELECT CAST([Version] AS VARCHAR(50)) AS [Version] FROM [VersionInfo]';
                const nativeResult = await dbNativeClientService.executeQuery(conn, nativeSql);
                if (nativeResult) {
                    const applied = new Set<string>();
                    for (const row of nativeResult.rows) {
                        const id = Array.isArray(row)
                            ? String(row[0] ?? '').trim()
                            : String((row as Record<string, unknown>).Version ?? '').trim();
                        if (id && !/^(Version|-{2,}|\d+ rows?)/i.test(id) && /^\d+$/.test(id)) applied.add(id);
                    }
                    return applied;
                }
                throw new Error('Native SQL Server query returned no result.');
            } catch {
                throw new Error('Failed to load applied Fluent migrations from SQL Server via native driver.');
            }
        }

        if (conn.type === 'oracle') {
            try {
                const nativeSql = 'SELECT CAST("Version" AS VARCHAR2(50)) AS "Version" FROM "VersionInfo"';
                const nativeResult = await dbNativeClientService.executeQuery(conn, nativeSql);
                if (nativeResult) {
                    const applied = new Set<string>();
                    for (const row of nativeResult.rows) {
                        const id = Array.isArray(row)
                            ? String(row[0] ?? '').trim()
                            : String((row as Record<string, unknown>).Version ?? '').trim();
                        if (id && !/^(Version|-{2,}|\d+ rows?)/i.test(id) && /^\d+$/.test(id)) applied.add(id);
                    }
                    return applied;
                }
                throw new Error('Native Oracle query returned no result.');
            } catch {
                throw new Error('Failed to load applied Fluent migrations from Oracle via native driver.');
            }
        }

        const extraPath = this.deps.dotnetToolsPath();
        const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
        const tmpFile = path.join(os.tmpdir(), `ob_fmmig_${Date.now()}.sql`);
        try {
            let cmd = '';
            switch (conn.type) {
                case 'sqlserver': {
                    fs.writeFileSync(tmpFile, 'SELECT CAST(Version AS VARCHAR(50)) FROM VersionInfo', 'utf-8');
                    const p = ['sqlcmd', `-S "${conn.server}"`, `-d "${conn.database}"`];
                    if (conn.user) p.push(`-U "${conn.user}"`);
                    if (conn.password) p.push(`-P "${conn.password}"`);
                    p.push(`-i "${tmpFile}" -s "|" -W -h -1`);
                    cmd = p.join(' ');
                    break;
                }
                default:
                    return new Set();
            }
            const stdout = await new Promise<string>((resolve, reject) => {
                exec(cmd, { env, timeout: 10000 }, (err, out, stderr) => {
                    if (err && !out) reject(new Error(stderr || err.message));
                    else resolve(out);
                });
            });
            const applied = new Set<string>();
            for (const line of stdout.split('\n')) {
                const id = line.trim().replace(/^"|"$/g, '');
                if (id && !/^(Version|-{2,}|\d+ rows?)/i.test(id) && /^\d+$/.test(id)) applied.add(id);
            }
            return applied;
        } finally {
            try {
                fs.unlinkSync(tmpFile);
            } catch {
                // ignore
            }
        }
    }

    private buildFmConnString(conn: DbConnection): string {
        switch (conn.type) {
            case 'sqlserver':
                return `Server=${conn.server};Database=${conn.database};${
                    conn.user ? `User Id=${conn.user};Password=${conn.password ?? ''};` : 'Trusted_Connection=True;'
                }`;
            case 'pgsql':
                return `Host=${conn.server};Port=${conn.port ?? '5432'};Database=${conn.database};Username=${conn.user ?? 'postgres'};Password=${conn.password ?? ''};`;
            case 'oracle':
                return `Data Source=${conn.server};User Id=${conn.user};Password=${conn.password ?? ''};`;
        }
    }

    private fmProcessorName(conn: DbConnection): string {
        switch (conn.type) {
            case 'sqlserver':
                return 'SqlServer2016';
            case 'pgsql':
                return 'Postgres';
            case 'oracle':
                return 'Oracle';
        }
    }

    private findFmAssembly(fmDir: string): string | undefined {
        let dir = fmDir;
        for (let i = 0; i < 4; i++) {
            try {
                const csproj = fs.readdirSync(dir).find((f) => f.endsWith('.csproj'));
                if (csproj) {
                    const projName = path.basename(csproj, '.csproj');
                    const binDir = path.join(dir, 'bin');
                    const dll = this.findDllInDir(binDir, projName + '.dll', 0);
                    if (dll) return dll;
                }
            } catch {
                // ignore
            }
            dir = path.dirname(dir);
        }
    }

    private findDllInDir(dir: string, name: string, depth: number): string | undefined {
        if (depth > 4) return undefined;
        try {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (e.isFile() && e.name === name) return path.join(dir, e.name);
                if (e.isDirectory()) {
                    const found = this.findDllInDir(path.join(dir, e.name), name, depth + 1);
                    if (found) return found;
                }
            }
        } catch {
            // ignore
        }
    }

    private runFmMigrationCommand(cwd: string, targetVersion?: string, isDown = false): void {
        const conn = this.deps.findConnection(cwd);
        if (!conn) {
            vscode.window.showErrorMessage('No database connection found.');
            return;
        }
        const fmDir = this.findFluentMigrationsDir(cwd);
        const assembly = fmDir ? this.findFmAssembly(fmDir) : undefined;
        if (!assembly) {
            vscode.window.showErrorMessage('Could not find Fluent Migrator assembly. Build the project first.');
            return;
        }
        const connStr = this.buildFmConnString(conn);
        const processor = this.fmProcessorName(conn);
        const extraPath = this.deps.dotnetToolsPath();
        const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
        const title = isDown ? `FM Rollback to ${targetVersion ?? '0'}` : `FM Migrate Up${targetVersion ? ` to ${targetVersion}` : ''}`;
        const channel = vscode.window.createOutputChannel(`OpenBase: ${title}`);
        channel.show(true);
        const args = [
            'fm',
            'migrate',
            `--processor "${processor}"`,
            `--connectionString "${connStr.replace(/"/g, '\\"')}"`,
            `--assembly "${assembly}"`,
        ];
        if (targetVersion) args.push(`--target ${targetVersion}`);
        if (isDown) args.push('--task rollback');
        const child = exec(`dotnet ${args.join(' ')}`, { cwd, env, timeout: 120000 });
        child.stdout?.on('data', (d: string) => channel.append(d));
        child.stderr?.on('data', (d: string) => channel.append(d));
        child.on('close', (code) => {
            if (code === 0) {
                channel.appendLine('\nCompleted successfully.');
                vscode.window.showInformationMessage(`${title} completed.`);
            } else {
                channel.appendLine(`\nFailed (exit ${code}).`);
                vscode.window.showErrorMessage(`${title} failed. Check the output panel.`);
            }
            void this.refresh();
        });
        child.on('error', (err) => {
            channel.appendLine(err.message);
            vscode.window.showErrorMessage(err.message);
            void this.refresh();
        });
    }

    private buildMigrationScriptHtml(nonce: string, cspSource: string): string {
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%;display:flex;flex-direction:column;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);background:var(--vscode-editor-background);color:var(--vscode-foreground)}
  :root{
    --ob-bg0: var(--vscode-editor-background);
    --ob-bg1: var(--vscode-sideBar-background);
    --ob-bg2: var(--vscode-input-background);
    --ob-purple: #b44fff;
    --ob-pink: #ff3fa4;
    --ob-border: var(--vscode-panel-border);
    --ob-text: var(--vscode-foreground);
    --ob-dim: var(--vscode-descriptionForeground);
  }
  body.vscode-dark {
    --ob-bg0: #0d0f1a;
    --ob-bg1: #131629;
    --ob-bg2: #1c1535;
    --ob-border: rgba(180,79,255,0.22);
    --ob-text: #ede8f8;
    --ob-dim: #9080b8;
  }
  body.vscode-light {
    --ob-bg0: #fdfdff;
    --ob-bg1: #f1f3f9;
    --ob-bg2: #ffffff;
    --ob-purple: #7b2cbf;
    --ob-pink: #d81b60;
    --ob-border: #e0e4ef;
    --ob-text: #24292e;
    --ob-dim: #6a737d;
  }
  html,body{background:var(--ob-bg0)!important;color:var(--ob-text)!important}
  .header{display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--ob-border);background:linear-gradient(135deg,rgba(180,79,255,.18),rgba(255,63,164,.10));flex-shrink:0}
  .header-title{font-weight:600;font-size:13px;background:linear-gradient(90deg,var(--ob-purple),var(--ob-pink));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
  .header-sub{font-size:11px;color:var(--ob-dim)}
  .toolbar{display:flex;align-items:center;gap:8px;padding:5px 12px;border-bottom:1px solid var(--ob-border);background:var(--ob-bg1);flex-shrink:0}
  .btn{padding:4px 10px;border:none;cursor:pointer;font-family:inherit;font-size:inherit;border-radius:4px}
  .btn-secondary{background:rgba(180,79,255,.12);color:var(--ob-purple);border:1px solid var(--ob-border)}
  .btn-secondary:hover{background:rgba(180,79,255,.24)}
  .hint{font-size:11px;color:var(--ob-dim);margin-left:auto}
  .sql-wrap{flex:1;overflow:auto;padding:16px}
  pre{font-family:var(--vscode-editor-font-family,monospace);font-size:12px;line-height:1.6;white-space:pre;tab-size:2;color:var(--ob-text)}
  .kw{color:#c084fc;font-weight:600}
  .cmt{color:#4b3f6b;font-style:italic}
  .str{color:#f472b6}
  .num{color:#67e8f9}
  .loading{padding:20px;color:var(--ob-dim);font-size:12px;font-style:italic}
  .err-box{padding:12px;background:rgba(255,63,164,.10);border:1px solid rgba(255,63,164,.35);color:#ff90c0;font-size:12px;white-space:pre-wrap;font-family:monospace}
</style>
</head>
<body>
<div class="header">
  <span class="header-title">Migration Dry Run</span>
  <span id="subtitle" class="header-sub"></span>
</div>
<div class="toolbar">
  <button id="copy-btn" class="btn btn-secondary">Copy SQL</button>
  <button id="save-btn" class="btn btn-secondary">Save as Script&hellip;</button>
  <span id="line-count" class="hint"></span>
</div>
<div class="sql-wrap">
  <div class="loading" id="loading">Generating script&hellip;</div>
  <pre id="sql-view" style="display:none"></pre>
  <div id="err-view" class="err-box" style="display:none"></div>
</div>
<script nonce="${nonce}">
  var vscode = acquireVsCodeApi();
  var rawSql = '';
  document.getElementById('copy-btn').onclick = function() { if (rawSql) vscode.postMessage({ command: 'copy', sql: rawSql }); };
  document.getElementById('save-btn').onclick = function() { if (rawSql) vscode.postMessage({ command: 'save', sql: rawSql }); };
  window.addEventListener('message', function(e) {
    var m = e.data;
    if (m.command === 'load') {
      rawSql = m.sql || '';
      document.getElementById('loading').style.display = 'none';
      if (m.subtitle) document.getElementById('subtitle').textContent = m.subtitle;
      var pre = document.getElementById('sql-view');
      pre.innerHTML = highlight(rawSql);
      pre.style.display = '';
      document.getElementById('line-count').textContent = rawSql.split('\\n').length + ' lines';
    } else if (m.command === 'error') {
      document.getElementById('loading').style.display = 'none';
      var err = document.getElementById('err-view');
      err.textContent = m.text;
      err.style.display = '';
    }
  });
  function highlight(sql) {
    var s = esc(sql);
    s = s.replace(/(--[^\\n]*)/g, '\\x01$1\\x02');
    s = s.replace(/('[^']*')/g, '\\x03$1\\x04');
    s = s.replace(/\\b(GO|USE|BEGIN|COMMIT|ROLLBACK|EXEC|EXECUTE|CREATE|ALTER|DROP|TABLE|INDEX|VIEW|PROCEDURE|FUNCTION|TRIGGER|CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|KEY|DEFAULT|CHECK|REFERENCES|NOT|NULL|IF|ELSE|END|SET|ON|OFF|WITH|AS|SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|AND|OR|IN|EXISTS|CASE|WHEN|DECLARE|PRINT|ADD|COLUMN|IDENTITY|INT|BIGINT|VARCHAR|NVARCHAR|DATETIME|BIT|FLOAT|DECIMAL|NUMERIC|CHAR|TEXT|DATE|SMALLINT)\\b/gi, '\\x05$1\\x06');
    s = s.replace(/\\b(\\d+)\\b/g, '\\x07$1\\x08');
    return s
      .replace(/\\x01([\\s\\S]*?)\\x02/g, '\\x3cspan class="cmt">$1\\x3c/span>')
      .replace(/\\x03([\\s\\S]*?)\\x04/g, '\\x3cspan class="str">$1\\x3c/span>')
      .replace(/\\x05([\\s\\S]*?)\\x06/g, '\\x3cspan class="kw">$1\\x3c/span>')
      .replace(/\\x07([\\s\\S]*?)\\x08/g, '\\x3cspan class="num">$1\\x3c/span>');
  }
  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/\\x3c/g,'&lt;').replace(/\\x3e/g,'&gt;');
  }
</script>
</body>
</html>`;
    }

    private async showMigrationScript(cwd: string, fromId?: string, toId?: string): Promise<void> {
        const migrationsDir = this.findMigrationsDir(cwd);
        const project = migrationsDir ? this.findMigrationProject(migrationsDir) : undefined;
        const extraPath = this.deps.dotnetToolsPath();
        const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };

        const nonce = this.deps.getNonce();

        if (this.migrationScriptPanel) {
            this.migrationScriptPanel.reveal(vscode.ViewColumn.Beside);
        } else {
            this.migrationScriptPanel = vscode.window.createWebviewPanel(
                'openbase.migrationScript',
                'Migration Dry Run',
                vscode.ViewColumn.Beside,
                { enableScripts: true, retainContextWhenHidden: true }
            );
            this.migrationScriptPanel.onDidDispose(() => {
                this.migrationScriptPanel = undefined;
            });
            this.migrationScriptPanel.webview.onDidReceiveMessage(async (msg) => {
                if (msg.command === 'copy') {
                    await vscode.env.clipboard.writeText(msg.sql);
                    vscode.window.showInformationMessage('SQL copied to clipboard.');
                }
                if (msg.command === 'save') {
                    const scriptsDir = this.deps.getScriptsDir();
                    if (!scriptsDir) {
                        vscode.window.showErrorMessage('No workspace folder open.');
                        return;
                    }
                    const name = await vscode.window.showInputBox({
                        prompt: 'Save migration script as',
                        placeHolder: 'migration-script',
                        validateInput: (v) =>
                            v?.trim() && /^[^\\/:\*\?"<>\|]+$/.test(v.trim()) ? undefined : 'Invalid name',
                    });
                    if (!name?.trim()) return;
                    const safeName = name.trim().replace(/\.sql$/i, '') + '.sql';
                    fs.mkdirSync(scriptsDir, { recursive: true });
                    fs.writeFileSync(path.join(scriptsDir, safeName), msg.sql, 'utf-8');
                    vscode.window.showInformationMessage(`Saved: ${safeName}`);
                    this.deps.refreshSqlScripts();
                }
            });
        }

        this.migrationScriptPanel.webview.html = this.buildMigrationScriptHtml(nonce, this.migrationScriptPanel.webview.cspSource);

        const startupProject = this.findEfStartupProject(cwd);
        const args: string[] = ['ef', 'migrations', 'script'];
        let subtitle = 'all pending (idempotent)';
        if (fromId !== undefined && toId !== undefined) {
            args.push(fromId, toId);
            subtitle = `${fromId || '0'} → ${toId}`;
        } else {
            args.push('--idempotent');
        }
        if (project) args.push('--project', `"${project}"`);
        if (startupProject) args.push('--startup-project', `"${startupProject}"`);

        exec(`dotnet ${args.join(' ')}`, { cwd, env, timeout: 60000 }, (err, stdout, stderr) => {
            if (err && !stdout) {
                this.migrationScriptPanel?.webview.postMessage({ command: 'error', text: stderr || err.message });
            } else {
                this.migrationScriptPanel?.webview.postMessage({ command: 'load', sql: stdout, subtitle });
            }
        });
    }

    private runMigrationCommand(cwd: string, efArgs: string[], title: string): void {
        const channel = vscode.window.createOutputChannel(`OpenBase: ${title}`);
        channel.show(true);
        const extraPath = this.deps.dotnetToolsPath();
        const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
        const migrationsDir = this.findMigrationsDir(cwd);
        const project = migrationsDir ? this.findMigrationProject(migrationsDir) : undefined;
        const startupProject = this.findEfStartupProject(cwd);
        const args = [...efArgs];
        if (project) args.push('--project', `"${project}"`);
        if (startupProject) args.push('--startup-project', `"${startupProject}"`);
        const child = exec(`dotnet ${args.join(' ')}`, { cwd, env, timeout: 120000 });
        child.stdout?.on('data', (d: string) => channel.append(d));
        child.stderr?.on('data', (d: string) => channel.append(d));
        child.on('close', (code) => {
            if (code === 0) {
                channel.appendLine('\nCompleted successfully.');
                vscode.window.showInformationMessage(`${title} completed.`);
            } else {
                channel.appendLine(`\nFailed (exit ${code}).`);
                vscode.window.showErrorMessage(`${title} failed. Check the output panel.`);
            }
            void this.refresh();
        });
        child.on('error', (err) => {
            channel.appendLine(err.message);
            vscode.window.showErrorMessage(err.message);
            void this.refresh();
        });
    }
}

export function setupMigrationRunner(context: vscode.ExtensionContext, deps: MigrationRunnerProviderDeps): void {
    const migrationProvider = new MigrationTreeProvider(deps);

    const tv = vscode.window.createTreeView('openbase.migrationrunner.migrations', {
        treeDataProvider: migrationProvider,
        showCollapseAll: false,
    });
    migrationProvider.setTreeView(tv);
    context.subscriptions.push(tv);

    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            void migrationProvider.refresh();
        }),
        vscode.commands.registerCommand('openbase.migrationRunner.refresh', () => migrationProvider.refresh()),
        vscode.commands.registerCommand('openbase.migrationRunner.migrateUp', () => migrationProvider.migrateUp()),
        vscode.commands.registerCommand('openbase.migrationRunner.migrateTo', (item: MigrationItem) => migrationProvider.migrateTo(item)),
        vscode.commands.registerCommand('openbase.migrationRunner.dryRun', () => migrationProvider.dryRun()),
        vscode.commands.registerCommand('openbase.migrationRunner.dryRunTo', (item: MigrationItem) => migrationProvider.dryRunTo(item)),
    );
}
