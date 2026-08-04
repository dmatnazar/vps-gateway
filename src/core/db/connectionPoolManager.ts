import sql from 'mssql';
import { decryptConnString } from './crypto';
import { tenantRepository } from '../../modules/tenant/tenant.repository';

const pools = new Map<string, sql.ConnectionPool>();

function poolKey(tenantSlug: string, dbKey?: string) {
  return dbKey ? `${tenantSlug}::${dbKey}` : tenantSlug;
}

/**
 * Resolve connection string for tenant + optional dbKey.
 * Falls back to tenant primary connection if dbKey missing or not found.
 */
async function resolveConnString(tenantSlug: string, dbKey?: string): Promise<string> {
  const tenant = await tenantRepository.findBySlug(tenantSlug);
  if (!tenant || !tenant.isActive) {
    throw new Error(`Unknown or inactive tenant: ${tenantSlug}`);
  }

  if (dbKey && tenant.connections?.length) {
    const conn = tenant.connections.find((c) => c.dbKey === dbKey);
    if (conn) {
      return decryptConnString(conn.dbConnEnc, conn.dbConnIv);
    }
    // soft fallback to primary if key unknown
  }

  return decryptConnString(tenant.dbConnEnc, tenant.dbConnIv);
}

export async function getTenantPool(
  tenantSlug: string,
  dbKey?: string
): Promise<sql.ConnectionPool> {
  const key = poolKey(tenantSlug, dbKey);
  const existing = pools.get(key);
  if (existing?.connected) return existing;

  const connString = await resolveConnString(tenantSlug, dbKey);
  const pool = new sql.ConnectionPool(connString);
  await pool.connect();
  pools.set(key, pool);
  return pool;
}

export function invalidateTenantPool(tenantSlug: string, dbKey?: string) {
  if (dbKey) {
    const key = poolKey(tenantSlug, dbKey);
    const pool = pools.get(key);
    if (pool) {
      pool.close().catch(() => {});
      pools.delete(key);
    }
    return;
  }
  // invalidate all pools for this tenant
  for (const [k, pool] of pools.entries()) {
    if (k === tenantSlug || k.startsWith(`${tenantSlug}::`)) {
      pool.close().catch(() => {});
      pools.delete(k);
    }
  }
}
