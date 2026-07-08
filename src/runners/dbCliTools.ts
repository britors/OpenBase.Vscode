import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { execSync } from 'child_process';

export type DbCliTool = 'psql' | 'sqlcmd' | 'sqlplus';

export interface DbCliToolResolver {
    resolve(tool: DbCliTool): string;
    configuredPath(tool: DbCliTool): string | undefined;
}

function quote(arg: string): string {
    return arg.includes(' ') ? `"${arg}"` : arg;
}

function isWindows(): boolean {
    return process.platform === 'win32';
}

function commandExists(command: string): boolean {
    try {
        if (isWindows()) {
            execSync(`where ${command}`, { stdio: 'ignore' });
        } else {
            execSync(`command -v ${command}`, { stdio: 'ignore' });
        }
        return true;
    } catch {
        return false;
    }
}

function settingKey(tool: DbCliTool): string {
    if (tool === 'psql') return 'dbTools.psqlPath';
    if (tool === 'sqlcmd') return 'dbTools.sqlcmdPath';
    return 'dbTools.sqlplusPath';
}

function normalizeToolExecutable(tool: DbCliTool): string {
    if (tool !== 'sqlplus' && isWindows()) {
        return `${tool}.exe`;
    }
    return tool;
}

function resolveCommandPath(tool: DbCliTool, cfg: vscode.WorkspaceConfiguration): string {
    const configured = (cfg.get<string>(settingKey(tool)) ?? '').trim();
    if (configured) {
        if (configured.includes(path.sep) || configured.includes('/') || configured.includes('\\')) {
            const normalized = configured.replace(/^"|"$/g, '');
            if (fs.existsSync(normalized)) {
                return quote(normalized);
            }
            // Keep configured value to surface shell error with the user-provided path.
            return quote(normalized);
        }
        return quote(configured);
    }

    const base = normalizeToolExecutable(tool);
    if (commandExists(base)) return base;
    return tool;
}

export function createDbCliToolResolver(cfg?: vscode.WorkspaceConfiguration): DbCliToolResolver {
    return {
        resolve(tool: DbCliTool): string {
            const conf = cfg ?? vscode.workspace.getConfiguration('openbase');
            return resolveCommandPath(tool, conf);
        },
        configuredPath(tool: DbCliTool): string | undefined {
            const conf = cfg ?? vscode.workspace.getConfiguration('openbase');
            const val = (conf.get<string>(settingKey(tool)) ?? '').trim();
            return val || undefined;
        },
    };
}

export function buildDbCliEnv(dotnetToolsPath: string): NodeJS.ProcessEnv {
    const cfg = vscode.workspace.getConfiguration('openbase');
    const prependPaths = cfg.get<string[]>('dbTools.prependPaths') ?? [];
    const resolver = createDbCliToolResolver(cfg);
    const configured = (['psql', 'sqlcmd', 'sqlplus'] as DbCliTool[])
        .map((tool) => resolver.configuredPath(tool))
        .filter((v): v is string => Boolean(v))
        .map((v) => v.replace(/^"|"$/g, ''))
        .map((v) => path.dirname(v));

    const extraPaths = [dotnetToolsPath, ...prependPaths, ...configured].filter((p) => p && p.trim().length > 0);
    return {
        ...process.env,
        PATH: `${extraPaths.join(path.delimiter)}${path.delimiter}${process.env.PATH ?? ''}`,
    };
}
