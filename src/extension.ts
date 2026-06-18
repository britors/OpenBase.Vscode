import * as vscode from 'vscode';
import { ExtensionOrchestrator } from './orchestrator';

export function activate(context: vscode.ExtensionContext): void {
    new ExtensionOrchestrator(context).activate();
}

export function deactivate(): void {}
