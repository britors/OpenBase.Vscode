import * as mssql from 'mssql';
import { Client as PgClient } from 'pg';
import oracledb from 'oracledb';
import { DbConnection } from '../models/dbConnection';
import { SqlQueryResult } from './sqlRunner.service';
import { DbTemplate } from '../models/dbTemplate';

// Oracle returns CLOB columns as Lob streams by default; fetch them as plain strings instead.
oracledb.fetchAsString = [oracledb.CLOB];

export type SqlObjects = {
    tables: string[];
    procedures: string[];
    functions: string[];
    packages: string[];
    dbType: DbTemplate;
};

export type NativeTableDetails = {
    columns: Array<{ name: string; type: string; size: string; nullable: string; defaultVal: string }>;
    constraints: Array<{ type: string; name: string; column: string; refSchema: string; refTable: string; refColumn: string }>;
};

function toCell(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    return String(value);
}

export class DbNativeClientService {
    async executeQuery(conn: DbConnection, sql: string): Promise<SqlQueryResult> {
        if (conn.type === 'pgsql') return this.executePg(conn, sql);
        if (conn.type === 'sqlserver') return this.executeSqlServer(conn, sql);
        if (conn.type === 'oracle') return this.executeOracle(conn, sql);
        throw new Error(`Unsupported database type: ${conn.type}`);
    }

    async explainQuery(conn: DbConnection, sql: string): Promise<string> {
        if (conn.type === 'pgsql') {
            const client = new PgClient({
                host: conn.server,
                port: Number(conn.port ?? '5432'),
                user: conn.user ?? 'postgres',
                password: conn.password ?? '',
                database: conn.database,
            });
            await client.connect();
            try {
                const res = await client.query(`EXPLAIN (FORMAT JSON)\n${sql}`);
                const first = res.rows?.[0] as Record<string, unknown> | undefined;
                if (!first) return '[]';
                const val = first['QUERY PLAN'];
                return typeof val === 'string' ? val : JSON.stringify(val);
            } finally {
                await client.end();
            }
        }

        if (conn.type === 'sqlserver') {
            // pool max:1 keeps SET SHOWPLAN_TEXT ON and the query on the same session.
            const pool = await this.connectSqlServer(conn, { max: 1 });
            try {
                await pool.request().batch('SET SHOWPLAN_TEXT ON');
                const result = await pool.request().query(sql);
                const rows = (result.recordset ?? []) as Array<Record<string, unknown>>;
                return rows.map((r) => toCell(r[Object.keys(r)[0]])).join('\n');
            } finally {
                await pool.close();
            }
        }

        if (conn.type === 'oracle') {
            const connection = await this.connectOracle(conn);
            try {
                // EXPLAIN PLAN populates PLAN_TABLE for this session; DBMS_XPLAN.DISPLAY() then
                // reads back the most recently explained statement from the same session.
                await connection.execute(`EXPLAIN PLAN FOR ${sql}`);
                const result = await connection.execute(
                    'SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY())',
                    [],
                    { outFormat: oracledb.OUT_FORMAT_ARRAY },
                );
                const rows = (result.rows ?? []) as unknown[][];
                return rows.map((r) => toCell(r[0])).join('\n');
            } finally {
                await connection.close();
            }
        }

        throw new Error(`Unsupported database type: ${conn.type}`);
    }

    async fetchSchemas(conn: DbConnection): Promise<string[] | undefined> {
        if (conn.type === 'pgsql') {
            const client = new PgClient({
                host: conn.server,
                port: Number(conn.port ?? '5432'),
                user: conn.user ?? 'postgres',
                password: conn.password ?? '',
                database: conn.database,
            });
            await client.connect();
            try {
                const res = await client.query(
                    "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog','information_schema') ORDER BY schema_name",
                );
                return res.rows
                    .map((r) => toCell((r as Record<string, unknown>).schema_name))
                    .filter((s) => s.trim().length > 0);
            } finally {
                await client.end();
            }
        }

        if (conn.type === 'sqlserver') {
            const pool = await this.connectSqlServer(conn);
            try {
                const result = await pool.request().query("SELECT name FROM sys.schemas WHERE name NOT IN ('sys', 'information_schema', 'guest') ORDER BY name");
                return (result.recordset ?? [])
                    .map((r) => toCell((r as Record<string, unknown>).name))
                    .filter((s) => s.trim().length > 0);
            } finally {
                await pool.close();
            }
        }

        if (conn.type === 'oracle') {
            const connection = await this.connectOracle(conn);
            try {
                const result = await connection.execute(
                    'SELECT DISTINCT username FROM all_users ORDER BY username',
                    [],
                    { outFormat: oracledb.OUT_FORMAT_ARRAY },
                );
                const rows = (result.rows ?? []) as unknown[][];
                return rows.map((r) => toCell(r[0])).filter((s) => s.trim().length > 0);
            } finally {
                await connection.close();
            }
        }

        return undefined;
    }

