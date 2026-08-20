import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { env } from '../config/env';
import { getDb } from '../store/sqliteDb';

declare module 'fastify' {
  interface FastifyInstance {
    verifyAdminSyncSignature: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    verifyDeviceSyncSignature: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    verifySyncSignature: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

async function verifyAdminSignature(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply) {
  const signature = req.headers['x-admin-signature'];
  if (!signature || typeof signature !== 'string') {
    return reply.code(401).send({ error: 'Missing X-Admin-Signature header' });
  }

  const payload =
    req.body !== undefined && req.body !== null
      ? JSON.stringify(req.body)
      : '{}';

  const expected = crypto
    .createHmac('sha256', env.ADMIN_SYNC_SECRET)
    .update(payload)
    .digest('hex');

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);

  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return reply.code(403).send({ error: 'Invalid admin signature' });
  }
}

/** Requires device row + device_sync_secret already in DB. Do NOT use on /devices/register or first /status. */
async function verifyDeviceSignature(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply) {
  const signature = req.headers['x-device-sync-signature'];
  const deviceId = req.headers['x-device-id'];
  if (!signature || typeof signature !== 'string') {
    return reply.code(401).send({ error: 'Missing X-Device-Sync-Signature header' });
  }
  if (!deviceId || typeof deviceId !== 'string') {
    return reply.code(401).send({ error: 'Missing X-Device-Id header' });
  }

  const db = getDb();
  const device = db.prepare(`SELECT device_sync_secret FROM devices WHERE id = ?`).get(deviceId) as any;
  if (!device || !device.device_sync_secret) {
    return reply.code(403).send({ error: 'Device not found or no sync secret' });
  }

  const payload =
    req.body !== undefined && req.body !== null
      ? JSON.stringify(req.body)
      : '{}';

  const signedPayload = JSON.stringify({ deviceId, ...(req.body !== undefined && req.body !== null ? req.body : {}) });

  const expected = crypto
    .createHmac('sha256', device.device_sync_secret)
    .update(signedPayload)
    .digest('hex');

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);

  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return reply.code(403).send({ error: 'Invalid device sync signature' });
  }
}

async function authPluginImpl(app: FastifyInstance) {
  app.decorate('verifyAdminSyncSignature', async (req: FastifyRequest, reply: FastifyReply) => {
    return verifyAdminSignature(app, req, reply);
  });

  app.decorate('verifyDeviceSyncSignature', async (req: FastifyRequest, reply: FastifyReply) => {
    return verifyDeviceSignature(app, req, reply);
  });

  app.decorate('verifySyncSignature', async (req: FastifyRequest, reply: FastifyReply) => {
    const adminSig = req.headers['x-admin-signature'];
    const deviceSig = req.headers['x-device-sync-signature'];

    if (adminSig && typeof adminSig === 'string') {
      return verifyAdminSignature(app, req, reply);
    }
    if (deviceSig && typeof deviceSig === 'string') {
      return verifyDeviceSignature(app, req, reply);
    }
    return reply.code(401).send({ error: 'Missing sync signature header' });
  });
}

export const authPlugin = fp(authPluginImpl);
