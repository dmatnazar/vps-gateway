export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface ParamDef {
  name: string;
  sqlParam: string;
  type: 'int' | 'bigint' | 'date' | 'datetime' | 'nvarchar' | 'bit' | 'float';
  required: boolean;
  default?: unknown;
}

export interface ParamsSchema {
  urlParams: ParamDef[];
  queryParams: ParamDef[];
  bodyParams: ParamDef[];
}

export interface ResponseSchema {
  [key: string]: unknown;
}

export interface EndpointConfig {
  tenantSlug: string;
  name: string;
  method: HttpMethod;
  pathTemplate: string;
  sqlQuery: string;
  paramsSchema: ParamsSchema;
  responseSchema?: ResponseSchema;
  cacheTtlSec: number;
  authRequired: boolean;
  /** Which DB connection key under the tenant (e.g. "primary", "companydb") */
  dbKey?: string;
}

export interface TenantConnectionRecord {
  dbKey: string;
  label: string;
  database?: string;
  dbConnEnc: string;
  dbConnIv: string;
}

export interface TenantRecord {
  id: string;
  slug: string;
  name: string;
  /** Legacy single connection (kept as primary fallback) */
  dbConnEnc: string;
  dbConnIv: string;
  /** Optional multi-connection list */
  connections?: TenantConnectionRecord[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  keyHash: string;
  label: string;
  scopes: string[];
  revoked: boolean;
  createdAt: string;
}
