/**
 * Transforms raw MSSQL recordset rows into a custom nested JSON shape
 * as defined by an endpoint's `responseSchema`. Supports simple field
 * renaming/casting for a single-object root, plus grouped arrays.
 */
type Row = Record<string, unknown>;

export function mapResponse(rows: Row[], schema: any): unknown {
  if (!schema || !schema.root) return rows;

  // Grouped array mode: build an array of mapped objects
  if (schema.root.items?.fromArray) {
    return rows.map((row) => mapRow(row, schema.root.items.map));
  }

  const firstRow = rows[0] ?? {};
  return buildObject(schema.root, firstRow, rows);
}

function buildObject(node: any, row: Row, allRows: Row[]): unknown {
  const out: Record<string, unknown> = {};

  for (const key of Object.keys(node)) {
    const def = node[key];

    if (def.fromArray) {
      out[key] = allRows.map((r) => mapRow(r, def.map));
      continue;
    }

    if (def.from) {
      out[key] = castValue(row[def.from], def.cast);
      continue;
    }

    if (typeof def === 'object' && def !== null) {
      out[key] = buildObject(def, row, allRows);
    }
  }

  return out;
}

function mapRow(row: Row, map: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [outKey, sourceCol] of Object.entries(map)) {
    out[outKey] = row[sourceCol];
  }
  return out;
}

function castValue(value: unknown, cast?: string): unknown {
  if (value === undefined || value === null) return value;
  switch (cast) {
    case 'number':
      return Number(value);
    case 'string':
      return String(value);
    case 'boolean':
      return Boolean(value);
    default:
      return value;
  }
}
