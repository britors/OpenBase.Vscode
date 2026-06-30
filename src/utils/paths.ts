import * as os from 'os';
import * as path from 'path';

export function dotnetToolsPath(): string {
	return path.join(os.homedir(), '.dotnet', 'tools');
}
