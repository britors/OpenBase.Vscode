import { DbConnection } from '../models/dbConnection';

export function buildSqlRunnerHtml(conn: DbConnection | undefined, nonce: string, cspSource: string): string {
    const connLabel = (conn?.label ?? 'No connection')
        .replace(/&/g, '&amp;').replace(/\x3c/g, '&lt;').replace(/\x3e/g, '&gt;');
    const monacoBase = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.47.0/min/vs';
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline' https://cdn.jsdelivr.net; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net data:; worker-src blob: data:;">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%;overflow:hidden}
  body{display:flex;flex-direction:column;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background)}
  .header{display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}
  .header-title{font-weight:600;font-size:13px}
  .badge{padding:2px 8px;border-radius:3px;font-size:11px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
  .badge.warn{background:var(--vscode-inputValidation-warningBackground);color:var(--vscode-inputValidation-warningForeground,#000)}
  .editor-wrap{flex:0 0 220px;position:relative;border-bottom:1px solid var(--vscode-panel-border)}
  #editor{position:absolute;top:0;left:0;right:0;bottom:0}
  .editor-loading{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:11px;opacity:.4;pointer-events:none}
  .toolbar{display:flex;align-items:center;gap:8px;padding:5px 12px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;background:var(--vscode-sideBar-background)}
  .btn{padding:4px 10px;border:none;cursor:pointer;font-family:inherit;font-size:inherit}
  .btn-primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
  .btn-primary:hover{background:var(--vscode-button-hoverBackground)}
  .btn-primary:disabled{opacity:.5;cursor:not-allowed}
  .btn-secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
  .btn-secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}
  .btn-cancel{background:var(--vscode-statusBarItem-errorBackground,#c72e0f);color:#fff}
  .btn-cancel:hover{opacity:.85}
  .hidden{display:none!important}
  .hint{font-size:11px;color:var(--vscode-descriptionForeground)}
  .status{margin-left:auto;font-size:11px;color:var(--vscode-descriptionForeground);display:flex;align-items:center;gap:5px}
  .spinner{display:inline-block;width:10px;height:10px;border:2px solid var(--vscode-foreground);border-top-color:transparent;border-radius:50%;animation:spin .6s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .results{flex:1;overflow:auto}
  .placeholder{padding:20px;color:var(--vscode-descriptionForeground);font-size:12px;font-style:italic}
  .err-box{margin:12px;padding:8px 12px;background:var(--vscode-inputValidation-errorBackground);border:1px solid var(--vscode-inputValidation-errorBorder);font-size:12px;white-space:pre-wrap;font-family:monospace}
  .msg-box{margin:12px;padding:8px 12px;background:var(--vscode-inputValidation-infoBackground);border:1px solid var(--vscode-inputValidation-infoBorder);font-size:12px;white-space:pre-wrap;font-family:monospace}
  .result-header{display:flex;align-items:center;justify-content:space-between;padding:4px 12px;font-size:11px;color:var(--vscode-descriptionForeground);border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);flex-shrink:0}
  table{width:100%;border-collapse:collapse;font-size:12px}
  thead{position:sticky;top:0;background:var(--vscode-editor-background);z-index:1}
  th{text-align:left;padding:5px 10px;border-bottom:2px solid var(--vscode-panel-border);font-weight:600;white-space:nowrap}
  td{padding:4px 10px;border-bottom:1px solid color-mix(in srgb,var(--vscode-panel-border) 40%,transparent);white-space:nowrap;max-width:360px;overflow:hidden;text-overflow:ellipsis}
  tr:hover td{background:var(--vscode-list-hoverBackground)}
  td.null{color:var(--vscode-descriptionForeground);font-style:italic}
  td.editing{padding:0!important}
  .cell-edit-input{width:100%;height:100%;background:var(--ob-bg2,#1c1535);color:var(--ob-text,#ede8f8);border:1px solid var(--ob-purple,#b44fff)!important;font-size:12px;font-family:inherit;padding:3px 8px;outline:none}
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
  .header{background:linear-gradient(135deg,rgba(180,79,255,.18),rgba(255,63,164,.10))!important;border-bottom:1px solid var(--ob-border)!important}
  .header-title{background:linear-gradient(90deg,var(--ob-purple),var(--ob-pink));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
  .badge{background:rgba(180,79,255,.2)!important;color:var(--ob-purple)!important;border:1px solid var(--ob-border)}
  .badge.warn{background:rgba(255,63,164,.15)!important;color:var(--ob-pink)!important;border-color:rgba(255,63,164,.35)!important}
  .editor-wrap{border-bottom:1px solid var(--ob-border)!important}
  .toolbar{background:var(--ob-bg1)!important;border-bottom:1px solid var(--ob-border)!important}
  .btn-primary{background:linear-gradient(135deg,var(--ob-purple),var(--ob-pink))!important;color:#fff!important;border-radius:4px}
  .btn-primary:hover:not(:disabled){filter:brightness(1.15)}
  .btn-primary:disabled{opacity:.35!important}
  .btn-secondary{background:rgba(180,79,255,.12)!important;color:var(--ob-purple)!important;border:1px solid var(--ob-border);border-radius:4px}
  .btn-secondary:hover{background:rgba(180,79,255,.24)!important}
  .btn-cancel{border-radius:4px}
  .hint{color:var(--ob-dim)!important}
  .status{color:var(--ob-dim)!important}
  .results{background:var(--ob-bg0)!important}
  .placeholder{color:var(--ob-dim)!important}
  .result-header{background:var(--ob-bg1)!important;border-bottom:1px solid var(--ob-border)!important;color:var(--ob-dim)!important}
  thead{background:var(--ob-bg1)!important}
  th{border-bottom-color:var(--ob-border)!important;color:var(--ob-purple)!important}
  td{border-bottom:1px solid rgba(180,79,255,.07)!important}
  tr:hover td{background:rgba(180,79,255,.07)!important}
  .err-box{background:rgba(255,63,164,.10)!important;border-color:rgba(255,63,164,.35)!important;color:#ff90c0!important}
  .msg-box{background:rgba(180,79,255,.10)!important;border-color:var(--ob-border)!important;color:var(--ob-purple)!important}
  .spinner{border-color:var(--ob-purple)!important;border-top-color:transparent!important}
  .editor-loading{color:var(--ob-dim)!important}
  #history-panel{flex:1;overflow:auto;display:flex;flex-direction:column;background:var(--ob-bg0)}
  .history-toolbar{display:flex;align-items:center;justify-content:space-between;padding:4px 12px;font-size:11px;color:var(--ob-dim);border-bottom:1px solid var(--ob-border);background:var(--ob-bg1);flex-shrink:0}
  #history-list{flex:1;overflow:auto}
  .history-item{padding:8px 12px;border-bottom:1px solid rgba(180,79,255,.07);cursor:pointer;display:flex;flex-direction:column;gap:4px}
  .history-item:hover{background:rgba(180,79,255,.07)}
  .history-preview{font-family:monospace;font-size:11px;color:var(--ob-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .history-meta{font-size:10px;color:var(--ob-dim);display:flex;gap:8px;align-items:center}
  .history-pin{margin-left:auto;font-size:10px!important;padding:1px 6px!important;opacity:0;transition:opacity .15s}
  .history-item:hover .history-pin{opacity:1}
  .history-empty{padding:20px;color:var(--ob-dim);font-size:12px;font-style:italic}
  #explain-panel{flex:1;overflow:auto;display:flex;flex-direction:column;background:var(--ob-bg0)}
  .explain-toolbar{display:flex;align-items:center;justify-content:space-between;padding:4px 12px;font-size:11px;color:var(--ob-dim);border-bottom:1px solid var(--ob-border);background:var(--ob-bg1);flex-shrink:0}
  .explain-tree{padding:12px;overflow:auto;flex:1}
  .explain-node{margin-left:14px;border-left:2px solid rgba(180,79,255,.2);padding-left:10px;margin-top:6px}
  .explain-root{margin-left:0!important;border-left:none!important;padding-left:0!important;margin-top:0!important}
  #result-tabs{display:flex;flex-shrink:0;border-bottom:1px solid var(--ob-border);background:var(--ob-bg1);overflow-x:auto;overflow-y:hidden;min-height:28px}
  .result-tab{display:flex;align-items:center;gap:5px;padding:3px 10px;cursor:pointer;font-size:11px;border-right:1px solid var(--ob-border);white-space:nowrap;user-select:none;color:var(--ob-dim);border-top:2px solid transparent}
  .result-tab.active{color:var(--ob-text);background:var(--ob-bg0);border-top-color:var(--ob-purple)}
  .result-tab:hover:not(.active){background:rgba(180,79,255,.07)}
  .result-tab-label{max-width:160px;overflow:hidden;text-overflow:ellipsis}
  .result-tab-close{opacity:0;font-size:10px;line-height:1;padding:1px 3px;border-radius:2px;flex-shrink:0}
  .result-tab-close:hover{background:rgba(255,63,164,.25);opacity:1!important;color:var(--ob-pink)}
  .result-tab:hover .result-tab-close{opacity:.5}
  .node-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:3px 0}
  .node-op{font-weight:600;font-size:12px;color:var(--ob-text)}
  .node-detail{font-size:11px;color:var(--ob-dim);font-style:italic}
  .cost-badge{font-size:10px;padding:1px 5px;border-radius:3px;font-family:monospace}
  .rows-badge{font-size:10px;color:var(--ob-dim);font-family:monospace}
  .cost-low{background:rgba(52,211,153,.15);color:#34d399;border:1px solid rgba(52,211,153,.3)}
  .cost-med{background:rgba(251,191,36,.15);color:#fbbf24;border:1px solid rgba(251,191,36,.3)}
  .cost-high{background:rgba(248,113,113,.15);color:#f87171;border:1px solid rgba(248,113,113,.3)}
</style>
</head>
<body>
<div class="header">
  <span class="header-title">OpenBase SQL</span>
  <span class="badge ${conn ? '' : 'warn'}">${connLabel}</span>
</div>
<div class="editor-wrap">
  <div id="editor"></div>
  <div class="editor-loading" id="editor-loading">Loading editor&hellip;</div>
</div>
<div class="toolbar">
  <button id="run-btn" class="btn btn-primary">&#x25B6; Run</button>
  <button id="cancel-btn" class="btn btn-cancel hidden">&#x2715; Cancel</button>
  <button id="explain-btn" class="btn btn-secondary" title="Show execution plan (Explain)">&#x26A1; Explain</button>
  <button id="save-btn" class="btn btn-secondary" title="Save script to library">Save&hellip;</button>
  <button id="history-btn" class="btn btn-secondary" title="Show query history">History</button>
  <button id="specialist-btn" class="btn btn-secondary" title="Send query to Specialist">&#x2192; Specialist</button>
  <span class="hint">F8 to run</span>
  <span id="status" class="status"></span>
</div>
<div id="result-tabs" class="hidden"></div>
<div id="results" class="results">
  <p class="placeholder">Write a query above and press Run or F8</p>
</div>
<div id="history-panel" class="hidden">
  <div class="history-toolbar">
    <span>Query history</span>
    <input id="history-filter" type="text" placeholder="Filter history..." style="font-size:11px;padding:2px 5px;margin-left:auto;width:120px">
    <button id="clear-history-btn" class="btn btn-secondary" style="font-size:11px;padding:2px 8px">Clear all</button>
  </div>
  <div id="history-list"><p class="history-empty">No history yet.</p></div>
</div>
<div id="explain-panel" class="hidden">
  <div class="explain-toolbar">
    <span>Execution plan</span>
    <button id="back-from-explain-btn" class="btn btn-secondary" style="font-size:11px;padding:2px 8px">&#xAB; Results</button>
  </div>
  <div id="explain-tree" class="explain-tree"><p class="placeholder">Loading…</p></div>
</div>
<script src="${monacoBase}/loader.js"></script>
<script nonce="${nonce}">
  window.onerror = function(msg, src, line, col) {
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#c72e0f;color:#fff;padding:6px 10px;font-size:12px;font-family:monospace;z-index:9999;white-space:pre-wrap';
    box.textContent = 'JS ERROR: ' + msg + '\n' + src + ':' + line + ':' + col;
    document.body.appendChild(box);
  };
  var vscode = acquireVsCodeApi();
  var running = false, t0 = 0;
  var lastColumns = [], lastRows = [];
  var runTimeoutId = null;
  var editor = null;
  var pendingLoad = null;
  var historyEntries = [];
  var historyVisible = false;
  var activePanel = 'results'; // 'results' | 'history' | 'explain'
  var resultTabs = [];
  var activeTabId = null;
  var tabCounter = 0;
  var lastRunSql = '';

  document.getElementById('run-btn').addEventListener('click', run);
  document.getElementById('cancel-btn').addEventListener('click', function() {
    clearRunTimeout();
    vscode.postMessage({ command: 'cancel' });
  });
  document.getElementById('save-btn').addEventListener('click', function() {
    var sql = editor ? editor.getValue() : '';
    if (sql.trim()) vscode.postMessage({ command: 'saveScript', sql: sql });
  });
  document.getElementById('history-btn').addEventListener('click', function() {
    toggleHistory();
  });
  document.getElementById('history-filter').addEventListener('input', function(e) {
    var filter = e.target.value.toLowerCase();
    var items = document.querySelectorAll('.history-item');
    items.forEach(function(item) {
        var text = item.textContent.toLowerCase();
        item.classList.toggle('hidden', text.indexOf(filter) === -1);
    });
  });
  document.getElementById('clear-history-btn').addEventListener('click', function() {
    vscode.postMessage({ command: 'clearHistory' });
  });
  document.getElementById('history-list').addEventListener('click', function(e) {
    var pin = e.target.closest('.history-pin');
    if (pin) {
      var idx = parseInt(pin.getAttribute('data-idx'), 10);
      var entry = historyEntries[idx];
      if (entry) vscode.postMessage({ command: 'saveScript', sql: entry.sql });
      return;
    }
    var item = e.target.closest('.history-item');
    if (item) {
      var idx2 = parseInt(item.getAttribute('data-idx'), 10);
      var entry2 = historyEntries[idx2];
      if (entry2) {
        if (editor) {
          editor.setValue(entry2.sql);
          editor.setPosition({ lineNumber: 1, column: 1 });
        } else {
          pendingLoad = entry2.sql;
        }
        if (historyVisible) toggleHistory();
      }
    }
  });
  document.getElementById('specialist-btn').addEventListener('click', function() {
    var sql = editor ? editor.getValue() : '';
    var sel = editor ? editor.getSelection() : null;
    if (sel && !sel.isEmpty()) sql = editor.getModel().getValueInRange(sel);
    if (sql.trim()) vscode.postMessage({ command: 'sendToSpecialist', sql: sql });
  });
  document.getElementById('explain-btn').addEventListener('click', function() {
    var sql = editor ? editor.getValue() : '';
    var sel = editor ? editor.getSelection() : null;
    if (sel && !sel.isEmpty()) sql = editor.getModel().getValueInRange(sel);
    if (!sql.trim()) return;
    vscode.postMessage({ command: 'explain', sql: sql });
  });
  document.getElementById('back-from-explain-btn').addEventListener('click', function() {
    showPanel('results');
  });
  document.getElementById('result-tabs').addEventListener('click', function(e) {
    var closeBtn = e.target.closest('[data-close-id]');
    if (closeBtn) { closeTab(parseInt(closeBtn.getAttribute('data-close-id'), 10)); return; }
    var tabEl = e.target.closest('[data-tab-id]');
    if (tabEl) activateTab(parseInt(tabEl.getAttribute('data-tab-id'), 10));
  });
  document.getElementById('results').addEventListener('click', function(e) {
    if (e.target && e.target.id === 'export-csv-btn') exportCsv();
  });
  document.getElementById('results').addEventListener('dblclick', function(e) {
    var td = e.target.closest('td');
    if (!td) return;
    var c = parseInt(td.getAttribute('data-c'), 10);
    if (isNaN(c) || c === 0) return;
    var r = parseInt(td.getAttribute('data-r'), 10);
    if (isNaN(r)) return;
    var sql = editor ? editor.getValue() : '';
    var tableMatch = sql.match(/\bFROM\s+([\w\."\`\[\]]+)/i);
    if (!tableMatch) return;
    var tableName = tableMatch[1].replace(/["\`\[\]]/g, '');
    var keyCol = lastColumns[0];
    var keyVal = lastRows[r] ? String(lastRows[r][0]) : '';
    var colName = lastColumns[c];
    var origVal = td.textContent;
    td.classList.add('editing');
    td.innerHTML = '';
    var inp = document.createElement('input');
    inp.className = 'cell-edit-input';
    inp.value = origVal === 'NULL' ? '' : origVal;
    td.appendChild(inp);
    inp.focus();
    inp.select();
    function commit() {
      var newVal = inp.value;
      td.classList.remove('editing');
      td.textContent = newVal;
      vscode.postMessage({ command: 'editCell', table: tableName, keyColumn: keyCol, keyValue: keyVal, column: colName, newValue: newVal });
    }
    function cancel() {
      td.classList.remove('editing');
      td.textContent = origVal;
    }
    inp.addEventListener('keydown', function(ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
      else if (ev.key === 'Tab') { ev.preventDefault(); commit(); }
    });
    inp.addEventListener('blur', function() { cancel(); });
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'F8') { e.preventDefault(); run(); }
  });

  window.MonacoEnvironment = {
    getWorkerUrl: function() {
      return 'data:text/javascript;charset=utf-8,' + encodeURIComponent('self.onmessage=function(){};');
    }
  };
  require.config({ paths: { vs: '${monacoBase}' } });
  require(['vs/editor/editor.main'], function() {
    monaco.editor.defineTheme('openbase-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'keyword.sql',  foreground: 'c084fc', fontStyle: 'bold' },
        { token: 'keyword',      foreground: 'c084fc', fontStyle: 'bold' },
        { token: 'string.sql',   foreground: 'f472b6' },
        { token: 'string',       foreground: 'f472b6' },
        { token: 'number',       foreground: '67e8f9' },
        { token: 'comment',      foreground: '4b3f6b', fontStyle: 'italic' },
        { token: 'operator',     foreground: 'e879f9' },
        { token: 'identifier',   foreground: 'ede8f8' },
        { token: 'predefined',   foreground: 'a78bfa' },
      ],
      colors: {
        'editor.background':                   '#0d0f1a',
        'editor.foreground':                   '#ede8f8',
        'editor.lineHighlightBackground':      '#1c153528',
        'editor.selectionBackground':          '#b44fff33',
        'editor.inactiveSelectionBackground':  '#b44fff1a',
        'editorLineNumber.foreground':         '#3d3060',
        'editorLineNumber.activeForeground':   '#b44fff',
        'editorCursor.foreground':             '#b44fff',
        'editorIndentGuide.background1':       '#1c1535',
        'editorIndentGuide.activeBackground1': '#b44fff44',
        'editorWidget.background':             '#131629',
        'editorWidget.border':                 '#b44fff44',
        'editorSuggestWidget.background':      '#131629',
        'editorSuggestWidget.border':          '#b44fff44',
        'editorSuggestWidget.selectedBackground': '#1c1535',
        'editorSuggestWidget.foreground':      '#ede8f8',
        'scrollbarSlider.background':          '#b44fff22',
        'scrollbarSlider.hoverBackground':     '#b44fff44',
        'scrollbarSlider.activeBackground':    '#b44fff66',
        'editorGutter.background':             '#0d0f1a',
      }
    });
    editor = monaco.editor.create(document.getElementById('editor'), {
      value: '',
      language: 'sql',
      theme: 'openbase-dark',
      minimap: { enabled: false },
      fontSize: 13,
      lineNumbers: 'on',
      automaticLayout: true,
      wordWrap: 'off',
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      padding: { top: 10, bottom: 10 },
      quickSuggestions: true,
      suggestOnTriggerCharacters: true,
      folding: true,
      tabSize: 2,
      insertSpaces: true,
      overviewRulerLanes: 0,
      scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
      contextmenu: false,
    });
    editor.addCommand(monaco.KeyCode.F8, function() { run(); });
    editor.onDidChangeModelContent(function() {
      vscode.postMessage({ command: 'autoSave', sql: editor.getValue() });
    });
    document.getElementById('editor-loading').style.display = 'none';
    if (pendingLoad !== null) {
      editor.setValue(pendingLoad);
      editor.setPosition({ lineNumber: 1, column: 1 });
      pendingLoad = null;
    }
    vscode.postMessage({ command: 'ready' });
  });

  function clearRunTimeout() {
    if (runTimeoutId) { clearTimeout(runTimeoutId); runTimeoutId = null; }
  }

  function run() {
    if (running) return;
    var sql = editor ? editor.getValue().trim() : '';
    if (!sql) {
      document.getElementById('results').innerHTML = '<p class="placeholder">Enter a SQL query above before running.</p>';
      return;
    }
    lastRunSql = sql;
    running = true;
    t0 = Date.now();
    document.getElementById('run-btn').classList.add('hidden');
    document.getElementById('cancel-btn').classList.remove('hidden');
    document.getElementById('results').innerHTML = '';
    setStatus('<span class="spinner"></span> Sending…');
    runTimeoutId = setTimeout(function() {
      running = false;
      document.getElementById('run-btn').classList.remove('hidden');
      document.getElementById('cancel-btn').classList.add('hidden');
      setStatus('');
      document.getElementById('results').innerHTML =
        '<div class="err-box">Extension did not respond after 10s.\nMake sure an OpenBase project with appsettings.json is open in the workspace.</div>';
    }, 10000);
    vscode.postMessage({ command: 'run', sql: sql });
  }

  function exportCsv() {
    if (!lastColumns.length) return;
    var lines = [lastColumns.map(csvCell).join(',')];
    for (var r = 0; r < lastRows.length; r++) lines.push(lastRows[r].map(csvCell).join(','));
    var csv = lines.join('\r\n');
    var name = 'query_' + new Date().toISOString().slice(0,19).replace(/[T:]/g,'-') + '.csv';
    vscode.postMessage({ command: 'saveCsv', csvData: csv, csvName: name });
  }

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  window.addEventListener('message', function(e) {
    var m = e.data;
    if (m.command === 'triggerRun') { run(); return; }
    if (m.command === 'loadHistory') {
      historyEntries = m.entries || [];
      renderHistory();
      return;
    }
    if (m.command === 'loadScript') {
      if (editor) {
        editor.setValue(m.content || '');
        editor.setPosition({ lineNumber: 1, column: 1 });
      } else {
        pendingLoad = m.content || '';
      }
      document.getElementById('results').innerHTML = '<p class="placeholder">Write a query above and press Run or F8</p>';
      lastColumns = []; lastRows = [];
      return;
    }
    if (m.command === 'reset') {
      running = false; clearRunTimeout();
      document.getElementById('run-btn').classList.remove('hidden');
      document.getElementById('cancel-btn').classList.add('hidden');
      setStatus('');
      return;
    }
    clearRunTimeout();
    if (m.command === 'running') {
      running = true; t0 = Date.now();
      setStatus('<span class="spinner"></span> Running…');
    } else if (m.command === 'result') {
      running = false;
      document.getElementById('run-btn').classList.remove('hidden');
      document.getElementById('cancel-btn').classList.add('hidden');
      if (historyVisible) toggleHistory();
      var elapsed = ((Date.now() - t0) / 1000).toFixed(2) + 's';
      renderResult(m.columns, m.rows, m.message, elapsed);
    } else if (m.command === 'error') {
      running = false;
      document.getElementById('run-btn').classList.remove('hidden');
      document.getElementById('cancel-btn').classList.add('hidden');
      setStatus('');
      lastColumns = []; lastRows = [];
      document.getElementById('results').innerHTML = '<div class="err-box">' + esc(m.text) + '</div>';
    } else if (m.command === 'cancelled') {
      running = false;
      document.getElementById('run-btn').classList.remove('hidden');
      document.getElementById('cancel-btn').classList.add('hidden');
      setStatus('');
      lastColumns = []; lastRows = [];
      document.getElementById('results').innerHTML = '<div class="msg-box">Query cancelled.\x3c/div>';
    } else if (m.command === 'explainRunning') {
      showPanel('explain');
      document.getElementById('explain-tree').innerHTML = '\x3cdiv style="padding:20px;display:flex;align-items:center;gap:8px">\x3cspan class="spinner">\x3c/span>\x3cspan style="color:var(--ob-dim);font-size:12px">Generating execution plan…\x3c/span>\x3c/div>';
    } else if (m.command === 'explainResult') {
      showPanel('explain');
      var maxC = calcMaxCost(m.tree);
      document.getElementById('explain-tree').innerHTML = renderExplainNode(m.tree, maxC, true);
    } else if (m.command === 'explainError') {
      showPanel('explain');
      document.getElementById('explain-tree').innerHTML = '\x3cdiv class="err-box">' + esc(m.text) + '\x3c/div>';
    }
  });

  function renderResult(columns, rows, message, elapsed) {
    setStatus('');
    if (!columns || !columns.length) {
      document.getElementById('results').innerHTML =
        '<div class="msg-box">' + esc(message || 'Command completed.') + '</div>';
      return;
    }
    tabCounter++;
    var firstLine = lastRunSql.trim().split('\n')[0].trim();
    var label = '#' + tabCounter + ' ' + (firstLine.length > 24 ? firstLine.slice(0, 23) + '…' : firstLine);
    var tab = { id: tabCounter, label: label, columns: columns || [], rows: rows || [], message: message, elapsed: elapsed };
    resultTabs.push(tab);
    if (resultTabs.length > 10) resultTabs.shift();
    activateTab(tab.id);
    showPanel('results');
  }

  function activateTab(id) {
    var tab = null;
    for (var i = 0; i < resultTabs.length; i++) { if (resultTabs[i].id === id) { tab = resultTabs[i]; break; } }
    if (!tab) return;
    activeTabId = id;
    lastColumns = tab.columns;
    lastRows = tab.rows;
    renderTabBar();
    renderResultContent(tab.columns, tab.rows, tab.message, tab.elapsed);
  }

  function closeTab(id) {
    var idx = -1;
    for (var i = 0; i < resultTabs.length; i++) { if (resultTabs[i].id === id) { idx = i; break; } }
    if (idx === -1) return;
    resultTabs.splice(idx, 1);
    if (activeTabId === id) {
      if (resultTabs.length > 0) {
        activateTab(resultTabs[Math.min(idx, resultTabs.length - 1)].id);
      } else {
        activeTabId = null; lastColumns = []; lastRows = [];
        document.getElementById('results').innerHTML = '<p class="placeholder">Write a query above and press Run or F8</p>';
        renderTabBar();
      }
    } else {
      renderTabBar();
    }
  }

  function renderTabBar() {
    var bar = document.getElementById('result-tabs');
    if (!resultTabs.length) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
    bar.classList.remove('hidden');
    var html = '';
    for (var i = 0; i < resultTabs.length; i++) {
      var t = resultTabs[i];
      html += '<div class="result-tab' + (t.id === activeTabId ? ' active' : '') + '" data-tab-id="' + t.id + '">'
            + '<span class="result-tab-label" title="' + esc(t.label) + '">' + esc(t.label) + '</span>'
            + '<span class="result-tab-close" data-close-id="' + t.id + '">✕</span>'
            + '</div>';
    }
    bar.innerHTML = html;
  }

  function renderResultContent(columns, rows, message, elapsed) {
    if (!columns || !columns.length) {
      document.getElementById('results').innerHTML =
        '<div class="msg-box">' + esc(message || 'Command completed.') + '</div>';
      return;
    }
    var rowCount = rows ? rows.length : 0;
    var infoMsg = message ? ' \xB7 ' + esc(message) : '';
    var hdr = '<div class="result-header">'
            + '<span>' + rowCount + ' row' + (rowCount !== 1 ? 's' : '') + ' \xB7 ' + elapsed + infoMsg + '</span>'
            + '<button id="export-csv-btn" class="btn btn-secondary" style="font-size:11px;padding:2px 8px">Export CSV</button>'
            + '</div>';
    var tbl = '<table><thead><tr>';
    for (var i = 0; i < columns.length; i++) tbl += '<th>' + esc(columns[i]) + '</th>';
    tbl += '</tr></thead><tbody>';
    for (var r = 0; r < rowCount; r++) {
      tbl += '<tr>';
      for (var c = 0; c < columns.length; c++) {
        var val = (rows[r] && rows[r][c] != null) ? rows[r][c] : '';
        var isNull = val === 'NULL';
        tbl += '<td' + (isNull ? ' class="null"' : '') + ' title="' + esc(val) + '" data-r="' + r + '" data-c="' + c + '">'
             + (isNull ? 'NULL' : esc(val)) + '</td>';
      }
      tbl += '</tr>';
    }
    tbl += '</tbody></table>';
    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;height:100%';
    wrap.innerHTML = hdr + '<div style="flex:1;overflow:auto">' + tbl + '</div>';
    var res = document.getElementById('results');
    res.innerHTML = '';
    res.appendChild(wrap);
  }

  function showPanel(which) {
    activePanel = which;
    var showResults = which === 'results';
    document.getElementById('result-tabs').classList.toggle('hidden', !showResults || !resultTabs.length);
    document.getElementById('results').classList.toggle('hidden', !showResults);
    document.getElementById('history-panel').classList.toggle('hidden', which !== 'history');
    document.getElementById('explain-panel').classList.toggle('hidden', which !== 'explain');
    historyVisible = (which === 'history');
    document.getElementById('history-btn').textContent = historyVisible ? '\xAB Results' : 'History';
  }

  function toggleHistory() {
    showPanel(historyVisible ? 'results' : 'history');
  }

  function calcMaxCost(node) {
    if (!node) return 0;
    var max = node.cost || 0;
    for (var i = 0; i < (node.children || []).length; i++) {
      var c = calcMaxCost(node.children[i]);
      if (c > max) max = c;
    }
    return max;
  }

  function renderExplainNode(node, maxCost, isRoot) {
    if (!node) return '';
    var pct = (maxCost > 0 && node.cost > 0) ? (node.cost / maxCost * 100) : -1;
    var costHtml = node.cost > 0
      ? '\x3cspan class="cost-badge ' + (pct > 66 ? 'cost-high' : pct > 33 ? 'cost-med' : 'cost-low') + '">cost ' + node.cost.toFixed(2) + '\x3c/span>'
      : '';
    var rowsHtml = node.rows > 0 ? '\x3cspan class="rows-badge">' + node.rows + ' rows\x3c/span>' : '';
    var detailHtml = node.detail ? '\x3cspan class="node-detail">' + esc(node.detail) + '\x3c/span>' : '';
    var kids = '';
    for (var i = 0; i < (node.children || []).length; i++) kids += renderExplainNode(node.children[i], maxCost, false);
    return '\x3cdiv class="explain-node' + (isRoot ? ' explain-root' : '') + '">'
      + '\x3cdiv class="node-row">\x3cspan class="node-op">' + esc(node.op) + '\x3c/span>' + detailHtml + costHtml + rowsHtml + '\x3c/div>'
      + (kids ? '\x3cdiv class="node-children">' + kids + '\x3c/div>' : '')
      + '\x3c/div>';
  }

  function renderHistory() {
    var list = document.getElementById('history-list');
    if (!historyEntries.length) {
      list.innerHTML = '\x3cp class="history-empty">No history yet.\x3c/p>';
      return;
    }
    var html = '';
    for (var i = 0; i < historyEntries.length; i++) {
      var e = historyEntries[i];
      var preview = e.sql.replace(/\s+/g, ' ').slice(0, 80);
      var ts = new Date(e.timestamp).toLocaleString();
      var rows = e.rowCount + ' row' + (e.rowCount !== 1 ? 's' : '');
      html += '\x3cdiv class="history-item" data-idx="' + i + '">'
            + '\x3cdiv class="history-preview">' + esc(preview) + '\x3c/div>'
            + '\x3cdiv class="history-meta">'
            + '\x3cspan>' + esc(ts) + '\x3c/span>'
            + '\x3cspan>' + esc(e.connectionLabel) + '\x3c/span>'
            + '\x3cspan>' + rows + '\x3c/span>'
            + '\x3cbutton class="btn btn-secondary history-pin" data-idx="' + i + '" title="Save to script library">Pin\x3c/button>'
            + '\x3c/div>'
            + '\x3c/div>';
    }
    list.innerHTML = html;
  }

  function setStatus(html) { document.getElementById('status').innerHTML = html; }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/\x3c/g,'&lt;').replace(/\x3e/g,'&gt;').replace(/"/g,'&quot;');
  }
</script>
</body>
</html>`;
}
