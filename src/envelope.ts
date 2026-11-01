import canonicalize from 'canonicalize';
import { need } from './errors';

export const ZERO_HASH = '0'.repeat(64);
export const HASH_RE = /^[0-9a-f]{64}$/;
export const HANDLE_RE = /^[a-z0-9_]{2,32}$/;
export const MAX_FILE = 100_000_000;
export interface Attachment { sha256: string; mime: string; size: number; filename: string }
export interface Envelope {
  v: 1; thread_id: string; seq: number; prev_hash: string; author: string;
  created_at: string; text: string; attachments: Attachment[];
}
export const utf8 = (value: string) => new TextEncoder().encode(value);
export function jcs(value: unknown): string {
  // JCS excludes lone surrogates and non-finite numbers (RFC 8785 §3.2.2).
  const visit = (v: any): void => {
    if (typeof v === 'number') need(Number.isFinite(v), 'invalid_json', 'Non-finite number.');
    if (typeof v === 'string') need(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v), 'invalid_json', 'Lone Unicode surrogate.');
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => { visit(k); visit(x); });
  };
  visit(value);
  const result = canonicalize(value);
  need(typeof result === 'string', 'invalid_json', 'Cannot canonicalize JSON.');
  return result;
}
export const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');
export async function sha256(value: string | Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? utf8(value) : value));
}
export function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeKey(value: string, length: number): Uint8Array {
  need(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value), 'invalid_encoding', 'Expected unpadded base64url.');
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), x => x.charCodeAt(0)); }
  catch { need(false, 'invalid_encoding', 'Invalid base64url.'); }
  need(bytes.length === length && b64url(bytes) === value, 'invalid_encoding', `Expected ${length} canonical bytes.`);
  return bytes;
}
export async function verifySignature(pubkey: string, sig: string, bytes: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', decodeKey(pubkey, 32), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, decodeKey(sig, 64), bytes);
  } catch { return false; }
}
export function attachment(value: any): asserts value is Attachment {
  need(value && HASH_RE.test(value.sha256), 'invalid_attachment', 'Expected lowercase SHA-256.');
  need(typeof value.mime === 'string' && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value.mime) && value.mime.length <= 127, 'invalid_attachment', 'Invalid MIME type.');
  need(Number.isSafeInteger(value.size) && value.size > 0 && value.size <= MAX_FILE, 'invalid_attachment', `File must be 1–${MAX_FILE} bytes.`);
  need(typeof value.filename === 'string' && value.filename.length > 0 && value.filename.length <= 255 && !/[\x00-\x1f\x7f]/.test(value.filename), 'invalid_attachment', 'Invalid filename.');
  need(Object.keys(value).sort().join(',') === 'filename,mime,sha256,size', 'invalid_attachment', 'Unexpected attachment fields.');
}
export function validateEnvelope(value: any, author: string, thread: string, now = Date.now()): asserts value is Envelope {
  need(value && Object.keys(value).sort().join(',') === 'attachments,author,created_at,prev_hash,seq,text,thread_id,v', 'invalid_envelope', 'Unexpected or missing envelope fields.');
  need(value.v === 1 && value.thread_id === thread, 'invalid_envelope', 'Wrong version or thread.');
  need(value.author === author, 'author_mismatch', 'X-Agent must equal envelope.author.');
  need(Number.isSafeInteger(value.seq) && value.seq > 0 && HASH_RE.test(value.prev_hash), 'invalid_envelope', 'Invalid sequence or previous hash.');
  need(typeof value.created_at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value.created_at) && Number.isFinite(Date.parse(value.created_at)), 'invalid_envelope', 'created_at must be an RFC 3339 UTC timestamp.');
  need(Date.parse(value.created_at) <= now + 600_000, 'future_timestamp', 'created_at is over ten minutes ahead.');
  need(typeof value.text === 'string' && [...value.text].length <= 20_000, 'invalid_text', 'Text limit is 20,000 Unicode characters.');
  need(Array.isArray(value.attachments) && value.attachments.length <= 10, 'invalid_attachment', 'At most ten attachments.');
  value.attachments.forEach(attachment);
  need(value.text.length || value.attachments.length, 'empty_message', 'Text or attachments required.');
  jcs(value);
}
export function validLink(envelope: Envelope, head: { seq: number; hash: string }): boolean {
  return envelope.seq === head.seq + 1 && envelope.prev_hash === head.hash;
}
