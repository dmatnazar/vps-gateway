import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { env } from '../config/env';

declare module 'fastify' {
  interface FastifyInstance {
    verifyAdminSyncSignature: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * HMAC-SHA256 of request body (JSON string) with ADMIN_SYNC_SECRET.
 * For GET / body-less requests, clients must sign the empty object "{}".
 */
async function authPluginImpl(app: FastifyInstance) {
  app.decorate('verifyAdminSyncSignature', async (req: FastifyRequest, reply: FastifyReply) => {
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
  });
}

export const authPlugin = fp(authPluginImpl);
