import * as vscode from 'vscode';
import { registerChatParticipant } from '../chat/chatParticipant';

export class ChatParticipantProvider {
	register(
		context: vscode.ExtensionContext,
		execute: (command: string, message: string, stream: vscode.ChatResponseStream) => Promise<void>,
		handleIssueImplementation: (type: string, id: string, stream: vscode.ChatResponseStream) => Promise<void>
	): void {
		registerChatParticipant(context, execute, handleIssueImplementation);
	}
}
