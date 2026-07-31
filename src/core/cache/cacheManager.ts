/**
 * Simple in-memory TTL cache. Swap the implementation for ioredis in
 * production by implementing the same get/set interface against Redis —
 * the rest of the codebase doesn't need to change.
 */
interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

class CacheManager {
  private store = new Map<string, CacheEntry>();

  async get(key: string): Promise<unknown | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: unknown, ttlSec: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
  }

  async clear() {
    this.store.clear();
  }
}

export const cacheManager = new CacheManager();
