"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.routeRegistry = void 0;
function normalizePath(path) {
    let p = (path || '/').trim();
    if (!p.startsWith('/'))
        p = `/${p}`;
    // collapse multiple slashes, strip trailing slash (except root)
    p = p.replace(/\/+/g, '/');
    if (p.length > 1 && p.endsWith('/'))
        p = p.slice(0, -1);
    return p;
}
class RouteRegistry {
    routes = new Map();
    byTenant = new Map();
    key(tenantSlug, method, pathTemplate, dbKey) {
        return `${tenantSlug}:${dbKey || 'default'}:${method.toUpperCase()}:${normalizePath(pathTemplate)}`;
    }
    upsert(tenantSlug, endpoint) {
        const normalized = {
            ...endpoint,
            pathTemplate: normalizePath(endpoint.pathTemplate),
            dbKey: endpoint.dbKey || 'primary',
        };
        const k = this.key(tenantSlug, normalized.method, normalized.pathTemplate, normalized.dbKey);
        this.routes.set(k, normalized);
        if (!this.byTenant.has(tenantSlug))
            this.byTenant.set(tenantSlug, new Set());
        this.byTenant.get(tenantSlug).add(k);
    }
    replaceTenantRoutes(tenantSlug, endpoints) {
        const existing = this.byTenant.get(tenantSlug);
        if (existing)
            existing.forEach((k) => this.routes.delete(k));
        this.byTenant.set(tenantSlug, new Set());
        endpoints.forEach((e) => this.upsert(tenantSlug, e));
    }
    resolve(tenantSlug, method, pathname, dbKey) {
        const tenantKeys = this.byTenant.get(tenantSlug);
        if (!tenantKeys)
            return null;
        const actual = normalizePath(pathname);
        for (const k of tenantKeys) {
            const endpoint = this.routes.get(k);
            if (endpoint.method.toUpperCase() !== method.toUpperCase())
                continue;
            if (dbKey && endpoint.dbKey && endpoint.dbKey !== dbKey)
                continue;
            if (!dbKey && endpoint.dbKey && endpoint.dbKey !== 'default' && endpoint.dbKey !== 'primary') {
                continue;
            }
            const match = matchTemplate(endpoint.pathTemplate, actual);
            if (match)
                return { endpoint, params: match };
        }
        return null;
    }
    debugAll() {
        return Array.from(this.routes.entries()).map(([k, v]) => ({
            key: k,
            method: v.method,
            pathTemplate: v.pathTemplate,
            dbKey: v.dbKey,
            name: v.name,
            authRequired: v.authRequired,
            tenantSlug: v.tenantSlug,
        }));
    }
}
function matchTemplate(template, actual) {
    const tParts = normalizePath(template).split('/').filter(Boolean);
    const aParts = normalizePath(actual).split('/').filter(Boolean);
    if (tParts.length !== aParts.length)
        return null;
    const params = {};
    for (let i = 0; i < tParts.length; i++) {
        if (tParts[i].startsWith(':')) {
            params[tParts[i].slice(1)] = decodeURIComponent(aParts[i]);
        }
        else if (tParts[i].toLowerCase() !== aParts[i].toLowerCase()) {
            return null;
        }
    }
    return params;
}
exports.routeRegistry = new RouteRegistry();
//# sourceMappingURL=routeRegistry.js.map