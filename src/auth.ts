import type { Context } from 'hono';
import type { Agent, AppEnv } from './types';
import { ApiError, need } from './errors';
import { sha256, utf8, verifySignature } from './envelope';

export function signingInput(method: string, path: string, timestamp: string, bodyHash: string): string {
  return [method.toUpperCase(), path, timestamp, bodyHash].join('\n');
}
export async function verifyRequest(request: Request, raw: string, pubkey: string, handle: string, now = Date.now()): Promise<void> {
  const timestamp = request.headers.get('X-Timestamp') ?? '';
  need(request.headers.get('X-Agent') === handle, 'unauthorized', 'X-Agent mismatch.', 401);
  need(/^\d{1,12}$/.test(timestamp) && Math.abs(Number(timestamp) - now / 1000) <= 300, 'stale_timestamp', 'Timestamp must be within 300 seconds.', 401);
  const url = new URL(request.url);
  const input = signingInput(request.method, url.pathname + url.search, timestamp, await sha256(raw));
  need(await verifySignature(pubkey, request.headers.get('X-Signature') ?? '', utf8(input)), 'bad_signature', 'Invalid request signature.', 401);
}
export async function authenticate(c: Context<AppEnv>): Promise<Agent> {
  const handle = c.req.header('X-Agent');
  const agent = await c.env.DB.prepare('SELECT * FROM agents WHERE handle = ?').bind(handle ?? '').first<Agent>();
  need(agent, 'unknown_agent', 'Agent is not registered.', 401);
  need(agent.status === 'active', 'revoked_agent', 'Agent is revoked.', 403);
  await verifyRequest(c.req.raw, c.get('rawBody'), agent.pubkey, agent.handle);
  return agent;
}
// One INSERT is atomic. The trigger enforces a rolling ten-minute limit across isolates.
export async function consumeWrite(c: Context<AppEnv>, identity: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const fingerprint = await sha256([identity, c.req.method, c.req.path, c.req.header('X-Timestamp'), c.req.header('X-Signature')].join('\n'));
  try {
    await c.env.DB.prepare('INSERT INTO writes (identity, fingerprint, at) VALUES (?, ?, ?)').bind(identity, fingerprint, now).run();
  } catch (error) {
    const message = String(error);
    if (message.includes('write_rate_limit')) throw new ApiError(429, 'rate_limited', 'At most 60 writes per rolling ten minutes.', { retry_after: 600 });
    if (message.includes('UNIQUE')) throw new ApiError(409, 'replayed_request', 'Request already used. Sign a fresh request with a new timestamp.');
    throw error;
  }
}
