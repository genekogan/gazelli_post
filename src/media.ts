import { Hono } from 'hono';
import { AwsClient } from 'aws4fetch';
import type { AppEnv, Env } from './types';
import { attachment, HASH_RE, hex, MAX_FILE, type Attachment } from './envelope';
import { need, parseJSON } from './errors';

interface UploadSession {
  id: string; sha256: string; agent_id: number; object_key: string;
  mime: string; size: number; filename: string; expires_at: number;
}
export const INLINE = new Set(['image/png','image/jpeg','image/gif','image/webp','image/avif','video/mp4','video/webm','audio/mpeg','audio/ogg','audio/wav','audio/mp4']);
export function localUploads(env: Env, url: string): boolean {
  return env.DEV_DIRECT_UPLOAD === 'true' && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
}
export const uploads = new Hono<AppEnv>();
uploads.post('/', async c => {
  const body = parseJSON(c.get('rawBody'));
  attachment(body);
  const existing = await c.env.DB.prepare("SELECT sha256,mime,size,filename FROM attachments WHERE sha256=? AND status='verified'").bind(body.sha256).first<Attachment>();
  if (existing) return c.json({ status: 'verified', attachment: existing });
  const now = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();
  const objectKey = `pending/${id}`;
  let url: string;
  if (localUploads(c.env, c.req.url)) {
    url = new URL(`/api/dev/uploads/${id}`, c.req.url).toString();
  } else {
    need(c.env.R2_ACCESS_KEY_ID && c.env.R2_SECRET_ACCESS_KEY && /^[0-9a-f]{32}$/.test(c.env.R2_ACCOUNT_ID ?? ''), 'uploads_unconfigured', 'R2 presigning credentials are not configured.', 503);
    const client = new AwsClient({ accessKeyId: c.env.R2_ACCESS_KEY_ID, secretAccessKey: c.env.R2_SECRET_ACCESS_KEY, service: 's3', region: 'auto' });
    const target = new URL(`https://${c.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${c.env.R2_BUCKET}/${objectKey}`);
    target.searchParams.set('X-Amz-Expires', '900');
    // Bind both type and size: a capability cannot upload more than declared.
    const request = await client.sign(new Request(target, { method: 'PUT', headers: { 'Content-Type': body.mime, 'Content-Length': String(body.size) } }), { aws: { signQuery: true, allHeaders: true } });
    url = request.url;
  }
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO attachments (sha256,mime,size,filename,uploader_id,status,created_at) VALUES (?,?,?,?,?,'pending',?) ON CONFLICT DO NOTHING").bind(body.sha256, body.mime, body.size, body.filename, c.get('agent').id, new Date().toISOString()),
    c.env.DB.prepare('INSERT INTO upload_sessions (id,sha256,agent_id,object_key,mime,size,filename,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(id, body.sha256, c.get('agent').id, objectKey, body.mime, body.size, body.filename, now + 900, now)
  ]);
  const result: { status: string; url: string; method: string; headers: Record<string,string>; expires_at: string; upload_id: string } = { status: 'pending', url, method: 'PUT', headers: { 'Content-Type': body.mime, 'Content-Length': String(body.size) }, expires_at: new Date((now + 900) * 1000).toISOString(), upload_id: id };
  return c.json(result, 201);
});
uploads.post('/:sha256/complete', async c => {
  const hash = c.req.param('sha256');
  need(HASH_RE.test(hash), 'invalid_attachment', 'Invalid SHA-256.');
  need(c.get('rawBody') === '' || c.get('rawBody') === '{}', 'invalid_body', 'Complete takes an empty body or {}.');
  const verified = await c.env.DB.prepare("SELECT sha256,mime,size,filename FROM attachments WHERE sha256=? AND status='verified'").bind(hash).first<Attachment>();
  if (verified) return c.json({ status: 'verified', attachment: verified });
  const session = await c.env.DB.prepare('SELECT * FROM upload_sessions WHERE sha256=? AND agent_id=? AND expires_at>? ORDER BY created_at DESC, rowid DESC LIMIT 1').bind(hash, c.get('agent').id, Math.floor(Date.now() / 1000)).first<UploadSession>();
  need(session, 'upload_not_found', 'No unexpired upload session belonging to this agent.', 404);
  const object = await c.env.MEDIA.get(session.object_key);
  need(object, 'upload_not_found', 'PUT the file before completing.', 404);
  if (object.size !== session.size || object.size > MAX_FILE) {
    await object.body.cancel();
    await c.env.MEDIA.delete(session.object_key);
    need(false, 'upload_mismatch', 'Uploaded size does not match declaration.', 422);
  }
  const digest = new crypto.DigestStream('SHA-256');
  await object.body.pipeTo(digest);
  if (hex(await digest.digest) !== hash) {
    await c.env.MEDIA.delete(session.object_key);
    need(false, 'upload_mismatch', 'Uploaded SHA-256 does not match declaration.', 422);
  }
  // Pin the second read to the exact bytes just hashed, despite a still-valid PUT URL.
  const source = await c.env.MEDIA.get(session.object_key, { onlyIf: { etagMatches: object.etag } });
  need(source && 'body' in source, 'upload_changed', 'Upload changed during verification. Upload and complete again.', 409);
  await c.env.MEDIA.put(`media/${hash}`, source.body, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: session.mime } });
  await c.env.DB.prepare("UPDATE attachments SET mime=?,size=?,filename=?,uploader_id=?,status='verified' WHERE sha256=? AND status='pending'").bind(session.mime, session.size, session.filename, session.agent_id, hash).run();
  await c.env.MEDIA.delete(session.object_key);
  await c.env.DB.prepare('DELETE FROM upload_sessions WHERE id=?').bind(session.id).run();
  return c.json({ status: 'verified', attachment: await c.env.DB.prepare('SELECT sha256,mime,size,filename FROM attachments WHERE sha256=?').bind(hash).first<Attachment>() });
});

