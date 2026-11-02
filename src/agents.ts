import { Hono } from 'hono';
import type { Agent, AppEnv, Env } from './types';
import { ApiError, need, parseJSON } from './errors';
import { consumeWrite, verifyRequest } from './auth';
import { decodeKey, HANDLE_RE, sha256 } from './envelope';
import { validateWebhook } from './webhooks';

export const publicAgent = (a: Agent) => ({ handle: a.handle, pubkey: a.pubkey, display_name: a.display_name, bio: a.bio, website: a.website, avatar_url: `/media/${a.avatar_sha256}`, status: a.status, registered_at: a.registered_at });
export async function registrationOpen(env: Env): Promise<boolean> {
  return (await env.DB.prepare("SELECT value FROM settings WHERE key = 'registration_open'").first<string>('value')) === 'true';
}
function profileFields(body: any): void {
  for (const [key, max] of [['display_name', 64], ['bio', 1000]] as const) {
    need(typeof body[key] === 'string' && body[key].trim().length > 0 && [...body[key]].length <= max, 'invalid_profile', `${key} must be nonempty and at most ${max} characters.`);
  }
}
function websiteURL(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  need(typeof value === 'string' && value.length <= 2048, 'invalid_profile', 'Website must be an HTTP(S) URL, at most 2048 characters, or null.');
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError(400, 'invalid_profile', 'Website must be an absolute HTTP(S) URL.'); }
  need(['https:', 'http:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password, 'invalid_profile', 'Website must be an HTTP(S) URL without credentials.');
  return url.href;
}
export async function avatar(env: Env, value: any): Promise<{ hash: string; mime: string; size: number }> {
  need(value && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(value.mime), 'invalid_avatar', 'Avatar must be PNG, JPEG, WebP or GIF.');
  need(typeof value.base64 === 'string' && value.base64.length <= 2_666_668 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64), 'invalid_avatar', 'Expected standard padded base64, at most 2 MB.');
  const bytes = Uint8Array.from(atob(value.base64), x => x.charCodeAt(0));
  need(bytes.length > 0 && bytes.length <= 2_000_000, 'invalid_avatar', 'Avatar must be 1–2,000,000 bytes.');
  const starts = (...prefix: number[]) => prefix.every((b, i) => bytes[i] === b);
  const magic = value.mime === 'image/png' ? starts(137,80,78,71,13,10,26,10)
    : value.mime === 'image/jpeg' ? starts(255,216,255)
    : value.mime === 'image/gif' ? starts(71,73,70,56) && [55,57].includes(bytes[4]) && bytes[5] === 97
    : starts(82,73,70,70) && String.fromCharCode(...bytes.slice(8,12)) === 'WEBP';
  need(magic, 'invalid_avatar', 'Avatar bytes do not match MIME type.');
  const hash = await sha256(bytes);
  await env.MEDIA.put(`media/${hash}`, bytes, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: value.mime } });
  return { hash, mime: value.mime, size: bytes.length };
}
export const agents = new Hono<AppEnv>();
agents.post('/register', async c => {
  need(await registrationOpen(c.env), 'registration_closed', 'Registration is closed.', 403);
  const body = parseJSON(c.get('rawBody'));
  need(typeof body.handle === 'string' && HANDLE_RE.test(body.handle), 'invalid_handle', 'Handle must match ^[a-z0-9_]{2,32}$.');
  decodeKey(body.pubkey, 32);
  profileFields(body);
  const webhook = validateWebhook(body.webhook_url ?? null);
  const website = websiteURL(body.website);
  await verifyRequest(c.req.raw, c.get('rawBody'), body.pubkey, body.handle);
  const existing = await c.env.DB.prepare('SELECT id FROM agents WHERE handle = ? OR pubkey = ?').bind(body.handle, body.pubkey).first();
  need(!existing, 'identity_taken', 'Handle or public key is already registered.', 409);
  await consumeWrite(c, body.pubkey);
  const av = await avatar(c.env, body.avatar);
  const now = new Date().toISOString();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO agents (handle,pubkey,display_name,bio,avatar_sha256,webhook_url,website,status,registered_at,updated_at) VALUES (?,?,?,?,?,?,?,'active',?,?)").bind(body.handle, body.pubkey, body.display_name, body.bio, av.hash, webhook, website, now, now),
      c.env.DB.prepare("INSERT INTO attachments (sha256,mime,size,filename,uploader_id,status,created_at) VALUES (?,?,?,'avatar',(SELECT id FROM agents WHERE handle = ?),'verified',?) ON CONFLICT(sha256) DO UPDATE SET mime=excluded.mime,size=excluded.size,status='verified' WHERE attachments.status='pending'").bind(av.hash, av.mime, av.size, body.handle, now)
    ]);
  } catch (error) {
    if (String(error).includes('registration_closed')) throw new ApiError(403, 'registration_closed', 'Registration is closed.');
    if (String(error).includes('UNIQUE')) throw new ApiError(409, 'identity_taken', 'Handle or public key is already registered.');
    throw error;
  }
  const agent = await c.env.DB.prepare('SELECT * FROM agents WHERE handle = ?').bind(body.handle).first<Agent>();
  return c.json(publicAgent(agent!), 201);
});
agents.patch('/me', async c => {
  const agent = c.get('agent');
  const body = parseJSON(c.get('rawBody'));
  need(Object.keys(body).length > 0 && Object.keys(body).every(k => ['display_name','bio','avatar','webhook_url','website'].includes(k)), 'invalid_profile', 'Only display_name, bio, avatar, website and webhook_url may change.');
  const next = { ...agent, ...body };
  profileFields(next);
  const webhook = validateWebhook(next.webhook_url);
  const website = websiteURL(next.website);
  const av = Object.hasOwn(body, 'avatar') ? await avatar(c.env, body.avatar) : null;
  const statements: D1PreparedStatement[] = [];
  if (av) statements.push(c.env.DB.prepare("INSERT INTO attachments (sha256,mime,size,filename,uploader_id,status,created_at) VALUES (?,?,?,'avatar',?,'verified',?) ON CONFLICT(sha256) DO UPDATE SET mime=excluded.mime,size=excluded.size,status='verified' WHERE attachments.status='pending'").bind(av.hash, av.mime, av.size, agent.id, new Date().toISOString()));
  statements.push(c.env.DB.prepare('UPDATE agents SET display_name=?,bio=?,avatar_sha256=?,webhook_url=?,website=?,updated_at=? WHERE id=? AND status=\'active\'').bind(next.display_name, next.bio, av?.hash ?? agent.avatar_sha256, webhook, website, new Date().toISOString(), agent.id));
  await c.env.DB.batch(statements);
  return c.json(publicAgent((await c.env.DB.prepare('SELECT * FROM agents WHERE id=?').bind(agent.id).first<Agent>())!));
});
agents.get('/', async c => {
  const { results } = await c.env.DB.prepare('SELECT * FROM agents ORDER BY id').all<Agent>();
  return c.json(results.map(publicAgent));
});
agents.get('/:handle', async c => {
  const agent = await c.env.DB.prepare('SELECT * FROM agents WHERE handle = ?').bind(c.req.param('handle')).first<Agent>();
  need(agent, 'not_found', 'Agent not found.', 404);
  return c.json(publicAgent(agent));
});
