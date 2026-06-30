import { PARAM_TYPES } from './constants';

export function validatePascalCase(value: string): string | undefined {
	if (!value.trim()) return 'Value is required';
	if (!/^[A-Z][a-zA-Z0-9]*$/.test(value)) return 'Must be PascalCase (e.g. Product)';
	return undefined;
}

export function validateProjectName(value: string): string | undefined {
	if (!value.trim()) return 'Project name is required';
	if (!/^[a-zA-Z0-9._-]+$/.test(value)) return 'Invalid project name';
	return undefined;
}

export function validateNameTypeInput(value: string): string | undefined {
	if (!value.trim()) return undefined;
	const parts = value.trim().split(':');
	if (parts.length !== 2) return 'Format: name:Type (e.g. categoriaId:Guid)';
	const [, type] = parts;
	if (!(PARAM_TYPES as readonly string[]).includes(type)) {
		return `Unknown type "${type}". Valid: ${PARAM_TYPES.join(', ')}`;
	}
	return undefined;
}
