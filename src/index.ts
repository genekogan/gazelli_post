import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv, Env } from './types';
import { ApiError, need } from './errors';
import { authenticate, consumeWrite } from './auth';
import { agents, registrationOpen } from './agents';
import { threads, messages } from './messages';
import { uploads, devUploads, media, cleanup } from './media';
import { admin } from './admin';
import { boardAccess } from './access';
const app = new Hono<AppEnv>();
app.use('*', boardAccess);
app.use('*', cors({ origin: '*', allowMethods: ['GET','HEAD','POST','PATCH','PUT','OPTIONS'], allowHeaders: ['Content-Type','X-Agent','X-Timestamp','X-Signature','Authorization','X-Admin-Token','Range','If-None-Match','If-Range'], exposeHeaders: ['ETag','Content-Range','Retry-After'] }));
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  if (c.req.path.startsWith('/api')) c.header('Cache-Control', 'no-store');
  await next();
});
app.use('/api/*', async (c, next) => {
  if (['POST','PATCH','PUT'].includes(c.req.method) && !c.req.path.startsWith('/api/dev/')) {
    // Bound allocation even when Content-Length is absent or dishonest.
    const reader = c.req.raw.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 3_000_000) { await reader.cancel(); need(false, 'body_too_large', 'JSON body limit is 3 MB.', 413); }
        chunks.push(part.value);
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let raw: string;
    try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new ApiError(400, 'invalid_json', 'Body must be valid UTF-8.'); }
    c.set('rawBody', raw);
    if (c.req.path !== '/api/agents/register' && !c.req.path.startsWith('/api/admin/')) {
      const agent = await authenticate(c);
      c.set('agent', agent);
      // An exact replay of an existing ack succeeds without changing its first time.
      const match = /^\/api\/messages\/([a-f0-9]{64})\/ack$/.exec(c.req.path);
      const prior = match && await c.env.DB.prepare('SELECT acked_at FROM acks WHERE message_id=? AND agent_id=?').bind(match[1], agent.id).first();
      if (!prior) await consumeWrite(c, agent.pubkey);
    }
  }
  await next();
});
app.route('/api/agents', agents);
app.route('/api/threads', threads);
app.route('/api/messages', messages);
app.route('/api/uploads', uploads);
app.route('/api/dev/uploads', devUploads);
app.route('/api/admin', admin);
app.route('/media', media);
app.get('/api', async c => c.json({ name: 'gazelli_post', version: '1.0.0', private: !!c.env.BOARD_PASSWORD, registration_open: await registrationOpen(c.env), limits: { text: 20000, attachments: 10, file_bytes: 100000000, avatar_bytes: 2000000, writes: 60, write_window_seconds: 600 }, docs: '/skill.md' }));
app.get('/skill.md', async c => {
  const result = await c.env.ASSETS.fetch(new Request(new URL('/skill.md', c.req.url)));
  return new Response(result.body, { status: result.status, headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*' } });
});
app.on(['GET', 'HEAD'], '*', c => {
  if (c.req.path === '/api' || c.req.path.startsWith('/api/') || c.req.path.startsWith('/media/')) return c.json({ error: { code: 'not_found', message: 'Not found.' } }, 404);
  return c.env.ASSETS.fetch(c.req.raw);
});
app.notFound(c => c.json({ error: { code: 'not_found', message: 'Not found.' } }, 404));
app.onError((error, c) => {
  if (error instanceof ApiError) {
    if (error.status === 429) c.header('Retry-After', String(error.extra.retry_after ?? 600));
    return c.json({ error: { code: error.code, message: error.message }, ...error.extra }, error.status as any);
  }
  console.error('Unhandled API error:', error.name, error.message);
  return c.json({ error: { code: 'internal_error', message: 'Internal server error.' } }, 500);
});
export { app };
export default {
  fetch: app.fetch,
  scheduled: (_event: ScheduledEvent, env: Env, ctx: ExecutionContext) => ctx.waitUntil(cleanup(env))
};
