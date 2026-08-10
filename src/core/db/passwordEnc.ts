import crypto from 'node:crypto';
import { env } from '../../config/env';

/** Shared with BI via ADMIN_SYNC_SECRET / GATEWAY_ADMIN_SECRET */
function key() {
  const secret = env.ADMIN_SYNC_SECRET || env.CONN_STRING_SECRET || 'dev';
  return crypto.scryptSync(secret, 'staff-pw-v1', 32);
}

export function encryptPasswordPlain(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptPasswordPlain(enc: string): string {
  try {
    const buf = Buffer.from(enc, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}
