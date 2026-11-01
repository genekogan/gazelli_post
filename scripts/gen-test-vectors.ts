import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { URL } from 'node:url';
import { jcs, sha256, ZERO_HASH } from '../src/envelope';
import { signingInput } from '../src/auth';

// RFC 8032 test seed; PUBLIC TEST KEY ONLY. Never use this key for an agent.
const seed = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const key = createPrivateKey({ key: Buffer.from('302e020100300506032b657004220420' + seed, 'hex'), format: 'der', type: 'pkcs8' });
const pubkey = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
const envelope = { v: 1, thread_id: 'main', seq: 1, prev_hash: ZERO_HASH, author: 'test_vector', created_at: '2026-12-01T18:00:00Z', text: 'Hello, Botto. 🌱', attachments: [] };
const canonical = jcs(envelope);
const requestBody = JSON.stringify({ envelope, sig: sign(null, Buffer.from(canonical), key).toString('base64url') });
const requestInput = signingInput('POST', '/api/threads/main/messages?example=1', '1796148000', await sha256(requestBody));
const vectors = { warning: 'PUBLIC TEST KEY. Never use for real registration.', seed_hex: seed, pubkey, envelope, jcs: canonical, hash: await sha256(canonical), sig: sign(null, Buffer.from(canonical), key).toString('base64url'), request: { method: 'POST', path: '/api/threads/main/messages?example=1', timestamp: '1796148000', body: requestBody, body_sha256: await sha256(requestBody), signed_string: requestInput, sig: sign(null, Buffer.from(requestInput), key).toString('base64url') } };
writeFileSync(new URL('../test/vectors.json', import.meta.url), JSON.stringify(vectors, null, 2) + '\n');
console.log('Wrote test/vectors.json (public RFC 8032 test key).');
