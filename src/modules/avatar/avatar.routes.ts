import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../../config/env';
import { z } from 'zod';

function avatarDir() {
  const dir = path.join(path.dirname(env.DB_FILE), 'avatars');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(username: string) {
  return username.toLowerCase().replace(/[^a-z0-9_-]/g, '') + '.jpg';
}

export async function registerAvatarRoutes(app: FastifyInstance) {
  /** Upload: { username, imageBase64, maxWidth? } — compress client-side already */
  app.post('/api/admin/avatar', { preHandler: [app.verifyAdminSyncSignature] }, async (req, reply) => {
    const body = z
      .object({
        username: z.string().min(1),
        imageBase64: z.string().min(1),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad body' });

    const raw = body.data.imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const buf = Buffer.from(raw, 'base64');
    if (buf.length > 2_000_000) return reply.code(400).send({ error: 'Max 2MB' });

    const file = path.join(avatarDir(), safeName(body.data.username));
    fs.writeFileSync(file, buf);
    return reply.send({
      ok: true,
      url: `/api/avatars/${encodeURIComponent(body.data.username.toLowerCase())}`,
    });
  });

  app.delete('/api/admin/avatar', { preHandler: [app.verifyAdminSyncSignature] }, async (req, reply) => {
    const body = z.object({ username: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad body' });
    const file = path.join(avatarDir(), safeName(body.data.username));
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return reply.send({ ok: true });
  });

  app.get('/api/avatars/:username', async (req, reply) => {
    const { username } = req.params as { username: string };
    const file = path.join(avatarDir(), safeName(username));
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'not found' });
    const buf = fs.readFileSync(file);
    return reply.type('image/jpeg').send(buf);
  });
}
