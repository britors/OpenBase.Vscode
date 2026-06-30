// Extracted from extension.ts to keep activation wiring readable.

export function buildHttpRunnerHtml(baseUrl: string, nonce: string, cspSource: string): string {
    const safeBase = JSON.stringify(baseUrl);
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%;overflow:hidden}
  body{display:flex;flex-direction:column;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background)}
  input,select,textarea{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);font-family:inherit;font-size:inherit;outline:none;padding:4px 7px}
  input:focus,select:focus,textarea:focus{border-color:var(--vscode-focusBorder)}
  input::placeholder,textarea::placeholder{color:var(--vscode-input-placeholderForeground)}
  .btn{border:none;cursor:pointer;font-family:inherit;font-size:inherit;padding:4px 10px}
  .btn-primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
  .btn-primary:hover{background:var(--vscode-button-hoverBackground)}
  .btn-primary:disabled{opacity:.5;cursor:not-allowed}
  .btn-secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);font-size:11px}
  .btn-secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}
  .btn-ghost{background:transparent;color:var(--vscode-foreground);padding:1px 6px;opacity:.5;border:none;cursor:pointer;font-size:14px}
  .btn-ghost:hover{opacity:1;background:var(--vscode-list-hoverBackground)}

  /* URL bar */
  .url-bar{display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;background:var(--vscode-sideBar-background);align-items:center}
  #method{width:92px}
  #url-input{flex:1}

  /* method color hints */
  .m-GET{color:#6fbf6f} .m-POST{color:#bf9c6f} .m-PUT{color:#6f9cbf}
  .m-PATCH{color:#bf6fbf} .m-DELETE{color:#bf6f6f} .m-OPTIONS,.m-HEAD{color:#9c9c9c}

  /* tabs */
  .tab-strip{display:flex;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;background:var(--vscode-sideBar-background)}
  .tab{padding:5px 14px;cursor:pointer;font-size:12px;border-bottom:2px solid transparent;user-select:none}
  .tab:hover{background:var(--vscode-list-hoverBackground)}
  .tab.active{border-bottom-color:var(--vscode-focusBorder);color:var(--vscode-textLink-activeForeground)}

  /* request section */
  .req-section{flex:0 0 auto;border-bottom:2px solid var(--vscode-panel-border);display:flex;flex-direction:column}
  .tab-content{flex:1;overflow-y:auto;padding:8px 12px;max-height:190px;min-height:60px}
  .hidden{display:none!important}

  /* kv rows */
  .kv-row{display:flex;gap:4px;margin-bottom:4px;align-items:center}
  .kv-row .key{flex:0 0 38%}
  .kv-row .val{flex:1}

  /* body */
  .body-toolbar{display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:12px}
  #body-text{width:100%;min-height:110px;resize:none;font-family:var(--vscode-editor-font-family,monospace);font-size:var(--vscode-editor-font-size,12px);line-height:1.5}

  /* auth */
  .auth-label{font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:6px}

  /* response section */
  .res-section{flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0}
  .res-bar{display:flex;align-items:center;gap:8px;padding:5px 12px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;font-size:12px;background:var(--vscode-sideBar-background);min-height:32px}
  .status-badge{padding:2px 8px;border-radius:3px;font-weight:700;font-size:12px}
  .s2xx{background:rgba(80,180,80,.2);color:#6fca6f;border:1px solid rgba(80,180,80,.3)}
  .s3xx{background:rgba(200,160,60,.2);color:#cabd6f;border:1px solid rgba(200,160,60,.3)}
  .s4xx{background:rgba(200,80,60,.2);color:#ca7a6f;border:1px solid rgba(200,80,60,.3)}
  .s5xx{background:rgba(200,40,40,.2);color:#ca5a5a;border:1px solid rgba(200,40,40,.3)}
  .meta{font-size:11px;color:var(--vscode-descriptionForeground)}
  .res-body-wrap{flex:1;overflow:auto;padding:10px 12px}
  .placeholder-msg{color:var(--vscode-descriptionForeground);font-size:12px;font-style:italic}
  .err-box{padding:8px 10px;background:var(--vscode-inputValidation-errorBackground);border:1px solid var(--vscode-inputValidation-errorBorder);font-size:12px;white-space:pre-wrap;font-family:monospace}
  pre{font-family:var(--vscode-editor-font-family,monospace);font-size:var(--vscode-editor-font-size,12px);white-space:pre-wrap;word-break:break-all;line-height:1.6}

  /* json syntax */
  .jk{color:#9cdcfe} .js{color:#ce9178} .jn{color:#b5cea8} .jb{color:#569cd6}

  /* response headers table */
  .hdr-table{width:100%;border-collapse:collapse;font-size:12px}
  .hdr-table th{text-align:left;padding:4px 8px;border-bottom:1px solid var(--vscode-panel-border);font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--vscode-descriptionForeground);font-weight:600}
  .hdr-table td{padding:4px 8px;border-bottom:1px solid color-mix(in srgb,var(--vscode-panel-border) 30%,transparent);font-family:monospace;font-size:12px;word-break:break-all}
  .hdr-table tr:hover td{background:var(--vscode-list-hoverBackground)}
  .hdr-name{white-space:nowrap;width:34%;color:#9cdcfe}

  .spinner{display:inline-block;width:11px;height:11px;border:2px solid var(--vscode-foreground);border-top-color:transparent;border-radius:50%;animation:spin .6s linear infinite;flex-shrink:0}
  @keyframes spin{to{transform:rotate(360deg)}}

  /* ÔöÇÔöÇ OpenBase brand theme ÔöÇÔöÇ */
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
  input,select,textarea{background:var(--ob-bg2)!important;color:var(--ob-text)!important;border-color:var(--ob-border)!important}
  input:focus,select:focus,textarea:focus{border-color:var(--ob-purple)!important}
  input::placeholder,textarea::placeholder{color:var(--ob-dim)!important}
  .btn-primary{background:linear-gradient(135deg,var(--ob-purple),var(--ob-pink))!important;color:#fff!important;border-radius:4px}
  .btn-primary:hover:not(:disabled){filter:brightness(1.15)}
  .btn-primary:disabled{opacity:.35!important}
  .btn-secondary{background:rgba(180,79,255,.12)!important;color:var(--ob-purple)!important;border:1px solid var(--ob-border);border-radius:4px}
  .btn-secondary:hover{background:rgba(180,79,255,.24)!important}
  .btn-ghost{color:var(--ob-dim)!important}
  .btn-ghost:hover{background:rgba(180,79,255,.12)!important;color:var(--ob-text)!important;opacity:1!important}
  .url-bar{background:var(--ob-bg1)!important;border-bottom:1px solid var(--ob-border)!important}
  .tab-strip{background:var(--ob-bg1)!important;border-bottom:1px solid var(--ob-border)!important}
  .tab:hover{background:rgba(180,79,255,.08)!important}
  .tab.active{border-bottom-color:var(--ob-purple)!important;color:var(--ob-purple)!important}
  .req-section{border-bottom:2px solid var(--ob-border)!important}
  .tab-content{background:var(--ob-bg0)}
  .res-bar{background:var(--ob-bg1)!important;border-bottom:1px solid var(--ob-border)!important}
  .res-body-wrap,.res-headers-wrap{background:var(--ob-bg0)}
  .placeholder-msg{color:var(--ob-dim)!important}
  .spinner{border-color:var(--ob-purple)!important;border-top-color:transparent!important}
  .err-box{background:rgba(255,63,164,.10)!important;border-color:rgba(255,63,164,.35)!important;color:#ff90c0!important}
  .hdr-table th{border-bottom-color:var(--ob-border)!important;color:var(--ob-dim)!important}
  .hdr-table td{border-bottom-color:rgba(180,79,255,.08)!important}
  .hdr-table tr:hover td{background:rgba(180,79,255,.07)!important}
  .hdr-name{color:var(--ob-purple)!important}
  .meta{color:var(--ob-dim)!important}
  .jk{color:#d08fff}.js{color:#ff9fd8}.jn{color:#7dffb8}.jb{color:#8888ff}
  .status-badge.s2xx{background:rgba(80,220,120,.15)!important;color:#6fdc8f!important;border-color:rgba(80,220,120,.25)!important}
  .status-badge.s4xx{background:rgba(255,63,164,.15)!important;color:#ff80c0!important;border-color:rgba(255,63,164,.3)!important}
  .status-badge.s5xx{background:rgba(255,40,40,.15)!important;color:#ff7070!important;border-color:rgba(255,40,40,.3)!important}
  .status-badge.s3xx{background:rgba(255,200,60,.12)!important;color:#ffd060!important;border-color:rgba(255,200,60,.25)!important}
  #copy-btn{background:rgba(180,79,255,.12)!important;color:var(--ob-purple)!important;border:1px solid var(--ob-border)!important}
  #http-history-panel{flex:1;overflow:auto;display:flex;flex-direction:column;background:var(--ob-bg0)}
  .http-hist-toolbar{display:flex;align-items:center;justify-content:space-between;padding:4px 12px;font-size:11px;color:var(--ob-dim);border-bottom:1px solid var(--ob-border);background:var(--ob-bg1);flex-shrink:0}
  #http-history-list{flex:1;overflow:auto}
  .http-hist-item{border-bottom:1px solid rgba(180,79,255,.07)}
  .http-hist-row{display:flex;align-items:center;gap:8px;padding:7px 12px;cursor:pointer}
  .http-hist-row:hover{background:rgba(180,79,255,.07)}
  .http-method-badge{font-size:10px;font-weight:700;padding:1px 5px;border-radius:3px;flex-shrink:0;font-family:monospace}
  .mb-GET{background:rgba(80,220,80,.15);color:#6fdc8f;border:1px solid rgba(80,220,80,.2)}
  .mb-POST{background:rgba(180,140,60,.15);color:#ddb86f;border:1px solid rgba(180,140,60,.25)}
  .mb-PUT{background:rgba(80,150,200,.15);color:#6fbfdc;border:1px solid rgba(80,150,200,.25)}
  .mb-PATCH{background:rgba(160,80,200,.15);color:#c06fdc;border:1px solid rgba(160,80,200,.25)}
  .mb-DELETE{background:rgba(255,63,100,.15);color:#ff7090;border:1px solid rgba(255,63,100,.25)}
  .mb-OTHER{background:rgba(150,150,150,.12);color:#aaa;border:1px solid rgba(150,150,150,.2)}
  .http-hist-url{flex:1;font-size:11px;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ob-text)}
  .http-hist-meta{display:flex;align-items:center;gap:6px;flex-shrink:0}
  .http-hist-time{font-size:10px;color:var(--ob-dim)}
  .http-hist-ts{font-size:10px;color:var(--ob-dim)}
  .http-hist-actions{display:flex;gap:4px;margin-left:2px}
  .http-hist-actions .btn{font-size:10px!important;padding:1px 6px!important}
  .http-hist-expand{background:transparent;border:none;cursor:pointer;color:var(--ob-dim);font-size:11px;padding:0 3px}
  .http-hist-body{padding:8px 12px;border-top:1px solid rgba(180,79,255,.07);background:var(--ob-bg1)}
  .http-hist-body pre{font-size:11px;max-height:180px;overflow:auto;white-space:pre-wrap;word-break:break-all}
  .http-hist-empty{padding:20px;color:var(--ob-dim);font-size:12px;font-style:italic}
  .curl-modal{position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;z-index:1000}
  .curl-modal-inner{background:var(--ob-bg1);border:1px solid var(--ob-border);padding:16px;width:90%;max-width:520px;display:flex;flex-direction:column;gap:10px;border-radius:4px}
  .curl-modal-title{font-size:13px;font-weight:600;color:var(--ob-purple)}
  #curl-input{height:120px;resize:vertical;font-family:monospace;font-size:11px;width:100%}
  .curl-modal-actions{display:flex;gap:8px;justify-content:flex-end}
  .env-bar{display:flex;align-items:center;gap:8px;padding:3px 12px;border-bottom:1px solid var(--ob-border);flex-shrink:0;background:var(--ob-bg1);font-size:11px}
  .env-label{color:var(--ob-dim)}
  #env-select{background:var(--ob-bg2)!important;color:var(--ob-text)!important;border:1px solid var(--ob-border)!important;padding:2px 6px;font-size:11px;border-radius:3px;max-width:160px}
  .env-var-count{font-size:10px;color:var(--ob-dim)}
</style>
</head>
<body>

<!-- URL BAR -->
<div class="url-bar">
  <select id="method">
    <option>GET</option><option>POST</option><option>PUT</option>
    <option>PATCH</option><option>DELETE</option><option>OPTIONS</option><option>HEAD</option>
  </select>
  <input id="url-input" type="text" placeholder="https://localhost:7215/api/...">
  <button id="send-btn" class="btn btn-primary">ÔûÂ Send</button>
  <button id="save-req-btn" class="btn btn-secondary" title="Save request to library">SaveÔÇª</button>
  <button id="import-curl-btn" class="btn btn-secondary" style="font-size:10px;padding:2px 7px" title="Import from cURL command">Ôåô cURL</button>
  <button id="copy-curl-btn" class="btn btn-secondary" style="font-size:10px;padding:2px 7px" title="Copy as cURL">Ôåæ cURL</button>
  <button id="http-history-btn" class="btn btn-secondary" title="Show request history">History</button>
</div>

<!-- ENV BAR -->
<div class="env-bar">
  <span class="env-label">Env</span>
  <select id="env-select">
    <option value="">ÔÇö none ÔÇö</option>
  </select>
  <span id="env-var-count" class="env-var-count"></span>
  <button id="new-env-btn" class="btn btn-secondary" style="margin-left:auto;font-size:10px;padding:1px 8px" title="Create new environment file">+ New Env</button>
</div>

<!-- REQUEST TABS -->
<div class="req-section">
  <div class="tab-strip">
    <div class="tab active" data-tab="headers">Headers</div>
    <div class="tab" data-tab="body">Body</div>
    <div class="tab" data-tab="auth">Auth</div>
  </div>

  <div id="req-headers" class="tab-content">
    <div id="headers-list"></div>
    <button id="add-header-btn" class="btn btn-secondary" style="margin-top:4px">+ Add Header</button>
  </div>

  <div id="req-body" class="tab-content hidden">
    <div class="body-toolbar">
      <span>Body:</span>
      <select id="body-type">
        <option value="none">none</option>
        <option value="json">JSON</option>
        <option value="text">Text</option>
        <option value="form">Form URL-encoded</option>
      </select>
    </div>
    <textarea id="body-text" class="hidden" placeholder='{"key": "value"}'></textarea>
  </div>

  <div id="req-auth" class="tab-content hidden">
    <p class="auth-label">Bearer Token ÔÇö automatically added as Authorization header on send</p>
    <input id="auth-token" type="password" style="width:100%" placeholder="eyJhbGci...">
    <div style="margin-top:8px;display:flex;align-items:center;gap:6px">
      <input id="auth-show" type="checkbox" style="width:auto">
      <label for="auth-show" style="font-size:11px;cursor:pointer">Show token</label>
    </div>
  </div>
</div>

<!-- RESPONSE SECTION -->
<div class="res-section">
  <div class="res-bar" id="res-bar">
    <span class="placeholder-msg">Send a request to see the response</span>
  </div>
  <div class="tab-strip hidden" id="res-tab-strip">
    <div class="tab active" data-tab="body">Body</div>
    <div class="tab" data-tab="headers">Headers</div>
  </div>
  <div class="res-body-wrap" id="res-body-wrap"></div>
  <div class="res-body-wrap hidden" id="res-headers-wrap"></div>
</div>

<div id="curl-modal" class="curl-modal hidden">
  <div class="curl-modal-inner">
    <div class="curl-modal-title">Import cURL</div>
    <textarea id="curl-input" placeholder="curl -X POST https://api.example.com/users \&#10;  -H 'Authorization: Bearer ...' \&#10;  -d '{&quot;key&quot;: &quot;value&quot;}'"></textarea>
    <div class="curl-modal-actions">
      <button id="curl-import-cancel" class="btn btn-secondary">Cancel</button>
      <button id="curl-import-ok" class="btn btn-primary">Import</button>
    </div>
  </div>
</div>


<div id="http-history-panel" class="hidden">
  <div class="http-hist-toolbar">
    <span>Request history</span>
    <button id="http-clear-hist-btn" class="btn btn-secondary" style="font-size:11px;padding:2px 8px">Clear all</button>
  </div>
  <div id="http-history-list"><p class="http-hist-empty">No history yet.</p></div>
</div>

<script nonce="${nonce}">
  window.onerror = function(msg, src, line, col) {
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#c72e0f;color:#fff;padding:6px 10px;font-size:12px;font-family:monospace;z-index:9999;white-space:pre-wrap';
    box.textContent = 'JS ERROR: ' + msg + '\\n' + src + ':' + line + ':' + col;
    document.body.appendChild(box);
  };
  const vscode = acquireVsCodeApi();
  vscode.postMessage({ command: 'ready' });
  let sending = false;
  const BASE_URL = ${safeBase};
  var httpHistory = [];
  var httpHistoryVisible = false;
  var historyExpanded = {};

  // init
  if (BASE_URL) document.getElementById('url-input').value = BASE_URL + '/api/';
  addHeader('Content-Type', 'application/json');
  addHeader('Accept', 'application/json');

  document.getElementById('send-btn').addEventListener('click', sendRequest);
  document.getElementById('save-req-btn').addEventListener('click', function() {
    var headers = [];
    document.getElementById('headers-list').querySelectorAll('.kv-row').forEach(function(r) {
      var ins = r.querySelectorAll('input');
      var k = ins[0].value.trim(), v = ins[1].value.trim();
      if (k) headers.push({ name: k, value: v });
    });
    vscode.postMessage({
      command: 'saveRequest',
      method: document.getElementById('method').value,
      url: document.getElementById('url-input').value.trim(),
      headers: headers,
      bodyType: document.getElementById('body-type').value,
      body: document.getElementById('body-text').value,
      authToken: document.getElementById('auth-token').value.trim()
    });
  });
  document.getElementById('import-curl-btn').addEventListener('click', function() {
    document.getElementById('curl-modal').classList.remove('hidden');
    document.getElementById('curl-input').value = '';
    setTimeout(function() { document.getElementById('curl-input').focus(); }, 50);
  });
  document.getElementById('curl-import-cancel').addEventListener('click', function() {
    document.getElementById('curl-modal').classList.add('hidden');
  });
  document.getElementById('curl-import-ok').addEventListener('click', function() {
    var parsed = parseCurl(document.getElementById('curl-input').value);
    if (parsed && parsed.url) {
      loadHistoryEntry(parsed);
      document.getElementById('curl-modal').classList.add('hidden');
    }
  });
  document.getElementById('copy-curl-btn').addEventListener('click', function() {
    var curl = buildCurl();
    if (!curl) return;
    navigator.clipboard.writeText(curl).then(function() {
      var btn = document.getElementById('copy-curl-btn');
      btn.textContent = 'Ô£ô ok';
      setTimeout(function() { btn.textContent = 'Ôåæ cURL'; }, 1500);
    });
  });
  document.getElementById('env-select').addEventListener('change', function() {
    vscode.postMessage({ command: 'setEnv', filename: this.value });
  });
  document.getElementById('new-env-btn').addEventListener('click', function() {
    vscode.postMessage({ command: 'newEnv' });
  });
  document.getElementById('http-history-btn').addEventListener('click', function() {
    toggleHttpHistory();
  });
  document.getElementById('http-clear-hist-btn').addEventListener('click', function() {
    vscode.postMessage({ command: 'clearHttpHistory' });
  });
  document.getElementById('http-history-list').addEventListener('click', function(e) {
    var loadBtn = e.target.closest('.hist-load-btn');
    if (loadBtn) {
      var idx = parseInt(loadBtn.getAttribute('data-idx'), 10);
      loadHistoryEntry(httpHistory[idx]);
      if (httpHistoryVisible) toggleHttpHistory();
      return;
    }
    var resendBtn = e.target.closest('.hist-resend-btn');
    if (resendBtn) {
      var idx2 = parseInt(resendBtn.getAttribute('data-idx'), 10);
      loadHistoryEntry(httpHistory[idx2]);
      if (httpHistoryVisible) toggleHttpHistory();
      setTimeout(function() { sendRequest(); }, 50);
      return;
    }
    var saveBtn = e.target.closest('.hist-save-btn');
    if (saveBtn) {
      var idx3 = parseInt(saveBtn.getAttribute('data-idx'), 10);
      var entry = httpHistory[idx3];
      if (entry) vscode.postMessage({ command: 'saveRequest', method: entry.method, url: entry.url, headers: entry.headers, bodyType: entry.bodyType, body: entry.body, authToken: entry.authToken });
      return;
    }
    var row = e.target.closest('.http-hist-row');
    if (row) {
      var idx4 = parseInt(row.getAttribute('data-idx'), 10);
      historyExpanded[idx4] = !historyExpanded[idx4];
      renderHttpHistory();
    }
  });
  document.getElementById('url-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') sendRequest();
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'F8') { e.preventDefault(); sendRequest(); }
    if (e.key === 'Escape') document.getElementById('curl-modal').classList.add('hidden');
  });
  document.getElementById('method').addEventListener('change', function() { onMethodChange(this); });
  document.getElementById('body-type').addEventListener('change', function() { onBodyType(); });
  document.getElementById('add-header-btn').addEventListener('click', function() { addHeader('',''); });
  document.getElementById('auth-show').addEventListener('change', function() {
    document.getElementById('auth-token').type = this.checked ? 'text' : 'password';
  });
  document.querySelectorAll('.req-section .tab-strip .tab').forEach(function(tab) {
    tab.addEventListener('click', function() { reqTab(this, this.getAttribute('data-tab')); });
  });
  document.querySelectorAll('#res-tab-strip .tab').forEach(function(tab) {
    tab.addEventListener('click', function() { resTab(this, this.getAttribute('data-tab')); });
  });

  function triggerAutoSave() {
    vscode.postMessage({
      command: 'autoSaveHttp',
      data: {
        method: document.getElementById('method').value,
        url: document.getElementById('url-input').value,
        headers: collectHeadersArray(),
        bodyType: document.getElementById('body-type').value,
        body: document.getElementById('body-text').value,
        authToken: document.getElementById('auth-token').value
      }
    });
  }
  ['url-input', 'method', 'body-type', 'body-text', 'auth-token'].forEach(function(id) {
    document.getElementById(id).addEventListener('input', triggerAutoSave);
  });
  document.getElementById('headers-list').addEventListener('input', triggerAutoSave);
  document.getElementById('headers-list').addEventListener('click', function(e) {
    if (e.target.classList.contains('btn-ghost')) setTimeout(triggerAutoSave, 10);
  });

  var NO_BODY_METHODS = ['GET','HEAD','OPTIONS'];

  function onMethodChange(sel) {
    sel.className = 'm-' + sel.value;
    var noBody = NO_BODY_METHODS.indexOf(sel.value) !== -1;
    document.querySelectorAll('.req-section .tab').forEach(function(t) {
      if (t.textContent === 'Body') t.style.opacity = noBody ? '.35' : '';
    });
    if (noBody) {
      var bodyTab = document.querySelector('.req-section .tab.active');
      if (bodyTab && bodyTab.textContent === 'Body') {
        reqTab(document.querySelector('.req-section .tab'), 'headers');
      }
    }
  }
  onMethodChange(document.getElementById('method'));

  // \u2500\u2500 request tabs \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  function reqTab(el, id) {
    document.querySelectorAll('.req-section .tab').forEach(function(t) { t.classList.remove('active'); });
    ['req-headers','req-body','req-auth'].forEach(function(i) { document.getElementById(i).classList.add('hidden'); });
    el.classList.add('active');
    document.getElementById('req-' + id).classList.remove('hidden');
  }

  function resTab(el, id) {
    document.querySelectorAll('#res-tab-strip .tab').forEach(function(t) { t.classList.remove('active'); });
    document.getElementById('res-body-wrap').classList.add('hidden');
    document.getElementById('res-headers-wrap').classList.add('hidden');
    el.classList.add('active');
    document.getElementById('res-' + id + '-wrap').classList.remove('hidden');
  }

  // \u2500\u2500 headers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  function addHeader(k, v) {
    var row = document.createElement('div');
    row.className = 'kv-row';
    var ki = document.createElement('input'); ki.className = 'key'; ki.type = 'text'; ki.value = k || ''; ki.placeholder = 'Header name';
    var vi = document.createElement('input'); vi.className = 'val'; vi.type = 'text'; vi.value = v || ''; vi.placeholder = 'Value';
    var rm = document.createElement('button'); rm.className = 'btn-ghost'; rm.textContent = '\u00d7'; rm.onclick = function() { row.remove(); };
    row.appendChild(ki); row.appendChild(vi); row.appendChild(rm);
    document.getElementById('headers-list').appendChild(row);
    if (!k) ki.focus();
    return row;
  }

  function collectHeaders() {
    var h = {};
    document.getElementById('headers-list').querySelectorAll('.kv-row').forEach(function(r) {
      var ins = r.querySelectorAll('input');
      var k = ins[0].value.trim(), v = ins[1].value.trim();
      if (k) h[k] = v;
    });
    return h;
  }

  function collectHeadersArray() {
    var h = [];
    document.getElementById('headers-list').querySelectorAll('.kv-row').forEach(function(r) {
      var ins = r.querySelectorAll('input');
      var k = ins[0].value.trim(), v = ins[1].value.trim();
      if (k) h.push({ name: k, value: v });
    });
    return h;
  }

  // \u2500\u2500 body type \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  function onBodyType() {
    var t = document.getElementById('body-type').value;
    var txt = document.getElementById('body-text');
    txt.classList.toggle('hidden', t === 'none');
    if (t === 'json')      txt.placeholder = '{\\n  "key": "value"\\n}';
    else if (t === 'form') txt.placeholder = 'key1=value1&key2=value2';
    else                   txt.placeholder = 'Request body...';
  }

  var sendTimeoutId = null;
  function clearSendTimeout() {
    if (sendTimeoutId) { clearTimeout(sendTimeoutId); sendTimeoutId = null; }
  }

  // \u2500\u2500 send \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  function sendRequest() {
    if (sending) return;
    var url = document.getElementById('url-input').value.trim();
    if (!url) {
      showError('Enter a URL before sending.');
      return;
    }

    var method = document.getElementById('method').value;
    var rawHdrsArr = collectHeadersArray();
    var hdrs = {};
    rawHdrsArr.forEach(function(h) { hdrs[h.name] = h.value; });

    var token = document.getElementById('auth-token').value.trim();
    if (token) hdrs['Authorization'] = 'Bearer ' + token;

    var bodyType = document.getElementById('body-type').value;
    var body = undefined;
    if (bodyType !== 'none' && NO_BODY_METHODS.indexOf(method) === -1) {
      body = document.getElementById('body-text').value;
      if (bodyType === 'json') {
        if (!hdrs['Content-Type']) hdrs['Content-Type'] = 'application/json';
        if (body) {
          try { JSON.parse(body); } catch {
            showError('Invalid JSON body \u2014 fix the syntax before sending.');
            return;
          }
        }
      }
      if (bodyType === 'form') hdrs['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    sending = true;
    document.getElementById('send-btn').disabled = true;
    document.getElementById('res-bar').innerHTML = '<span class="spinner"></span><span class="meta">Sending\u2026</span>';
    document.getElementById('res-tab-strip').classList.add('hidden');
    document.getElementById('res-body-wrap').innerHTML = '';
    document.getElementById('res-headers-wrap').innerHTML = '';
    document.getElementById('res-body-wrap').classList.remove('hidden');
    document.getElementById('res-headers-wrap').classList.add('hidden');

    vscode.postMessage({ command: 'send', method: method, url: url, headers: hdrs, headersArray: rawHdrsArr, bodyType: bodyType, body: body || '', authToken: token });

    sendTimeoutId = setTimeout(function() {
      sending = false;
      document.getElementById('send-btn').disabled = false;
      showError('Extension did not respond after 30s. Check the URL and try again.');
    }, 30000);
  }

  // \u2500\u2500 messages \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  window.addEventListener('message', function(e) {
    var m = e.data;
    if (m.command === 'triggerSend') { sendRequest(); return; }
    if (m.command === 'loadRequest') { loadHistoryEntry(m); return; }
    if (m.command === 'loadEnvs') {
      var sel = document.getElementById('env-select');
      sel.innerHTML = '\x3coption value="">ÔÇö none ÔÇö\x3c/option>';
      (m.envs || []).forEach(function(env) {
        var opt = document.createElement('option');
        opt.value = env.filename;
        opt.textContent = env.name;
        if (env.filename === m.activeFilename) opt.selected = true;
        sel.appendChild(opt);
      });
      var active = (m.envs || []).find(function(e) { return e.filename === m.activeFilename; });
      document.getElementById('env-var-count').textContent = active ? active.varCount + ' var' + (active.varCount !== 1 ? 's' : '') : '';
      return;
    }
    if (m.command === 'loadHttpHistory') {
      httpHistory = m.entries || [];
      historyExpanded = {};
      renderHttpHistory();
      return;
    }
    clearSendTimeout();
    sending = false;
    document.getElementById('send-btn').disabled = false;
    if (m.command === 'response') {
      if (httpHistoryVisible) toggleHttpHistory();
      showResponse(m);
    } else if (m.command === 'error') showError(m.text);
  });

  var lastRawBody = '';

  function copyBody() {
    if (!lastRawBody) return;
    navigator.clipboard.writeText(lastRawBody).then(function() {
      var btn = document.getElementById('copy-btn');
      if (btn) { btn.textContent = 'Copied!'; setTimeout(function() { btn.textContent = 'Copy'; }, 1500); }
    });
  }

  function showResponse(m) {
    lastRawBody = m.body || '';
    var cls = m.status >= 500 ? 's5xx' : m.status >= 400 ? 's4xx' : m.status >= 300 ? 's3xx' : 's2xx';
    var size = m.size >= 1024 ? (m.size / 1024).toFixed(1) + ' KB' : m.size + ' B';
    document.getElementById('res-bar').innerHTML =
      '<span class="status-badge ' + cls + '">' + m.status + ' ' + esc(m.statusText) + '</span>' +
      '<span class="meta">' + m.time + ' ms</span>' +
      '<span class="meta">\u00b7</span>' +
      '<span class="meta">' + size + '</span>' +
      '<button id="copy-btn" class="btn btn-secondary" style="margin-left:auto;font-size:11px;padding:2px 8px">Copy</button>';
    var cpBtn = document.getElementById('copy-btn');
    if (cpBtn) cpBtn.addEventListener('click', copyBody);
    document.getElementById('res-tab-strip').classList.remove('hidden');

    // body
    var ct = flatHeader(m.headers, 'content-type') || '';
    var bodyHtml;
    if (/application\\/json/i.test(ct) || looksLikeJson(m.body)) {
      try { bodyHtml = syntaxHighlight(JSON.stringify(JSON.parse(m.body), null, 2)); }
      catch { bodyHtml = esc(m.body); }
    } else {
      bodyHtml = esc(m.body);
    }
    document.getElementById('res-body-wrap').innerHTML = m.body
      ? '<pre>' + bodyHtml + '</pre>'
      : '<p class="placeholder-msg">Empty response body</p>';

    // headers
    var hdrHtml = '<table class="hdr-table"><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody>';
    var hdrs = m.headers || {};
    Object.keys(hdrs).sort().forEach(function(k) {
      var v = Array.isArray(hdrs[k]) ? hdrs[k].join(', ') : String(hdrs[k] || '');
      hdrHtml += '<tr><td class="hdr-name">' + esc(k) + '</td><td>' + esc(v) + '</td></tr>';
    });
    document.getElementById('res-headers-wrap').innerHTML = hdrHtml + '</tbody></table>';
  }

  function showError(text) {
    document.getElementById('res-bar').innerHTML =
      '<span class="status-badge s5xx">Error</span>';
    document.getElementById('res-tab-strip').classList.add('hidden');
    document.getElementById('res-body-wrap').innerHTML = '<div class="err-box">' + esc(text) + '</div>';
    document.getElementById('res-body-wrap').classList.remove('hidden');
  }

  // \u2500\u2500 helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  function uq(s) {
    if (!s) return '';
    if ((s[0] === "'" && s[s.length-1] === "'") || (s[0] === '"' && s[s.length-1] === '"')) return s.slice(1, -1);
    return s;
  }

  function parseCurl(raw) {
    if (!raw) return null;
    var text = raw.replace(/\\\\\\r?\\n/g, ' ').replace(/\\s+/g, ' ').trim();
    if (!/^curl\\b/i.test(text)) return null;
    var method = 'GET', url = '', headers = [], body = '', bodyType = 'none', authToken = '';
    var tokens = [], re = /(?:'[^']*'|"(?:\\\\.|[^"\\\\])*"|[^\\s]+)/g, m;
    while ((m = re.exec(text)) !== null) tokens.push(m[0]);
    var i = 0;
    while (i < tokens.length) {
      var t = tokens[i];
      if (i === 0 && /^curl$/i.test(t)) { i++; continue; }
      if (t === '-X' || t === '--request') {
        method = uq(tokens[++i] || 'GET').toUpperCase();
      } else if (t === '-H' || t === '--header') {
        var hdr = uq(tokens[++i] || '');
        var col = hdr.indexOf(':');
        if (col > 0) {
          var hn = hdr.slice(0, col).trim(), hv = hdr.slice(col + 1).trim();
          if (hn.toLowerCase() === 'authorization' && hv.toLowerCase().startsWith('bearer ')) {
            authToken = hv.slice(7).trim();
          } else { headers.push({ name: hn, value: hv }); }
        }
      } else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary' || t === '--data-urlencode') {
        body = uq(tokens[++i] || '');
        var tb = body.trim();
        bodyType = (tb[0] === '{' || tb[0] === '[') ? 'json' : (body.indexOf('=') !== -1 ? 'form' : 'text');
        if (method === 'GET') method = 'POST';
      } else if (!t.startsWith('-') && !url) {
        url = uq(t);
      }
      i++;
    }
    return { method: method, url: url, headers: headers, body: body, bodyType: bodyType, authToken: authToken };
  }

  function buildCurl() {
    var url = document.getElementById('url-input').value.trim();
    if (!url) return null;
    var method = document.getElementById('method').value;
    var sq = function(s) { return "'" + s.replace(/'/g, "'\\''") + "'"; };
    var parts = ['curl'];
    if (method !== 'GET') parts.push('-X ' + method);
    parts.push(sq(url));
    collectHeadersArray().forEach(function(h) { parts.push('-H ' + sq(h.name + ': ' + h.value)); });
    var token = document.getElementById('auth-token').value.trim();
    if (token) parts.push('-H ' + sq('Authorization: Bearer ' + token));
    var bodyType = document.getElementById('body-type').value;
    var body = document.getElementById('body-text').value;
    if (bodyType !== 'none' && body) parts.push('-d ' + sq(body));
    return parts.join(' \\\n  ');
  }


  function toggleHttpHistory() {
    httpHistoryVisible = !httpHistoryVisible;
    document.getElementById('http-history-panel').classList.toggle('hidden', !httpHistoryVisible);
    document.querySelector('.req-section').classList.toggle('hidden', httpHistoryVisible);
    document.querySelector('.res-section').classList.toggle('hidden', httpHistoryVisible);
    document.getElementById('http-history-btn').textContent = httpHistoryVisible ? '┬½ Back' : 'History';
  }

  function loadHistoryEntry(entry) {
    if (!entry) return;
    var sel = document.getElementById('method');
    sel.value = entry.method || 'GET';
    onMethodChange(sel);
    document.getElementById('url-input').value = entry.url || '';
    document.getElementById('headers-list').innerHTML = '';
    (entry.headers || []).forEach(function(h) { addHeader(h.name, h.value); });
    var bt = document.getElementById('body-type');
    bt.value = entry.bodyType || 'none';
    onBodyType();
    document.getElementById('body-text').value = entry.body || '';
    document.getElementById('auth-token').value = entry.authToken || '';
  }

  function renderHttpHistory() {
    var list = document.getElementById('http-history-list');
    if (!httpHistory.length) {
      list.innerHTML = '\x3cp class="http-hist-empty">No history yet.\x3c/p>';
      return;
    }
    var html = '';
    for (var i = 0; i < httpHistory.length; i++) {
      var e = httpHistory[i];
      var m = (e.method || 'GET').toUpperCase();
      var mCls = ['GET','POST','PUT','PATCH','DELETE'].indexOf(m) !== -1 ? 'mb-' + m : 'mb-OTHER';
      var sc = e.statusCode || 0;
      var scCls = sc >= 500 ? 's5xx' : sc >= 400 ? 's4xx' : sc >= 300 ? 's3xx' : 's2xx';
      var ts = new Date(e.timestamp).toLocaleTimeString();
      var expanded = !!historyExpanded[i];
      html += '\x3cdiv class="http-hist-item">'
            + '\x3cdiv class="http-hist-row" data-idx="' + i + '">'
            + '\x3cspan class="http-method-badge ' + mCls + '">' + esc(m) + '\x3c/span>'
            + '\x3cspan class="http-hist-url" title="' + esc(e.url || '') + '">' + esc(e.url || '') + '\x3c/span>'
            + '\x3cdiv class="http-hist-meta">'
            + '\x3cspan class="status-badge ' + scCls + '" style="font-size:10px;padding:1px 6px">' + sc + '\x3c/span>'
            + '\x3cspan class="http-hist-time">' + e.responseTimeMs + ' ms\x3c/span>'
            + '\x3cspan class="http-hist-ts">' + esc(ts) + '\x3c/span>'
            + '\x3c/div>'
            + '\x3cdiv class="http-hist-actions">'
            + '\x3cbutton class="btn btn-secondary hist-load-btn" data-idx="' + i + '">Load\x3c/button>'
            + '\x3cbutton class="btn btn-secondary hist-resend-btn" data-idx="' + i + '">Resend\x3c/button>'
            + '\x3cbutton class="btn btn-secondary hist-save-btn" data-idx="' + i + '">Save\x3c/button>'
            + '\x3cbutton class="http-hist-expand">' + (expanded ? 'Ôû╝' : 'ÔûÂ') + '\x3c/button>'
            + '\x3c/div>'
            + '\x3c/div>';
      if (expanded && e.responseBody) {
        html += '\x3cdiv class="http-hist-body">\x3cpre>' + esc(e.responseBody.slice(0, 3000)) + '\x3c/pre>\x3c/div>';
      }
      html += '\x3c/div>';
    }
    list.innerHTML = html;
  }

  function flatHeader(hdrs, name) {
    var v = hdrs[name] || hdrs[name.split('-').map(function(p,i){return i===0?p:p[0].toUpperCase()+p.slice(1);}).join('-')];
    return Array.isArray(v) ? v[0] : (v || '');
  }

  function looksLikeJson(s) {
    if (!s) return false; var t = s.trim(); return t[0] === '{' || t[0] === '[';
  }

  function syntaxHighlight(json) {
    return json.replace(
      /("(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*"(?:\\s*:)?|\\b(?:true|false|null)\\b|-?\\d+(?:\\.\\d*)?(?:[eE][+\\-]?\\d+)?)/g,
      function(m) {
        var c = 'jn';
        if (/^"/.test(m)) c = /:$/.test(m) ? 'jk' : 'js';
        else if (/true|false/.test(m)) c = 'jb';
        else if (/null/.test(m)) c = 'jb';
        return '<span class="' + c + '">' + esc(m) + '</span>';
      }
    );
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/\x3c/g,'&lt;').replace(/\x3e/g,'&gt;').replace(/"/g,'&quot;');
  }
</script>
</body>
</html>`;
}

