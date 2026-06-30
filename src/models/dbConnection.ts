export interface DbConnection {
	type: 'sqlserver' | 'pgsql' | 'oracle';
	label: string;
	server: string;
	database: string;
	user?: string;
	password?: string;
	port?: string;
}
