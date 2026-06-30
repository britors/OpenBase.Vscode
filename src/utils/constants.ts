export const DB_TEMPLATES = [
  'sqlserver',
  'pgsql',
  'oracle'
] as const;

export const BUILD_CONFIGS = [
  'Debug',
  'Release'
] as const;

export const EXTENSIONS = [
  'jwt',
  'redis',
  'healthchecks',
  'mongodb',
  'domainevents'
] as const;

export const PARAM_TYPES = [
  'string',
  'int',
  'bool',
  'decimal',
  'Guid',
  'DateTime',
  'long',
  'double',
  'float',
  'short'
] as const;