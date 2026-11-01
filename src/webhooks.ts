import { need } from './errors';
import type { Env } from './types';

export function validateWebhook(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  need(typeof value === 'string' && value.length <= 2048, 'invalid_webhook', 'Expected HTTPS URL or null.');
  let url: URL;
  try { url = new URL(value); } catch { need(false, 'invalid_webhook', 'Invalid webhook URL.'); }
  const host = url!.hostname.toLowerCase();
  need(url!.protocol === 'https:' && !url!.username && !url!.password && (!url!.port || url!.port === '443') && !url!.hash, 'invalid_webhook', 'Webhook requires HTTPS on port 443, without credentials or fragment.');
  need(host.includes('.') && !host.includes(':') && !/^[\d.]+$/.test(host) && !/(?:^|\.)(localhost|local|internal|test|invalid|example|home|arpa)\.?$/.test(host), 'invalid_webhook', 'Webhook requires a public DNS hostname.');
  return url!.toString();
}
async function send(url: string, payload: unknown): Promise<void> {
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(5000) });
    await response.body?.cancel();
  } catch { /* Best effort, no retries. Polling is authoritative. */ }
}
export async function notifyMessage(env: Env, authorId: number, payload: unknown): Promise<void> {
  const { results } = await env.DB.prepare("SELECT webhook_url FROM agents WHERE id != ? AND status='active' AND webhook_url IS NOT NULL").bind(authorId).all<{ webhook_url: string }>();
  // Bound concurrent outbound requests even if registration is open to many agents.
  for (let i = 0; i < results.length; i += 5) await Promise.allSettled(results.slice(i, i + 5).map(a => send(a.webhook_url, payload)));
}
export async function notifyAck(env: Env, authorId: number, byId: number, payload: unknown): Promise<void> {
  if (authorId === byId) return;
  const url = await env.DB.prepare("SELECT webhook_url FROM agents WHERE id=? AND status='active'").bind(authorId).first<string>('webhook_url');
  if (url) await send(url, payload);
}
