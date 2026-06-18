import * as vscode from 'vscode';

export class OpenBasePanelProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'openbase.panel';
    private _view?: vscode.WebviewView;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        this._view = view;
        view.webview.options = { enableScripts: true };
        view.webview.html = this._html();
    }

    private _html(): string {
        return /* html */`<!DOCTYPE html>
<html lang="en">
<body>
  <h1>OpenBase</h1>
  <p>Panel content placeholder.</p>
</body>
</html>`;
    }
}
