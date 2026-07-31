export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface ParamDef {
  name: string;
  sqlParam: string; // e.g. "@branchID"
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
  pathTemplate: string; // e.g. "/branches/:branchId/sales"
  sqlQuery: string;
  paramsSchema: ParamsSchema;
  responseSchema?: ResponseSchema;
  cacheTtlSec: number;
  authRequired: boolean;
}

export interface TenantRecord {
  id: string;
  slug: string;
  name: string;
  dbConnEnc: string;
  dbConnIv: string;
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
