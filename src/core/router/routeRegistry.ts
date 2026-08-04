import type { EndpointConfig } from '../../types/contracts';

type RouteKey = string;

class RouteRegistry {
  private routes = new Map<RouteKey, EndpointConfig>();
  private byTenant = new Map<string, Set<RouteKey>>();

  private key(tenantSlug: string, method: string, pathTemplate: string, dbKey?: string): RouteKey {
    return `${tenantSlug}:${dbKey || 'default'}:${method.toUpperCase()}:${pathTemplate}`;
  }

  upsert(tenantSlug: string, endpoint: EndpointConfig) {
    const k = this.key(tenantSlug, endpoint.method, endpoint.pathTemplate, endpoint.dbKey);
    this.routes.set(k, endpoint);
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

    for (const k of tenantKeys) {
      const endpoint = this.routes.get(k)!;
      if (endpoint.method.toUpperCase() !== method.toUpperCase()) continue;
      // Match dbKey: endpoint.dbKey optional → accepts any; if set must match
      if (dbKey && endpoint.dbKey && endpoint.dbKey !== dbKey) continue;
      if (!dbKey && endpoint.dbKey && endpoint.dbKey !== 'default' && endpoint.dbKey !== 'primary') {
        // request without dbKey only matches primary/default endpoints
        continue;
      }
      const match = matchTemplate(endpoint.pathTemplate, pathname);
      if (match) return { endpoint, params: match };
    }
    return null;
  }

  debugAll() {
    return Array.from(this.routes.entries()).map(([k, v]) => ({ key: k, ...v }));
  }
}

function matchTemplate(template: string, actual: string): Record<string, string> | null {
  const tParts = template.split('/').filter(Boolean);
  const aParts = actual.split('/').filter(Boolean);
  if (tParts.length !== aParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < tParts.length; i++) {
    if (tParts[i].startsWith(':')) {
      params[tParts[i].slice(1)] = decodeURIComponent(aParts[i]);
    } else if (tParts[i] !== aParts[i]) {
      return null;
    }
  }
  return params;
}

export const routeRegistry = new RouteRegistry();
