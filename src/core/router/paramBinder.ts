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

/**
 * Binds URL / query / body params onto a mssql.Request.
 * Values are NEVER concatenated into SQL — parameterized only.
 *
 * Lookup order for each param:
 *  1) def.name (API param name, e.g. beginDate)
 *  2) sqlParam without @ (e.g. beginDate from @beginDate)
 *  3) def.default
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

    // Skip unbound optional params (null) so SQL can use its own defaults if any
    if (value === null || value === undefined) continue;

    const sqlType = TYPE_MAP[def.type]?.() ?? sql.NVarChar(sql.MAX);

    // Coerce common types
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
