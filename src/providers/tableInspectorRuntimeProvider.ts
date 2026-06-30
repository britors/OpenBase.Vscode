import { exec } from 'child_process';
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
                if (!file) { resolve(undefined); return; }
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
): Promise<{ columns: TableColumn[]; constraints: TableConstraint[] }> {
    const details = await dbNativeClientService.loadTableDetails(conn, schema, table);
    if (!details) throw new Error(`Table details unavailable for connection type: ${conn.type}`);
    return details;
}