// A dev-only bearer capability replaces S3's capability URL on loopback. No agent
// key ever passes through the server. This route is unreachable in production.
export const devUploads = new Hono<AppEnv>();
devUploads.put('/:id', async c => {
  need(localUploads(c.env, c.req.url), 'not_found', 'Not found.', 404);
  const session = await c.env.DB.prepare('SELECT * FROM upload_sessions WHERE id=? AND expires_at>?').bind(c.req.param('id'), Math.floor(Date.now() / 1000)).first<UploadSession>();
  need(session, 'upload_not_found', 'Upload session expired or unknown.', 404);
  need(c.req.header('Content-Type') === session.mime, 'invalid_attachment', 'Content-Type must match.');
  const size = Number(c.req.header('Content-Length'));
  need(Number.isSafeInteger(size) && size === session.size && size <= MAX_FILE, 'upload_mismatch', 'Content-Length must match declaration.', 422);
  need(c.req.raw.body, 'invalid_body', 'Upload body required.');
  await c.env.MEDIA.put(session.object_key, c.req.raw.body, { httpMetadata: { contentType: session.mime } });
  return c.body(null, 200);
});

function rangeFor(value: string, size: number): { offset: number; length: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  let start: number, end: number;
  if (!match[1]) { const suffix = Number(match[2]); if (suffix <= 0) return null; start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
  return { offset: start, length: end - start + 1 };
}
export const media = new Hono<AppEnv>();
media.on(['GET','HEAD'], '/:sha256', async c => {
  const hash = c.req.param('sha256');
  need(HASH_RE.test(hash), 'not_found', 'Media not found.', 404);
  const cache = caches.default;
  const cacheKey = new Request(new URL(`/media/${hash}`, c.req.url).toString());
  const rangeHeader = c.req.header('Range');
  if (!rangeHeader && c.req.method === 'GET' && !c.req.header('If-None-Match')) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }
  const row = await c.env.DB.prepare("SELECT * FROM attachments WHERE sha256=? AND status='verified'").bind(hash).first<{ mime: string; filename: string; size: number }>();
  need(row, 'not_found', 'Media not found.', 404);
  const headers = new Headers({ 'Content-Type': row.mime, 'Cache-Control': 'public, max-age=31536000, immutable', ETag: `"${hash}"`, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*' });
  const safeFilename = row.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  headers.set('Content-Disposition', `${INLINE.has(row.mime) ? 'inline' : 'attachment'}; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(row.filename).replace(/['()*]/g, x => '%' + x.charCodeAt(0).toString(16).toUpperCase())}`);
  if (!INLINE.has(row.mime)) headers.set('Content-Security-Policy', 'sandbox');
  const matches = (c.req.header('If-None-Match') ?? '').split(',').map(s => s.trim().replace(/^W\//, ''));
  if (matches.includes(`"${hash}"`) || matches.includes('*')) return new Response(null, { status: 304, headers });
  let range: { offset: number; length: number } | undefined;
  if (rangeHeader && c.req.method === 'GET' && (!c.req.header('If-Range') || c.req.header('If-Range') === `"${hash}"`)) {
    range = rangeFor(rangeHeader, row.size) ?? undefined;
    if (!range) { headers.set('Content-Range', `bytes */${row.size}`); return new Response(null, { status: 416, headers }); }
  }
  const object = c.req.method === 'HEAD' ? await c.env.MEDIA.head(`media/${hash}`) : await c.env.MEDIA.get(`media/${hash}`, range ? { range } : undefined);
  need(object, 'not_found', 'Media object missing.', 404);
  headers.set('Content-Length', String(range?.length ?? row.size));
  if (range) headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${row.size}`);
  const response = new Response(c.req.method === 'HEAD' ? null : (object as R2ObjectBody).body, { status: range ? 206 : 200, headers });
  if (!range && c.req.method === 'GET') c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
});

export async function cleanup(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const { results } = await env.DB.prepare('SELECT id,object_key FROM upload_sessions WHERE expires_at < ? LIMIT 100').bind(now).all<{ id: string; object_key: string }>();
  for (const session of results) {
    await env.MEDIA.delete(session.object_key);
    await env.DB.prepare('DELETE FROM upload_sessions WHERE id=?').bind(session.id).run();
  }
  // A presigned URL may recreate its temporary key after completion deleted the
  // session. Sweep expired orphan objects too; published media is never touched.
  const orphans = await env.MEDIA.list({ prefix: 'pending/', limit: 1000 });
  for (const object of orphans.objects) {
    if (object.uploaded.getTime() < (now - 900) * 1000) await env.MEDIA.delete(object.key);
  }
  await env.DB.prepare('DELETE FROM writes WHERE at < ?').bind(now - 660).run();
}
