import { exec } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DbConnection } from '../models/dbConnection';
import { DbNativeClientService } from '../services/dbNativeClient.service';
import { TableColumn, TableConstraint } from './tableInspectorHtml';

const dbNativeClientService = new DbNativeClientService();

export function tableToPascalCase(name: string): string {
    if (/[_\-]/.test(name)) {
        return name.split(/[_\-]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
    }
    return name.charAt(0).toUpperCase() + name.slice(1);
}

export async function detectScaffoldEntity(cwd: string, table: string): Promise<string | undefined> {
    const escaped = table.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return new Promise<string | undefined>((resolve) => {
        exec(
            `find "${cwd}/src" -name "*Configuration.cs" -not -path "*/obj/*" -exec grep -l 'ToTable("${escaped}")' {} + 2>/dev/null`,
            { timeout: 5000 },
            (_err, out) => {
                const file = out.trim().split('\n')[0];
                if (!file) {
                    resolve(undefined);
                    return;
                }
                const m = path.basename(file).match(/^(.+)Configuration\.cs$/);
                resolve(m ? m[1] : undefined);
            },
        );
    });
}

export async function loadTableDetails(
    conn: DbConnection,
    schema: string,
    table: string,
    dotnetToolsPath: () => string,
): Promise<{ columns: TableColumn[]; constraints: TableConstraint[] }> {
    let nativeError: unknown;
    try {
        const nativeDetails = await dbNativeClientService.loadTableDetails(conn, schema, table);
        if (nativeDetails) {
            return {
                columns: nativeDetails.columns,
                constraints: nativeDetails.constraints,
            };
        }
        if (conn.type === 'sqlserver' && conn.user && conn.password) {
            throw new Error('Native SQL Server details query returned no result.');
        }
    } catch (e) {
        nativeError = e;
        // Continue into CLI fallback.
    }

    const extraPath = dotnetToolsPath();
    const env = { ...process.env, PATH: `${extraPath}${path.delimiter}${process.env.PATH ?? ''}` };
    const ts = Date.now();
    const colFile = path.join(os.tmpdir(), `ob_cols_${ts}.sql`);
    const conFile = path.join(os.tmpdir(), `ob_cons_${ts}.sql`);
    const s = schema.replace(/'/g, "''");
    const t = table.replace(/'/g, "''");

    let colCmd = '';
    let conCmd = '';
    let sep = '|';

    switch (conn.type) {
        case 'sqlserver': {
            if (conn.user && conn.password) {
                const suffix = nativeError instanceof Error ? ` ${nativeError.message}` : '';
                throw new Error(`Failed to load SQL Server table details via native driver.${suffix}`.trim());
            }
            const auth = conn.user ? `-U "${conn.user}" -P "${conn.password ?? ''}"` : '';
            const colQ = `SELECT c.COLUMN_NAME, c.DATA_TYPE, CASE WHEN c.CHARACTER_MAXIMUM_LENGTH IS NOT NULL THEN CAST(c.CHARACTER_MAXIMUM_LENGTH AS VARCHAR) WHEN c.NUMERIC_PRECISION IS NOT NULL THEN CAST(c.NUMERIC_PRECISION AS VARCHAR) ELSE '' END AS SZ, c.IS_NULLABLE, ISNULL(c.COLUMN_DEFAULT,'') FROM INFORMATION_SCHEMA.COLUMNS c WHERE c.TABLE_SCHEMA='${s}' AND c.TABLE_NAME='${t}' ORDER BY c.ORDINAL_POSITION`;
            const conQ = `SELECT tc.CONSTRAINT_TYPE, tc.CONSTRAINT_NAME, kcu.COLUMN_NAME, ISNULL(ccu.TABLE_SCHEMA,'') AS RS, ISNULL(ccu.TABLE_NAME,'') AS RT, ISNULL(ccu.COLUMN_NAME,'') AS RC FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ON tc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA=kcu.TABLE_SCHEMA AND tc.TABLE_NAME=kcu.TABLE_NAME LEFT JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc ON tc.CONSTRAINT_NAME=rc.CONSTRAINT_NAME LEFT JOIN INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE ccu ON rc.UNIQUE_CONSTRAINT_NAME=ccu.CONSTRAINT_NAME WHERE tc.TABLE_SCHEMA='${s}' AND tc.TABLE_NAME='${t}' ORDER BY tc.CONSTRAINT_TYPE, kcu.ORDINAL_POSITION`;
            fs.writeFileSync(colFile, colQ, 'utf-8');
            fs.writeFileSync(conFile, conQ, 'utf-8');
            colCmd = `sqlcmd -S "${conn.server}" -d "${conn.database}" ${auth} -i "${colFile}" -s "|" -W -h -1`;
            conCmd = `sqlcmd -S "${conn.server}" -d "${conn.database}" ${auth} -i "${conFile}" -s "|" -W -h -1`;
            break;
        }
        case 'pgsql': {
            const suffix = nativeError instanceof Error ? ` ${nativeError.message}` : '';
            throw new Error(`Failed to load PostgreSQL table details via native driver.${suffix}`.trim());
        }
        case 'oracle': {
            const suffix = nativeError instanceof Error ? ` ${nativeError.message}` : '';
            throw new Error(`Failed to load Oracle table details via native driver.${suffix}`.trim());
        }
    }

    const runQ = (cmd: string, type: string) => new Promise<string>((resolve, reject) => {
        console.log(`Executing ${type} command: ${cmd}`);
        exec(cmd, { env, timeout: 15000 }, (err, out, stderr) => {
            if (err) {
                console.error(`Error executing ${type}:`, err);
                console.error('Stderr:', stderr);
                reject(new Error(stderr || err.message));
            } else {
                console.log(`${type} output:`, out);
                resolve(out);
            }
        });
    });

    try {
        const [colOut, conOut] = await Promise.all([runQ(colCmd, 'columns'), runQ(conCmd, 'constraints')]);

        const header = new Set(['column_name', 'constraint_type', 'sz', 'owner']);

        const parseRows = (raw: string, minCols: number): string[][] =>
            raw.split('\n')
                .map((l) => l.trim())
                .filter((l) => l && !l.startsWith('---') && !/^\d+ rows? selected/i.test(l))
                .map((l) => l.split(sep).map((p) => p.replace(/^"|"$/g, '').trim()))
                .filter((p) => p.length >= minCols && !header.has(p[0].toLowerCase()));

        const conRows = parseRows(conOut, 3);
        const constraints: TableConstraint[] = conRows.map((r) => {
            let type = r[0] ?? '';
            if (type === 'P') type = 'PRIMARY KEY';
            else if (type === 'R') type = 'FOREIGN KEY';
            else if (type === 'U') type = 'UNIQUE';
            else if (type === 'C') type = 'CHECK';
            return {
                type,
                name: r[1] ?? '',
                column: r[2] ?? '',
                refSchema: (r[3] ?? '').trim(),
                refTable: (r[4] ?? '').trim(),
                refColumn: (r[5] ?? '').trim(),
            };
        });

        const columns: TableColumn[] = parseRows(colOut, 5).map((r) => ({
            name: r[0] ?? '',
            type: r[1] ?? '',
            size: r[2] ?? '',
            nullable: r[3] ?? '',
            defaultVal: r[4] ?? '',
        }));

        return { columns, constraints };
    } finally {
        try { fs.unlinkSync(colFile); } catch { }
        try { fs.unlinkSync(conFile); } catch { }
    }
}
