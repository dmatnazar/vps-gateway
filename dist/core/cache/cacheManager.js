"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cacheManager = void 0;
class CacheManager {
    store = new Map();
    async get(key) {
        const entry = this.store.get(key);
        if (!entry)
            return null;
        if (Date.now() > entry.expiresAt) {
            this.store.delete(key);
            return null;
        }
        return entry.value;
    }
    async set(key, value, ttlSec) {
        this.store.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
    }
    async clear() {
        this.store.clear();
    }
}
exports.cacheManager = new CacheManager();
//# sourceMappingURL=cacheManager.js.map