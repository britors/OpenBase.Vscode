import * as vscode from 'vscode'
import { createBuildCommand } from '../commands/build.command';
import { createExtensionAddCommand, createExtensionListCommand } from '../commands/extension.command';
import { createHistoryCommand } from '../commands/history.command';
import { createNewProjectCommand } from '../commands/newProject.command';
import { createProcedureCommand } from '../commands/procedure.command';
import { createRunCommand } from '../commands/run.command';
import { createScaffoldCommand } from '../commands/scaffold.command';
import { createScaffoldUpdateCommand } from '../commands/scaffoldUpdate.command';
import { createSpecialistCommand } from '../commands/specialist.command';
import { createUpdateCommand } from '../commands/update.command';
import { createVersionCommand } from '../commands/version.command';
import { ChatParticipantProvider } from '../providers/chatParticipantProvider';
import { OpenBaseCliService } from '../services/openBaseCli.service';
import { SettingsService } from '../services/settings.service';
import { TerminalService } from '../services/terminal.service';
import { WorkspaceService } from '../services/workspace.service';

export class OpenBaseOrchestrator {

    private readonly workspaceService: WorkspaceService;
    private readonly terminalService: TerminalService;
    private readonly cliService: OpenBaseCliService;
    private readonly settingsService: SettingsService;
    private readonly chatProvider: ChatParticipantProvider;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly execute: (command: string, message: string, stream: vscode.ChatResponseStream) => Promise<void>,
        private readonly handleIssueImplementation: (type: string, id: string, stream: vscode.ChatResponseStream) => Promise<void>
    ) {
        this.workspaceService = new WorkspaceService();
        this.terminalService = new TerminalService();
        this.cliService = new OpenBaseCliService(this.terminalService);
        this.settingsService = new SettingsService(context);
        this.chatProvider = new ChatParticipantProvider();
    }

    async initialize(): Promise<void> {

        this.registerProviders();

        this.registerCommands();

        this.registerChat();

        this.initializeDiagnostics();
    }

    private registerProviders() {
        this.chatProvider.register(this.context, this.execute, this.handleIssueImplementation);
    }

    private registerCommands() {
        const reg = (id: string, fn: (...args: any[]) => any) =>
            this.context.subscriptions.push(vscode.commands.registerCommand(id, fn));

        reg('openbase.newProject', createNewProjectCommand(this.cliService, this.workspaceService, this.settingsService));
        reg('openbase.scaffold', createScaffoldCommand(this.cliService, this.workspaceService));
        reg('openbase.scaffoldUpdate', createScaffoldUpdateCommand(this.cliService, this.workspaceService));
        reg('openbase.specialist', createSpecialistCommand(this.cliService, this.workspaceService));
        reg('openbase.procedure', createProcedureCommand(this.cliService, this.workspaceService));
        reg('openbase.extensionAdd', createExtensionAddCommand(this.cliService, this.workspaceService));
        reg('openbase.extensionList', createExtensionListCommand(this.cliService, this.workspaceService));
        reg('openbase.build', createBuildCommand(this.cliService, this.workspaceService));
        reg('openbase.run', createRunCommand(this.cliService, this.workspaceService));
        reg('openbase.update', createUpdateCommand(this.cliService, this.workspaceService));
        reg('openbase.history', createHistoryCommand(this.cliService, this.workspaceService));
        reg('openbase.version', createVersionCommand(this.cliService));
    }

    private registerChat() {}

    private initializeDiagnostics() {}
}