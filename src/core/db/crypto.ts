import crypto from 'node:crypto';
import { env } from '../../config/env';

const ALGO = 'aes-256-gcm';
const KEY = Buffer.from(env.CONN_STRING_SECRET, 'hex'); // must be 32 bytes

export function encryptConnString(plain: string): { enc: string; iv: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    enc: Buffer.concat([encrypted, tag]).toString('base64'),
    iv: iv.toString('base64'),
  };
}

export function decryptConnString(encB64: string, ivB64: string): string {
  const raw = Buffer.from(encB64, 'base64');
  const tag = raw.subarray(raw.length - 16);
  const data = raw.subarray(0, raw.length - 16);
  const decipher = crypto.createDecipheriv(ALGO, KEY, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
