import { JSONFilePreset } from 'lowdb/node';
import path from 'node:path';
import fs from 'node:fs';
import { env } from '../config/env';
import type {
  TenantRecord,
  ApiKeyRecord,
  EndpointConfig,
  StaffRecord,
  RegistrationRecord,
  UserNotification,
} from '../types/contracts';

interface DbSchema {
  tenants: TenantRecord[];
  endpoints: (EndpointConfig & { id: string })[];
  apiKeys: ApiKeyRecord[];
  staff: StaffRecord[];
  registrations: RegistrationRecord[];
  notifications: UserNotification[];
}

const defaultData: DbSchema = {
  tenants: [],
  endpoints: [],
  apiKeys: [],
  staff: [],
  registrations: [],
  notifications: [],
};

const dbDir = path.dirname(env.DB_FILE);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

let dbInstance: Awaited<ReturnType<typeof JSONFilePreset<DbSchema>>> | null = null;

export async function getDb() {
  if (!dbInstance) {
    dbInstance = await JSONFilePreset<DbSchema>(env.DB_FILE, defaultData);
    // migrate older files missing new collections
    const d = dbInstance.data as any;
    if (!Array.isArray(d.staff)) d.staff = [];
    if (!Array.isArray(d.registrations)) d.registrations = [];
    if (!Array.isArray(d.notifications)) d.notifications = [];
    await dbInstance.write();
  }
  return dbInstance;
}
