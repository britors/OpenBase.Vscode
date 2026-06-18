import * as vscode from 'vscode';

export const DB_TEMPLATES = ['sqlserver', 'pgsql', 'oracle'] as const;
export type DbTemplate = typeof DB_TEMPLATES[number];
export const BUILD_CONFIGS = ['Debug', 'Release'] as const;
export const NEW_PROJECT_PREFS_KEY = 'newProjectPrefs';
export const EXTENSIONS = ['jwt', 'redis', 'healthchecks', 'mongodb', 'domainevents'] as const;
export const EXTENSION_PROVIDERS: Partial<Record<string, string[]>> = {};

export interface DbConnection {
    label: string;
    type: DbTemplate;
    server: string;
    database: string;
    user?: string;
    password?: string;
    port?: string;
}

export interface ExplainNode {
    op: string;
    cost: number;
    rows: number;
    detail?: string;
    children?: ExplainNode[];
}

export interface PackageRef {
    name: string;
    version: string;
    latest?: string;
}

export interface ProjectPackages {
    project: string;
    projectPath: string;
    packages: PackageRef[];
}

export interface HistoryEntry {
    sql: string;
    timestamp: number;
    connectionLabel: string;
    rowCount: number;
}

export let extContext: vscode.ExtensionContext | undefined;
export let diagnosticCollection: vscode.DiagnosticCollection;
