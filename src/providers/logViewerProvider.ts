import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { spawn } from 'child_process';

export interface LogViewerProviderDeps {
    getNonce: () => string;
    dotnetToolsPath: () => string;
}

class LogViewerController {
    private logPanel: vscode.WebviewPanel | undefined;
    private logProcess: import('child_process').ChildProcess | undefined;

    constructor(private readonly deps: LogViewerProviderDeps) {}

    async open(): Promise<void> {
        if (this.logPanel) {
            this.logPanel.reveal(vscode.ViewColumn.One);
            return;
        }

        const nonce = this.deps.getNonce();
        this.logPanel = vscode.window.createWebviewPanel(
            'openbase.logViewer',
            'OpenBase Logs',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        this.logPanel.onDidDispose(() => {
            this.logProcess?.kill();
            this.logProcess = undefined;
            this.logPanel = undefined;
        });
        this.logPanel.webview.html = buildLogViewerHtml(nonce, this.logPanel.webview.cspSource);

        this.logPanel.webview.onDidReceiveMessage(async (msg: { command: string; config?: string; text?: string }) => {
            if (msg.command === 'start') {
                if (this.logProcess) {
                    this.logProcess.kill();
                    this.logProcess = undefined;
                }
                const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!cwd) {
                    vscode.window.showErrorMessage('No workspace folder open.');
                    return;
                }
                const config = msg.config ?? 'Debug';
                const extraPath = this.deps.dotnetToolsPath();
                const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
                this.logProcess = spawn('openbase', ['run', '-c', config], {
                    cwd,
                    env,
                    detached: true,
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
                this.logPanel?.webview.postMessage({ command: 'processStarted' });
                const onLine = (chunk: Buffer | string) => {
                    const text = chunk.toString();
                    text.split(/\r?\n/).forEach((line) => {
                        if (line) this.logPanel?.webview.postMessage({ command: 'logLine', text: line });
                    });
                };
                this.logProcess.stdout?.on('data', onLine);
                this.logProcess.stderr?.on('data', onLine);
                this.logProcess.on('close', () => {
                    this.logProcess = undefined;
                    this.logPanel?.webview.postMessage({ command: 'processStopped' });
                });
                this.logProcess.on('error', (err) => {
                    this.logProcess = undefined;
                    this.logPanel?.webview.postMessage({ command: 'processStopped' });
                    this.logPanel?.webview.postMessage({ command: 'logLine', text: `[Error] ${err.message}` });
                });
                return;
            }

            if (msg.command === 'stop') {
                this.logProcess?.kill();
                this.logProcess = undefined;
                this.logPanel?.webview.postMessage({ command: 'processStopped' });
                return;
            }

            if (msg.command === 'export') {
                const defaultUri = vscode.Uri.file(
                    path.join(
                        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(),
                        `openbase-logs-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`,
                    ),
                );
                const uri = await vscode.window.showSaveDialog({ defaultUri, filters: { Text: ['txt'] } });
                if (uri && msg.text) {
                    fs.writeFileSync(uri.fsPath, msg.text, 'utf-8');
                    vscode.window.showInformationMessage(`Logs exported to ${path.basename(uri.fsPath)}`);
                }
                return;
            }
        });
    }
}

function buildLogViewerHtml(nonce: string, cspSource: string): string {
    void cspSource;
    return /* html */ `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root{
    --ob-bg1:var(--vscode-editor-background,#1e1e1e);
    --ob-bg2:var(--vscode-sideBar-background,#252526);
    --ob-border:var(--vscode-panel-border,rgba(128,128,128,.2));
    --ob-text:var(--vscode-editor-foreground,#d4d4d4);
    --ob-dim:var(--vscode-descriptionForeground,#858585);
    --ob-purple:#b44fff;
    --ob-yellow:#e5c07b;
    --ob-red:#e06c75;
    --ob-red2:#ff5555;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:var(--vscode-editor-font-family,Consolas,monospace);font-size:var(--vscode-editor-font-size,12px);color:var(--ob-text);background:var(--ob-bg1);height:100vh;display:flex;flex-direction:column;overflow:hidden}
  .toolbar{display:flex;align-items:center;gap:5px;padding:4px 8px;background:var(--ob-bg2);border-bottom:1px solid var(--ob-border);flex-shrink:0;flex-wrap:wrap}
  .sep{width:1px;height:16px;background:var(--ob-border);flex-shrink:0}
  .btn{padding:2px 8px;font-size:11px;font-family:inherit;cursor:pointer;border:1px solid var(--ob-border);background:var(--ob-bg2);color:var(--ob-text);border-radius:2px;white-space:nowrap}
  .btn:hover{background:var(--ob-purple);color:#fff;border-color:var(--ob-purple)}
  .btn-primary{background:var(--ob-purple);color:#fff;border-color:var(--ob-purple)}
  .btn-primary:hover{opacity:.85}
  .btn-danger{background:#c72e0f;color:#fff;border-color:transparent}
  .btn-danger:hover{opacity:.85;background:#c72e0f}
  .btn.active{background:var(--ob-purple);color:#fff;border-color:var(--ob-purple)}
  select,input[type=text]{background:var(--ob-bg1);color:var(--ob-text);border:1px solid var(--ob-border);padding:2px 5px;font-size:11px;font-family:inherit;border-radius:2px;outline:none}
  input[type=text]{width:120px}
  .badge{font-size:10px;padding:1px 7px;border-radius:10px;font-weight:600;white-space:nowrap}
  .badge-running{background:var(--ob-purple);color:#fff}
  .badge-stopped{background:transparent;color:var(--ob-dim);border:1px solid var(--ob-border)}
  .cnt-err{color:var(--ob-red);font-size:10px;font-weight:600;white-space:nowrap}
  .cnt-warn{color:var(--ob-yellow);font-size:10px;font-weight:600;white-space:nowrap}
  #log-area{flex:1;overflow-y:auto;padding:2px 0}
  .log-line{padding:1px 8px;line-height:1.5;white-space:pre-wrap;word-break:break-all;font-family:inherit}
  .log-line:hover{background:rgba(128,128,128,.07)}
  .log-line.hidden{display:none}
  .ll-trace{color:var(--ob-dim);opacity:.7}
  .ll-debug{color:var(--ob-dim)}
  .ll-info{color:var(--ob-text)}
  .ll-warn{color:var(--ob-yellow)}
  .ll-error{color:var(--ob-red)}
  .ll-critical{color:var(--ob-red2);background:rgba(255,85,85,.08);font-weight:600}
  .hl{background:rgba(180,79,255,.35);border-radius:2px}
  .placeholder{padding:24px;color:var(--ob-dim);font-size:12px;font-style:italic;text-align:center}
  .hidden{display:none!important}
</style>
</head>
<body>
<div class="toolbar">
  <button id="start-btn" class="btn btn-primary">&#x25B6; Run</button>
  <button id="stop-btn" class="btn btn-danger hidden">&#x25A0; Stop</button>
  <select id="config-select"><option value="Debug">Debug</option><option value="Release">Release</option></select>
  <span id="status-badge" class="badge badge-stopped">Stopped</span>
  <div class="sep"></div>
  <select id="level-select" title="Minimum log level">
    <option value="0">TRACE+</option>
    <option value="1">DEBUG+</option>
    <option value="2" selected>INFO+</option>
    <option value="3">WARN+</option>
    <option value="4">ERROR+</option>
  </select>
  <input id="search-input" type="text" placeholder="Filter text&#x2026;" title="Filter by text">
  <input id="ns-input" type="text" placeholder="Hide ns&#x2026;" title="Hide namespace, e.g. Microsoft.*">
  <div class="sep"></div>
  <button id="autoscroll-btn" class="btn active" title="Toggle auto-scroll">&#x21E9; Auto</button>
  <span id="cnt-err" class="cnt-err">0 err</span>
  <span id="cnt-warn" class="cnt-warn">0 warn</span>
  <div class="sep"></div>
  <button id="clear-btn" class="btn">Clear</button>
  <button id="export-btn" class="btn">Export</button>
</div>
<div id="log-area"><p class="placeholder">Start the application to see logs&#x2026;</p></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const MAX_LINES = 5000;
  var buffer = [];
  var errCount = 0, warnCount = 0;
  var autoScroll = true;
  var searchTimer = null;
  var LCLS = ['ll-trace','ll-debug','ll-info','ll-warn','ll-error','ll-critical'];

  function detectLevel(t) {
    var m = t.match(/^\\{"@[Ll]"\\s*:\\s*"(\\w+)"/);
    if (m) {
      var jl = m[1].toLowerCase();
      if (jl==='fatal'||jl==='critical') return 5;
      if (jl==='error') return 4;
      if (jl==='warning') return 3;
      if (jl==='debug') return 1;
      if (jl==='verbose'||jl==='trace') return 0;
      return 2;
    }
    if (/^crit\\s*:/i.test(t)) return 5;
    if (/^(fail|error)\\s*:/i.test(t)) return 4;
    if (/^warn\\s*:/i.test(t)) return 3;
    if (/^info\\s*:/i.test(t)) return 2;
    if (/^(dbug|debug)\\s*:/i.test(t)) return 1;
    if (/^trce\\s*:/i.test(t)) return 0;
    var sm = t.match(/\\[\\d{2}:\\d{2}:\\d{2} (\\w{3})\\]/);
    if (sm) {
      var sl = sm[1].toUpperCase();
      if (sl==='FTL') return 5;
      if (sl==='ERR') return 4;
      if (sl==='WRN') return 3;
      if (sl==='INF') return 2;
      if (sl==='DBG') return 1;
      if (sl==='VRB') return 0;
    }
    if (/\\b(crit|critical|fatal)\\b/i.test(t)) return 5;
    if (/\\b(error|fail|exception)\\b/i.test(t)) return 4;
    if (/\\b(warn|warning)\\b/i.test(t)) return 3;
    if (/\\bdebug\\b/i.test(t)) return 1;
    if (/\\b(trace|verbose)\\b/i.test(t)) return 0;
    return 2;
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/\\x3c/g,'&lt;').replace(/>/g,'&gt;');
  }

  function hlText(text, search) {
    if (!search) return esc(text);
    try {
      var re = new RegExp(search.replace(/[.*+?^{}()|[\\]\\\\$]/g,'\\\\$&'),'gi');
      return esc(text).replace(re,function(m){return '\\x3cspan class="hl">'+m+'\\x3c/span>';});
    } catch(e) { return esc(text); }
  }

  function getMinLvl(){ return parseInt(document.getElementById('level-select').value,10); }
  function getSearch(){ return document.getElementById('search-input').value.trim().toLowerCase(); }
  function getNs(){ return document.getElementById('ns-input').value.trim(); }

  function nsHides(text, pat) {
    if (!pat) return false;
    try {
      var re = new RegExp('^'+pat.replace(/\\./g,'\\\\.').replace(/\\*/g,'.*')+'\\b','i');
      return re.test(text);
    } catch(e){ return false; }
  }

  function passes(entry) {
    if (entry.level < getMinLvl()) return false;
    var s = getSearch();
    if (s && entry.text.toLowerCase().indexOf(s) === -1) return false;
    var ns = getNs();
    if (ns && nsHides(entry.text, ns)) return false;
    return true;
  }

  var logArea = document.getElementById('log-area');
  var placeholder = logArea.querySelector('.placeholder');

  function clearPlaceholder() {
    if (placeholder) { placeholder.remove(); placeholder = null; }
  }

  function mkEl(entry) {
    var div = document.createElement('div');
    div.className = 'log-line ' + LCLS[Math.min(entry.level,5)];
    div.innerHTML = hlText(entry.text, getSearch());
    if (!passes(entry)) div.classList.add('hidden');
    return div;
  }

  function addEntry(text, level) {
    clearPlaceholder();
    var entry = { text: text, level: level };
    if (buffer.length >= MAX_LINES) {
      buffer.shift();
      if (logArea.firstChild) logArea.removeChild(logArea.firstChild);
    }
    buffer.push(entry);
    if (level >= 5) errCount++;
    else if (level >= 4) errCount++;
    else if (level >= 3) warnCount++;
    updateCounters();
    var el = mkEl(entry);
    logArea.appendChild(el);
    if (autoScroll && !el.classList.contains('hidden')) logArea.scrollTop = logArea.scrollHeight;
  }

  function updateCounters() {
    document.getElementById('cnt-err').textContent = errCount + ' err';
    document.getElementById('cnt-warn').textContent = warnCount + ' warn';
  }

  function rebuildView() {
    logArea.innerHTML = '';
    placeholder = null;
    buffer.forEach(function(entry) {
      logArea.appendChild(mkEl(entry));
    });
    if (autoScroll) logArea.scrollTop = logArea.scrollHeight;
  }

  document.getElementById('start-btn').addEventListener('click', function() {
    vscode.postMessage({ command: 'start', config: document.getElementById('config-select').value });
  });
  document.getElementById('stop-btn').addEventListener('click', function() {
    vscode.postMessage({ command: 'stop' });
  });
  document.getElementById('clear-btn').addEventListener('click', function() {
    buffer = []; errCount = 0; warnCount = 0;
    updateCounters();
    logArea.innerHTML = '\\x3cp class="placeholder">Cleared.\\x3c/p>';
    placeholder = logArea.querySelector('.placeholder');
  });
  document.getElementById('export-btn').addEventListener('click', function() {
    vscode.postMessage({ command: 'export', text: buffer.map(function(e){return e.text;}).join('\\n') });
  });
  document.getElementById('autoscroll-btn').addEventListener('click', function() {
    autoScroll = !autoScroll;
    this.classList.toggle('active', autoScroll);
    if (autoScroll) logArea.scrollTop = logArea.scrollHeight;
  });
  document.getElementById('level-select').addEventListener('change', rebuildView);
  document.getElementById('search-input').addEventListener('input', function() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(rebuildView, 150);
  });
  document.getElementById('ns-input').addEventListener('input', function() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(rebuildView, 150);
  });

  window.addEventListener('message', function(event) {
    var msg = event.data;
    if (msg.command === 'logLine') {
      addEntry(msg.text, detectLevel(msg.text));
    } else if (msg.command === 'processStarted') {
      document.getElementById('start-btn').classList.add('hidden');
      document.getElementById('stop-btn').classList.remove('hidden');
      document.getElementById('config-select').disabled = true;
      var badge = document.getElementById('status-badge');
      badge.textContent = 'Running';
      badge.className = 'badge badge-running';
    } else if (msg.command === 'processStopped') {
      document.getElementById('start-btn').classList.remove('hidden');
      document.getElementById('stop-btn').classList.add('hidden');
      document.getElementById('config-select').disabled = false;
      var badge2 = document.getElementById('status-badge');
      badge2.textContent = 'Stopped';
      badge2.className = 'badge badge-stopped';
    }
  });
</script>
</body></html>`;
}

export function setupLogViewer(context: vscode.ExtensionContext, deps: LogViewerProviderDeps): void {
    const controller = new LogViewerController(deps);
    context.subscriptions.push(vscode.commands.registerCommand('openbase.logViewer', () => controller.open()));
}
