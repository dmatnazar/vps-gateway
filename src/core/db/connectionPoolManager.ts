import sql from 'mssql';
import { decryptConnString } from './crypto';
import { tenantRepository } from '../../modules/tenant/tenant.repository';

const pools = new Map<string, sql.ConnectionPool>();

function poolKey(tenantSlug: string, dbKey?: string) {
  return dbKey ? `${tenantSlug}::${dbKey}` : tenantSlug;
}

/**
 * Parse ADO.NET-style connection string.
 * Handles Password={value;with;semicolons} braced form.
 */
export function parseConnectionString(connStr: string): {
  server: string;
  port: number;
  database?: string;
  user?: string;
  password?: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
} {
  const parts: Record<string, string> = {};
  // Split on ; but respect {...} blocks
  const segments: string[] = [];
  let buf = '';
  let inBrace = false;
  for (let i = 0; i < connStr.length; i++) {
    const ch = connStr[i];
    if (ch === '{') inBrace = true;
    if (ch === '}') inBrace = false;
    if (ch === ';' && !inBrace) {
      if (buf.trim()) segments.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) segments.push(buf);

  for (const segment of segments) {
    const idx = segment.indexOf('=');
    if (idx <= 0) continue;
    const key = segment.slice(0, idx).trim().toLowerCase();
    let val = segment.slice(idx + 1).trim();
    // Unwrap {braced} values
    if (val.startsWith('{') && val.endsWith('}')) {
      val = val.slice(1, -1);
    }
    if (key) parts[key] = val;
  }

  const serverRaw =
    parts['server'] ||
    parts['data source'] ||
    parts['addr'] ||
    parts['address'] ||
    parts['network address'] ||
    '';

  let host = serverRaw;
  let port = 1433;
  if (serverRaw.includes(',')) {
    const [h, p] = serverRaw.split(',');
    host = h.trim();
    const n = parseInt((p || '').trim(), 10);
    if (!Number.isNaN(n) && n > 0) port = n;
  } else if (parts['port']) {
    const n = parseInt(parts['port'], 10);
    if (!Number.isNaN(n) && n > 0) port = n;
  }

  const truthy = (v: string | undefined, defaultVal: boolean) => {
    if (v === undefined || v === '') return defaultVal;
    const s = v.toLowerCase();
    return s === 'true' || s === 'yes' || s === '1';
  };

  return {
    server: host,
    port,
    database: parts['database'] || parts['initial catalog'] || undefined,
    user: parts['user id'] || parts['uid'] || parts['user'] || undefined,
    password: parts['password'] || parts['pwd'] || undefined,
    // LAN SQL often breaks with encrypt=true → default false for private IPs later
    encrypt: truthy(parts['encrypt'], true),
    trustServerCertificate: truthy(parts['trustservercertificate'], true),
  };
}

function isPrivateIp(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  return false;
}

function buildConfig(
  parsed: ReturnType<typeof parseConnectionString>,
  overrides?: Partial<{ encrypt: boolean; trustServerCertificate: boolean }>
): sql.config {
  const encrypt = overrides?.encrypt ?? parsed.encrypt;
  const trust = overrides?.trustServerCertificate ?? parsed.trustServerCertificate;

  return {
    server: parsed.server,
    port: parsed.port,
    database: parsed.database,
    user: parsed.user,
    password: parsed.password,
    options: {
      encrypt,
      trustServerCertificate: trust,
      enableArithAbort: true,
      connectTimeout: 20000,
      // Avoid some TLS handshake hangs on older SQL Server
      cryptoCredentialsDetails: undefined,
    },
    connectionTimeout: 20000,
    requestTimeout: 60000,
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000,
    },
  };
}

function isTlsOrHangError(err: unknown): boolean {
  const msg = ((err as Error)?.message || String(err)).toLowerCase();
  return (
    msg.includes('socket hang up') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('timeout') ||
    msg.includes('cert') ||
    msg.includes('ssl') ||
    msg.includes('tls') ||
    msg.includes('handshake') ||
    msg.includes('self signed') ||
    msg.includes('failed to connect')
  );
}

async function tryConnect(config: sql.config): Promise<sql.ConnectionPool> {
  const pool = new sql.ConnectionPool(config);
  try {
    await pool.connect();
    return pool;
  } catch (err) {
    try {
      await pool.close();
    } catch {
      /* ignore */
    }
    throw err;
  }
}

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
  }

  return decryptConnString(tenant.dbConnEnc, tenant.dbConnIv);
}

/**
 * Connect like Electron admin does (structured config), with automatic
 * fallback: if TLS/hang fails on private LAN → retry encrypt=false.
 */
export async function getTenantPool(
  tenantSlug: string,
  dbKey?: string
): Promise<sql.ConnectionPool> {
  const key = poolKey(tenantSlug, dbKey);
  const existing = pools.get(key);
  if (existing?.connected) return existing;

  const connString = await resolveConnString(tenantSlug, dbKey);
  const parsed = parseConnectionString(connString);

  if (!parsed.server) {
    throw new Error('Connection string has no Server/host — re-sync from Admin with a valid connection');
  }

  const attempts: Array<{ label: string; encrypt: boolean; trust: boolean }> = [];

  // 1) As stored in connection string
  attempts.push({
    label: `stored(encrypt=${parsed.encrypt})`,
    encrypt: parsed.encrypt,
    trust: parsed.trustServerCertificate,
  });

  // 2) Private LAN: force encrypt=false (most common fix for socket hang up)
  if (isPrivateIp(parsed.server)) {
    attempts.push({ label: 'lan-no-encrypt', encrypt: false, trust: true });
  }

  // 3) encrypt=true + trust cert
  attempts.push({ label: 'encrypt+trust', encrypt: true, trust: true });

  // 4) encrypt=false always as last resort
  attempts.push({ label: 'no-encrypt', encrypt: false, trust: true });

  // Dedupe identical attempts
  const seen = new Set<string>();
  const unique = attempts.filter((a) => {
    const k = `${a.encrypt}:${a.trust}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const errors: string[] = [];

  for (const attempt of unique) {
    const config = buildConfig(parsed, {
      encrypt: attempt.encrypt,
      trustServerCertificate: attempt.trust,
    });
    try {
      // eslint-disable-next-line no-console
      console.log(
        `[mssql] try ${attempt.label} → ${config.server}:${config.port}/${config.database || '?'} user=${config.user || '?'}`
      );
      const pool = await tryConnect(config);
      // eslint-disable-next-line no-console
      console.log(`[mssql] OK with ${attempt.label}`);
      pools.set(key, pool);
      return pool;
    } catch (err) {
      const msg = (err as Error).message || String(err);
      errors.push(`${attempt.label}: ${msg}`);
      // eslint-disable-next-line no-console
      console.warn(`[mssql] fail ${attempt.label}: ${msg}`);
      if (!isTlsOrHangError(err) && unique.indexOf(attempt) === 0) {
        // Non-TLS error on first attempt (login failed etc.) — still try fallbacks once for hang cases
      }
    }
  }

  throw new Error(
    `MSSQL connect failed (${parsed.server}:${parsed.port}/${parsed.database || '?'}): ` +
      errors.map((e) => e).join(' | ')
  );
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
  for (const [k, pool] of pools.entries()) {
    if (k === tenantSlug || k.startsWith(`${tenantSlug}::`)) {
      pool.close().catch(() => {});
      pools.delete(k);
    }
  }
}
