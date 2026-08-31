"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mapResponse = mapResponse;
function mapResponse(rows, schema) {
    if (!schema || !schema.root)
        return rows;
    // Grouped array mode: build an array of mapped objects
    if (schema.root.items?.fromArray) {
        return rows.map((row) => mapRow(row, schema.root.items.map));
    }
    const firstRow = rows[0] ?? {};
    return buildObject(schema.root, firstRow, rows);
}
function buildObject(node, row, allRows) {
    const out = {};
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
function mapRow(row, map) {
    const out = {};
    for (const [outKey, sourceCol] of Object.entries(map)) {
        out[outKey] = row[sourceCol];
    }
    return out;
}
function castValue(value, cast) {
    if (value === undefined || value === null)
        return value;
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
//# sourceMappingURL=mapper.js.map