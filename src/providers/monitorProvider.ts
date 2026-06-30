import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { exec, spawn } from 'child_process';

export interface MonitorProviderDeps {
    dotnetToolsPath: () => string;
    getNonce: () => string;
}

class MonitorController {
    private monitorPanel: vscode.WebviewPanel | undefined;
    private monitorTimer: ReturnType<typeof setInterval> | undefined;
    private monPrevCpu: { idle: number; total: number } | undefined;
    private monPrevDisk: { r: number; w: number; ts: number } | undefined;
    private monPrevNet: { rx: number; tx: number; ts: number } | undefined;
    private monCountersProcess: ReturnType<typeof spawn> | undefined;
    private monSelectedPid: number | undefined;

    constructor(private readonly deps: MonitorProviderDeps) {}

    async monitor(): Promise<void> {
        if (this.monitorPanel) {
            this.monitorPanel.reveal(vscode.ViewColumn.One);
            return;
        }

        const nonce = this.deps.getNonce();
        this.monitorPanel = vscode.window.createWebviewPanel(
            'openbase.monitor',
            'Monitor',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        this.monitorPanel.onDidDispose(() => {
            if (this.monitorTimer) clearInterval(this.monitorTimer);
            this.monitorTimer = undefined;
            this.monPrevCpu = undefined;
            this.monPrevDisk = undefined;
            this.monPrevNet = undefined;
            this.stopMonCounters();
            this.monSelectedPid = undefined;
            this.monitorPanel = undefined;
        });
        this.monitorPanel.webview.html = this.buildMonitorHtml(nonce, this.monitorPanel.webview.cspSource);

        let intervalMs = 2000;
        this.monitorPanel.webview.onDidReceiveMessage((msg: { command: string; interval?: number; pid?: number }) => {
            if (msg.command === 'setInterval' && msg.interval) {
                intervalMs = msg.interval;
                if (this.monitorTimer !== undefined) this.monStartPolling(intervalMs);
            } else if (msg.command === 'pause') {
                if (this.monitorTimer) clearInterval(this.monitorTimer);
                this.monitorTimer = undefined;
            } else if (msg.command === 'resume') {
                this.monStartPolling(intervalMs);
            } else if (msg.command === 'selectProcess') {
                if (msg.pid === this.monSelectedPid) {
                    this.stopMonCounters();
                    this.monSelectedPid = undefined;
                } else if (msg.pid !== undefined) {
                    this.monSelectedPid = msg.pid;
                    this.startMonCounters(msg.pid);
                }
            }
        });

        this.monCollectOs();
        this.monStartPolling(intervalMs);
    }

    private parseDotnetCounters(line: string): Record<string, number> | null {
        try {
            const obj = JSON.parse(line) as Record<string, unknown>;
            const events = (obj['Events'] ?? obj['events'] ?? obj['metrics'] ?? []) as Array<Record<string, unknown>>;
            if (!Array.isArray(events)) return null;
            const result: Record<string, number> = {};
            for (const e of events) {
                const provider = String(e['Provider'] ?? e['provider'] ?? '');
                if (provider !== 'System.Runtime') continue;
                const name = String(e['Name'] ?? e['name'] ?? '');
                const val = Number(e['Mean'] ?? e['mean'] ?? e['value'] ?? 0);
                if (name && !isNaN(val)) result[name] = val;
            }
            return Object.keys(result).length > 0 ? result : null;
        } catch {
            return null;
        }
    }

    private stopMonCounters(): void {
        if (this.monCountersProcess) {
            this.monCountersProcess.kill();
            this.monCountersProcess = undefined;
        }
    }

    private startMonCounters(pid: number): void {
        this.stopMonCounters();
        const extraPath = this.deps.dotnetToolsPath();
        const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };

        exec('dotnet-counters --version', { env }, (err) => {
            if (err) {
                this.monitorPanel?.webview.postMessage({
                    command: 'dotnetCountersUnavailable',
                    pid,
                    installCmd: 'dotnet tool install --global dotnet-counters',
                });
                return;
            }
            const child = spawn(
                'dotnet-counters',
                ['monitor', '--process-id', String(pid), '--format', 'json', '--counters', 'System.Runtime'],
                { env },
            );
            this.monCountersProcess = child;
            let buf = '';
            child.stdout?.on('data', (data: Buffer) => {
                buf += data.toString();
                const lines = buf.split('\n');
                buf = lines.pop() ?? '';
                for (const line of lines) {
                    const t = line.trim();
                    if (!t.startsWith('{')) continue;
                    const metrics = this.parseDotnetCounters(t);
                    if (metrics) this.monitorPanel?.webview.postMessage({ command: 'dotnetCounters', pid, metrics });
                }
            });
            child.on('exit', () => {
                this.monCountersProcess = undefined;
                if (this.monSelectedPid === pid) this.monitorPanel?.webview.postMessage({ command: 'dotnetCountersStopped', pid });
            });
            child.on('error', () => {
                this.monitorPanel?.webview.postMessage({
                    command: 'dotnetCountersUnavailable',
                    pid,
                    installCmd: 'dotnet tool install --global dotnet-counters',
                });
            });
        });
    }

