import { beforeAll, describe, expect, it } from 'vitest';
import { env as bindings } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { app } from '../src/index';
import { b64url, sha256, utf8 } from '../src/envelope';
import { signingInput } from '../src/auth';
import type { Env } from '../src/types';

const password = 'local-only:pássword';
const basic = (value = password, username = 'any') => 'Basic ' + btoa(String.fromCharCode(...utf8(username + ':' + value)));
const env = { ...bindings, ADMIN_TOKEN:'test-admin', ASSETS:{fetch:async () => new Response('static asset')} } as unknown as Env;
const privateEnv = { ...env, BOARD_PASSWORD:password };
async function call(path: string, options: RequestInit = {}, config: Env = privateEnv) {
  const ctx = createExecutionContext();
  const r = await app.fetch(new Request('https://board.example'+path,options),config,ctx);
  await waitOnExecutionContext(ctx);
  return r;
}
beforeAll(async () => applyD1Migrations(env.DB, (bindings as any).TEST_MIGRATIONS));
describe('optional shared board password', () => {
  it('challenges every unauthenticated route and method except GET /api', async () => {
    for (const [method,path] of [['GET','/'],['GET','/style.css'],['GET','/vendor/marked.js'],['GET','/skill.md'],['GET','/api/agents'],['GET','/media/'+'a'.repeat(64)],['POST','/api/agents/register'],['GET','/missing'],['HEAD','/api'],['OPTIONS','/api/agents']]) {
      const r = await call(path,{method});
      expect(r.status, method+' '+path).toBe(401);
      expect(r.headers.get('WWW-Authenticate')).toBe('Basic realm="gazelli_board", charset="UTF-8"');
      expect(r.headers.get('Cache-Control')).toBe('no-store');
    }
    for (const header of [basic('wrong'),'Basic not-base64!','Bearer token','Basic '+btoa('no-colon')]) {
      expect((await call('/',{headers:{Authorization:header}})).status).toBe(401);
    }
  });
  it('accepts any username, UTF-8 and colons in passwords and gates static assets', async () => {
    for (const username of ['agent','','other person']) {
      const r = await call('/style.css',{headers:{Authorization:basic(password,username)}});
      expect(r.status).toBe(200);
      expect(await r.text()).toBe('static asset');
      expect(r.headers.get('Cache-Control')).toBe('private, no-store');
    }
  });
  it('leaves GET /api open with either mode and restores public routing when unset', async () => {
    for (const config of [env,privateEnv]) {
      const r = await call('/api?health=1',{},config);
      expect(r.status).toBe(200);
      expect((await r.json() as any).private).toBe(!!config.BOARD_PASSWORD);
    }
    for (const path of ['/','/style.css','/api/agents','/skill.md']) expect((await call(path,{},env)).status).toBe(200);
  });
  it('requires Basic auth in addition to unchanged request signatures', async () => {
    const keys = await crypto.subtle.generateKey('Ed25519',true,['sign','verify']) as CryptoKeyPair;
    const pubkey = b64url(new Uint8Array(await crypto.subtle.exportKey('raw',keys.publicKey) as ArrayBuffer));
    const body = JSON.stringify({handle:'private_agent',pubkey,display_name:'Private agent',bio:'Local test.',avatar:{mime:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII='}});
    const timestamp = String(Math.floor(Date.now()/1000));
    const input = signingInput('POST','/api/agents/register',timestamp,await sha256(body));
    const headers = {'X-Agent':'private_agent','X-Timestamp':timestamp,'X-Signature':b64url(new Uint8Array(await crypto.subtle.sign('Ed25519',keys.privateKey,utf8(input))))};
    expect((await call('/api/agents/register',{method:'POST',body,headers})).status).toBe(401);
    const r = await call('/api/agents/register',{method:'POST',body,headers:{...headers,Authorization:basic()}});
    expect(r.status).toBe(201);
    const profile = await r.json() as any;
    const cacheKey = new Request('https://board.example'+profile.avatar_url);
    await caches.default.put(cacheKey,new Response('shared cache sentinel',{headers:{'Cache-Control':'public, max-age=3600'}}));
    const media = await call(profile.avatar_url,{headers:{Authorization:basic()}});
    expect(media.status).toBe(200);
    expect(media.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
    expect((await media.arrayBuffer()).byteLength).toBe(68);
    expect(await (await caches.default.match(cacheKey))?.text()).toBe('shared cache sentinel');
    const range = await call(profile.avatar_url,{headers:{Authorization:basic(),Range:'bytes=0-3'}});
    expect(range.status).toBe(206);
    expect(range.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
    await caches.default.delete(cacheKey);
    expect((await call('/api/agents/me',{method:'PATCH',body:'{"bio":"Unsigned"}',headers:{Authorization:basic()}})).status).toBe(401);
  });
  it('keeps independent admin authorization available in both modes', async () => {
    const path = '/api/admin/registration';
    const body = '{"open":true}';
    expect((await call(path,{method:'POST',body,headers:{Authorization:basic()}})).status).toBe(401);
    expect((await call(path,{method:'POST',body,headers:{Authorization:basic(),'X-Admin-Token':'test-admin'}})).status).toBe(200);
    expect((await call(path,{method:'POST',body,headers:{Authorization:'Bearer test-admin'}},env)).status).toBe(200);
  });
});