    async loadSqlObjects(conn: DbConnection, targetSchema?: string): Promise<Map<string, SqlObjects> | undefined> {
        if (conn.type === 'pgsql') {
            const client = new PgClient({
                host: conn.server,
                port: Number(conn.port ?? '5432'),
                user: conn.user ?? 'postgres',
                password: conn.password ?? '',
                database: conn.database,
            });
            await client.connect();
            try {
                const schemaFilter = targetSchema
                    ? `AND table_schema = '${targetSchema.replace(/'/g, "''")}'`
                    : "AND table_schema NOT IN ('pg_catalog','information_schema')";
                const q = `
                    SELECT table_schema AS schema_name, table_name AS object_name, 'TABLE' AS object_type FROM information_schema.tables WHERE table_type='BASE TABLE' ${schemaFilter}
                    UNION ALL
                    SELECT routine_schema AS schema_name, routine_name AS object_name, routine_type AS object_type FROM information_schema.routines WHERE 1=1 ${schemaFilter.replace(/table_schema/g, 'routine_schema')}
                    ORDER BY schema_name, object_type, object_name`;
                const res = await client.query(q);
                return this.mapSqlObjectsFromRows('pgsql', res.rows as Array<Record<string, unknown>>);
            } finally {
                await client.end();
            }
        }

        if (conn.type === 'sqlserver') {
            const pool = await this.connectSqlServer(conn);
            try {
                const schemaFilter = targetSchema
                    ? `WHERE TABLE_SCHEMA = '${targetSchema.replace(/'/g, "''")}'`
                    : '';
                const q = `
                    SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS object_name, 'TABLE' AS object_type FROM INFORMATION_SCHEMA.TABLES ${schemaFilter} ${schemaFilter ? 'AND' : 'WHERE'} TABLE_TYPE='BASE TABLE'
                    UNION ALL
                    SELECT ROUTINE_SCHEMA AS schema_name, ROUTINE_NAME AS object_name, ROUTINE_TYPE AS object_type FROM INFORMATION_SCHEMA.ROUTINES ${targetSchema ? `WHERE ROUTINE_SCHEMA = '${targetSchema.replace(/'/g, "''")}'` : ''}
                    ORDER BY schema_name, object_type, object_name`;
                const result = await pool.request().query(q);
                return this.mapSqlObjectsFromRows('sqlserver', result.recordset as Array<Record<string, unknown>>);
            } finally {
                await pool.close();
            }
        }

        if (conn.type === 'oracle') {
            const connection = await this.connectOracle(conn);
            try {
                const schema = (targetSchema ?? conn.user ?? '').toUpperCase().replace(/'/g, "''");
                const q = `
                    SELECT OWNER AS "schema_name", TABLE_NAME AS "object_name", 'TABLE' AS "object_type"
                    FROM ALL_TABLES WHERE OWNER = '${schema}' ORDER BY TABLE_NAME`;
                const result = await connection.execute(q, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
                return this.mapSqlObjectsFromRows('oracle', (result.rows ?? []) as Array<Record<string, unknown>>);
            } finally {
                await connection.close();
            }
        }

        return undefined;
    }

    async loadTableDetails(conn: DbConnection, schema: string, table: string): Promise<NativeTableDetails | undefined> {
        if (conn.type === 'pgsql') {
            const client = new PgClient({
                host: conn.server,
                port: Number(conn.port ?? '5432'),
                user: conn.user ?? 'postgres',
                password: conn.password ?? '',
                database: conn.database,
            });
            await client.connect();
            try {
                const s = schema.replace(/'/g, "''");
                const t = table.replace(/'/g, "''");
                const colQ = `
                    SELECT column_name, data_type,
                        COALESCE(CAST(character_maximum_length AS VARCHAR), CAST(numeric_precision AS VARCHAR), '') AS sz,
                        is_nullable,
                        COALESCE(column_default,'') AS default_val
                    FROM information_schema.columns
                    WHERE table_schema='${s}' AND table_name='${t}'
                    ORDER BY ordinal_position`;
                const conQ = `
                    SELECT tc.constraint_type, tc.constraint_name, kcu.column_name,
                        COALESCE(ccu.table_schema,'') AS rs,
                        COALESCE(ccu.table_name,'') AS rt,
                        COALESCE(ccu.column_name,'') AS rc
                    FROM information_schema.table_constraints tc
                    JOIN information_schema.key_column_usage kcu
                        ON tc.constraint_name=kcu.constraint_name
                        AND tc.table_schema=kcu.table_schema
                        AND tc.table_name=kcu.table_name
                    LEFT JOIN information_schema.referential_constraints rfk
                        ON tc.constraint_name=rfk.constraint_name
                    LEFT JOIN information_schema.constraint_column_usage ccu
                        ON rfk.unique_constraint_name=ccu.constraint_name
                    WHERE tc.table_schema='${s}' AND tc.table_name='${t}'
                    ORDER BY tc.constraint_type, kcu.ordinal_position`;

                const [colRes, conRes] = await Promise.all([client.query(colQ), client.query(conQ)]);
                const columns = colRes.rows.map((r) => ({
                    name: toCell((r as Record<string, unknown>).column_name),
                    type: toCell((r as Record<string, unknown>).data_type),
                    size: toCell((r as Record<string, unknown>).sz),
                    nullable: toCell((r as Record<string, unknown>).is_nullable),
                    defaultVal: toCell((r as Record<string, unknown>).default_val),
                }));
                const constraints = conRes.rows.map((r) => {
                    let type = toCell((r as Record<string, unknown>).constraint_type);
                    if (type === 'P') type = 'PRIMARY KEY';
                    else if (type === 'R') type = 'FOREIGN KEY';
                    else if (type === 'U') type = 'UNIQUE';
                    else if (type === 'C') type = 'CHECK';
                    return {
                        type,
                        name: toCell((r as Record<string, unknown>).constraint_name),
                        column: toCell((r as Record<string, unknown>).column_name),
                        refSchema: toCell((r as Record<string, unknown>).rs),
                        refTable: toCell((r as Record<string, unknown>).rt),
                        refColumn: toCell((r as Record<string, unknown>).rc),
                    };
                });
                return { columns, constraints };
            } finally {
                await client.end();
            }
        }

        if (conn.type === 'sqlserver') {
            const pool = await this.connectSqlServer(conn);
            try {
                const s = schema.replace(/'/g, "''");
                const t = table.replace(/'/g, "''");
                const colQ = `
                    SELECT c.COLUMN_NAME, c.DATA_TYPE,
                        CASE WHEN c.CHARACTER_MAXIMUM_LENGTH IS NOT NULL THEN CAST(c.CHARACTER_MAXIMUM_LENGTH AS VARCHAR)
                             WHEN c.NUMERIC_PRECISION IS NOT NULL THEN CAST(c.NUMERIC_PRECISION AS VARCHAR)
                             ELSE '' END AS SZ,
                        c.IS_NULLABLE,
                        ISNULL(c.COLUMN_DEFAULT,'') AS default_val
                    FROM INFORMATION_SCHEMA.COLUMNS c
                    WHERE c.TABLE_SCHEMA='${s}' AND c.TABLE_NAME='${t}'
                    ORDER BY c.ORDINAL_POSITION`;
                const conQ = `
                    SELECT tc.CONSTRAINT_TYPE, tc.CONSTRAINT_NAME, kcu.COLUMN_NAME,
                        ISNULL(ccu.TABLE_SCHEMA,'') AS RS,
                        ISNULL(ccu.TABLE_NAME,'') AS RT,
                        ISNULL(ccu.COLUMN_NAME,'') AS RC
                    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                    JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
                        ON tc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME
                        AND tc.TABLE_SCHEMA=kcu.TABLE_SCHEMA
                        AND tc.TABLE_NAME=kcu.TABLE_NAME
                    LEFT JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
                        ON tc.CONSTRAINT_NAME=rc.CONSTRAINT_NAME
                    LEFT JOIN INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE ccu
                        ON rc.UNIQUE_CONSTRAINT_NAME=ccu.CONSTRAINT_NAME
                    WHERE tc.TABLE_SCHEMA='${s}' AND tc.TABLE_NAME='${t}'
                    ORDER BY tc.CONSTRAINT_TYPE, kcu.ORDINAL_POSITION`;

                const [colRes, conRes] = await Promise.all([
                    pool.request().query(colQ),
                    pool.request().query(conQ),
                ]);

                const columns = (colRes.recordset ?? []).map((r) => ({
                    name: toCell((r as Record<string, unknown>).COLUMN_NAME),
                    type: toCell((r as Record<string, unknown>).DATA_TYPE),
                    size: toCell((r as Record<string, unknown>).SZ),
                    nullable: toCell((r as Record<string, unknown>).IS_NULLABLE),
                    defaultVal: toCell((r as Record<string, unknown>).default_val),
                }));
                const constraints = (conRes.recordset ?? []).map((r) => ({
                    type: toCell((r as Record<string, unknown>).CONSTRAINT_TYPE),
                    name: toCell((r as Record<string, unknown>).CONSTRAINT_NAME),
                    column: toCell((r as Record<string, unknown>).COLUMN_NAME),
                    refSchema: toCell((r as Record<string, unknown>).RS),
                    refTable: toCell((r as Record<string, unknown>).RT),
                    refColumn: toCell((r as Record<string, unknown>).RC),
                }));
                return { columns, constraints };
            } finally {
                await pool.close();
            }
        }

        if (conn.type === 'oracle') {
            const connection = await this.connectOracle(conn);
            try {
                const s = schema.toUpperCase().replace(/'/g, "''");
                const t = table.toUpperCase().replace(/'/g, "''");
                const colQ = `
                    SELECT COLUMN_NAME AS "column_name", DATA_TYPE AS "data_type",
                        CASE WHEN DATA_PRECISION IS NOT NULL THEN TO_CHAR(DATA_PRECISION) ELSE TO_CHAR(DATA_LENGTH) END AS "sz",
                        NULLABLE AS "nullable"
                    FROM ALL_TAB_COLUMNS
                    WHERE OWNER = '${s}' AND TABLE_NAME = '${t}'
                    ORDER BY COLUMN_ID`;
                const conQ = `
                    SELECT uc.CONSTRAINT_TYPE AS "constraint_type", uc.CONSTRAINT_NAME AS "constraint_name", ucc.COLUMN_NAME AS "column_name",
                        NVL(rc.OWNER,' ') AS "rs", NVL(rc.TABLE_NAME,' ') AS "rt", NVL(rcc.COLUMN_NAME,' ') AS "rc"
                    FROM ALL_CONSTRAINTS uc
                    JOIN ALL_CONS_COLUMNS ucc ON uc.CONSTRAINT_NAME = ucc.CONSTRAINT_NAME AND uc.OWNER = ucc.OWNER
                    LEFT JOIN ALL_CONSTRAINTS rc ON uc.R_CONSTRAINT_NAME = rc.CONSTRAINT_NAME
                    LEFT JOIN ALL_CONS_COLUMNS rcc ON rc.CONSTRAINT_NAME = rcc.CONSTRAINT_NAME AND rcc.POSITION = 1
                    WHERE uc.OWNER = '${s}' AND uc.TABLE_NAME = '${t}' AND uc.CONSTRAINT_TYPE IN ('P','R','U')
                    ORDER BY uc.CONSTRAINT_TYPE, ucc.POSITION`;

                const [colRes, conRes] = await Promise.all([
                    connection.execute(colQ, [], { outFormat: oracledb.OUT_FORMAT_OBJECT }),
                    connection.execute(conQ, [], { outFormat: oracledb.OUT_FORMAT_OBJECT }),
                ]);

                const columns = ((colRes.rows ?? []) as Array<Record<string, unknown>>).map((r) => ({
                    name: toCell(r.column_name),
                    type: toCell(r.data_type),
                    size: toCell(r.sz),
                    nullable: toCell(r.nullable) === 'N' ? 'NO' : 'YES',
                    defaultVal: '',
                }));
                const constraints = ((conRes.rows ?? []) as Array<Record<string, unknown>>).map((r) => {
                    let type = toCell(r.constraint_type);
                    if (type === 'P') type = 'PRIMARY KEY';
                    else if (type === 'R') type = 'FOREIGN KEY';
                    else if (type === 'U') type = 'UNIQUE';
                    return {
                        type,
                        name: toCell(r.constraint_name),
                        column: toCell(r.column_name),
                        refSchema: toCell(r.rs).trim(),
                        refTable: toCell(r.rt).trim(),
                        refColumn: toCell(r.rc).trim(),
                    };
                });
                return { columns, constraints };
            } finally {
                await connection.close();
            }
        }

        return undefined;
    }

    private async executePg(conn: DbConnection, sql: string): Promise<SqlQueryResult> {
        const client = new PgClient({
            host: conn.server,
            port: Number(conn.port ?? '5432'),
            user: conn.user ?? 'postgres',
            password: conn.password ?? '',
            database: conn.database,
        });

        await client.connect();
        try {
            const res = await client.query(sql);
            const columns = res.fields?.map((f) => f.name) ?? [];
            const rows = res.rows.map((r) => columns.map((c) => toCell((r as Record<string, unknown>)[c])));
            if (!columns.length) {
                const message = [res.command, typeof res.rowCount === 'number' ? res.rowCount : undefined]
                    .filter((x) => x !== undefined)
                    .join(' ');
                return { columns: [], rows: [], message: message || 'Command completed.' };
            }
            return { columns, rows };
        } finally {
            await client.end();
        }
    }

    private async executeSqlServer(conn: DbConnection, sql: string): Promise<SqlQueryResult> {
        const pool = await this.connectSqlServer(conn);
        try {
            const result = await pool.request().query(sql);
            const recordset = result.recordset ?? [];
            if (!recordset.length) {
                const affected = (result.rowsAffected ?? []).reduce((sum, n) => sum + n, 0);
                return {
                    columns: [],
                    rows: [],
                    message: affected > 0 ? `(${affected} rows affected)` : 'Command completed.',
                };
            }

            const columns = Object.keys(recordset[0] as Record<string, unknown>);
            const rows = recordset.map((r) => columns.map((c) => toCell((r as Record<string, unknown>)[c])));
            return { columns, rows };
        } finally {
            await pool.close();
        }
    }

    private async executeOracle(conn: DbConnection, sql: string): Promise<SqlQueryResult> {
        const connection = await this.connectOracle(conn);
        try {
            const result = await connection.execute(sql, [], { outFormat: oracledb.OUT_FORMAT_ARRAY, autoCommit: true });
            const columns = (result.metaData ?? []).map((m) => m.name);
            if (!columns.length) {
                const affected = typeof result.rowsAffected === 'number' ? result.rowsAffected : 0;
                return {
                    columns: [],
                    rows: [],
                    message: affected > 0 ? `${affected} row(s) affected.` : 'Command completed.',
                };
            }
            const rows = (result.rows ?? []) as unknown[][];
            return { columns, rows: rows.map((r) => r.map((c) => toCell(c))) };
        } finally {
            await connection.close();
        }
    }

    private async connectOracle(conn: DbConnection): Promise<oracledb.Connection> {
        return oracledb.getConnection({
            user: conn.user,
            password: conn.password ?? '',
            connectString: conn.server,
        });
    }

    private async connectSqlServer(conn: DbConnection, poolOpts?: { max?: number }): Promise<mssql.ConnectionPool> {
        const useWindowsAuth = !conn.user || !conn.password;
        const config: mssql.config = {
            server: conn.server,
            database: conn.database,
            options: {
                encrypt: false,
                trustServerCertificate: true,
                trustedConnection: useWindowsAuth,
            },
        };

        if (!useWindowsAuth) {
            config.user = conn.user;
            config.password = conn.password;
        }

        if (conn.port) {
            config.port = Number(conn.port);
        }

        if (poolOpts) {
            config.pool = { ...config.pool, ...poolOpts };
        }

        const pool = new mssql.ConnectionPool(config);
        await pool.connect();
        return pool;
    }

    private mapSqlObjectsFromRows(type: DbTemplate, rows: Array<Record<string, unknown>>): Map<string, SqlObjects> {
        const result = new Map<string, SqlObjects>();
        for (const row of rows) {
            const schema = toCell(row.schema_name ?? row.TABLE_SCHEMA ?? row.table_schema ?? row.owner);
            const name = toCell(row.object_name ?? row.TABLE_NAME ?? row.table_name ?? row.name);
            const objectType = toCell(row.object_type ?? row.TYPE ?? row.type ?? row.OBJECT_TYPE).toUpperCase();
            if (!schema || !name || !objectType) continue;

            let entry = result.get(schema);
            if (!entry) {
                entry = { tables: [], procedures: [], functions: [], packages: [], dbType: type };
                result.set(schema, entry);
            }

            if (objectType === 'TABLE') entry.tables.push(name);
            else if (objectType === 'PROCEDURE') entry.procedures.push(name);
            else if (objectType === 'FUNCTION') entry.functions.push(name);
            else if (objectType === 'PACKAGE') entry.packages.push(name);
        }
        return result;
    }
}
