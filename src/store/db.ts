import { JSONFilePreset } from 'lowdb/node';
import path from 'node:path';
import fs from 'node:fs';
import { env } from '../config/env';
import type { TenantRecord, ApiKeyRecord, EndpointConfig } from '../types/contracts';

interface DbSchema {
  tenants: TenantRecord[];
  endpoints: (EndpointConfig & { id: string })[];
  apiKeys: ApiKeyRecord[];
}

const defaultData: DbSchema = { tenants: [], endpoints: [], apiKeys: [] };

const dbDir = path.dirname(env.DB_FILE);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

let dbInstance: Awaited<ReturnType<typeof JSONFilePreset<DbSchema>>> | null = null;

export async function getDb() {
  if (!dbInstance) {
    dbInstance = await JSONFilePreset<DbSchema>(env.DB_FILE, defaultData);
  }
  return dbInstance;
}
