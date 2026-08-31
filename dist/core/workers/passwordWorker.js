"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyPasswordSync = verifyPasswordSync;
exports.verifyPasswordAsync = verifyPasswordAsync;
const node_worker_threads_1 = require("node:worker_threads");
const node_crypto_1 = __importDefault(require("node:crypto"));
const workerCode = `
const { parentPort } = require('worker_threads');
const crypto = require('crypto');
parentPort.on('message', ({ id, plain, stored }) => {
  try {
    if (!stored) { parentPort.postMessage({ id, ok: false }); return; }
    if (stored.includes(':') && !stored.startsWith('$')) {
      const [saltHex, hashHex] = stored.split(':');
      if (!saltHex || !hashHex) { parentPort.postMessage({ id, ok: false }); return; }
      let candidate = crypto.scryptSync(plain, saltHex, 64).toString('hex');
      if (candidate !== hashHex) candidate = crypto.scryptSync(plain, Buffer.from(saltHex, 'hex'), 64).toString('hex');
      const a = Buffer.from(candidate, 'hex');
      const b = Buffer.from(hashHex, 'hex');
      parentPort.postMessage({ id, ok: a.length === b.length && crypto.timingSafeEqual(a, b) });
      return;
    }
    parentPort.postMessage({ id, ok: null, needsBcrypt: true, plain, stored });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: String(e) });
  }
});
`;
let worker = null;
let seq = 0;
const pending = new Map();
function getWorker() {
    try {
        if (worker)
            return worker;
        worker = new node_worker_threads_1.Worker(workerCode, { eval: true });
        worker.on('message', (msg) => {
            const p = pending.get(msg.id);
            if (!p)
                return;
            pending.delete(msg.id);
            if (msg.needsBcrypt && msg.plain && msg.stored) {
                try {
                    const bcrypt = require('bcryptjs');
                    p.resolve(bcrypt.compareSync(msg.plain, msg.stored));
                }
                catch {
                    p.resolve(false);
                }
                return;
            }
            p.resolve(Boolean(msg.ok));
        });
        worker.on('error', () => { worker = null; });
        return worker;
    }
    catch {
        return null;
    }
}
function verifyPasswordSync(plain, stored) {
    if (!stored || !plain)
        return false;
    // Electron scrypt: "saltHex:hashHex"
    if (stored.includes(':') && !stored.startsWith('$')) {
        const [saltHex, hashHex] = stored.split(':');
        if (!saltHex || !hashHex)
            return false;
        try {
            // 1) salt as UTF-8 string (Electron staff:hashPassword)
            let candidate = node_crypto_1.default.scryptSync(plain, saltHex, 64).toString('hex');
            if (candidate === hashHex)
                return true;
            // 2) salt as binary from hex
            candidate = node_crypto_1.default.scryptSync(plain, Buffer.from(saltHex, 'hex'), 64).toString('hex');
            return candidate === hashHex;
        }
        catch {
            return false;
        }
    }
    // BI bcrypt ($2a$ / $2b$ / $2y$) — requires bcryptjs package
    if (stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$')) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const bcrypt = require('bcryptjs');
            return bcrypt.compareSync(plain, stored);
        }
        catch (e) {
            console.error('[passwordWorker] bcryptjs missing — BI passwords will fail. Run: npm install bcryptjs', e);
            return false;
        }
    }
    return stored === plain;
}
function verifyPasswordAsync(plain, stored) {
    const w = getWorker();
    if (!w)
        return Promise.resolve(verifyPasswordSync(plain, stored));
    const id = ++seq;
    return new Promise((resolve) => {
        pending.set(id, { resolve });
        w.postMessage({ id, plain, stored });
        setTimeout(() => {
            if (pending.has(id)) {
                pending.delete(id);
                resolve(verifyPasswordSync(plain, stored));
            }
        }, 3000);
    });
}
//# sourceMappingURL=passwordWorker.js.map