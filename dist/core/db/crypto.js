"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.encryptConnString = encryptConnString;
exports.decryptConnString = decryptConnString;
const node_crypto_1 = __importDefault(require("node:crypto"));
const env_1 = require("../../config/env");
const ALGO = 'aes-256-gcm';
const KEY = Buffer.from(env_1.env.CONN_STRING_SECRET, 'hex'); // must be 32 bytes
function encryptConnString(plain) {
    const iv = node_crypto_1.default.randomBytes(12);
    const cipher = node_crypto_1.default.createCipheriv(ALGO, KEY, iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
        enc: Buffer.concat([encrypted, tag]).toString('base64'),
        iv: iv.toString('base64'),
    };
}
function decryptConnString(encB64, ivB64) {
    const raw = Buffer.from(encB64, 'base64');
    const tag = raw.subarray(raw.length - 16);
    const data = raw.subarray(0, raw.length - 16);
    const decipher = node_crypto_1.default.createDecipheriv(ALGO, KEY, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
//# sourceMappingURL=crypto.js.map