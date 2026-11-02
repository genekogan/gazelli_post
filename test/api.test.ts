import { beforeAll, describe, expect, it, vi } from 'vitest';
import { env as bindings } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { app } from '../src/index';
import { b64url, jcs, sha256, utf8 } from '../src/envelope';
import { signingInput } from '../src/auth';
import type { Env } from '../src/types';
import { validateWebhook } from '../src/webhooks';
import { localUploads, cleanup } from '../src/media';

const env = bindings as unknown as Env;
const avatar = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=';
const png = Uint8Array.from(atob(avatar), c => c.charCodeAt(0));
type Identity = { handle: string; pubkey: string; key: CryptoKey };
async function identity(handle: string): Promise<Identity> {
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign','verify']) as CryptoKeyPair;
  return { handle, pubkey: b64url(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey) as ArrayBuffer)), key: keys.privateKey };
}
async function sign(a: Identity, value: string): Promise<string> { return b64url(new Uint8Array(await crypto.subtle.sign('Ed25519', a.key, utf8(value)))); }
let nonce = 0;
async function call(path: string, method = 'GET', body?: unknown, a?: Identity, timestamp = String(Math.floor(Date.now() / 1000))) {
  const raw = body === undefined ? '' : JSON.stringify(body) + ' '.repeat(++nonce);
  const headers: Record<string,string> = { 'Content-Type':'application/json' };
  if (a) Object.assign(headers, { 'X-Agent':a.handle, 'X-Timestamp':timestamp, 'X-Signature':await sign(a, signingInput(method, path, timestamp, await sha256(raw))) });
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request('http://localhost' + path, { method, headers, ...(raw ? { body:raw } : {}) }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status:response.status, data:await response.json() as any, headers:response.headers };
}
async function admin(path: string, body: unknown) {
  const ctx = createExecutionContext();
  const r = await app.fetch(new Request('http://localhost/api/admin' + path, { method:'POST', headers:{ Authorization:'Bearer local-test-admin' }, body:JSON.stringify(body) }), env, ctx);
  return { status:r.status, data:await r.json() as any };
}
async function register(a: Identity, fields: any = {}) {
  return call('/api/agents/register', 'POST', { handle:a.handle, pubkey:a.pubkey, display_name:a.handle, bio:'A test agent.', avatar:{ base64:avatar, mime:'image/png' }, ...fields }, a);
}
async function envelope(a: Identity, fields: any = {}) {
  const h = (await call('/api/threads/main/head')).data;
  const e = { v:1, thread_id:'main', seq:h.seq+1, prev_hash:h.hash, author:a.handle, created_at:new Date().toISOString(), text:'Hello.', attachments:[], ...fields };
  return { envelope:e, sig:await sign(a, jcs(e)) };
}
let a: Identity, b: Identity;
beforeAll(async () => {
  await applyD1Migrations(env.DB, (bindings as any).TEST_MIGRATIONS);
  a = await identity('test_a'); b = await identity('test_b');
  expect((await register(a)).status).toBe(201);
  expect((await register(b, {website:'https://example.org'})).status).toBe(201);
});
describe('D1-backed API and R2 integration', () => {
  it('registers automatically, keeps webhooks private, requires profile and key possession', async () => {
    expect((await call('/api/agents')).data.map((a: any) => a.handle)).toEqual(['test_a','test_b']);
    expect((await call('/api/agents/test_a')).data).not.toHaveProperty('webhook_url');
    expect((await register(a)).status).toBe(409);
    const bad = await identity('bad_profile');
    expect((await register(bad, { bio:'' })).data.error.code).toBe('invalid_profile');
    expect((await register(bad, { avatar:{base64:btoa('html'),mime:'image/png'} })).status).toBe(400);
    expect((await call('/api/agents/register','POST',{handle:'no_key',pubkey:a.pubkey})).status).toBe(400);
  });
  it('publishes and updates optional websites while rejecting unsafe links', async () => {
    expect((await call('/api/agents/test_a')).data.website).toBeNull();
    expect((await call('/api/agents/test_b')).data.website).toBe('https://example.org/');
    expect((await call('/api/agents')).data.find((p: any) => p.handle === b.handle).website).toBe('https://example.org/');
    for (const website of ['javascript:alert(1)', 'data:text/html,bad', 'https://user:pass@example.org', 'relative', 42, 'https://example.org/'+'a'.repeat(2048)]) {
      expect((await call('/api/agents/me','PATCH',{website},b)).data.error.code).toBe('invalid_profile');
    }
    const c = await identity('bad_website');
    expect((await register(c,{website:'javascript:alert(1)'})).data.error.code).toBe('invalid_profile');
    expect((await call('/api/agents/me','PATCH',{website:'https://abraham.ai'},b)).data.website).toBe('https://abraham.ai/');
    expect((await call('/api/agents/me','PATCH',{bio:'Website is preserved.'},b)).data.website).toBe('https://abraham.ai/');
    expect((await call('/api/agents/me','PATCH',{website:null},b)).data.website).toBeNull();
  });
  it('rejects stale and invalid signatures and immutable identity updates', async () => {
    expect((await call('/api/agents/me','PATCH',{bio:'changed'},a,'1')).status).toBe(401);
    expect((await call('/api/agents/me','PATCH',{handle:'new'},a)).status).toBe(400);
    expect((await call('/api/agents/me','PATCH',{avatar:false},a)).status).toBe(400);
    const impostor = { ...b, handle:a.handle };
    expect((await call('/api/agents/me','PATCH',{bio:'forged'},impostor)).data.error.code).toBe('bad_signature');
    expect((await call('/api/agents/me','PATCH',{bio:'A longer biography.'},a)).status).toBe(200);
  });
  it('returns a client error for malformed attachment metadata before creating an upload', async () => {
    const descriptor = {sha256:'c'.repeat(64),mime:'image/png',size:1,filename:'drawing.png'};
    for (const fields of [{sha256:[descriptor.sha256]},{filename:'bad\ud800.png'},{filename:'bad\udc00.png'}]) {
      const result = await call('/api/uploads','POST',{...descriptor,...fields},a);
      expect(result.status).toBe(400);
      expect(result.data.error.code).toBe('invalid_attachment');
    }
    expect(await env.DB.prepare('SELECT sha256 FROM attachments WHERE sha256=?').bind(descriptor.sha256).first()).toBeNull();
  });
  it('rejects author mismatch, wrong envelope sig, unverified media, future time and oversize text', async () => {
    for (const [fields, expected] of [[{author:b.handle},'author_mismatch'], [{attachments:[{sha256:'f'.repeat(64),mime:'image/png',size:100,filename:'x.png'}]},'unverified_attachment'], [{text:'x'.repeat(20001)},'invalid_text'], [{created_at:'2099-01-01T00:00:00Z'},'future_timestamp']] as const) {
      const r = await call('/api/threads/main/messages','POST',await envelope(a,fields),a);
      expect(r.data.error.code).toBe(expected);
    }
    const e = await envelope(a);
    e.sig = await sign(b, jcs(e.envelope));
    expect((await call('/api/threads/main/messages','POST',e,a)).data.error.code).toBe('bad_envelope_signature');
  });
  it('enforces both sequence and previous hash atomically under concurrency', async () => {
    expect((await call('/api/threads/main/messages','POST',await envelope(a,{prev_hash:'f'.repeat(64)}),a)).status).toBe(409);
    expect((await call('/api/threads/main/messages','POST',await envelope(a,{seq:99}),a)).status).toBe(409);
    const ea = await envelope(a), eb = await envelope(b);
    const results = await Promise.all([call('/api/threads/main/messages','POST',ea,a),call('/api/threads/main/messages','POST',eb,b)]);
    expect(results.map(r => r.status).sort()).toEqual([201,409]);
    const conflict = results.find(r => r.status === 409)!;
    expect(conflict.data.head.seq).toBe(1);
    const loser = results[0].status === 409 ? a : b;
    expect((await call('/api/threads/main/messages','POST',await envelope(loser),loser)).status).toBe(201);
  });
  it('acks idempotently and exports every key and exact canonical envelope', async () => {
    const list = (await call('/api/threads/main/messages?since=0&limit=200')).data;
    const id = list[0].id;
    const first = await call(`/api/messages/${id}/ack`,'POST',undefined,b);
    const second = await call(`/api/messages/${id}/ack`,'POST',undefined,b);
    expect(second.data.acked_at).toBe(first.data.acked_at);
    expect((await call(`/api/messages/${id}`)).data.acks).toEqual([{handle:b.handle,acked_at:first.data.acked_at}]);
    const exported = (await call('/api/threads/main/export')).data;
    expect(exported.agents).toHaveLength(2);
    expect(exported.messages).toHaveLength(2);
    for (const m of exported.messages) expect(jcs(m.envelope)).toBe(m.envelope_raw);
    expect((await call('/api/threads/main/messages?limit=201')).status).toBe(400);
  });
  it('completes uploads, serves ranges/conditional requests, prevents overwrite and renders unsafe MIME as downloads', async () => {
    const bytes = utf8('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const hash = await sha256(bytes);
    const descriptor = {sha256:hash,mime:'image/svg+xml',size:bytes.length,filename:'drawing-🎨.svg'};
    const upload = await call('/api/uploads','POST',descriptor,b);
    expect(upload.status).toBe(201);
    const url = new URL(upload.data.url);
    const ctx = createExecutionContext();
    const put = await app.fetch(new Request(url,{method:'PUT',headers:{'Content-Type':descriptor.mime,'Content-Length':String(bytes.length)},body:bytes}),env,ctx);
    expect(put.status).toBe(200);
    expect((await call(`/api/uploads/${hash}/complete`,'POST',undefined,a)).status).toBe(404);
    expect((await call(`/api/uploads/${hash}/complete`,'POST',undefined,b)).status).toBe(200);
    const full = await app.fetch(new Request(`http://localhost/media/${hash}`),env,ctx);
    expect(full.headers.get('Content-Disposition')).toContain('attachment');
    expect(full.headers.get('Content-Disposition')).toContain("filename*=UTF-8''drawing-%F0%9F%8E%A8.svg");
    expect(full.headers.get('Content-Security-Policy')).toBe('sandbox');
    expect(full.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes);
    await waitOnExecutionContext(ctx);
    const range = await app.fetch(new Request(`http://localhost/media/${hash}`,{headers:{Range:'bytes=1-4'}}),env,createExecutionContext());
    expect(range.status).toBe(206); expect(await range.text()).toBe('svg ');
    const notModified = await app.fetch(new Request(`http://localhost/media/${hash}`,{headers:{'If-None-Match':`"${hash}"`}}),env,createExecutionContext());
    expect(notModified.status).toBe(304);
    const invalid = await app.fetch(new Request(`http://localhost/media/${hash}`,{headers:{Range:'bytes=900-'}}),env,createExecutionContext());
    expect(invalid.status).toBe(416);
    const again = await call('/api/uploads','POST',descriptor,b);
    expect(again.data.status).toBe('verified'); expect(again.data.url).toBeUndefined();
    const expired = await app.fetch(new Request(url,{method:'PUT',headers:{'Content-Type':descriptor.mime,'Content-Length':String(bytes.length)},body:bytes}),env,createExecutionContext());
    expect(expired.status).toBe(404);
    expect((await call('/api/threads/main/messages','POST',await envelope(b,{text:'',attachments:[descriptor]}),b)).status).toBe(201);
  });
  it('deletes bad bytes and cannot enable dev uploads on a production host', async () => {
    const descriptor = {sha256:'e'.repeat(64),mime:'image/png',size:png.length,filename:'bad.png'};
    const upload = await call('/api/uploads','POST',descriptor,a);
    const url = new URL(upload.data.url);
    const put = await app.fetch(new Request(url,{method:'PUT',headers:{'Content-Type':descriptor.mime,'Content-Length':String(png.length)},body:png}),env,createExecutionContext());
    expect(put.status).toBe(200);
    expect((await call(`/api/uploads/${descriptor.sha256}/complete`,'POST',undefined,a)).status).toBe(422);
    expect(await env.MEDIA.head(`pending/${upload.data.upload_id}`)).toBeNull();
    expect(localUploads(env,'https://gazelli-post.example.workers.dev')).toBe(false);
    expect(localUploads({...env,DEV_DIRECT_UPLOAD:'false'},'http://localhost')).toBe(false);
    await cleanup(env);
  });
  it('presigns only temporary keys and binds declared MIME, byte length and expiry', async () => {
    const path = '/api/uploads';
    const body = JSON.stringify({sha256:'d'.repeat(64),mime:'application/octet-stream',size:12,filename:'test.bin'});
    const timestamp = String(Math.floor(Date.now()/1000));
    const request = new Request('https://gazelli-post.example.workers.dev'+path,{method:'POST',body,headers:{'X-Agent':a.handle,'X-Timestamp':timestamp,'X-Signature':await sign(a,signingInput('POST',path,timestamp,await sha256(body)))}});
    const response = await app.fetch(request,{...env,DEV_DIRECT_UPLOAD:'false',R2_ACCESS_KEY_ID:'public-test-access-key',R2_SECRET_ACCESS_KEY:'public-test-secret-not-a-real-credential',R2_ACCOUNT_ID:'a'.repeat(32)},createExecutionContext());
    expect(response.status).toBe(201);
    const data = await response.json() as any;
    const url = new URL(data.url);
    expect(url.hostname).toBe('a'.repeat(32)+'.r2.cloudflarestorage.com');
    expect(url.pathname).toMatch(/^\/gazelli-post-media\/pending\/[a-f0-9-]+$/);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(data.headers).toEqual({'Content-Type':'application/octet-stream','Content-Length':'12'});
  });
  it('sends only IDs through best-effort webhooks and keeps destinations private', async () => {
    const mock = vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('',{status:200}));
    try {
      expect((await call('/api/agents/me','PATCH',{webhook_url:'https://receiver.example.org/events'},b)).status).toBe(200);
      const posted = await call('/api/threads/main/messages','POST',await envelope(a),a);
      expect(mock).toHaveBeenCalledTimes(1);
      const init = mock.mock.calls[0][1] as RequestInit;
      expect(JSON.parse(init.body as string)).toEqual({event:'message',thread_id:'main',seq:posted.data.seq,id:posted.data.id});
      expect(init.redirect).toBe('error'); expect(init.signal).toBeDefined();
      const byB = await call('/api/threads/main/messages','POST',await envelope(b),b);
      await call(`/api/messages/${byB.data.id}/ack`,'POST',undefined,a);
      expect(mock).toHaveBeenCalledTimes(2);
      expect(JSON.parse(mock.mock.calls[1][1]!.body as string)).toEqual({event:'ack',message_id:byB.data.id,by:a.handle});
      expect((await call('/api/agents/test_b')).data.webhook_url).toBeUndefined();
    } finally { mock.mockRestore(); await call('/api/agents/me','PATCH',{webhook_url:null},b); }
    for (const url of ['http://receiver.example.org','https://127.0.0.1','https://[::1]','https://x.local','https://user:pass@x.example.org','https://x.example.org:8080']) expect(() => validateWebhook(url)).toThrow();
  });
  it('revocation blocks writes, closure blocks registration, admin-only thread creation', async () => {
    expect((await admin(`/agents/${a.handle}/revoke`,{revoked:true})).status).toBe(200);
    expect((await call('/api/agents/me','PATCH',{bio:'should fail'},a)).status).toBe(403);
    expect((await call('/api/threads/main/export')).data.messages.length).toBeGreaterThan(0);
    expect((await admin(`/agents/${a.handle}/revoke`,{revoked:false})).status).toBe(200);
    expect((await admin('/threads',{id:'future',title:'Future'})).status).toBe(201);
    expect((await call('/api/threads/future/head')).data.seq).toBe(0);
    expect((await call('/api/admin/registration','POST',{open:false},a)).status).toBe(401);
    expect((await admin('/registration',{open:false})).status).toBe(200);
    expect((await register(await identity('third_agent'))).data.error.code).toBe('registration_closed');
    expect((await admin('/registration',{open:true})).status).toBe(200);
  });
  it('enforces a rolling per-key write limit with Retry-After', async () => {
    const limited = await identity('rate_test');
    expect((await register(limited)).status).toBe(201);
    for (let i=0;i<59;i++) expect((await call('/api/agents/me','PATCH',{bio:`Change ${i}`},limited)).status).toBe(200);
    const blocked = await call('/api/agents/me','PATCH',{bio:'too many'},limited);
    expect(blocked.status).toBe(429); expect(blocked.headers.get('Retry-After')).toBe('600');
  });
});
