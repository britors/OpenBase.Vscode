import * as fs from 'fs';
import * as path from 'path';
import { DbConnection } from '../models/dbConnection';

export class ConnectionService {
	parseConnectionString(connectionString: string): DbConnection | undefined {
		const get = (...keys: string[]): string | undefined => {
			for (const k of keys) {
				const m = connectionString.match(new RegExp(`(?:^|;)\\s*${k.replace(/\\s/g, '\\s*')}\\s*=\\s*([^;]+)`, 'i'));
				if (m) return m[1].trim();
			}
		};

		const provider = get('Provider');
		const dataSource = get('Data Source', 'DataSource');
		const isOracleHint = /oracle/i.test(connectionString) || (provider && /oracle/i.test(provider));

		if (/(?:^|;)\s*Host\s*=/i.test(connectionString) || /(?:^|;)\s*Username\s*=/i.test(connectionString)) {
			if (isOracleHint) {
				const server = get('Host', 'Server', 'Data Source', 'DataSource') ?? 'localhost';
				const database = get('Database', 'Service Name', 'SID') ?? '';
				return {
					type: 'oracle',
					label: `oracle · ${database || server}`,
					server,
					database,
					user: get('Username', 'User Id', 'User', 'UID'),
					password: get('Password', 'PWD'),
					port: get('Port'),
				};
			}

			const server = get('Host', 'Server') ?? 'localhost';
			const database = get('Database') ?? '';
			return {
				type: 'pgsql',
				label: `pgsql · ${database}`,
				server,
				database,
				user: get('Username', 'User Id'),
				password: get('Password'),
				port: get('Port'),
			};
		}

		const isOracle = isOracleHint || (dataSource && (/[/@(]/.test(dataSource)) && !/^\./.test(dataSource) && !/\\/.test(dataSource));
		if (isOracle && dataSource) {
			return {
				type: 'oracle',
				label: `oracle · ${dataSource}`,
				server: dataSource,
				database: dataSource,
				user: get('User Id', 'User', 'UID'),
				password: get('Password', 'PWD'),
			};
		}

		const server = get('Server', 'Data Source', 'DataSource') ?? '.';
		const database = get('Database', 'Initial Catalog') ?? '';
		if (!get('Initial Catalog') && !get('Integrated Security') && isOracleHint) {
			return {
				type: 'oracle',
				label: `oracle · ${database || server}`,
				server,
				database,
				user: get('User Id', 'UID'),
				password: get('Password', 'PWD'),
			};
		}

		return {
			type: 'sqlserver',
			label: `sqlserver · ${database}`,
			server,
			database,
			user: get('User Id', 'UID'),
			password: get('Password', 'PWD'),
		};
	}

	findConnection(cwd: string): DbConnection | undefined {
		const scan = (dir: string, depth: number): string | undefined => {
			if (depth > 4) return undefined;
			for (const name of ['appsettings.Development.json', 'appsettings.json']) {
				const filePath = path.join(dir, name);
				if (fs.existsSync(filePath)) return filePath;
			}

			try {
				for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
					if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
						const found = scan(path.join(dir, entry.name), depth + 1);
						if (found) return found;
					}
				}
			} catch {
				return undefined;
			}
		};

		const file = scan(cwd, 0);
		if (!file) return undefined;

		try {
			const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
			const cs = json?.ConnectionStrings?.DefaultConnection
				?? json?.ConnectionStrings?.Connection
				?? (Object.values(json?.ConnectionStrings ?? {}) as string[])[0];
			if (typeof cs === 'string') return this.parseConnectionString(cs);
		} catch {
			return undefined;
		}

		return undefined;
	}
}
