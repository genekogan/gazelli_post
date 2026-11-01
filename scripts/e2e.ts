import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import canonicalize from 'canonicalize';
import { verifyExport } from './verify-export';

const BASE = (process.env.BASE_URL ?? 'http://localhost:4112').replace(/\/$/,'');
const ADMIN = process.env.ADMIN_TOKEN;
if (!ADMIN) throw new Error('Set ADMIN_TOKEN in the environment (do not put production secrets in command history).');
const local = /^http:\/\/(localhost|127\.0\.0\.1):/.test(BASE);
if (!local && process.env.ALLOW_LIVE_E2E !== 'true') throw new Error('Live E2E requires ALLOW_LIVE_E2E=true and an empty board.');
const prefix = local ? 'test' : `e2e_${Date.now().toString(36)}`;
const output = process.env.E2E_OUTPUT ?? '.e2e/api';
mkdirSync(output,{recursive:true});
const checks: string[] = [];
const ok = (name: string) => { checks.push(name); console.log('PASS',name); };
const avatar = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=';
// A different tiny PNG, so the attachment exercises PUT rather than avatar deduplication.
const file = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVQIHWP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC','base64');
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Agent = { handle: string; pubkey: string; key: KeyObject };
function agent(suffix: string): Agent {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { handle:`${prefix}_${suffix}`, key:privateKey, pubkey:publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('base64url') };
}
const a = agent('a'), b = agent('b'), third = agent('closed');
let nonce = 0;
async function signed(a: Agent, path: string, body?: unknown) {
  // Distinct insignificant whitespace avoids identical request auth in one second.
  const raw = body === undefined ? '' : JSON.stringify(body) + ' '.repeat(++nonce);
  const timestamp = String(Math.floor(Date.now()/1000));
  const input = ['POST',path,timestamp,hash(raw)].join('\n');
  const response = await fetch(BASE+path,{method:'POST',headers:{'Content-Type':'application/json','X-Agent':a.handle,'X-Timestamp':timestamp,'X-Signature':sign(null,Buffer.from(input),a.key).toString('base64url')},...(raw?{body:raw}:{})});
  return {status:response.status,data:await response.json() as any};
}
async function read(path: string) {
  const response = await fetch(BASE+path);
  assert.equal(response.status,200,path);
  return response.json() as Promise<any>;
}
async function admin(open: boolean) {
  const response = await fetch(BASE+'/api/admin/registration',{method:'POST',headers:{Authorization:`Bearer ${ADMIN}`,'Content-Type':'application/json'},body:JSON.stringify({open})});
  assert.equal(response.status,200,'Admin registration toggle');
}
async function register(identity: Agent) {
  return signed(identity,'/api/agents/register',{handle:identity.handle,pubkey:identity.pubkey,display_name:identity === third?'Closed registration test':identity === a?'Test A':'Test B',bio:'Throwaway E2E test agent.',avatar:{base64:avatar,mime:'image/png'}});
}
async function message(a: Agent, text: string, attachments: any[] = [], h?: any) {
  const head = h ?? await read('/api/threads/main/head');
  const envelope = {v:1,thread_id:'main',seq:head.seq+1,prev_hash:head.hash,author:a.handle,created_at:new Date().toISOString(),text,attachments};
  return {envelope,sig:sign(null,Buffer.from(canonicalize(envelope)!),a.key).toString('base64url')};
}
const initialHead = await read('/api/threads/main/head');
assert.equal(initialHead.seq,0,'E2E requires a fresh empty main thread.');
assert.equal((await read('/api/agents')).length,0,'E2E requires no real agents.');
assert.equal((await read('/api')).registration_open,true,'Registration must start open.');
writeFileSync(`${output}/manifest.json`,JSON.stringify({base:BASE,prefix,handles:[a.handle,b.handle],pubkeys:[a.pubkey,b.pubkey],initialHead,media_sha256:hash(file)},null,2)+'\n');
try {
  assert.equal((await register(a)).status,201);
  assert.equal((await register(b)).status,201); ok('two agents register with proof of possession');
  const first = await signed(a,'/api/threads/main/messages',await message(a,'Hello, B. A message in the open.'));
  assert.equal(first.status,201); ok('A posts signed text');
  const polled = await read('/api/threads/main/messages?since=0&limit=200');
  assert.equal(polled[0].id,first.data.id); ok('B polls the new message');
  const ack = await signed(b,`/api/messages/${first.data.id}/ack`);
  assert.equal(ack.status,200);
  const again = await signed(b,`/api/messages/${first.data.id}/ack`);
  assert.equal(again.data.acked_at,ack.data.acked_at); ok('B acknowledges; first receipt retained');
  let descriptor = {sha256:hash(file),mime:'image/png',size:file.length,filename:'e2e-pixel.png'};
  const declared = await signed(b,'/api/uploads',descriptor);
  assert.equal(declared.status,201); assert.equal(declared.data.status,'pending');
  const put = await fetch(declared.data.url,{method:'PUT',headers:declared.data.headers,body:file});
  assert.equal(put.status,200,'direct PUT to returned upload URL');
  const completed = await signed(b,`/api/uploads/${descriptor.sha256}/complete`);
  assert.equal(completed.status,200); descriptor = completed.data.attachment;
  const downloaded = await fetch(BASE+'/media/'+descriptor.sha256);
  assert.equal(hash(new Uint8Array(await downloaded.arrayBuffer())),descriptor.sha256);
  const withImage = await signed(b,'/api/threads/main/messages',await message(b,'I have read it. Here is an image.',[descriptor]));
  assert.equal(withImage.status,201); ok('B uploads, verifies, fetches and posts an image');
  const sameHead = await read('/api/threads/main/head');
  const raced = await Promise.all([
    message(a,'A concurrent thought.',[],sameHead).then(body=>signed(a,'/api/threads/main/messages',body)),
    message(b,'B concurrent thought.',[],sameHead).then(body=>signed(b,'/api/threads/main/messages',body))
  ]);
  assert.deepEqual(raced.map(r=>r.status).sort(),[201,409]);
  const loser = raced[0].status===409?a:b;
  const conflict = raced.find(r=>r.status===409)!;
  assert.equal(conflict.data.error.code,'chain_conflict'); assert.equal(conflict.data.head.seq,3);
  const retried = await signed(loser,'/api/threads/main/messages',await message(loser,'A fresh signature after the new head.'));
  assert.equal(retried.status,201); ok('one concurrent post conflicts; fresh envelope retry succeeds');
  const exported = await read('/api/threads/main/export');
  assert.equal(verifyExport(exported).seq,4);
  writeFileSync(`${output}/export.json`,JSON.stringify(exported,null,2)+'\n');
  const tampered = structuredClone(exported); tampered.messages[0].envelope_raw = tampered.messages[0].envelope_raw.replace('Hello','Altered');
  assert.throws(()=>verifyExport(tampered)); ok('independent Node verification accepts chain and rejects tampering');
  await admin(false);
  const denied = await register(third);
  assert.equal(denied.status,403); assert.equal(denied.data.error.code,'registration_closed'); ok('admin closure rejects a third registration');
  const skill = await fetch(BASE+'/skill.md');
  assert.equal(skill.status,200); const guide = await skill.text();
  assert.match(skill.headers.get('Content-Type')??'',/text\/markdown/); assert.match(guide,/TEST_VECTORS_START/); ok('self-contained skill is served as Markdown');
} finally {
  await admin(true);
  writeFileSync(`${output}/summary.json`,JSON.stringify({status:checks.length===9?'pass':'fail',base:BASE,checks,registration_open:true},null,2)+'\n');
}
console.log(`All ${checks.length} API E2E checks passed. Registration reopened. Evidence: ${output}`);
