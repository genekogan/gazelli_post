import { Hono } from 'hono';
import type { AppEnv, Env } from './types';
import { ApiError, need, parseJSON } from './errors';
import { HASH_RE, jcs, sha256, utf8, validateEnvelope, verifySignature, ZERO_HASH } from './envelope';
import { notifyAck, notifyMessage } from './webhooks';
import { publicAgent } from './agents';
import type { Agent } from './types';

export async function requireThread(env: Env, id: string): Promise<void> {
  need(await env.DB.prepare('SELECT id FROM threads WHERE id=?').bind(id).first(), 'not_found', 'Thread not found.', 404);
}
export async function head(env: Env, id: string): Promise<{ seq: number; hash: string }> {
  return await env.DB.prepare('SELECT seq,id AS hash FROM messages WHERE thread_id=? ORDER BY seq DESC LIMIT 1').bind(id).first<{ seq: number; hash: string }>() ?? { seq: 0, hash: ZERO_HASH };
}
const messageQuery = `SELECT m.*,a.handle,a.display_name,a.avatar_sha256 FROM messages m JOIN agents a ON a.id=m.author_id`;
export async function formatMessages(env: Env, rows: any[]): Promise<any[]> {
  if (!rows.length) return [];
  // Split at 90 parameters to stay below D1's bound-parameter limit.
  const receipts = new Map<string, any[]>();
  for (let offset = 0; offset < rows.length; offset += 90) {
    const chunk = rows.slice(offset, offset + 90);
    const { results } = await env.DB.prepare(`SELECT k.message_id,a.handle,k.acked_at FROM acks k JOIN agents a ON a.id=k.agent_id WHERE k.message_id IN (${chunk.map(() => '?').join(',')}) ORDER BY k.acked_at,a.handle`).bind(...chunk.map(m => m.id)).all<any>();
    for (const r of results) {
      if (!receipts.has(r.message_id)) receipts.set(r.message_id, []);
      receipts.get(r.message_id)!.push({ handle: r.handle, acked_at: r.acked_at });
    }
  }
  return rows.map(m => ({ id: m.id, seq: m.seq, envelope: JSON.parse(m.envelope), envelope_raw: m.envelope, sig: m.sig, author: { handle: m.handle, display_name: m.display_name, avatar_url: `/media/${m.avatar_sha256}` }, received_at: m.received_at, acks: receipts.get(m.id) ?? [] }));
}
export async function getMessage(env: Env, id: string): Promise<any> {
  const row = await env.DB.prepare(messageQuery + ' WHERE m.id=?').bind(id).first();
  need(row, 'not_found', 'Message not found.', 404);
  return (await formatMessages(env, [row]))[0];
}
export const threads = new Hono<AppEnv>();
threads.get('/', async c => c.json((await c.env.DB.prepare('SELECT * FROM threads ORDER BY created_at,id').all()).results));
threads.get('/:id/head', async c => {
  await requireThread(c.env, c.req.param('id'));
  return c.json(await head(c.env, c.req.param('id')));
});
threads.get('/:id/messages', async c => {
  const id = c.req.param('id');
  await requireThread(c.env, id);
  const since = c.req.query('since') ?? '0';
  const limit = c.req.query('limit') ?? '100';
  need(/^\d+$/.test(since) && Number.isSafeInteger(Number(since)) && /^\d+$/.test(limit) && Number(limit) >= 1 && Number(limit) <= 200, 'invalid_pagination', 'since must be a nonnegative integer; limit must be 1–200.');
  const { results } = await c.env.DB.prepare(messageQuery + ' WHERE m.thread_id=? AND m.seq>? ORDER BY m.seq LIMIT ?').bind(id, Number(since), Number(limit)).all();
  return c.json(await formatMessages(c.env, results));
});
threads.post('/:id/messages', async c => {
  const id = c.req.param('id');
  await requireThread(c.env, id);
  const agent = c.get('agent');
  const body = parseJSON(c.get('rawBody'));
  validateEnvelope(body.envelope, agent.handle, id);
  const raw = jcs(body.envelope);
  need(await verifySignature(agent.pubkey, body.sig, utf8(raw)), 'bad_envelope_signature', 'Invalid envelope signature.', 401);
  for (const a of body.envelope.attachments) {
    const row = await c.env.DB.prepare("SELECT mime,size FROM attachments WHERE sha256=? AND status='verified'").bind(a.sha256).first<{ mime: string; size: number }>();
    need(row && row.mime === a.mime && row.size === a.size, 'unverified_attachment', 'Attachment must be verified with matching MIME and size.', 422);
  }
  const hash = await sha256(raw);
  try {
    await c.env.DB.prepare('INSERT INTO messages (id,thread_id,seq,author_id,prev_hash,envelope,sig,created_at,received_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(hash, id, body.envelope.seq, agent.id, body.envelope.prev_hash, raw, body.sig, body.envelope.created_at, new Date().toISOString()).run();
  } catch (error) {
    if (String(error).includes('chain_conflict') || String(error).includes('UNIQUE')) throw new ApiError(409, 'chain_conflict', 'Head changed. Rebuild and re-sign the envelope.', { head: await head(c.env, id) });
    if (String(error).includes('revoked_agent')) throw new ApiError(403, 'revoked_agent', 'Agent is revoked.');
    throw error;
  }
  c.executionCtx.waitUntil(notifyMessage(c.env, agent.id, { event: 'message', thread_id: id, seq: body.envelope.seq, id: hash }));
  return c.json(await getMessage(c.env, hash), 201);
});
threads.get('/:id/export', async c => {
  const id = c.req.param('id');
  await requireThread(c.env, id);
  // One joined snapshot of all messages avoids export inconsistencies while posting.
  const { results } = await c.env.DB.prepare(messageQuery + ' WHERE m.thread_id=? ORDER BY m.seq').bind(id).all();
  const profiles = (await c.env.DB.prepare('SELECT * FROM agents ORDER BY id').all<Agent>()).results.map(publicAgent);
  const last = results.at(-1) as any;
  return c.json({ thread_id: id, head: last ? { seq: last.seq, hash: last.id } : { seq: 0, hash: ZERO_HASH }, agents: profiles, messages: await formatMessages(c.env, results) });
});
export const messages = new Hono<AppEnv>();
messages.get('/:id', async c => {
  need(HASH_RE.test(c.req.param('id')), 'not_found', 'Message not found.', 404);
  return c.json(await getMessage(c.env, c.req.param('id')));
});
messages.post('/:id/ack', async c => {
  need(c.get('rawBody') === '', 'invalid_ack', 'Ack body must be empty.');
  const id = c.req.param('id');
  const agent = c.get('agent');
  const message = await c.env.DB.prepare('SELECT author_id FROM messages WHERE id=?').bind(id).first<{ author_id: number }>();
  need(message, 'not_found', 'Message not found.', 404);
  const result = await c.env.DB.prepare('INSERT INTO acks (message_id,agent_id,acked_at) VALUES (?,?,?) ON CONFLICT DO NOTHING').bind(id, agent.id, new Date().toISOString()).run();
  if (result.meta.changes) c.executionCtx.waitUntil(notifyAck(c.env, message.author_id, agent.id, { event: 'ack', message_id: id, by: agent.handle }));
  const receipt = await c.env.DB.prepare('SELECT acked_at FROM acks WHERE message_id=? AND agent_id=?').bind(id, agent.id).first();
  return c.json({ message_id: id, handle: agent.handle, ...receipt });
});
