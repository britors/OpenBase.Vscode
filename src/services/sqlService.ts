import * as path from 'path';
import * as fs from 'fs';
import { DbConnection } from '../types';

export function parseConnectionString(cs: string): DbConnection | undefined {
    const get = (...keys: string[]): string | undefined => {
        for (const k of keys) {
            const m = cs.match(new RegExp(`(?:^|;)\\s*${k.replace(/\s/g, '\\s*')}\\s*=\\s*([^;]+)`, 'i'));
            if (m) return m[1].trim();
        }
    };

    const provider = get('Provider');
    const isOracleHint = /oracle/i.test(cs) || (provider && /oracle/i.test(provider));

    if (/(?:^|;)\s*Host\s*=/i.test(cs) || /(?:^|;)\s*Username\s*=/i.test(cs)) {
        if (isOracleHint) {
            const server   = get('Host', 'Server', 'Data Source', 'DataSource') ?? 'localhost';
            const database = get('Database', 'Service Name', 'SID') ?? '';
            return { type: 'oracle', label: `oracle · ${database || server}`, server, database,
                user: get('User Id', 'UID'), password: get('Password', 'PWD') };
        }
    }

    const server   = get('Server', 'Data Source', 'DataSource') ?? '.';
    const database = get('Database', 'Initial Catalog') ?? '';

    if (!get('Initial Catalog') && !get('Integrated Security') && isOracleHint) {
         return { type: 'oracle', label: `oracle · ${database || server}`, server, database,
            user: get('User Id', 'UID'), password: get('Password', 'PWD') };
    }

    return { type: 'sqlserver', label: `sqlserver · ${database}`, server, database,
        user: get('User Id', 'UID'), password: get('Password', 'PWD') };
}

export function findConnection(cwd: string): DbConnection | undefined {
    function scan(dir: string, depth: number): string | undefined {
        if (depth > 4) return undefined;
        for (const name of ['appsettings.Development.json', 'appsettings.json']) {
            const p = path.join(dir, name);
            if (fs.existsSync(p)) return p;
        }
        try {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
                    const found = scan(path.join(dir, e.name), depth + 1);
                    if (found) return found;
                }
            }
        } catch { /* ignore */ }
    }
    const configPath = scan(cwd, 0);
    if (!configPath) return undefined;
    
    // Simplification: In a real scenario, this would parse the JSON to get the actual connection string
    return undefined;
}
