import { DbConnection } from '../models/dbConnection';

export interface SqlQueryResult {
	columns: string[];
	rows: string[][];
	message?: string;
}

export interface ExplainNode {
	op: string;
	detail: string;
	cost: number;
	rows: number;
	children: ExplainNode[];
}

export class SqlRunnerService {
	parseSqlOutput(raw: string, type: DbConnection['type']): SqlQueryResult {
		const lines = raw.split('\n').map((l) => l.trimEnd()).filter(Boolean);

		if (type === 'pgsql') {
			if (!lines.length) return { columns: [], rows: [] };
			const nonTable = lines.find((l) => /^(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|DO)\b/i.test(l));
			if (nonTable) return { columns: [], rows: [], message: lines.join('\n') };

			const parseCSV = (line: string): string[] => {
				const res: string[] = [];
				let cur = '';
				let inQ = false;
				for (const ch of line) {
					if (ch === '"') { inQ = !inQ; continue; }
					if (ch === ',' && !inQ) { res.push(cur); cur = ''; continue; }
					cur += ch;
				}
				res.push(cur);
				return res;
			};

			const [header, ...rest] = lines;
			return { columns: parseCSV(header), rows: rest.map(parseCSV) };
		}

		if (type === 'sqlserver') {
			const affected = lines.find((l) => /^\(\d+ rows? affected\)/i.test(l));
			const dataLines = lines.filter((l) => !/^[-| ]+$/.test(l) && !/^\(\d+ rows? affected\)/i.test(l));
			if (!dataLines.length) return { columns: [], rows: [], message: affected ?? 'Command completed.' };
			const columns = dataLines[0].split('|').map((c) => c.trim()).filter(Boolean);
			const rows = dataLines.slice(1).map((l) => l.split('|').map((c) => c.trim()));
			return { columns, rows, message: affected };
		}

		const dataLines = lines.filter((l) => !/^[-]+$/.test(l) && !/^\d+ rows? selected/i.test(l) && !/^Disconnected/.test(l));
		if (!dataLines.length) return { columns: [], rows: [], message: lines.join('\n') };
		if (!dataLines[0].includes('|')) return { columns: [], rows: [], message: lines.join('\n') };
		const columns = dataLines[0].split('|').map((c) => c.trim()).filter(Boolean);
		const rows = dataLines.slice(1).map((l) => l.split('|').map((c) => c.trim()));
		return { columns, rows };
	}

	parseExplainPlan(output: string, dbType: string): ExplainNode {
		if (dbType === 'pgsql') return this.parsePgExplain(output);
		if (dbType === 'oracle') return this.parseOraclePlan(output);
		return this.parseSsTextPlan(output);
	}

	private pgPlanToNode(plan: Record<string, unknown>): ExplainNode {
		const nodeType = String(plan['Node Type'] ?? 'Unknown');
		const parts: string[] = [];
		if (plan['Relation Name']) parts.push(String(plan['Relation Name']));
		if (plan['Index Name']) parts.push(`idx:${plan['Index Name']}`);
		if (plan['Filter']) parts.push(`filter:${String(plan['Filter']).slice(0, 80)}`);
		if (plan['Join Filter']) parts.push(`join:${String(plan['Join Filter']).slice(0, 80)}`);

		const children: ExplainNode[] = [];
		if (Array.isArray(plan['Plans'])) {
			for (const child of plan['Plans'] as Record<string, unknown>[]) {
				children.push(this.pgPlanToNode(child));
			}
		}

		return {
			op: nodeType,
			detail: parts.join(' · '),
			cost: Number(plan['Total Cost'] ?? 0),
			rows: Number(plan['Plan Rows'] ?? 0),
			children,
		};
	}

	private parsePgExplain(output: string): ExplainNode {
		try {
			const s = output.trim();
			const start = s.indexOf('[');
			const end = s.lastIndexOf(']');
			if (start < 0 || end < 0) throw new Error('no json');
			const json = JSON.parse(s.slice(start, end + 1)) as Array<{ Plan: Record<string, unknown> }>;
			const plan = json[0]?.Plan;
			if (!plan) throw new Error('no plan');
			return this.pgPlanToNode(plan);
		} catch {
			return { op: 'Parse error', detail: output.slice(0, 300), cost: 0, rows: 0, children: [] };
		}
	}

	private parseSsTextPlan(output: string): ExplainNode {
		const nodeLines = output.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.includes('|--'));
		if (!nodeLines.length) {
			return { op: 'No plan', detail: output.replace(/\r?\n/g, ' ').slice(0, 200), cost: 0, rows: 0, children: [] };
		}

		const items = nodeLines.map((l) => {
			const idx = l.indexOf('|--');
			const level = Math.round(idx / 3);
			const text = l.slice(idx + 3).trim();
			const rowM = text.match(/EstimateRows[=\s]+([0-9.]+)/i);
			const opEnd = text.indexOf('(');
			return {
				level,
				op: opEnd > 0 ? text.slice(0, opEnd).trim() : text,
				detail: opEnd > 0 ? text.slice(opEnd + 1).replace(/\)$/, '').slice(0, 120) : '',
				cost: 0,
				rows: rowM ? Number(rowM[1]) : 0,
			};
		});

		const stack: Array<ExplainNode & { level: number }> = [];
		let root: (ExplainNode & { level: number }) | undefined;
		for (const item of items) {
			const node = { ...item, children: [] as ExplainNode[] };
			while (stack.length && stack[stack.length - 1].level >= item.level) stack.pop();
			if (!stack.length) root = node;
			else stack[stack.length - 1].children.push(node);
			stack.push(node);
		}

		return root ?? { op: 'No plan', detail: '', cost: 0, rows: 0, children: [] };
	}

	private parseOraclePlan(output: string): ExplainNode {
		const dataLines = output.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => /^\|\s*\d/.test(l));
		if (!dataLines.length) return { op: 'No plan', detail: output.slice(0, 200), cost: 0, rows: 0, children: [] };

		const items = dataLines.map((l) => {
			const cols = l.split('|').map((c) => c.trim()).filter((_, i) => i > 0);
			const rawOp = cols[1] ?? '';
			return {
				level: Math.floor((rawOp.length - rawOp.trimStart().length) / 2),
				op: rawOp.trim(),
				detail: cols[2] ?? '',
				cost: parseInt((cols[5] ?? '').replace(/\s*\(.*/, ''), 10) || 0,
				rows: parseInt(cols[3] ?? '0', 10) || 0,
			};
		});

		const stack: Array<ExplainNode & { level: number }> = [];
		let root: (ExplainNode & { level: number }) | undefined;
		for (const item of items) {
			const node = { ...item, children: [] as ExplainNode[] };
			while (stack.length && stack[stack.length - 1].level >= item.level) stack.pop();
			if (!stack.length) root = node;
			else stack[stack.length - 1].children.push(node);
			stack.push(node);
		}

		return root ?? { op: 'No plan', detail: '', cost: 0, rows: 0, children: [] };
	}
}
