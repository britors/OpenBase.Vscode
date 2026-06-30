import { DbTemplate } from '../models/dbTemplate';

export function dbTemplateLabel(template: DbTemplate): string {
	switch (template) {
		case 'sqlserver': return 'SQL Server';
		case 'pgsql': return 'PostgreSQL';
		case 'oracle': return 'Oracle';
	}
}

export function extensionLabel(extension: string): string {
	switch (extension) {
		case 'jwt': return 'JWT Authentication';
		case 'redis': return 'Redis';
		case 'healthchecks': return 'Health Checks';
		case 'mongodb': return 'MongoDB';
		case 'domainevents': return 'Domain Events';
		default: return extension;
	}
}