    private monReadCpu(): { idle: number; total: number } | undefined {
        try {
            const fields = fs
                .readFileSync('/proc/stat', 'utf-8')
                .split('\n')[0]
                .trim()
                .split(/\s+/)
                .slice(1)
                .map(Number);
            const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
            return { idle, total: fields.reduce((s, v) => s + v, 0) };
        } catch {
            return undefined;
        }
    }

    private monReadMem(): { totalMB: number; usedMB: number } {
        try {
            const t = fs.readFileSync('/proc/meminfo', 'utf-8');
            const n = (k: string) => parseInt(t.match(new RegExp(k + ':\\s*(\\d+)'))?.[1] ?? '0', 10);
            return {
                totalMB: Math.round(n('MemTotal') / 1024),
                usedMB: Math.round((n('MemTotal') - n('MemAvailable')) / 1024),
            };
        } catch {
            return { totalMB: 0, usedMB: 0 };
        }
    }

    private monReadDisk(): { r: number; w: number } {
        try {
            let r = 0;
            let w = 0;
            for (const line of fs.readFileSync('/proc/diskstats', 'utf-8').split('\n')) {
                const p = line.trim().split(/\s+/);
                if (p.length < 14 || !/^(sd[a-z]|nvme\d+n\d+|vd[a-z]|hd[a-z])$/.test(p[2])) continue;
                r += parseInt(p[5], 10);
                w += parseInt(p[9], 10);
            }
            return { r: r * 512, w: w * 512 };
        } catch {
            return { r: 0, w: 0 };
        }
    }

    private monReadNet(): { rx: number; tx: number } {
        try {
            let rx = 0;
            let tx = 0;
            for (const line of fs.readFileSync('/proc/net/dev', 'utf-8').split('\n').slice(2)) {
                const colon = line.indexOf(':');
                if (colon < 0) continue;
                const iface = line.slice(0, colon).trim();
                if (iface === 'lo') continue;
                const parts = line.slice(colon + 1).trim().split(/\s+/);
                rx += parseInt(parts[0], 10) || 0;
                tx += parseInt(parts[8], 10) || 0;
            }
            return { rx, tx };
        } catch {
            return { rx: 0, tx: 0 };
        }
    }

    private monCollectOs() {
        const now = Date.now();

        const cpu = this.monReadCpu();
        let cpuPct = -1;
        if (cpu && this.monPrevCpu) {
            const dt = cpu.total - this.monPrevCpu.total;
            const di = cpu.idle - this.monPrevCpu.idle;
            cpuPct = dt > 0 ? Math.max(0, Math.min(100, Math.round((100 * (dt - di)) / dt))) : 0;
        }
        if (cpu) this.monPrevCpu = cpu;

        const mem = this.monReadMem();
        const memPct = mem.totalMB > 0 ? Math.round((100 * mem.usedMB) / mem.totalMB) : -1;

        const disk = this.monReadDisk();
        let diskR = -1;
        let diskW = -1;
        if (this.monPrevDisk) {
            const dt = (now - this.monPrevDisk.ts) / 1000;
            if (dt > 0) {
                diskR = Math.max(0, (disk.r - this.monPrevDisk.r) / 1024 / 1024 / dt);
                diskW = Math.max(0, (disk.w - this.monPrevDisk.w) / 1024 / 1024 / dt);
            }
        }
        this.monPrevDisk = { r: disk.r, w: disk.w, ts: now };

        const net = this.monReadNet();
        let netRx = -1;
        let netTx = -1;
        if (this.monPrevNet) {
            const dt = (now - this.monPrevNet.ts) / 1000;
            if (dt > 0) {
                netRx = Math.max(0, (net.rx - this.monPrevNet.rx) / 1024 / 1024 / dt);
                netTx = Math.max(0, (net.tx - this.monPrevNet.tx) / 1024 / 1024 / dt);
            }
        }
        this.monPrevNet = { rx: net.rx, tx: net.tx, ts: now };

        return { cpuPct, memUsedMB: mem.usedMB, memTotalMB: mem.totalMB, memPct, diskR, diskW, netRx, netTx };
    }

