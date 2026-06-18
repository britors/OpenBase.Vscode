import * as vscode from 'vscode';
import * as path from 'path';
import { exec } from 'child_process';
import { Utils } from '../utils';

export class TaskItem extends vscode.TreeItem {
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

export class TaskProvider implements vscode.TreeDataProvider<TaskItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TaskItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly cwd: string) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TaskItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TaskItem): Promise<TaskItem[]> {
        if (element) return [];

        const tasks: TaskItem[] = [];

        // GitHub Issues (Existing)
        try {
            const stdout = await new Promise<string>((resolve, reject) => {
                const extraPath = Utils.getInstance().dotnetToolsPath();
                const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
                exec('gh issue list --json number,title,labels,assignees,milestone', { cwd: this.cwd, env }, (err, out, stderr) => {
                    if (err) reject(err);
                    else resolve(out);
                });
            });
            const issues = JSON.parse(stdout);
            tasks.push(...issues.map((i: any) => new TaskItem(i.number, i.title, i.labels.map((l: any) => l.name), i.milestone?.title || null, i.assignees.map((a: any) => a.login))));
        } catch (e) {
            console.error('Error fetching GitHub issues:', e);
        }

        // Azure DevOps (Stub)
        tasks.push(new TaskItem(0, "Azure DevOps Integration (Stub)", ["Azure"], null, []));

        // Jira (Stub)
        tasks.push(new TaskItem(0, "Jira Integration (Stub)", ["Jira"], null, []));

        return tasks;
    }
}
