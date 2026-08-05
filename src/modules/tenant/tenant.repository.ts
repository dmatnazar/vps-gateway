import crypto from 'node:crypto';
import { getDb } from '../../store/db';
import type { TenantRecord, EndpointConfig, TenantConnectionRecord } from '../../types/contracts';

export const tenantRepository = {
  async findBySlug(slug: string): Promise<TenantRecord | undefined> {
    const db = await getDb();
    return db.data.tenants.find((t) => t.slug === slug);
  },

  async create(input: {
    slug: string;
    name: string;
    dbConnEnc: string;
    dbConnIv: string;
  }): Promise<TenantRecord> {
    const db = await getDb();
    const now = new Date().toISOString();
    const tenant: TenantRecord = {
      id: crypto.randomUUID(),
      slug: input.slug,
      name: input.name,
      dbConnEnc: input.dbConnEnc,
      dbConnIv: input.dbConnIv,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    db.data.tenants.push(tenant);
    await db.write();
    return tenant;
  },

  async replaceConnections(tenantId: string, connections: TenantConnectionRecord[]) {
    const db = await getDb();
    const tenant = db.data.tenants.find((t) => t.id === tenantId);
    if (!tenant) return;
    tenant.connections = connections;
    tenant.updatedAt = new Date().toISOString();
    await db.write();
  },

  async updateConnection(tenantId: string, enc: string, iv: string) {
    const db = await getDb();
    const tenant = db.data.tenants.find((t) => t.id === tenantId);
    if (!tenant) return;
    tenant.dbConnEnc = enc;
    tenant.dbConnIv = iv;
    tenant.updatedAt = new Date().toISOString();
    await db.write();
  },

  async replaceEndpoints(tenantId: string, endpoints: Omit<EndpointConfig, 'tenantSlug'>[]) {
    const db = await getDb();
    const tenant = db.data.tenants.find((t) => t.id === tenantId);
    if (!tenant) return;

    db.data.endpoints = db.data.endpoints.filter((e) => (e as any).tenantId !== tenantId);
    for (const ep of endpoints) {
      db.data.endpoints.push({
        ...ep,
        tenantSlug: tenant.slug,
        id: crypto.randomUUID(),
        // @ts-expect-error - extra field for filtering by tenant
        tenantId,
      });
    }
    await db.write();
  },

  async listAll(): Promise<TenantRecord[]> {
    const db = await getDb();
    return db.data.tenants;
  },

  /**
   * Ähli saklanan endpoint-ler.
   * app.ts bootstrapRoutes() bu bilen routeRegistry-ni doldurýar.
   */
  async listAllEndpoints(): Promise<(EndpointConfig & { id?: string; tenantId?: string })[]> {
    const db = await getDb();
    return db.data.endpoints ?? [];
  },
};
