import type { FastifyRequest } from 'fastify';
import sql from 'mssql';
import type { EndpointConfig } from '../../types/contracts';

const TYPE_MAP: Record<string, () => any> = {
  int: () => sql.Int,
  bigint: () => sql.BigInt,
  date: () => sql.Date,
  datetime: () => sql.DateTime,
  nvarchar: () => sql.NVarChar(sql.MAX),
  bit: () => sql.Bit,
  float: () => sql.Float,
};

export class MissingParamError extends Error {
  constructor(param: string) {
    super(`Missing required parameter: ${param}`);
    this.name = 'MissingParamError';
  }
}

/** Case-insensitive lookup in an object (query/body keys vary in case) */
function pick(source: Record<string, unknown> | undefined, ...keys: string[]): unknown {
  if (!source) return undefined;
  const lowerMap = new Map<string, unknown>();
  for (const [k, v] of Object.entries(source)) {
    lowerMap.set(k.toLowerCase(), v);
  }
  for (const key of keys) {
    if (!key) continue;
    const v = lowerMap.get(key.toLowerCase());
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

const BEGIN_NAME_RE = /begin|start|from|datefrom/i;
const END_NAME_RE = /end|gutar|dateto|until/i;
const DATE_NAME_RE = /date|sene|time|wagty/i;
const DATE_VALUE_RE = /^\d{4}-\d{2}-\d{2}/;

/**
 * Force wall-clock local datetime string — never JS Date (UTC shift).
 * begin* → YYYY-MM-DD 00:00:00
 * end*   → YYYY-MM-DD 23:59:59
 * other date-like → keep time if present, else 00:00:00
 */
function forceLocalDateTimeString(
  raw: unknown,
  sqlName: string,
  apiName: string,
  declaredType?: string
): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  let s = String(raw).trim();
  s = s.replace(/T/g, ' ').replace(/Z$/i, '').replace(/\.\d{1,3}$/, '');

  const m = s.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[\s]+(\d{2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (!m) return s;

  let y = Number(m[1]);
  let mo = Number(m[2]);
  let d = Number(m[3]);
  let hh = m[4] != null ? Number(m[4]) : null;
  let mi = m[5] != null ? Number(m[5]) : 0;
  let ss = m[6] != null ? Number(m[6]) : 0;
  const name = `${sqlName} ${apiName}`;

  /**
   * Recover UTC-shifted local-midnight values:
   *   local 00:00 +05 → stored/sent as previous day 19:00
   *   local 23:59 +05 → same day 18:59
   * If we see begin with hour 18-20, bump to next calendar day 00:00:00.
   * If we see end with hour 18-20 and min 59, use that calendar day 23:59:59
   *   (already correct day for end-of-day UTC shift of 23:59).
   */
  if (BEGIN_NAME_RE.test(name)) {
    if (hh != null && hh >= 18 && hh <= 20) {
      // treat as UTC instant of local midnight → next local day
      const dt = new Date(Date.UTC(y, mo - 1, d, hh, mi, ss));
      // add typical TM offset 5h to land on local midnight calendar day
      dt.setUTCHours(dt.getUTCHours() + 5);
      y = dt.getUTCFullYear();
      mo = dt.getUTCMonth() + 1;
      d = dt.getUTCDate();
    }
    const date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return `${date} 00:00:00`;
  }

  if (END_NAME_RE.test(name)) {
    if (hh != null && hh >= 18 && hh <= 20) {
      // 18:59 UTC ≈ 23:59 local +05 → keep same calendar day
      // already correct date part for end-of-day
    }
    const date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return `${date} 23:59:59`;
  }

  const date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (declaredType === 'date') return date;
  if (declaredType === 'datetime' || DATE_NAME_RE.test(name) || DATE_VALUE_RE.test(s)) {
    if (hh == null) return `${date} 00:00:00`;
    return `${date} ${String(hh).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }
  return s;
}

/**
 * Binds URL / query / body params onto a mssql.Request.
 * Values are NEVER concatenated into SQL — parameterized only.
 *
 * Date/datetime: ALWAYS bound as NVarChar string with local wall-clock
 * so node-mssql never applies UTC conversion.
 */
export function bindParams(
  sqlRequest: sql.Request,
  endpoint: EndpointConfig,
  routeParams: Record<string, string>,
  req: FastifyRequest
) {
  const query = (req.query ?? {}) as Record<string, unknown>;
  const body = (req.body ?? {}) as Record<string, unknown>;

  const defs = [
    ...endpoint.paramsSchema.urlParams.map((p) => ({ ...p, source: 'url' as const })),
    ...endpoint.paramsSchema.queryParams.map((p) => ({ ...p, source: 'query' as const })),
    ...endpoint.paramsSchema.bodyParams.map((p) => ({ ...p, source: 'body' as const })),
  ];

  for (const def of defs) {
    const sqlName = (def.sqlParam || def.name || '').replace(/^@/, '');
    const apiName = def.name || sqlName;

    let raw: unknown;
    if (def.source === 'url') {
      raw = pick(routeParams, apiName, sqlName);
    } else if (def.source === 'query') {
      raw = pick(query, apiName, sqlName);
    } else {
      raw = pick(body, apiName, sqlName);
    }

    const value = raw !== undefined ? raw : def.default ?? null;

    if (def.required && (value === null || value === undefined || value === '')) {
      throw new MissingParamError(apiName || sqlName || def.sqlParam);
    }

    if (!sqlName) continue;

    const sqlType = TYPE_MAP[def.type]?.() ?? sql.NVarChar(sql.MAX);

    // Boş / null → SQL NULL
    if (value === null || value === undefined || value === '') {
      sqlRequest.input(sqlName, sqlType, null);
      continue;
    }

    const rawStr = String(value);
    const isMulti =
      rawStr.includes(',') &&
      rawStr.split(',').filter((s) => s.trim() !== '').length > 1 &&
      !DATE_VALUE_RE.test(rawStr.trim());

    if (isMulti) {
      const parts = rawStr
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      sqlRequest.input(sqlName, sql.NVarChar(sql.MAX), parts.join(','));
      continue;
    }

    // ---- DATE / DATETIME: bind as plain string, never JS Date ----
    const looksLikeDate =
      def.type === 'date' ||
      def.type === 'datetime' ||
      DATE_VALUE_RE.test(rawStr.trim()) ||
      BEGIN_NAME_RE.test(sqlName) ||
      BEGIN_NAME_RE.test(apiName) ||
      END_NAME_RE.test(sqlName) ||
      END_NAME_RE.test(apiName);

    if (looksLikeDate) {
      const normalized = forceLocalDateTimeString(value, sqlName, apiName, def.type);
      // Always NVarChar — SQL Server casts to datetime without timezone shift
      sqlRequest.input(sqlName, sql.NVarChar(30), normalized);
      continue;
    }

    let coerced: unknown = value;
    if (def.type === 'int' || def.type === 'bigint') {
      coerced = typeof value === 'number' ? value : parseInt(String(value), 10);
    } else if (def.type === 'float') {
      coerced = typeof value === 'number' ? value : parseFloat(String(value));
    } else if (def.type === 'bit') {
      const s = String(value).toLowerCase();
      coerced = s === '1' || s === 'true' || s === 'yes';
    }

    sqlRequest.input(sqlName, sqlType, coerced);
  }
}
