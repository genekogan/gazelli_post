import { describe, it, expect } from 'vitest';
import { attachment, jcs, sha256, verifySignature, utf8, validateEnvelope, validLink, ZERO_HASH } from '../src/envelope';
import { verifyRequest, signingInput } from '../src/auth';
import vectors from './vectors.json';

describe('portable crypto contract', () => {
  it('canonicalizes recursively, Unicode and numbers per JCS', () => {
    expect(jcs({ z: -0, a: { b: 1e30, a: '🌱' } })).toBe('{"a":{"a":"🌱","b":1e+30},"z":0}');
    expect(() => jcs({ a: '\ud800' })).toThrow();
    expect(() => jcs({ a: Infinity })).toThrow();
  });
  it('matches fixed independently signed vectors', async () => {
    expect(jcs(vectors.envelope)).toBe(vectors.jcs);
    expect(await sha256(vectors.jcs)).toBe(vectors.hash);
    expect(await verifySignature(vectors.pubkey, vectors.sig, utf8(vectors.jcs))).toBe(true);
    expect(await verifySignature(vectors.pubkey, vectors.sig, utf8(vectors.jcs + ' '))).toBe(false);
  });
  it('rejects coerced hashes and filenames that cannot form valid UTF-8 headers', () => {
    const descriptor = { sha256:'a'.repeat(64),mime:'image/png',size:1,filename:'drawing-🎨.png' };
    expect(() => attachment(descriptor)).not.toThrow();
    expect(() => attachment({...descriptor,sha256:[descriptor.sha256]})).toThrow();
    for (const filename of ['bad\ud800.png','bad\udc00.png']) {
      expect(() => attachment({...descriptor,filename})).toThrow();
    }
  });
  it('authenticates exact raw body, query and timestamp', async () => {
    const r = vectors.request;
    const req = new Request('https://board.example' + r.path, { method: r.method, headers: { 'X-Agent': vectors.envelope.author, 'X-Timestamp': r.timestamp, 'X-Signature': r.sig }, body: r.body });
    expect(signingInput(r.method, r.path, r.timestamp, await sha256(r.body))).toBe(r.signed_string);
    await verifyRequest(req, r.body, vectors.pubkey, vectors.envelope.author, Number(r.timestamp) * 1000);
    await expect(verifyRequest(req, r.body, vectors.pubkey, vectors.envelope.author, (Number(r.timestamp) + 301) * 1000)).rejects.toMatchObject({ code: 'stale_timestamp' });
    await expect(verifyRequest(req, r.body + ' ', vectors.pubkey, vectors.envelope.author, Number(r.timestamp) * 1000)).rejects.toMatchObject({ code: 'bad_signature' });
  });
  it('enforces author, size, time, schema and chain', () => {
    const e = vectors.envelope;
    validateEnvelope(e, e.author, 'main', Date.parse(e.created_at));
    expect(validLink(e as any, { seq: 0, hash: ZERO_HASH })).toBe(true);
    expect(validLink({ ...e, seq: 2 } as any, { seq: 0, hash: ZERO_HASH })).toBe(false);
    expect(validLink({ ...e, prev_hash: 'f'.repeat(64) } as any, { seq: 0, hash: ZERO_HASH })).toBe(false);
    expect(() => validateEnvelope(e, 'botto', 'main')).toThrow();
    expect(() => validateEnvelope({...e,prev_hash:[ZERO_HASH]}, e.author, 'main')).toThrow();
    expect(() => validateEnvelope({ ...e, text: 'x'.repeat(20001) }, e.author, 'main')).toThrow();
    expect(() => validateEnvelope(e, e.author, 'main', 0)).toThrow();
  });
});
