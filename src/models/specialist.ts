import { PARAM_TYPES } from '../utils/constants';

export type SpecialistParamType = typeof PARAM_TYPES[number];

export interface SpecialistInput {
	entity: string;
	method: string;
	type: 'query' | 'command' | 'httpcall';
	sql: string;
	params: string[];
	columns: string[];
}
