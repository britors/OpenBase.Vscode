import * as vscode from 'vscode';

export function registerChatParticipant(context: vscode.ExtensionContext, execute: (command: string, message: string, stream: any) => Promise<void>, handleIssueImplementation: (type: string, id: string, stream: any) => Promise<void>): void {
    const chatParticipant = vscode.chat.createChatParticipant('openbase.participant', async (request, context, stream, token) => {
        const prompt = request.prompt.toLowerCase();

        // Regex para capturar: implemente a issue #tipo/numero
        const issueMatch = prompt.match(/implemente a issue\s+#([a-z]+)\/(\d+)/);
        if (issueMatch) {
            const type = issueMatch[1];
            const id = issueMatch[2];
            await handleIssueImplementation(type, id, stream);
            return;
        }

        if (prompt.includes('migrate') || prompt.includes('run migrations')) {
            await execute('openbase.migrationRunner.migrateUp', 'Running database migrations...', stream);
        } else if (prompt.includes('build')) {
            await execute('openbase.solutionExplorer.buildAll', 'Building solution...', stream);
        } else if (prompt.includes('run solution') || prompt.includes('run')) {
            await execute('openbase.solutionExplorer.runAll', 'Running solution...', stream);
        } else if (prompt.includes('test')) {
            await execute('openbase.solutionExplorer.test', 'Executing tests...', stream);
        } else if (prompt.includes('sql') || prompt.includes('database')) {
            await execute('openbase.sqlRunner', 'Opening SQL Runner...', stream);
        } else if (prompt.includes('http') || prompt.includes('api')) {
            await execute('openbase.httpRunner', 'Opening HTTP Runner...', stream);
        } else if (prompt.includes('log')) {
            await execute('openbase.logViewer', 'Opening Log Viewer...', stream);
        } else if (prompt.includes('monitor')) {
            await execute('openbase.monitor', 'Opening System Monitor...', stream);
        } else if (prompt.includes('new project')) {
            await execute('openbase.newProject', 'Starting new project wizard...', stream);
        } else if (prompt.includes('scaffold')) {
            await execute('openbase.scaffold', 'Starting scaffold wizard...', stream);
        } else if (prompt.includes('history')) {
            await execute('openbase.history', 'Showing project history...', stream);
        } else if (prompt.includes('version')) {
            await execute('openbase.version', 'Checking CLI version...', stream);
        } else if (prompt.includes('add extension')) {
            await execute('openbase.extensionAdd', 'Adding new extension...', stream);
        } else if (prompt.includes('context')) {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const doc = editor.document;
                stream.markdown(`Your current context is the file: \`${doc.fileName}\` (${doc.languageId}).`);
            } else {
                stream.markdown('No active editor found. Please open a file to see its context.');
            }
        } else if (prompt.includes('help')) {
            stream.markdown('I can help you interact with OpenBase tools. Try commands like:\n\n' +
                '- `migrate`: Run database migrations\n' +
                '- `build`: Build the solution\n' +
                '- `run`: Run the solution\n' +
                '- `test`: Execute tests\n' +
                '- `sql`: Open SQL Runner\n' +
                '- `http`: Open HTTP Runner\n' +
                '- `log`: Open Log Viewer\n' +
                '- `monitor`: Open System Monitor\n' +
                '- `new project`: Start new project wizard\n' +
                '- `scaffold`: Start scaffold wizard\n' +
                '- `context`: Show current file context\n' +
                '- `implemente a issue #tipo/id`: Automated issue workflow');
        } else {
            stream.markdown("I'm sorry, I don't recognize that command. Try `@openbase help` to see what I can do.");
        }
    });

    context.subscriptions.push(chatParticipant);
}
