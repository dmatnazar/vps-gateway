import type { FastifyRequest } from 'fastify';
import sql from 'mssql';
import type { EndpointConfig } from '../../types/contracts';

const TYPE_MAP: Record<string, () => any> = {
  int: () => sql.Int,
  bigint: () => sql.BigInt,
  date: () => sql.Date,
  datetime: () => sql.DateTime,
  nvarchar: () => sql.NVarChar,
  bit: () => sql.Bit,
  float: () => sql.Float,
};

export class MissingParamError extends Error {
  constructor(param: string) {
    super(`Missing required parameter: ${param}`);
    this.name = 'MissingParamError';
  }
}

/**
 * Binds URL / query / body params onto a mssql.Request using typed,
 * parameterized inputs. Values are NEVER string-concatenated into SQL —
 * this is what prevents SQL injection.
 */
export function bindParams(
  sqlRequest: sql.Request,
  endpoint: EndpointConfig,
  routeParams: Record<string, string>,
  req: FastifyRequest
) {
  const defs = [
    ...endpoint.paramsSchema.urlParams.map((p) => ({ ...p, source: routeParams })),
    ...endpoint.paramsSchema.queryParams.map((p) => ({
      ...p,
      source: (req.query ?? {}) as Record<string, string>,
    })),
    ...endpoint.paramsSchema.bodyParams.map((p) => ({
      ...p,
      source: (req.body ?? {}) as Record<string, string>,
    })),
  ];

  for (const def of defs) {
    const raw = def.source?.[def.name];
    const value = raw ?? def.default ?? null;

    if (def.required && (value === null || value === undefined)) {
      throw new MissingParamError(def.name);
    }

    const sqlType = TYPE_MAP[def.type]?.() ?? sql.NVarChar;
    sqlRequest.input(def.sqlParam.replace('@', ''), sqlType, value);
  }
}
