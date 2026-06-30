import * as vscode from 'vscode';

export class DiagnosticsService {

    constructor(
        private readonly diagnosticCollection: vscode.DiagnosticCollection
    ) {}

    parse(
        output:string,
        cwd:string
    ): void {
        const diagnostics: { [uri: string]: vscode.Diagnostic[] } = {};
        const regex = /^(.+)\((\d+),(\d+)\): (error|warning) ([\w\d]+): (.*)$/gm;
        let match: RegExpExecArray | null;

        while ((match = regex.exec(output)) !== null) {
            const [, file, line, col, severityStr, code, message] = match;
            const absolutePath = file.match(/^[a-zA-Z]:\\|^\//) ? file : require('path').resolve(cwd, file);
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
            this.diagnosticCollection.set(vscode.Uri.parse(uri), diagnostics[uri]);
        }
    }

    clear(): void {
        this.diagnosticCollection.clear();
    }
}