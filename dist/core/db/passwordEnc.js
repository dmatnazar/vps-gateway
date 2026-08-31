"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.encryptPasswordPlain = encryptPasswordPlain;
exports.decryptPasswordPlain = decryptPasswordPlain;
const node_crypto_1 = __importDefault(require("node:crypto"));
const env_1 = require("../../config/env");
/** Shared with BI via ADMIN_SYNC_SECRET / GATEWAY_ADMIN_SECRET */
function key() {
    const secret = env_1.env.ADMIN_SYNC_SECRET || env_1.env.CONN_STRING_SECRET || 'dev';
    return node_crypto_1.default.scryptSync(secret, 'staff-pw-v1', 32);
}
function encryptPasswordPlain(plain) {
    const iv = node_crypto_1.default.randomBytes(12);
    const cipher = node_crypto_1.default.createCipheriv('aes-256-gcm', key(), iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
}
function decryptPasswordPlain(enc) {
    try {
        const buf = Buffer.from(enc, 'base64');
        const iv = buf.subarray(0, 12);
        const tag = buf.subarray(12, 28);
        const data = buf.subarray(28);
        const decipher = node_crypto_1.default.createDecipheriv('aes-256-gcm', key(), iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    }
    catch {
        return '';
    }
}
//# sourceMappingURL=passwordEnc.js.map