    private monCollectDotnet(): Array<{ pid: number; name: string; memMB: number; threads: number }> {
        const result: Array<{ pid: number; name: string; memMB: number; threads: number }> = [];
        try {
            for (const e of fs.readdirSync('/proc', { withFileTypes: true })) {
                if (!e.isDirectory() || !/^\d+$/.test(e.name)) continue;
                const pid = parseInt(e.name, 10);
                try {
                    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim();
                    if (!cmd.toLowerCase().includes('dotnet')) continue;
                    const dll = cmd.split(' ').find((p) => p.endsWith('.dll'));
                    const name = dll ? path.basename(dll, '.dll') : 'dotnet';
                    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf-8');
                    const vmRss = parseInt(status.match(/VmRSS:\s*(\d+)/)?.[1] ?? '0', 10);
                    const threads = parseInt(status.match(/Threads:\s*(\d+)/)?.[1] ?? '0', 10);
                    result.push({ pid, name, memMB: Math.round(vmRss / 1024), threads });
                } catch {
                    // process exited or no perms
                }
            }
        } catch {
            // /proc not available
        }
        return result.sort((a, b) => b.memMB - a.memMB);
    }

    private monStartPolling(intervalMs: number): void {
        if (this.monitorTimer) clearInterval(this.monitorTimer);
        this.monitorTimer = setInterval(() => {
            if (!this.monitorPanel) {
                if (this.monitorTimer) clearInterval(this.monitorTimer);
                return;
            }
            this.monitorPanel.webview.postMessage({ command: 'metrics', os: this.monCollectOs(), dotnet: this.monCollectDotnet() });
        }, intervalMs);
    }

