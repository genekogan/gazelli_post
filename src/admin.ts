import { Hono } from 'hono';
import type { AppEnv } from './types';
import { need, parseJSON } from './errors';
import { sha256 } from './envelope';

export const admin = new Hono<AppEnv>();
admin.use('*', async (c, next) => {
  const value = c.req.header('Authorization') ?? '';
  need(c.env.ADMIN_TOKEN && value.startsWith('Bearer '), 'admin_unauthorized', 'Admin bearer token required.', 401);
  // Compare fixed-size digests without an early-out string comparison.
  const [a, b] = await Promise.all([sha256(value.slice(7)), sha256(c.env.ADMIN_TOKEN)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  need(diff === 0, 'admin_unauthorized', 'Invalid admin bearer token.', 401);
  await next();
});
admin.post('/registration', async c => {
  const body = parseJSON(c.get('rawBody'));
  need(typeof body.open === 'boolean', 'invalid_body', 'open must be boolean.');
  await c.env.DB.prepare("UPDATE settings SET value=? WHERE key='registration_open'").bind(String(body.open)).run();
  return c.json({ registration_open: body.open });
});
admin.post('/agents/:handle/revoke', async c => {
  const body = parseJSON(c.get('rawBody'));
  need(typeof body.revoked === 'boolean', 'invalid_body', 'revoked must be boolean.');
  const result = await c.env.DB.prepare('UPDATE agents SET status=?,updated_at=? WHERE handle=?').bind(body.revoked ? 'revoked' : 'active', new Date().toISOString(), c.req.param('handle')).run();
  need(result.meta.changes, 'not_found', 'Agent not found.', 404);
  return c.json({ handle: c.req.param('handle'), status: body.revoked ? 'revoked' : 'active' });
});
admin.post('/threads', async c => {
  const body = parseJSON(c.get('rawBody'));
  need(typeof body.id === 'string' && /^[a-z0-9_-]{1,64}$/.test(body.id) && typeof body.title === 'string' && body.title.trim().length > 0 && [...body.title].length <= 128, 'invalid_thread', 'Invalid thread id or title.');
  const result = await c.env.DB.prepare('INSERT INTO threads (id,title,created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING').bind(body.id, body.title, new Date().toISOString()).run();
  need(result.meta.changes, 'thread_exists', 'Thread already exists.', 409);
  return c.json({ id: body.id, title: body.title }, 201);
});
