import * as vscode from 'vscode';

export class RunnerSidebarProvider implements vscode.WebviewViewProvider {
    constructor(
        private readonly label: string,
        private readonly btnLabel: string,
        private readonly open: () => void
    ) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        view.webview.options = { enableScripts: true };
        view.webview.html = this.html();
        view.onDidChangeVisibility(() => { if (view.visible) this.open(); });
        view.webview.onDidReceiveMessage((msg: { command?: string }) => {
            if (msg.command === 'open') this.open();
        });
    }

    private html(): string {
        return /* html */`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:16px;text-align:center}
  p{color:var(--vscode-descriptionForeground);font-size:12px;margin-bottom:12px}
  button{padding:6px 12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;cursor:pointer;font-family:inherit;font-size:inherit;width:100%}
  button:hover{background:var(--vscode-button-hoverBackground)}
</style></head>
<body>
  <p>Click below to open ${this.label} in the editor.</p>
  <button onclick="vscode.postMessage({command:'open'})">${this.btnLabel}</button>
  <script>const vscode = acquireVsCodeApi();</script>
</body></html>`;
    }
}