    private buildMonitorHtml(nonce: string, cspSource: string): string {
        void cspSource;
        return /* html */ `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root{--bg1:var(--vscode-editor-background,#1e1e1e);--bg2:var(--vscode-sideBar-background,#252526);--border:var(--vscode-panel-border,rgba(128,128,128,.2));--text:var(--vscode-editor-foreground,#d4d4d4);--dim:var(--vscode-descriptionForeground,#858585);--purple:#b44fff;--green:#4ec994;--yellow:#e5c07b}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:var(--vscode-font-family,sans-serif);font-size:var(--vscode-font-size,13px);color:var(--text);background:var(--bg1);display:flex;flex-direction:column;height:100vh;overflow:hidden}
  .toolbar{display:flex;align-items:center;gap:6px;padding:5px 10px;background:var(--bg2);border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap}
  .btn{padding:2px 8px;font-size:11px;font-family:inherit;cursor:pointer;border:1px solid var(--border);background:var(--bg2);color:var(--text);border-radius:2px}
  .btn:hover{background:var(--purple);color:#fff;border-color:var(--purple)}
  select{background:var(--bg1);color:var(--text);border:1px solid var(--border);padding:2px 5px;font-size:11px;font-family:inherit;border-radius:2px;outline:none}
  .lbl{font-size:11px;color:var(--dim)}
  .badge-run{display:inline-block;font-size:10px;padding:1px 7px;border-radius:10px;background:var(--purple);color:#fff}
  .badge-pause{display:inline-block;font-size:10px;padding:1px 7px;border-radius:10px;border:1px solid var(--border);color:var(--dim)}
  .content{flex:1;overflow-y:auto;padding:10px}
  .section{margin-bottom:16px}
  .section-hdr{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:var(--dim);margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid var(--border)}
  .metric{display:flex;align-items:center;gap:8px;margin-bottom:7px}
  .m-lbl{font-size:11px;color:var(--dim);width:58px;flex-shrink:0}
  .bar-track{flex:1;height:6px;background:rgba(255,255,255,.08);border-radius:3px;overflow:hidden}
  .bar-fill{height:100%;border-radius:3px;transition:width .5s ease}
  .bar-cpu{background:var(--purple)}
  .bar-mem{background:var(--green)}
  .m-val{font-size:11px;min-width:90px;text-align:right;color:var(--text)}
  .io-row{display:flex;gap:6px;margin-top:4px}
  .io-box{flex:1;background:var(--bg2);border:1px solid var(--border);border-radius:3px;padding:5px 8px}
  .io-title{font-size:10px;color:var(--dim);margin-bottom:3px}
  .io-vals{display:flex;gap:8px;font-size:11px}
  .io-up::before{content:'↑ ';color:var(--purple)}
  .io-dn::before{content:'↓ ';color:var(--green)}
  .proc-row{display:flex;align-items:center;gap:6px;padding:5px 8px;margin-bottom:3px;background:var(--bg2);border:1px solid var(--border);border-radius:3px;cursor:pointer}
  .proc-row:hover{border-color:var(--purple)}
  .proc-row.selected{border-color:var(--purple);background:rgba(180,79,255,.08)}
  .proc-name{flex:1;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .proc-pid{font-size:10px;color:var(--dim)}
  .proc-tag{font-size:10px;padding:1px 5px;border-radius:3px;background:rgba(180,79,255,.15);color:var(--purple);white-space:nowrap}
  .empty{font-size:11px;color:var(--dim);font-style:italic}
  .gc-section{margin-top:10px;padding:10px;background:var(--bg2);border:1px solid var(--border);border-radius:4px}
  .gc-hdr{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:var(--dim);margin-bottom:8px}
  .gc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:6px}
  .gc-card{background:var(--bg1);border:1px solid var(--border);border-radius:3px;padding:6px 8px}
  .gc-name{font-size:10px;color:var(--dim);margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .gc-val{font-size:13px;font-weight:600;color:var(--text)}
  .gc-unavail{font-size:11px;color:var(--dim);font-style:italic}
  .gc-unavail code{font-family:var(--vscode-editor-font-family,monospace);font-size:10px;color:var(--purple)}
</style>
</head>
<body>
<div class="toolbar">
  <button id="tog" class="btn" onclick="toggle()">&#9646;&#9646; Pause</button>
  <span class="lbl">Every</span>
  <select id="ivl" onchange="chgInterval()">
    <option value="1000">1s</option>
    <option value="2000" selected>2s</option>
    <option value="5000">5s</option>
  </select>
  <span id="badge" class="badge-run">Running</span>
</div>
<div class="content">
  <div class="section">
    <div class="section-hdr">System</div>
    <div class="metric">
      <span class="m-lbl">CPU</span>
      <div class="bar-track"><div id="cpu-fill" class="bar-fill bar-cpu" style="width:0%"></div></div>
      <span id="cpu-val" class="m-val">--</span>
    </div>
    <div class="metric">
      <span class="m-lbl">Memory</span>
      <div class="bar-track"><div id="mem-fill" class="bar-fill bar-mem" style="width:0%"></div></div>
      <span id="mem-val" class="m-val">--</span>
    </div>
    <div class="io-row">
      <div class="io-box">
        <div class="io-title">Disk</div>
        <div class="io-vals"><span class="io-up" id="disk-w">--</span><span class="io-dn" id="disk-r">--</span></div>
      </div>
      <div class="io-box">
        <div class="io-title">Network</div>
        <div class="io-vals"><span class="io-up" id="net-tx">--</span><span class="io-dn" id="net-rx">--</span></div>
      </div>
    </div>
  </div>
  <div class="section">
    <div class="section-hdr">.NET Processes <span style="font-size:10px;font-weight:400;text-transform:none;letter-spacing:0;color:var(--dim)">(click to monitor GC)</span></div>
    <div id="dotnet-list"><span class="empty">No .NET processes detected</span></div>
    <div id="gc-section" style="display:none"></div>
  </div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  var paused = false;
  var selectedPid = null;

  function toggle() {
    paused = !paused;
    document.getElementById('tog').innerHTML = paused ? '&#9654; Resume' : '&#9646;&#9646; Pause';
    var b = document.getElementById('badge');
    b.className = paused ? 'badge-pause' : 'badge-run';
    b.textContent = paused ? 'Paused' : 'Running';
    vscode.postMessage({ command: paused ? 'pause' : 'resume' });
  }

  function chgInterval() {
    vscode.postMessage({ command: 'setInterval', interval: parseInt(document.getElementById('ivl').value, 10) });
  }

  function fmtMbs(v) {
    if (v < 0) return '--';
    if (v < 0.1) return (v * 1024).toFixed(0) + ' KB/s';
    return v.toFixed(1) + ' MB/s';
  }
  function fmtMb(v) {
    if (v < 0) return '--';
    return v >= 1024 ? (v / 1024).toFixed(1) + ' GB' : v + ' MB';
  }
  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/\x3c/g,'&lt;').replace(/>/g,'&gt;');
  }
  function fmtGcVal(name, v) {
    var n = name.toLowerCase();
    if (n.indexOf('memory') !== -1 || n.indexOf('bytes') !== -1) {
      var mb = v / 1048576;
      return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(1) + ' MB';
    }
    if (n.indexOf('ratio') !== -1 || n.indexOf('percent') !== -1) return v.toFixed(1) + '%';
    if (n.indexOf('time') !== -1 && v > 1000) return (v / 1000).toFixed(2) + ' s';
    if (Number.isInteger(v) || v > 100) return v.toFixed(0);
    return v.toFixed(2);
  }

  document.getElementById('dotnet-list').addEventListener('click', function(e) {
    var row = e.target.closest('.proc-row');
    if (!row) return;
    var pid = parseInt(row.dataset.pid, 10);
    vscode.postMessage({ command: 'selectProcess', pid: pid });
    if (selectedPid === pid) {
      selectedPid = null;
      row.classList.remove('selected');
      document.getElementById('gc-section').style.display = 'none';
    } else {
      selectedPid = pid;
      document.querySelectorAll('.proc-row').forEach(function(r) { r.classList.remove('selected'); });
      row.classList.add('selected');
      var gcSec = document.getElementById('gc-section');
      gcSec.style.display = 'block';
      gcSec.innerHTML = '<div class="gc-section"><div class="gc-hdr">GC / Runtime Metrics</div><span class="gc-unavail">Connecting…</span></div>';
    }
  });

  function renderGcMetrics(metrics) {
    var gcSec = document.getElementById('gc-section');
    gcSec.style.display = 'block';
    var keys = Object.keys(metrics).sort();
    var cards = keys.map(function(k) {
      return '<div class="gc-card"><div class="gc-name">' + esc(k) + '</div>' +
        '<div class="gc-val">' + esc(fmtGcVal(k, metrics[k])) + '</div></div>';
    }).join('');
    gcSec.innerHTML = '<div class="gc-section"><div class="gc-hdr">GC / Runtime Metrics (PID ' + selectedPid + ')</div><div class="gc-grid">' + cards + '</div></div>';
  }

  window.addEventListener('message', function(e) {
    var m = e.data;
    if (m.command === 'dotnetCounters') {
      if (m.pid === selectedPid) renderGcMetrics(m.metrics);
      return;
    }
    if (m.command === 'dotnetCountersUnavailable') {
      if (m.pid === selectedPid) {
        var gcSec = document.getElementById('gc-section');
        gcSec.style.display = 'block';
        gcSec.innerHTML = '<div class="gc-section"><div class="gc-hdr">GC / Runtime Metrics</div>' +
          '<span class="gc-unavail">dotnet-counters not found. Install: <code>' + esc(m.installCmd) + '</code></span></div>';
      }
      return;
    }
    if (m.command === 'dotnetCountersStopped') {
      if (m.pid === selectedPid) {
        var gcSec2 = document.getElementById('gc-section');
        if (gcSec2.style.display !== 'none') {
          gcSec2.innerHTML += '<span class="gc-unavail" style="display:block;margin-top:6px">Process exited</span>';
        }
        selectedPid = null;
      }
      return;
    }
    if (m.command !== 'metrics') return;
    var o = m.os;

    var cpuPct = o.cpuPct;
    document.getElementById('cpu-fill').style.width = (cpuPct >= 0 ? cpuPct : 0) + '%';
    document.getElementById('cpu-val').textContent = cpuPct >= 0 ? cpuPct + '%' : '--';

    var memPct = o.memPct;
    document.getElementById('mem-fill').style.width = (memPct >= 0 ? memPct : 0) + '%';
    document.getElementById('mem-val').textContent = memPct >= 0 ? fmtMb(o.memUsedMB) + ' / ' + fmtMb(o.memTotalMB) : '--';

    document.getElementById('disk-w').textContent = fmtMbs(o.diskW);
    document.getElementById('disk-r').textContent = fmtMbs(o.diskR);
    document.getElementById('net-tx').textContent = fmtMbs(o.netTx);
    document.getElementById('net-rx').textContent = fmtMbs(o.netRx);

    var procs = m.dotnet;
    var el = document.getElementById('dotnet-list');
    if (!procs || !procs.length) {
      el.innerHTML = '<span class="empty">No .NET processes detected</span>';
      return;
    }
    el.innerHTML = procs.map(function(p) {
      var sel = p.pid === selectedPid ? ' selected' : '';
      return '<div class="proc-row' + sel + '" data-pid="' + p.pid + '">' +
        '<span class="proc-name">' + esc(p.name) + '</span>' +
        '<span class="proc-pid">PID ' + p.pid + '</span>' +
        '<span class="proc-tag">' + p.memMB + ' MB</span>' +
        '<span class="proc-tag">' + p.threads + ' thr</span>' +
        '</div>';
    }).join('');
  });
</script>
</body></html>`;
    }
}

export function setupMonitor(context: vscode.ExtensionContext, deps: MonitorProviderDeps): void {
    const controller = new MonitorController(deps);
    context.subscriptions.push(
        vscode.commands.registerCommand('openbase.monitor', () => controller.monitor()),
    );
}
