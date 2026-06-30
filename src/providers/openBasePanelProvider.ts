import * as vscode from 'vscode';
import * as path from 'path';
import { exec, spawn } from 'child_process';

export interface OpenBasePanelProviderDeps {
		ensureInstalled: () => Promise<boolean>;
		openTerminal: (name: string, cwd: string, command: string) => void;
		getNewProjectPrefs: () => Record<string, string>;
		saveNewProjectPrefs: (prefs: Record<string, string>) => Promise<void> | Thenable<void>;
		diagnosticCollection: vscode.DiagnosticCollection;
		dotnetToolsPath: () => string;
}

export class OpenBasePanelProvider implements vscode.WebviewViewProvider {
		static readonly viewType = 'openbase.panel';
		private _view?: vscode.WebviewView;
		private _runProcess?: import('child_process').ChildProcess;
		private _channels = new Map<string, vscode.OutputChannel>();

		constructor(
				private readonly deps: OpenBasePanelProviderDeps
		) {}

		private _channel(name: string): vscode.OutputChannel {
				if (!this._channels.has(name)) {
						this._channels.set(name, vscode.window.createOutputChannel(name));
				}
				return this._channels.get(name)!;
		}

		resolveWebviewView(view: vscode.WebviewView): void {
				this._view = view;
				view.webview.options = { enableScripts: true };
				view.webview.html = this._html();
				view.webview.onDidReceiveMessage(async (msg) => {
						if (msg.command === 'ready') {
								const prefs = this.deps.getNewProjectPrefs();
								view.webview.postMessage({ command: 'loadNewProjectPrefs', prefs });
								return;
						}
						this._handle(msg, view);
				});
		}

		postNavigateTo(tab: string, query: string): void {
				this._view?.webview.postMessage({ command: 'navigateTo', tab, query });
		}

		postMessage(msg: any): void {
				this._view?.webview.postMessage(msg);
		}

