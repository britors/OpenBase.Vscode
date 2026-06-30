export function escapeCliQuotedValue(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
