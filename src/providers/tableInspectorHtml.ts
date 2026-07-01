import { DbTemplate } from '../models/dbTemplate';

export interface TableColumn {
    name: string;
    type: string;
    size: string;
    nullable: string;
    defaultVal: string;
}

export interface TableConstraint {
    type: string;
    name: string;
    column: string;
    refSchema: string;
    refTable: string;
    refColumn: string;
}

export interface ErTableData {
    schema: string;
    name: string;
    columns: { name: string; type: string; pk: boolean; fk: boolean }[];
    fks: { toSchema: string; toTable: string }[];
}

export function buildTableInspectorHtml(
    nonce: string,
    cspSource: string,
    schema: string,
    table: string,
    dbType: DbTemplate,
    columns: TableColumn[],
    constraints: TableConstraint[],
    entityName: string,
    hasScaffold: boolean,
): string {
    const esc = (s: string) => String(s)
        .replace(/&/g, '&amp;')
        .replace(/\x3c/g, '&lt;')
        .replace(/\x3e/g, '&gt;');

    const pkCols = new Set(constraints.filter(c => c.type === 'PRIMARY KEY').map(c => c.column));
    const fkCols = new Set(constraints.filter(c => c.type === 'FOREIGN KEY').map(c => c.column));

    const badge = (text: string, cls: string) => `<span class="badge ${cls}">${text}</span>`;

    const dbLabel: Record<DbTemplate, string> = {
        sqlserver: 'SQL Server', pgsql: 'PostgreSQL', oracle: 'Oracle',
    };

    const colRows = columns.map(c => {
        const sz = c.size && c.size !== '0' ? `(${esc(c.size)})` : '';
        const badges = (pkCols.has(c.name) ? badge('PK', 'pk') : '')
                     + (fkCols.has(c.name) ? badge('FK', 'fk') : '');
        const nullCell = (c.nullable === 'NO' || c.nullable === 'N')
            ? '<span class="not-null">NOT NULL</span>'
            : '<span class="null">NULL</span>';
        const defCell = c.defaultVal?.trim()
            ? `<code class="def">${esc(c.defaultVal)}</code>`
            : '';
        return `<tr><td><div class="col-name">${badges}<span>${esc(c.name)}</span></div></td><td class="mono">${esc(c.type)}${sz}</td><td>${nullCell}</td><td>${defCell}</td></tr>`;
    }).join('');

    const conRows = constraints.map(c => {
        const typeCell = c.type === 'PRIMARY KEY' ? badge('PK', 'pk') + '&nbsp;Primary Key'
            : c.type === 'FOREIGN KEY' ? badge('FK', 'fk') + '&nbsp;Foreign Key'
            : c.type === 'UNIQUE' ? badge('UQ', 'uq') + '&nbsp;Unique'
            : c.type === 'CHECK' ? badge('CK', 'ck') + '&nbsp;Check'
            : esc(c.type);
        const refsCell = c.refTable?.trim()
            ? `<span class="ref">${esc(c.refSchema)}.${esc(c.refTable)}</span><span class="ref-col">.${esc(c.refColumn)}</span>`
            : '';
        return `<tr><td class="con-type">${typeCell}</td><td class="mono small">${esc(c.name)}</td><td class="mono">${esc(c.column)}</td><td>${refsCell}</td></tr>`;
    }).join('');

    const stats = `${columns.length} column${columns.length !== 1 ? 's' : ''}${
        constraints.length
            ? ' &middot; ' + constraints.length + ' constraint' + (constraints.length !== 1 ? 's' : '')
            : ''}`;

    const conSection = constraints.length > 0 ? `<div class="section">
  <div class="section-title">Constraints</div>
  <table>
    <thead><tr><th>Type</th><th>Name</th><th>Column</th><th>References</th></tr></thead>
    <tbody>${conRows}</tbody>
  </table>
</div>` : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(schema)}.${esc(table)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d0f1a;color:#e8e8f0;font-family:'Segoe UI',-apple-system,sans-serif;font-size:13px}
.header{background:linear-gradient(135deg,#1a0830 0%,#0d0f1a 100%);border-bottom:1px solid rgba(180,79,255,0.25);padding:16px 20px;position:sticky;top:0;z-index:10}
.header-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.tbl-icon{width:34px;height:34px;background:linear-gradient(135deg,#b44fff,#ff3fa4);border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px;line-height:1}
.tbl-meta{flex:1;min-width:0}
.tbl-name{font-size:18px;font-weight:700;background:linear-gradient(90deg,#b44fff,#ff3fa4);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;line-height:1.2}
.tbl-schema{font-size:11px;color:#555;font-family:monospace;margin-top:3px}
.db-badge{background:#1a1040;border:1px solid rgba(180,79,255,0.35);color:#b44fff;font-size:10px;padding:2px 9px;border-radius:10px;white-space:nowrap;flex-shrink:0}
.btn-sel{background:linear-gradient(135deg,#b44fff,#ff3fa4);color:#fff;border:none;padding:6px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;transition:opacity .15s;white-space:nowrap;flex-shrink:0}
.btn-sel:hover{opacity:.82}
.btn-scaffold{background:rgba(180,79,255,.12);color:#b44fff;border:1px solid rgba(180,79,255,.4);padding:6px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s;white-space:nowrap;flex-shrink:0}
.btn-scaffold:hover{background:rgba(180,79,255,.22);border-color:#b44fff}
.stats{font-size:11px;color:#444;margin-top:8px}
.section{padding:0 20px 28px}
.section-title{font-size:10px;font-weight:700;letter-spacing:1.2px;color:#b44fff;text-transform:uppercase;padding:18px 0 10px;border-bottom:1px solid rgba(180,79,255,0.15)}
table{width:100%;border-collapse:collapse}
th{background:#120d2e;color:#555;font-size:11px;font-weight:600;letter-spacing:.5px;text-align:left;padding:8px 10px;border-bottom:1px solid rgba(180,79,255,0.15)}
td{padding:7px 10px;border-bottom:1px solid rgba(255,255,255,0.04);vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(180,79,255,0.05)}
.col-name{display:flex;align-items:center;gap:5px;font-weight:500}
.badge{font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;letter-spacing:.4px;flex-shrink:0}
.badge.pk{background:rgba(255,215,0,.12);color:#ffd700;border:1px solid rgba(255,215,0,.3)}
.badge.fk{background:rgba(79,195,247,.12);color:#4fc3f7;border:1px solid rgba(79,195,247,.3)}
.badge.uq{background:rgba(129,199,132,.12);color:#81c784;border:1px solid rgba(129,199,132,.3)}
.badge.ck{background:rgba(255,183,77,.12);color:#ffb74d;border:1px solid rgba(255,183,77,.3)}
.not-null{color:#ff6b6b;font-size:11px}
.null{color:#333;font-size:11px}
.mono{font-family:'Cascadia Code','Fira Code',Consolas,monospace;font-size:12px}
.small{font-size:11px}
.def{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);padding:1px 5px;border-radius:3px;font-size:11px;font-family:monospace;color:#666;max-width:180px;display:inline-block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}
.con-type{white-space:nowrap}
.ref{color:#b44fff;font-family:monospace;font-size:12px}
.ref-col{color:#ff3fa4;font-family:monospace;font-size:12px}
.empty{color:#444;text-align:center;padding:24px;font-style:italic}
</style>
</head>
<body>
<div class="header">
  <div class="header-top">
    <div class="tbl-icon">&#x1F5C4;</div>
    <div class="tbl-meta">
      <div class="tbl-name">${esc(table)}</div>
      <div class="tbl-schema">${esc(schema)}</div>
    </div>
    <span class="db-badge">${esc(dbLabel[dbType])}</span>
    <button class="btn-scaffold" id="btn-scaffold" data-cmd="${hasScaffold ? 'scaffoldUpdate' : 'scaffold'}" data-entity="${esc(entityName)}">${hasScaffold ? '&#x21BB;&nbsp;Update Scaffold' : '+&nbsp;Scaffold'}</button>
    <button class="btn-sel" id="btn-sel">&#x25B6;&nbsp;SELECT</button>
  </div>
  <div class="stats">${stats}</div>
</div>
<div class="section">
  <div class="section-title">Columns</div>
  <table>
    <thead><tr><th>Name</th><th>Type</th><th>Nullable</th><th>Default</th></tr></thead>
    <tbody>${colRows || '<tr><td colspan="4" class="empty">No columns found</td></tr>'}</tbody>
  </table>
</div>
${conSection}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.getElementById('btn-sel').addEventListener('click', function() {
    vscode.postMessage({ command: 'runSelect' });
});
var scaffoldBtn = document.getElementById('btn-scaffold');
scaffoldBtn.addEventListener('click', function() {
    vscode.postMessage({ command: scaffoldBtn.dataset.cmd, entity: scaffoldBtn.dataset.entity });
});
</script>
</body>
</html>`;
}

export function buildTableInspectorLoadingHtml(nonce: string, cspSource: string, schema: string, table: string): string {
    const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/\x3c/g, '&lt;').replace(/\x3e/g, '&gt;');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline';">
<style>
  :root {
    --ob-bg0: var(--vscode-editor-background);
    --ob-purple: #b44fff;
  }
  body.vscode-dark { --ob-bg0: #0d0f1a; }
  body.vscode-light { --ob-bg0: #fdfdff; --ob-purple: #7b2cbf; }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--ob-bg0);color:var(--vscode-foreground);font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:14px}
  .spinner{width:30px;height:30px;border:3px solid rgba(180,79,255,.2);border-top-color:var(--ob-purple);border-radius:50%;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .name{background:linear-gradient(90deg,var(--ob-purple),#ff3fa4);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;font-weight:700;font-size:14px}
  .lbl{color:var(--vscode-descriptionForeground);font-size:11px}
</style>
</head>
<body>
<div class="spinner"></div>
<div class="name">${esc(schema)}.${esc(table)}</div>
<div class="lbl">Loading table details&hellip;</div>
</body>
</html>`;
}

export function buildTableInspectorErrorHtml(nonce: string, cspSource: string, schema: string, table: string, error: string): string {
    const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/\x3c/g, '&lt;').replace(/\x3e/g, '&gt;');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline';">
<style>
  :root{
    --ob-bg0: var(--vscode-editor-background);
    --ob-text: var(--vscode-foreground);
    --ob-purple: #b44fff;
    --ob-pink: #ff3fa4;
  }
  body.vscode-dark {
    --ob-bg0: #0d0f1a;
    --ob-text: #e8e8f0;
  }
  body.vscode-light {
    --ob-bg0: #fdfdff;
    --ob-text: #24292e;
    --ob-purple: #7b2cbf;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--ob-bg0);color:var(--ob-text);font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:12px;padding:24px;text-align:center}
  .icon{font-size:30px}
  .name{background:linear-gradient(90deg,var(--ob-purple),var(--ob-pink));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;font-weight:700;font-size:14px}
  .err{background:rgba(255,107,107,0.05);border:1px solid rgba(255,107,107,.3);color:#ff6b6b;padding:12px 16px;border-radius:8px;font-family:monospace;font-size:12px;max-width:480px;word-break:break-word}
</style>
</head>
<body>
<div class="icon">&#x26A0;&#xFE0F;</div>
<div class="name">${esc(schema)}.${esc(table)}</div>
<div class="err">${esc(error)}</div>
</body>
</html>`;
}

// ÔöÇÔöÇÔöÇ ER Diagram ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

export function buildErDiagramLoadingHtml(nonce: string, cspSource: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline';">
<style>
  :root {
    --ob-bg0: var(--vscode-editor-background);
    --ob-purple: #b44fff;
  }
  body.vscode-dark { --ob-bg0: #0d0f1a; }
  body.vscode-light { --ob-bg0: #fdfdff; --ob-purple: #7b2cbf; }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--ob-bg0);color:var(--vscode-foreground);font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:14px}
  .spinner{width:32px;height:32px;border:3px solid rgba(180,79,255,.2);border-top-color:var(--ob-purple);border-radius:50%;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .lbl{color:var(--vscode-descriptionForeground);font-size:12px}
</style>
</head>
<body>
<div class="spinner"></div>
<div class="lbl">Loading ER Diagram&hellip;</div>
</body>
</html>`;
}

export function buildErDiagramHtml(nonce: string, cspSource: string, tables: ErTableData[]): string {
    const schemas = [...new Set(tables.map(t => t.schema))].sort();
    const schemaOpts = schemas.map(s => `<option value="${s.replace(/"/g, '&quot;')}">${s.replace(/&/g, '&amp;').replace(/\x3c/g, '&lt;')}</option>`).join('');
    const dataJson = JSON.stringify(tables).replace(/\x3c/g, '\\u003c');

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline' https://cdn.jsdelivr.net; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; img-src data: blob:;">
<style>
  :root {
    --ob-bg0: var(--vscode-editor-background);
    --ob-bg1: var(--vscode-sideBar-background);
    --ob-bg2: var(--vscode-input-background);
    --ob-purple: #b44fff;
    --ob-border: var(--vscode-panel-border);
    --ob-text: var(--vscode-foreground);
    --ob-dim: var(--vscode-descriptionForeground);
  }
  body.vscode-dark {
    --ob-bg0: #0d0f1a;
    --ob-bg1: #111328;
    --ob-bg2: #1a1c2e;
    --ob-border: #1e2035;
    --ob-text: #e8e8f0;
    --ob-dim: #888;
  }
  body.vscode-light {
    --ob-bg0: #fdfdff;
    --ob-bg1: #f1f3f9;
    --ob-bg2: #ffffff;
    --ob-purple: #7b2cbf;
    --ob-border: #e0e4ef;
    --ob-text: #24292e;
    --ob-dim: #6a737d;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%;overflow:hidden;background:var(--ob-bg0);color:var(--ob-text);font-family:'Segoe UI',sans-serif;font-size:13px}
  .toolbar{display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--ob-border);flex-shrink:0;background:var(--ob-bg1)}
  .toolbar label{color:var(--ob-dim);font-size:11px}
  select{background:var(--ob-bg2);color:var(--ob-text);border:1px solid var(--ob-border);border-radius:4px;padding:3px 6px;font-size:12px;font-family:inherit;cursor:pointer}
  .btn{padding:3px 10px;border:1px solid var(--ob-border);border-radius:4px;cursor:pointer;font-family:inherit;font-size:12px;background:var(--ob-bg2);color:var(--ob-text)}
  .btn:hover{background:var(--ob-bg1);border-color:var(--ob-purple)}
  .sep{width:1px;height:18px;background:var(--ob-border);margin:0 2px}
  .wrap{flex:1;overflow:hidden;position:relative;cursor:grab}
  .wrap.dragging{cursor:grabbing}
  #diagram{position:absolute;top:0;left:0;transform-origin:0 0;padding:20px}
  #diagram svg{display:block}
  .hint{color:var(--ob-dim);font-size:11px;margin-left:auto}
  .count{color:var(--ob-dim);font-size:11px}
</style>
</head>
<body style="display:flex;flex-direction:column">
<div class="toolbar">
  <label>Schema</label>
  <select id="schema-sel">
    ${schemas.length > 1 ? '<option value="__all__">All schemas</option>' : ''}
    ${schemaOpts}
  </select>
  <div class="sep"></div>
  <button class="btn" id="btn-zi">+</button>
  <button class="btn" id="btn-zo">&minus;</button>
  <button class="btn" id="btn-zr">Reset</button>
  <div class="sep"></div>
  <button class="btn" id="btn-ex">Export SVG</button>
  <span class="count" id="count"></span>
  <span class="hint">Scroll to zoom &middot; Drag to pan &middot; Click table to inspect</span>
</div>
<div class="wrap" id="wrap">
  <div id="diagram"></div>
</div>
<script type="application/json" id="er-data">${dataJson}</script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js" nonce="${nonce}"></script>
<script nonce="${nonce}">
(function() {
  var vscode = acquireVsCodeApi();
  var DATA = JSON.parse(document.getElementById('er-data').textContent || '[]');
  var scale = 1, panX = 20, panY = 20;
  var dragging = false, dx = 0, dy = 0, spx = 0, spy = 0;
  var diagramEl = document.getElementById('diagram');
  var wrap = document.getElementById('wrap');
  var currentTables = [];

  mermaid.initialize({ startOnLoad: false, theme: 'dark', maxTextSize: 200000, er: { diagramPadding: 24, entityPadding: 12, useMaxWidth: false } });

  function sanitize(s) { return String(s || '').replace(/[^a-zA-Z0-9]/g, '_') || '_'; }
  function eid(schema, table) { return sanitize(schema) + '_' + sanitize(table); }

  function buildDiagram(tables) {
    var lines = ['erDiagram'];
    var ids = {};
    for (var i = 0; i < tables.length; i++) { ids[eid(tables[i].schema, tables[i].name)] = true; }

    for (var i = 0; i < tables.length; i++) {
      var t = tables[i];
      var id = eid(t.schema, t.name);
      var seen = {};
      lines.push('  ' + id + ' {');
      if (t.columns.length > 0) {
        for (var j = 0; j < t.columns.length; j++) {
          var col = t.columns[j];
          var ctype = (col.type.split('(')[0] || 'text').replace(/[^a-zA-Z0-9_]/g, '_') || 'text';
          var cname = sanitize(col.name);
          if (/^[0-9]/.test(ctype)) { ctype = 't' + ctype; }
          if (/^[0-9]/.test(cname)) { cname = 'c' + cname; }
          var ukey = ctype + '_' + cname;
          if (seen[ukey]) { continue; }
          seen[ukey] = true;
          var attrs = col.pk ? ' PK' : (col.fk ? ' FK' : '');
          lines.push('    ' + ctype + ' ' + cname + attrs);
        }
      } else {
        lines.push('    string _');
      }
      lines.push('  }');
    }

    var relSeen = {};
    for (var i = 0; i < tables.length; i++) {
      var t = tables[i];
      var fromId = eid(t.schema, t.name);
      for (var j = 0; j < t.fks.length; j++) {
        var fk = t.fks[j];
        var toSchema = fk.toSchema || t.schema;
        var toId = eid(toSchema, fk.toTable);
        if (!ids[toId] || toId === fromId) { continue; }
        var rkey = toId + '|' + fromId;
        if (relSeen[rkey]) { continue; }
        relSeen[rkey] = true;
        lines.push('  ' + toId + ' ||--o{ ' + fromId + ' : "has"');
      }
    }
    return lines.join('\\n');
  }

  function applyT() {
    diagramEl.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')';
  }

  function addClicks(tables) {
    var map = {};
    for (var i = 0; i < tables.length; i++) {
      map[eid(tables[i].schema, tables[i].name)] = { schema: tables[i].schema, table: tables[i].name };
    }
    var svg = diagramEl.querySelector('svg');
    if (!svg) { return; }
    var texts = svg.querySelectorAll('text');
    for (var i = 0; i < texts.length; i++) {
      var txt = texts[i];
      var content = (txt.textContent || '').trim();
      if (!map[content]) { continue; }
      (function(info) {
        var g = txt.parentNode;
        while (g && g.tagName !== 'g' && g !== svg) { g = g.parentNode; }
        if (!g || g === svg) { return; }
        g.style.cursor = 'pointer';
        g.addEventListener('click', function(e) {
          e.stopPropagation();
          vscode.postMessage({ command: 'inspect', schema: info.schema, table: info.table });
        });
      })(map[content]);
    }
  }

  async function render(tables) {
    currentTables = tables;
    document.getElementById('count').textContent = tables.length + ' table' + (tables.length !== 1 ? 's' : '');
    if (tables.length === 0) {
      diagramEl.innerHTML = '\x3cp style="color:#555;padding:40px">No tables to display.\x3c/p>';
      return;
    }
    diagramEl.innerHTML = '';
    try {
      var str = buildDiagram(tables);
      var result = await mermaid.render('er-graph-' + Date.now(), str);
      diagramEl.innerHTML = result.svg;
      addClicks(tables);
    } catch(e) {
      diagramEl.innerHTML = '\x3cp style="color:#c72e0f;padding:40px">Render error: ' + String(e) + '\x3c/p>';
    }
  }

  function filterAndRender() {
    var sel = document.getElementById('schema-sel').value;
    var filtered = sel === '__all__' ? DATA : DATA.filter(function(t) { return t.schema === sel; });
    panX = 20; panY = 20; scale = 1; applyT();
    render(filtered);
  }

  document.getElementById('schema-sel').addEventListener('change', filterAndRender);
  document.getElementById('btn-zi').addEventListener('click', function() { scale = Math.min(4, scale * 1.2); applyT(); });
  document.getElementById('btn-zo').addEventListener('click', function() { scale = Math.max(0.1, scale / 1.2); applyT(); });
  document.getElementById('btn-zr').addEventListener('click', function() { scale = 1; panX = 20; panY = 20; applyT(); });
  document.getElementById('btn-ex').addEventListener('click', function() {
    var svg = diagramEl.querySelector('svg');
    if (!svg) { return; }
    vscode.postMessage({ command: 'exportSvg', svg: svg.outerHTML });
  });

  wrap.addEventListener('wheel', function(e) {
    e.preventDefault();
    var rect = wrap.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    var delta = e.deltaY > 0 ? 0.9 : 1.1;
    var ns = Math.min(4, Math.max(0.1, scale * delta));
    panX = mx - (mx - panX) * (ns / scale);
    panY = my - (my - panY) * (ns / scale);
    scale = ns;
    applyT();
  }, { passive: false });

  wrap.addEventListener('mousedown', function(e) {
    if (e.button !== 0) { return; }
    dragging = true; dx = e.clientX; dy = e.clientY; spx = panX; spy = panY;
    wrap.classList.add('dragging');
  });
  window.addEventListener('mousemove', function(e) {
    if (!dragging) { return; }
    panX = spx + (e.clientX - dx); panY = spy + (e.clientY - dy); applyT();
  });
  window.addEventListener('mouseup', function() { dragging = false; wrap.classList.remove('dragging'); });

  window.addEventListener('message', function(ev) {
    var msg = ev.data;
    if (msg && msg.command === 'refresh') { filterAndRender(); }
  });

  filterAndRender();
})();
</script>
</body>
</html>`;
}

