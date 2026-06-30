import * as vscode from 'vscode';

const NEW_PROJECT_PREFS_KEY = 'newProjectPrefs';

export class SettingsService {

    constructor(
        private context: vscode.ExtensionContext
    ){}

    getNewProjectPreferences(): Record<string, string> {
        return this.context.globalState.get<Record<string, string>>(NEW_PROJECT_PREFS_KEY) ?? {};
    }

    async saveNewProjectPreferences(preferences: Record<string, string>): Promise<void> {
        await this.context.globalState.update(NEW_PROJECT_PREFS_KEY, preferences);
    }
}