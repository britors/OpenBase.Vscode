import * as path from 'path';
import * as vscode from 'vscode';
import { exec } from 'child_process';

export interface TaskRunnerProviderDeps {
    dotnetToolsPath: () => string;
    postToPanel: (msg: { command: string; entity: string; method: string }) => void;
}

class TaskItem extends vscode.TreeItem {
    constructor(
        public readonly number: number,
        public readonly title: string,
        public readonly labels: string[],
        public readonly milestone: string | null,
        public readonly assignees: string[]
    ) {
        super(`[#${number}] ${title}`, vscode.TreeItemCollapsibleState.None);
        this.tooltip = `Issue #${number}: ${title}\nLabels: ${labels.join(', ')}\nMilestone: ${milestone ?? 'None'}\nAssignees: ${assignees.join(', ')}`;
        this.contextValue = 'task';
        this.iconPath = new vscode.ThemeIcon('issues');
    }
}

class TaskProvider implements vscode.TreeDataProvider<TaskItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TaskItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(
        private readonly cwd: string,
        private readonly dotnetToolsPath: () => string
    ) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TaskItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TaskItem): Promise<TaskItem[]> {
        if (element) return [];

        const tasks: TaskItem[] = [];

        try {
            const stdout = await new Promise<string>((resolve, reject) => {
                const extraPath = this.dotnetToolsPath();
                const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
                exec('gh issue list --json number,title,labels,assignees,milestone', { cwd: this.cwd, env }, (err, out) => {
                    if (err) reject(err);
                    else resolve(out);
                });
            });
            const issues = JSON.parse(stdout) as Array<{
                number: number;
                title: string;
                labels: Array<{ name: string }>;
                milestone?: { title?: string };
                assignees: Array<{ login: string }>;
            }>;
            tasks.push(...issues.map((i) => new TaskItem(i.number, i.title, i.labels.map((l) => l.name), i.milestone?.title || null, i.assignees.map((a) => a.login))));
        } catch (e) {
            console.error('Error fetching GitHub issues:', e);
        }

        tasks.push(new TaskItem(0, 'Azure DevOps Integration (Stub)', ['Azure'], null, []));
        tasks.push(new TaskItem(0, 'Jira Integration (Stub)', ['Jira'], null, []));

        return tasks;
    }
}

export function setupTaskRunner(context: vscode.ExtensionContext, deps: TaskRunnerProviderDeps): void {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootPath) return;

    const taskProvider = new TaskProvider(rootPath, deps.dotnetToolsPath);
    context.subscriptions.push(vscode.window.registerTreeDataProvider('openbase.taskrunner.tree', taskProvider));

    const reg = (id: string, fn: (...args: any[]) => any) =>
        context.subscriptions.push(vscode.commands.registerCommand(id, fn));

    reg('openbase.taskRunner.refresh', () => taskProvider.refresh());

    reg('openbase.taskRunner.openInBrowser', (item: TaskItem) => {
        if (!item) return;
        const extraPath = deps.dotnetToolsPath();
        const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
        exec(`gh issue view ${item.number} --web`, { cwd: rootPath, env });
    });

    reg('openbase.taskRunner.develop', (item: TaskItem) => {
        if (!item) return;
        const terminal = vscode.window.createTerminal({
            name: `OpenBase: Issue #${item.number}`,
            cwd: rootPath,
            env: { PATH: `${deps.dotnetToolsPath()}${path.delimiter}${process.env.PATH ?? ''}` },
        });
        terminal.show();
        terminal.sendText(`gh issue develop ${item.number}`);
    });

    reg('openbase.taskRunner.toSpecialist', (item: TaskItem) => {
        if (!item) return;

        let entity = '';
        let method = '';

        const m1 = item.title.match(/Add\s+(\w+)\s+to\s+(\w+)/i);
        if (m1) {
            method = m1[1];
            entity = m1[2];
        } else {
            const words = item.title.split(' ');
            if (words.length >= 2) {
                method = words[0];
                entity = words[words.length - 1];
            }
        }

        void vscode.commands.executeCommand('openbase.specialist');

        setTimeout(() => {
            deps.postToPanel({
                command: 'fillSpecialist',
                entity,
                method,
            });
        }, 1000);
    });
}
