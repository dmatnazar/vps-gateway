import type { EndpointConfig } from '../../types/contracts';

type RouteKey = string;

function normalizePath(path: string): string {
  let p = (path || '/').trim();
  if (!p.startsWith('/')) p = `/${p}`;
  // collapse multiple slashes, strip trailing slash (except root)
  p = p.replace(/\/+/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

class RouteRegistry {
  private routes = new Map<RouteKey, EndpointConfig>();
  private byTenant = new Map<string, Set<RouteKey>>();

  private key(tenantSlug: string, method: string, pathTemplate: string, dbKey?: string): RouteKey {
    const dk = (dbKey || 'primary').toLowerCase();
    return `${tenantSlug}:${dk}:${method.toUpperCase()}:${normalizePath(pathTemplate)}`;
  }

  upsert(tenantSlug: string, endpoint: EndpointConfig) {
    const normalized = {
      ...endpoint,
      pathTemplate: normalizePath(endpoint.pathTemplate),
      dbKey: (endpoint.dbKey || 'primary').toLowerCase(),
      method: (endpoint.method || 'GET').toUpperCase() as any,
    };
    const k = this.key(tenantSlug, normalized.method, normalized.pathTemplate, normalized.dbKey);
    this.routes.set(k, normalized);
    if (!this.byTenant.has(tenantSlug)) this.byTenant.set(tenantSlug, new Set());
    this.byTenant.get(tenantSlug)!.add(k);
  }

  replaceTenantRoutes(tenantSlug: string, endpoints: EndpointConfig[]) {
    const existing = this.byTenant.get(tenantSlug);
    if (existing) existing.forEach((k) => this.routes.delete(k));
    this.byTenant.set(tenantSlug, new Set());
    endpoints.forEach((e) => this.upsert(tenantSlug, e));
  }

  resolve(
    tenantSlug: string,
    method: string,
    pathname: string,
    dbKey?: string
  ): { endpoint: EndpointConfig; params: Record<string, string> } | null {
    const tenantKeys = this.byTenant.get(tenantSlug);
    if (!tenantKeys) return null;

    const actual = normalizePath(pathname);

    for (const k of tenantKeys) {
      const endpoint = this.routes.get(k)!;
      if (endpoint.method.toUpperCase() !== method.toUpperCase()) continue;

      const epKey = (endpoint.dbKey || 'primary').toLowerCase();
      if (dbKey && epKey && epKey !== dbKey.toLowerCase()) continue;
      // when no dbKey in URL, accept primary/default only
      if (!dbKey && epKey && epKey !== 'default' && epKey !== 'primary') {
        continue;
      }

      const match = matchTemplate(endpoint.pathTemplate, actual);
      if (match) return { endpoint, params: match };
    }

    // Fallback: ignore dbKey mismatch (some clients use wrong dbKey label)
    if (dbKey) {
      for (const k of tenantKeys) {
        const endpoint = this.routes.get(k)!;
        if (endpoint.method.toUpperCase() !== method.toUpperCase()) continue;
        const match = matchTemplate(endpoint.pathTemplate, actual);
        if (match) return { endpoint, params: match };
      }
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

function matchTemplate(template: string, actual: string): Record<string, string> | null {
  const tParts = normalizePath(template).split('/').filter(Boolean);
  const aParts = normalizePath(actual).split('/').filter(Boolean);
  if (tParts.length !== aParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < tParts.length; i++) {
    if (tParts[i].startsWith(':')) {
      params[tParts[i].slice(1)] = decodeURIComponent(aParts[i]);
    } else if (tParts[i].toLowerCase() !== aParts[i].toLowerCase()) {
      return null;
    }
  }
  return params;
}

export const routeRegistry = new RouteRegistry();
