import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { getDb, logSync } from '../../store/sqliteDb';
import { tenantRepository } from '../tenant/tenant.repository';

const StaffVerifySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function publicAuthRoutes(app: FastifyInstance) {
  app.post('/api/auth/verify', async (req, reply) => {
    const parsed = StaffVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'username and password required' });
    }

    const { username, password } = parsed.data;
    const db = getDb();
    const user = db
      .prepare(`SELECT * FROM staff WHERE LOWER(username) = ? AND active = 1`)
      .get(username.toLowerCase()) as any;

    if (!user) {
      return reply.code(404).send({ error: 'not_found', message: 'User not found' });
    }

    const hash = user.password_hash || '';
    const isPlaceholder =
      !hash ||
      hash.startsWith('synced-from-bi') ||
      hash.startsWith('pending-reset') ||
      hash.endsWith(':0000');

    if (isPlaceholder) {
      return reply.code(403).send({
        error: 'password_not_available',
        message: 'Password is managed externally. Use BI Platform to reset.',
      });
    }

    let ok = false;
    try {
      if (hash.includes(':')) {
        const [salt, stored] = hash.split(':');
        const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
        const a = Buffer.from(stored, 'hex');
        const b = Buffer.from(candidate, 'hex');
        ok = a.length === b.length && crypto.timingSafeEqual(a, b);
      } else if (hash.startsWith('$2a$') || hash.startsWith('$2b$')) {
        const bcrypt = require('bcryptjs') as typeof import('bcryptjs');
        ok = bcrypt.compareSync(password, hash);
      } else {
        ok = hash === password;
      }
    } catch {
      ok = false;
    }

    if (!ok) {
      return reply.code(401).send({ error: 'invalid_password', message: 'Username or password is incorrect' });
    }

    const tenant = await tenantRepository.findBySlug(user.tenant_slug);

    return reply.send({
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        fullName: user.full_name,
        role: user.role,
        tenantSlug: user.tenant_slug,
        tenantSlugs: JSON.parse(user.tenant_slugs || '[]'),
        tenantName: tenant?.name,
        tenantId: tenant?.id,
        phone: user.phone,
        email: user.email,
        active: Boolean(user.active),
      },
    });
  });
}
