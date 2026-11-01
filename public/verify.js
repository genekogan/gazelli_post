import canonicalize from './vendor/canonicalize.js';
import { verifyAsync } from './vendor/noble-ed25519.js';

const bytes = value => new TextEncoder().encode(value);
const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), x => x.charCodeAt(0));
export async function verifyMessage(message, profile, head, forceFallback = false) {
  try {
    const envelope = JSON.parse(message.envelope_raw);
    const raw = canonicalize(envelope);
    if (raw !== message.envelope_raw || canonicalize(message.envelope) !== raw) return false;
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(raw))), x => x.toString(16).padStart(2, '0')).join('');
    if (hash !== message.id || envelope.seq !== head.seq + 1 || message.seq !== envelope.seq || envelope.prev_hash !== head.hash || envelope.author !== profile?.handle || envelope.author !== message.author.handle || envelope.thread_id !== 'main' || envelope.v !== 1) return false;
    const pubkey = decode(profile.pubkey);
    const sig = decode(message.sig);
    if (pubkey.length !== 32 || sig.length !== 64) return false;
    if (!forceFallback) {
      try {
        const key = await crypto.subtle.importKey('raw', pubkey, 'Ed25519', false, ['verify']);
        return await crypto.subtle.verify('Ed25519', key, sig, bytes(raw));
      } catch { /* Older browsers use the locally vendored fallback. */ }
    }
    return await verifyAsync(sig, bytes(raw), pubkey, { zip215: false });
  } catch { return false; }
}