		private async _handle(msg: { command: string; data?: Record<string, string | boolean> }, view: vscode.WebviewView): Promise<void> {
				if (msg.command === 'pickFolder') {
						const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Select folder' });
						if (picked?.[0]) view.webview.postMessage({ command: 'folderPicked', path: picked[0].fsPath });
						return;
				}
				if (!await this.deps.ensureInstalled()) {
						view.webview.postMessage({ command: 'error', ctx: msg.data?.['ctx'] ?? '', text: 'OpenBase CLI not found.' });
						return;
				}
				switch (msg.command) {
						case 'newProject': await this._new(msg.data as never, view); break;
						case 'scaffold': await this._scaffold(msg.data as never, view); break;
						case 'scaffoldUpdate': await this._scaffoldUpdate(msg.data as never, view); break;
						case 'specialist': await this._specialist(msg.data as never, view); break;
						case 'procedure': await this._procedure(msg.data as never, view); break;
						case 'extensionAdd': await this._extensionAdd(msg.data as never, view); break;
						case 'build': await this._build(msg.data as never, view); break;
						case 'run': await this._run(msg.data as never, view); break;
						case 'stopRun': {
								const proc = this._runProcess;
								if (proc?.pid) {
										try { process.kill(-proc.pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
								}
								break;
						}
						case 'history': await this._exec('openbase history', await this._cwd() ?? process.cwd(), view, 'history', 'OpenBase: History'); break;
						case 'update': await this._exec('openbase update', await this._cwd() ?? process.cwd(), view, 'update', 'OpenBase: Update'); break;
				}
		}

		private async _new(d: { name: string; template: string; dbServer: string; dbName: string; dbUser: string; dbPassword: string; mediatrLicense: string; automapperLicense: string; folder: string }, view: vscode.WebviewView): Promise<void> {
				let cwd = d.folder;
				if (!cwd) {
						const folders = vscode.workspace.workspaceFolders;
						if (folders?.length === 1) {
								cwd = folders[0].uri.fsPath;
						} else {
								const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Select project folder' });
								if (!picked?.[0]) { view.webview.postMessage({ command: 'done', ctx: 'new' }); return; }
								cwd = picked[0].fsPath;
						}
				}
				const args = [`-n ${d.name}`, `-s ${d.template}`];
				if (d.dbServer) args.push(`--db-server "${d.dbServer}"`);
				if (d.dbName) args.push(`--db-name "${d.dbName}"`);
				if (d.dbUser) args.push(`--db-user "${d.dbUser}"`);
				if (d.dbPassword) args.push(`--db-password "${d.dbPassword}"`);
				args.push(`--mediatr-license "${d.mediatrLicense}"`);
				args.push(`--automapper-license "${d.automapperLicense}"`);

				const ok = await this._exec(`openbase new ${args.join(' ')}`, cwd, view, 'new', 'OpenBase: New Project');
				if (!ok) return;

				await this.deps.saveNewProjectPrefs({
						template: d.template,
						dbServer: d.dbServer,
						dbUser: d.dbUser,
						mediatrLicense: d.mediatrLicense,
						automapperLicense: d.automapperLicense,
				});

				const projectUri = vscode.Uri.file(path.join(cwd, d.name));
				const action = await vscode.window.showInformationMessage(`Project "${d.name}" created successfully!`, 'Open Folder', 'Open in New Window');
				if (action === 'Open Folder') vscode.commands.executeCommand('vscode.openFolder', projectUri, false);
				else if (action === 'Open in New Window') vscode.commands.executeCommand('vscode.openFolder', projectUri, true);
		}

		private async _scaffoldUpdate(d: { entity: string }, view: vscode.WebviewView): Promise<void> {
				const cwd = await this._cwd();
				if (!cwd) { view.webview.postMessage({ command: 'done', ctx: 'scu' }); return; }
				this.deps.openTerminal('Scaffold Update', cwd, `openbase scaffold -e ${d.entity} --update`);
				view.webview.postMessage({ command: 'done', ctx: 'scu' });
		}

		private async _scaffold(d: { entity: string }, view: vscode.WebviewView): Promise<void> {
				const cwd = await this._cwd();
				if (!cwd) { view.webview.postMessage({ command: 'done', ctx: 'sc' }); return; }
				this.deps.openTerminal('Scaffold', cwd, `openbase scaffold -e ${d.entity}`);
				view.webview.postMessage({ command: 'done', ctx: 'sc' });
		}

		private async _specialist(d: { entity: string; method: string; type: string; sql: string; params: string[]; columns: string[] }, view: vscode.WebviewView): Promise<void> {
				const cwd = await this._cwd();
				if (!cwd) { view.webview.postMessage({ command: 'done', ctx: 'sp' }); return; }

				const args: string[] = [
						`-e ${d.entity}`,
						`--method ${d.method}`,
						`--type ${d.type}`,
				];
				if (d.sql) args.push(`--sql "${d.sql.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
				for (const p of (d.params ?? [])) args.push(`--param ${p}`);
				for (const c of (d.columns ?? [])) args.push(`--column ${c}`);

				await this._exec(`openbase specialist ${args.join(' ')}`, cwd, view, 'sp', 'OpenBase: Specialist');
		}

		private async _procedure(d: { name: string; schema: string }, view: vscode.WebviewView): Promise<void> {
				const cwd = await this._cwd();
				if (!cwd) { view.webview.postMessage({ command: 'done', ctx: 'pr' }); return; }

				if (!d.name) {
						this.deps.openTerminal('Procedure', cwd, 'openbase procedure');
						view.webview.postMessage({ command: 'done', ctx: 'pr', text: 'Terminal aberto - selecione a procedure no terminal.' });
						return;
				}
				const args = [`-n ${d.name}`];
				if (d.schema) args.push(`-s "${d.schema}"`);
				await this._exec(`openbase procedure ${args.join(' ')}`, cwd, view, 'pr', 'OpenBase: Procedure');
		}

		private async _extensionAdd(d: { name: string; provider: string }, view: vscode.WebviewView): Promise<void> {
				const cwd = await this._cwd();
				if (!cwd) { view.webview.postMessage({ command: 'done', ctx: 'ext' }); return; }
				const args = d.provider ? `${d.name} -p ${d.provider}` : d.name;
				await this._exec(`openbase extension add ${args}`, cwd, view, 'ext', 'OpenBase: Extension');
		}

		private async _build(d: { configuration: string; noRestore: boolean }, view: vscode.WebviewView): Promise<void> {
				const cwd = await this._cwd();
				if (!cwd) { view.webview.postMessage({ command: 'done', ctx: 'build' }); return; }
				const flags = d.noRestore ? ' --no-restore' : '';
				await this._exec(`openbase build -c ${d.configuration}${flags}`, cwd, view, 'build', 'OpenBase: Build');
		}

		private async _run(d: { configuration: string; noBuild: boolean }, view: vscode.WebviewView): Promise<void> {
				const cwd = await this._cwd();
				if (!cwd) { view.webview.postMessage({ command: 'done', ctx: 'run' }); return; }

				const args = ['run', '-c', d.configuration];
				if (d.noBuild) args.push('--no-build');

				const channel = vscode.window.createOutputChannel('OpenBase: Run');
				channel.show(true);

				const extraPath = this.deps.dotnetToolsPath();
				const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };

				this._runProcess = spawn('openbase', args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
				this._runProcess.stdout?.on('data', (chunk: string) => channel.append(chunk));
				this._runProcess.stderr?.on('data', (chunk: string) => channel.append(chunk));
				view.webview.postMessage({ command: 'runStarted' });

				this._runProcess.on('close', () => {
						this._runProcess = undefined;
						view.webview.postMessage({ command: 'runStopped' });
				});
				this._runProcess.on('error', (err) => {
						channel.appendLine(err.message);
						this._runProcess = undefined;
						view.webview.postMessage({ command: 'runStopped' });
						view.webview.postMessage({ command: 'error', ctx: 'run', text: err.message });
				});
		}

		private async _cwd(): Promise<string | undefined> {
				const folders = vscode.workspace.workspaceFolders;
				if (folders?.length === 1) return folders[0].uri.fsPath;
				const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Select project folder' });
				return picked?.[0]?.fsPath;
		}

		private _parseDiagnostics(output: string, cwd: string): void {
				const diagnostics: { [uri: string]: vscode.Diagnostic[] } = {};
				const regex = /^(.+)\((\d+),(\d+)\): (error|warning) ([\w\d]+): (.*)$/gm;
				let match: RegExpExecArray | null;

				while ((match = regex.exec(output)) !== null) {
						const [, file, line, col, severityStr, code, message] = match;
						const absolutePath = path.isAbsolute(file) ? file : path.resolve(cwd, file);
						const uri = vscode.Uri.file(absolutePath).toString();

						const range = new vscode.Range(
								parseInt(line, 10) - 1,
								parseInt(col, 10) - 1,
								parseInt(line, 10) - 1,
								parseInt(col, 10) + 100
						);

						const severity = severityStr === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
						const diagnostic = new vscode.Diagnostic(range, `${code}: ${message}`, severity);
						diagnostic.source = 'OpenBase';
						diagnostic.code = code;

						if (!diagnostics[uri]) diagnostics[uri] = [];
						diagnostics[uri].push(diagnostic);
				}

				for (const uri in diagnostics) {
						this.deps.diagnosticCollection.set(vscode.Uri.parse(uri), diagnostics[uri]);
				}
		}

		private async _exec(cmd: string, cwd: string, view: vscode.WebviewView, ctx: string, channelName: string): Promise<boolean> {
				const channel = this._channel(channelName);
				channel.clear();
				channel.show(true);
				this.deps.diagnosticCollection.clear();

				let fullOutput = '';
				const extraPath = this.deps.dotnetToolsPath();
				const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
				return new Promise<boolean>((resolve) => {
						const child = exec(cmd, { cwd, env, timeout: 60000 });
						child.stdout?.on('data', (chunk: string) => {
								channel.append(chunk);
								fullOutput += chunk;
						});
						child.stderr?.on('data', (chunk: string) => {
								channel.append(chunk);
								fullOutput += chunk;
						});
						child.on('close', (code, signal) => {
								this._parseDiagnostics(fullOutput, cwd);
								if (signal === 'SIGTERM') {
										view.webview.postMessage({ command: 'error', ctx, text: 'Command timed out after 60s.' });
										resolve(false);
								} else if (code === 0) {
										view.webview.postMessage({ command: 'done', ctx, text: 'Completed successfully.' });
										resolve(true);
								} else {
										view.webview.postMessage({ command: 'error', ctx, text: `Command failed (exit ${code}). Check the output panel.` });
										resolve(false);
								}
						});
						child.on('error', (err) => {
								channel.appendLine(err.message);
								view.webview.postMessage({ command: 'error', ctx, text: err.message });
								resolve(false);
						});
				});
		}

		private _html(): string {
				return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://cdn.jsdelivr.net; script-src 'unsafe-inline' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net data:; worker-src blob: data:;">
	<style>
		*{box-sizing:border-box;margin:0;padding:0}
		body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground)}
		nav{border-bottom:1px solid var(--vscode-panel-border);margin-bottom:0}
		.nav-item{padding:5px 12px;cursor:pointer;font-size:12px;border-left:2px solid transparent}
		.nav-item:hover{background:var(--vscode-list-hoverBackground)}
		.nav-item.active{border-left-color:var(--vscode-focusBorder);color:var(--vscode-textLink-activeForeground);background:var(--vscode-list-activeSelectionBackground)}
		.page{display:none;padding:12px}
		.page.active{display:block}
		.field{margin-bottom:10px}
		label{display:block;margin-bottom:3px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--vscode-descriptionForeground)}
		.check-label{display:flex;align-items:center;gap:6px;font-size:12px;text-transform:none;letter-spacing:normal;font-weight:normal;color:var(--vscode-foreground);cursor:pointer}
		input,select,textarea{width:100%;padding:4px 7px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);font-family:inherit;font-size:inherit;outline:none}
		textarea{resize:vertical}
		input[type=checkbox]{width:auto}
		input:focus,select:focus,textarea:focus{border-color:var(--vscode-focusBorder)}
		input::placeholder,textarea::placeholder{color:var(--vscode-input-placeholderForeground)}
		.row{display:flex;gap:6px}
		.row input{flex:1;min-width:0}
		hr{border:none;border-top:1px solid var(--vscode-panel-border);margin:10px 0}
		.btn{padding:4px 8px;border:none;cursor:pointer;font-family:inherit;font-size:inherit}
		.btn-sm{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
		.btn-sm:hover{background:var(--vscode-button-secondaryHoverBackground)}
		.btn-primary{width:100%;padding:6px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);margin-top:6px}
		.btn-primary:hover{background:var(--vscode-button-hoverBackground)}
		.btn-primary:disabled{opacity:.5;cursor:not-allowed}
		.btn-danger{width:100%;padding:6px;background:var(--vscode-statusBarItem-errorBackground,#c72e0f);color:#fff;margin-top:6px;border:none;cursor:pointer;font-family:inherit;font-size:inherit}
		.hidden{display:none!important}
		.err{margin-top:8px;padding:5px 7px;font-size:12px;background:var(--vscode-inputValidation-errorBackground);border:1px solid var(--vscode-inputValidation-errorBorder);display:none}
		.ok{margin-top:8px;padding:5px 7px;font-size:12px;background:var(--vscode-inputValidation-infoBackground);border:1px solid var(--vscode-inputValidation-infoBorder);display:none}
		.hint{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:6px}
	</style>
</head>
<body>
	<nav>
		<div class="nav-item active" data-page="new"     onclick="nav(this,'new')">New Project</div>
		<div class="nav-item"        data-page="sc"      onclick="nav(this,'sc')">Scaffold</div>
		<div class="nav-item"        data-page="scu"     onclick="nav(this,'scu')">Scaffold Update</div>
		<div class="nav-item"        data-page="sp"      onclick="nav(this,'sp')">Specialist</div>
		<div class="nav-item"        data-page="pr"      onclick="nav(this,'pr')">Procedure</div>
		<div class="nav-item"        data-page="ext"     onclick="nav(this,'ext')">Extension</div>
		<div class="nav-item"        data-page="build"   onclick="nav(this,'build')">Build</div>
		<div class="nav-item"        data-page="run"     onclick="nav(this,'run')">Run</div>
		<div class="nav-item"        data-page="update"  onclick="nav(this,'update')">Update CLI</div>
		<div class="nav-item"        data-page="history" onclick="nav(this,'history')">History</div>
	</nav>

	<!-- NEW PROJECT -->
	<div id="page-new" class="page active">
		<div class="field"><label>Project name *</label><input id="new-name" type="text" placeholder="MyProject"></div>
		<div class="field"><label>Database</label>
			<select id="new-tpl" onchange="onTplChange()">
				<option value="sqlserver">SQL Server</option>
				<option value="pgsql">PostgreSQL</option>
				<option value="oracle">Oracle</option>
			</select>
		</div>
		<hr>
		<div class="field"><label>DB Server</label><input id="new-srv" type="text" placeholder="."></div>
		<div class="field"><label>DB Name</label><input id="new-db" type="text" placeholder="(same as project name)"></div>
		<div class="field"><label>DB User</label><input id="new-usr" type="text" placeholder="Windows Auth / postgres"></div>
		<div class="field"><label>DB Password</label><input id="new-pwd" type="password"></div>
		<hr>
		<div class="field"><label>MediatR License</label><textarea id="new-mediatR" rows="3" placeholder="(optional)" style="resize:vertical;font-family:monospace;font-size:11px;width:100%;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:4px 6px"></textarea></div>
		<div class="field"><label>AutoMapper License</label><textarea id="new-automapper" rows="3" placeholder="(optional)" style="resize:vertical;font-family:monospace;font-size:11px;width:100%;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:4px 6px"></textarea></div>
		<hr>
		<div class="field"><label>Destination folder</label>
			<div class="row">
				<input id="new-folder" type="text" placeholder="(workspace folder)" readonly>
				<button class="btn btn-sm" onclick="pickFolder()">Browse</button>
			</div>
		</div>
		<div id="new-err" class="err"></div>
		<div id="new-ok" class="ok"></div>
		<button id="new-btn" class="btn-primary" onclick="submitNew()" data-label="Create Project">Create Project</button>
	</div>

	<!-- SCAFFOLD -->
	<div id="page-sc" class="page">
		<div class="field"><label>Entity *</label><input id="sc-entity" type="text" placeholder="Product"></div>
		<div id="sc-err" class="err"></div>
		<div id="sc-ok" class="ok"></div>
		<button id="sc-btn" class="btn-primary" onclick="submitScaffold()" data-label="Run Scaffold">Run Scaffold</button>
	</div>

	<!-- SCAFFOLD UPDATE -->
	<div id="page-scu" class="page">
		<p class="hint" style="margin-bottom:10px">Le o schema do banco, compara com a entidade existente e regera os 16 arquivos dependentes de propriedades.</p>
		<div class="field"><label>Entity *</label><input id="scu-entity" type="text" placeholder="Product"></div>
		<p class="hint">Um terminal sera aberto para exibir o diff e confirmar as alteracoes.</p>
		<div id="scu-err" class="err"></div>
		<div id="scu-ok" class="ok"></div>
		<button id="scu-btn" class="btn-primary" onclick="submitScaffoldUpdate()" data-label="Run Scaffold Update">Run Scaffold Update</button>
	</div>

	<!-- SPECIALIST -->
	<div id="page-sp" class="page">
		<div class="field"><label>Entity *</label><input id="sp-entity" type="text" placeholder="Product"></div>
		<div class="field"><label>Method *</label><input id="sp-method" type="text" placeholder="GetByCategoria"></div>
		<div class="field"><label>Type</label>
			<select id="sp-type" onchange="onSpType()">
				<option value="query">query - MediatR query (SELECT)</option>
				<option value="command">command - MediatR command (INSERT/UPDATE/DELETE)</option>
				<option value="httpcall">httpcall - External HTTP call</option>
			</select>
		</div>
		<div id="sp-sql-field" class="field"><label>SQL *</label><div id="sp-sql-editor" style="height:180px;border:1px solid var(--vscode-input-border,#444);border-radius:3px;overflow:hidden;position:relative"><div id="sp-sql-loading" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:11px;opacity:.4;pointer-events:none">Loading editor...</div></div></div>
		<hr>
		<div class="field">
			<label>Parameters</label>
			<div id="sp-params"></div>
			<button class="btn btn-sm" style="margin-top:4px" onclick="addSpRow('sp-params','paramName:Type','e.g. categoriaId:Guid')">+ Add param</button>
			<p class="hint">Format: name:Type - valid types: string, int, bool, decimal, Guid, DateTime, long, double, float, short</p>
		</div>
		<div id="sp-cols-section" class="field">
			<label>Columns</label>
			<div id="sp-cols"></div>
			<button class="btn btn-sm" style="margin-top:4px" onclick="addSpRow('sp-cols','ColumnName:Type','e.g. Nome:string')">+ Add column</button>
			<p class="hint">Format: name:Type - same type list as above</p>
		</div>
		<div id="sp-err" class="err"></div>
		<div id="sp-ok" class="ok"></div>
		<button id="sp-btn" class="btn-primary" onclick="submitSpecialist()" data-label="Generate Specialist">Generate Specialist</button>
	</div>

	<!-- PROCEDURE -->
	<div id="page-pr" class="page">
		<div class="field"><label>Procedure name</label><input id="pr-name" type="text" placeholder="GetOrderById (leave empty to list from DB)"></div>
		<div class="field"><label>Schema</label><input id="pr-schema" type="text" placeholder="(auto-detect)"></div>
		<p class="hint">Deixe o nome em branco para listar as procedures do banco via terminal.</p>
		<div id="pr-err" class="err"></div>
		<div id="pr-ok" class="ok"></div>
		<button id="pr-btn" class="btn-primary" onclick="submitProcedure()" data-label="Generate Procedure">Generate Procedure</button>
	</div>

	<!-- EXTENSION -->
	<div id="page-ext" class="page">
		<div class="field"><label>Extension</label>
			<select id="ext-name">
				<option value="jwt">JWT Authentication</option>
				<option value="healthchecks">Health Checks</option>
				<option value="redis">Redis</option>
				<option value="mongodb">MongoDB</option>
				<option value="domainevents">Domain Events</option>
			</select>
		</div>
		<div id="ext-err" class="err"></div>
		<div id="ext-ok" class="ok"></div>
		<button id="ext-btn" class="btn-primary" onclick="submitExtension()" data-label="Add Extension">Add Extension</button>
	</div>

	<!-- BUILD -->
	<div id="page-build" class="page">
		<div class="field"><label>Configuration</label>
			<select id="build-cfg"><option value="Debug">Debug</option><option value="Release">Release</option></select>
		</div>
		<div class="field"><label class="check-label"><input id="build-nr" type="checkbox"> Skip restore (--no-restore)</label></div>
		<div id="build-err" class="err"></div>
		<div id="build-ok" class="ok"></div>
		<button id="build-btn" class="btn-primary" onclick="submitBuild()" data-label="Build">Build</button>
	</div>

	<!-- RUN -->
	<div id="page-run" class="page">
		<div class="field"><label>Configuration</label>
			<select id="run-cfg"><option value="Debug">Debug</option><option value="Release">Release</option></select>
		</div>
		<div class="field"><label class="check-label"><input id="run-nb" type="checkbox"> Skip build (--no-build)</label></div>
		<div id="run-err" class="err"></div>
		<div id="run-ok" class="ok"></div>
		<button id="run-btn" class="btn-primary" onclick="submitRun()" data-label="Run">Run</button>
		<button id="run-stop" class="btn-danger hidden" onclick="stopRun()">Stop</button>
	</div>

	<!-- HISTORY -->
	<div id="page-history" class="page">
		<p class="hint" style="margin-bottom:10px">Exibe o historico de geracoes do projeto OpenBase.</p>
		<div id="history-err" class="err"></div>
		<div id="history-ok" class="ok"></div>
		<button id="history-btn" class="btn-primary" onclick="submitHistory()" data-label="Show History">Show History</button>
	</div>

	<!-- UPDATE -->
	<div id="page-update" class="page">
		<p class="hint" style="margin-bottom:10px">Atualiza o OpenBase CLI e templates para a versao mais recente.</p>
		<div id="update-err" class="err"></div>
		<div id="update-ok" class="ok"></div>
		<button id="update-btn" class="btn-primary" onclick="submitUpdate()" data-label="Update OpenBase CLI">Update OpenBase CLI</button>
	</div>

	<script>
		const vscode = acquireVsCodeApi();
		function nav(el, page) { document.querySelectorAll('.page').forEach(function(p){ p.classList.remove('active'); }); document.querySelectorAll('.nav-item').forEach(function(n){ n.classList.remove('active'); }); document.getElementById('page-' + page).classList.add('active'); el.classList.add('active'); }
		function onTplChange() { document.getElementById('new-srv').placeholder = document.getElementById('new-tpl').value === 'sqlserver' ? '.' : 'localhost'; }
		function onSpType() { var type = document.getElementById('sp-type').value; document.getElementById('sp-sql-field').classList.toggle('hidden', type === 'httpcall'); document.getElementById('sp-cols-section').classList.toggle('hidden', type !== 'query'); }
		function addSpRow(containerId, placeholder, title) { var row = document.createElement('div'); row.className = 'row'; row.style.marginBottom = '4px'; var input = document.createElement('input'); input.type = 'text'; input.placeholder = placeholder; input.title = title; var btn = document.createElement('button'); btn.className = 'btn btn-sm'; btn.textContent = 'x'; btn.onclick = function() { row.remove(); }; row.appendChild(input); row.appendChild(btn); document.getElementById(containerId).appendChild(row); input.focus(); }
		function getSpRows(containerId) { return Array.from(document.getElementById(containerId).querySelectorAll('input')).map(function(i) { return i.value.trim(); }).filter(function(v) { return v; }); }
		function clearFields(ctx) { if (ctx === 'sc') { document.getElementById('sc-entity').value = ''; } else if (ctx === 'scu') { document.getElementById('scu-entity').value = ''; } else if (ctx === 'sp') { document.getElementById('sp-entity').value = ''; document.getElementById('sp-method').value = ''; if (spEditor) spEditor.setValue(''); document.getElementById('sp-params').innerHTML = ''; document.getElementById('sp-cols').innerHTML = ''; } else if (ctx === 'pr') { document.getElementById('pr-name').value = ''; document.getElementById('pr-schema').value = ''; } }
		function pickFolder() { vscode.postMessage({ command: 'pickFolder' }); }
		function err(ctx, msg) { var el = document.getElementById(ctx + '-err'); if (el) { el.textContent = msg; el.style.display = msg ? 'block' : 'none'; } if (msg) { var ok = document.getElementById(ctx + '-ok'); if (ok) ok.style.display = 'none'; } }
		function ok(ctx, msg) { var el = document.getElementById(ctx + '-ok'); if (el) { el.textContent = msg; el.style.display = msg ? 'block' : 'none'; } if (msg) { var er = document.getElementById(ctx + '-err'); if (er) er.style.display = 'none'; } }
		function loading(ctx, on) { var btn = document.getElementById(ctx + '-btn'); if (!btn) return; btn.disabled = on; btn.textContent = on ? 'Running...' : (btn.dataset.label || btn.textContent); if (on) { ok(ctx, ''); err(ctx, ''); } }
		window.addEventListener('message', function(e) { var m = e.data; if (m.command === 'navigateTo') { var navEl = document.querySelector('.nav-item[data-page="' + m.tab + '"]'); if (navEl) nav(navEl, m.tab); if (m.tab === 'sp' && m.query) { if (spEditor) { spEditor.setValue(m.query); spEditor.focus(); } else { spEditorPending = m.query; } } return; } if (m.command === 'fillSpecialist') { var navEl = document.querySelector('.nav-item[data-page="sp"]'); if (navEl) nav(navEl, 'sp'); if (m.entity) document.getElementById('sp-entity').value = m.entity; if (m.method) document.getElementById('sp-method').value = m.method; return; } if (m.command === 'loadNewProjectPrefs') { var p = m.prefs || {}; if (p.template) document.getElementById('new-tpl').value = p.template; if (p.dbServer) document.getElementById('new-srv').value = p.dbServer; if (p.dbUser) document.getElementById('new-usr').value = p.dbUser; if (p.mediatrLicense) document.getElementById('new-mediatR').value = p.mediatrLicense; if (p.automapperLicense) document.getElementById('new-automapper').value = p.automapperLicense; } else if (m.command === 'folderPicked') { document.getElementById('new-folder').value = m.path; } else if (m.command === 'done') { loading(m.ctx, false); if (m.text) ok(m.ctx, m.text); clearFields(m.ctx); } else if (m.command === 'error') { loading(m.ctx, false); err(m.ctx, m.text); } else if (m.command === 'runStarted') { document.getElementById('run-btn').classList.add('hidden'); document.getElementById('run-stop').classList.remove('hidden'); } else if (m.command === 'runStopped') { document.getElementById('run-btn').classList.remove('hidden'); document.getElementById('run-stop').classList.add('hidden'); loading('run', false); } });
		function submitNew() { var name = document.getElementById('new-name').value.trim(); err('new', ''); if (!name) { err('new', 'Project name is required.'); return; } if (!/^[a-zA-Z0-9._-]+$/.test(name)) { err('new', 'Invalid project name.'); return; } loading('new', true); vscode.postMessage({ command: 'newProject', data: { name: name, template: document.getElementById('new-tpl').value, dbServer: document.getElementById('new-srv').value.trim(), dbName: document.getElementById('new-db').value.trim(), dbUser: document.getElementById('new-usr').value.trim(), dbPassword: document.getElementById('new-pwd').value.trim(), mediatrLicense: document.getElementById('new-mediatR').value.trim(), automapperLicense: document.getElementById('new-automapper').value.trim(), folder: document.getElementById('new-folder').value.trim() }}); }
		function submitScaffold() { var entity = document.getElementById('sc-entity').value.trim(); err('sc', ''); if (!entity) { err('sc', 'Entity name is required.'); return; } if (!/^[A-Z][a-zA-Z0-9]*$/.test(entity)) { err('sc', 'Must be PascalCase (e.g. Product).'); return; } loading('sc', true); vscode.postMessage({ command: 'scaffold', data: { entity: entity }}); }
		function submitScaffoldUpdate() { var entity = document.getElementById('scu-entity').value.trim(); err('scu', ''); if (!entity) { err('scu', 'Entity name is required.'); return; } if (!/^[A-Z][a-zA-Z0-9]*$/.test(entity)) { err('scu', 'Must be PascalCase (e.g. Product).'); return; } loading('scu', true); vscode.postMessage({ command: 'scaffoldUpdate', data: { entity: entity }}); }
		function submitSpecialist() { var entity = document.getElementById('sp-entity').value.trim(); var method = document.getElementById('sp-method').value.trim(); var type = document.getElementById('sp-type').value; var sql = (spEditor ? spEditor.getValue() : '').trim(); err('sp', ''); if (!entity) { err('sp', 'Entity name is required.'); return; } if (!/^[A-Z][a-zA-Z0-9]*$/.test(entity)) { err('sp', 'Entity must be PascalCase (e.g. Product).'); return; } if (!method) { err('sp', 'Method name is required.'); return; } if (!/^[A-Z][a-zA-Z0-9]*$/.test(method)) { err('sp', 'Method must be PascalCase (e.g. GetByCategoria).'); return; } if (type !== 'httpcall' && !sql) { err('sp', 'SQL is required for query/command types.'); return; } var params = getSpRows('sp-params'); var columns = type === 'query' ? getSpRows('sp-cols') : []; loading('sp', true); vscode.postMessage({ command: 'specialist', data: { entity: entity, method: method, type: type, sql: sql, params: params, columns: columns }}); }
		function submitProcedure() { var name = document.getElementById('pr-name').value.trim(); err('pr', ''); if (name && !/^[A-Z][a-zA-Z0-9]*$/.test(name)) { err('pr', 'Must be PascalCase (e.g. GetOrderById).'); return; } loading('pr', true); vscode.postMessage({ command: 'procedure', data: { name: name, schema: document.getElementById('pr-schema').value.trim() }}); }
		function submitExtension() { err('ext', ''); loading('ext', true); var name = document.getElementById('ext-name').value; vscode.postMessage({ command: 'extensionAdd', data: { name: name } }); }
		function submitBuild() { err('build', ''); loading('build', true); vscode.postMessage({ command: 'build', data: { configuration: document.getElementById('build-cfg').value, noRestore: document.getElementById('build-nr').checked }}); }
		function submitRun() { err('run', ''); loading('run', true); vscode.postMessage({ command: 'run', data: { configuration: document.getElementById('run-cfg').value, noBuild: document.getElementById('run-nb').checked }}); }
		function stopRun() { vscode.postMessage({ command: 'stopRun' }); }
		function submitHistory() { err('history', ''); loading('history', true); vscode.postMessage({ command: 'history' }); }
		function submitUpdate() { err('update', ''); loading('update', true); vscode.postMessage({ command: 'update' }); }
	</script>
	<script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.47.0/min/vs/loader.js"></script>
	<script>
		var spEditor = null; var spEditorPending = null;
		window.MonacoEnvironment = { getWorkerUrl: function() { return 'data:text/javascript;charset=utf-8,' + encodeURIComponent('self.onmessage=function(){};'); } };
		require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.47.0/min/vs' } });
		require(['vs/editor/editor.main'], function() {
			monaco.editor.defineTheme('openbase-dark', { base: 'vs-dark', inherit: true, rules: [ { token: 'keyword.sql', foreground: 'c084fc', fontStyle: 'bold' }, { token: 'keyword', foreground: 'c084fc', fontStyle: 'bold' }, { token: 'string.sql', foreground: 'f472b6' }, { token: 'string', foreground: 'f472b6' }, { token: 'number', foreground: '67e8f9' }, { token: 'comment', foreground: '4b3f6b', fontStyle: 'italic' }, { token: 'operator', foreground: 'e879f9' }, { token: 'identifier', foreground: 'ede8f8' }, { token: 'predefined', foreground: 'a78bfa' } ], colors: { 'editor.background': '#0d0f1a', 'editor.foreground': '#ede8f8', 'editor.lineHighlightBackground': '#1c153528', 'editor.selectionBackground': '#b44fff33', 'editor.inactiveSelectionBackground': '#b44fff1a', 'editorLineNumber.foreground': '#3d3060', 'editorLineNumber.activeForeground': '#b44fff', 'editorCursor.foreground': '#b44fff', 'editorWidget.background': '#131629', 'editorWidget.border': '#b44fff44', 'scrollbarSlider.background': '#b44fff22', 'scrollbarSlider.hoverBackground': '#b44fff44', 'scrollbarSlider.activeBackground': '#b44fff66', 'editorGutter.background': '#0d0f1a' } });
			spEditor = monaco.editor.create(document.getElementById('sp-sql-editor'), { value: '', language: 'sql', theme: 'openbase-dark', minimap: { enabled: false }, fontSize: 13, lineNumbers: 'on', automaticLayout: true, wordWrap: 'off', scrollBeyondLastLine: false, renderLineHighlight: 'line', padding: { top: 8, bottom: 8 }, quickSuggestions: true, folding: false, tabSize: 2, insertSpaces: true, overviewRulerLanes: 0, scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 }, contextmenu: false, placeholder: 'SELECT Nome FROM Produtos WHERE CategoriaId = {{categoriaId}}' });
			document.getElementById('sp-sql-loading').style.display = 'none';
			if (spEditorPending !== null) { spEditor.setValue(spEditorPending); spEditor.focus(); spEditorPending = null; }
		});
	</script>
</body>
</html>`;
		}
}
