import sql from 'mssql';
import { decryptConnString } from './crypto';
import { tenantRepository } from '../../modules/tenant/tenant.repository';

const pools = new Map<string, sql.ConnectionPool>();

export async function getTenantPool(tenantSlug: string): Promise<sql.ConnectionPool> {
  const existing = pools.get(tenantSlug);
  if (existing?.connected) return existing;

  const tenant = await tenantRepository.findBySlug(tenantSlug);
  if (!tenant || !tenant.isActive) {
    throw new Error(`Unknown or inactive tenant: ${tenantSlug}`);
  }

  const connString = decryptConnString(tenant.dbConnEnc, tenant.dbConnIv);
  const pool = new sql.ConnectionPool(connString);
  await pool.connect();
  pools.set(tenantSlug, pool);
  return pool;
}

/** Call after a tenant's connection string changes via sync, to force a fresh pool */
export function invalidateTenantPool(tenantSlug: string) {
  const pool = pools.get(tenantSlug);
  if (pool) {
    pool.close().catch(() => {});
    pools.delete(tenantSlug);
  }
}
