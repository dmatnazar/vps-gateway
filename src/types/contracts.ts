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

/** Staff synced from Electron admin apps → used by BI Platform login */
export type StaffRole = 'admin' | 'editor' | 'viewer';

export interface StaffRecord {
  id: string;
  /** tenant slug this staff belongs to (primary company) */
  tenantSlug: string;
  /** additional tenant slugs the staff can access */
  tenantSlugs: string[];
  fullName: string;
  username: string;
  /** Electron scrypt format: "saltHex:hashHex" */
  passwordHash: string;
  /** Optional AES-encrypted plain password for admin UI reveal */
  passwordEnc?: string;
  role: StaffRole;
  phone?: string;
  email?: string;
  active: boolean;
  updatedAt: string;
  createdAt: string;
}

export type RegistrationStatus = 'pending' | 'approved' | 'rejected';

/** Registration created by BI Platform, reviewed by Electron (or BI admin) */
export interface RegistrationRecord {
  id: string;
  tenantSlug: string;
  tenantName: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  username: string;
  /** bcrypt or scrypt hash from BI */
  passwordHash: string;
  status: RegistrationStatus;
  requestedRole?: StaffRole;
  reviewedBy?: string;
  reviewedAt?: string;
  note?: string;
  /** set when an Electron instance first fetches this registration */
  deliveredAt?: string;
  createdAt: string;
}

/** Simple user-facing notification (approve/reject) */
export interface UserNotification {
  id: string;
  username: string;
  type: 'registration_approved' | 'registration_rejected';
  title: string;
  message: string;
  read: boolean;
  createdAt: string;
}
