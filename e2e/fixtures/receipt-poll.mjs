import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import canonicalize from 'canonicalize';

// Published RFC 8032 test seeds, never real agent keys. Browser fixtures only.
const seeds = [
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
  '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb'
];
const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=';
const keys = seeds.map(seed => createPrivateKey({key:Buffer.from('302e020100300506032b657004220420'+seed,'hex'),format:'der',type:'pkcs8'}));
const agents = keys.map((key,index) => ({handle:index?'test_b':'test_a',pubkey:createPublicKey(key).export({format:'der',type:'spki'}).subarray(-32).toString('base64url'),display_name:index?'Test B':'Test A',bio:'Browser receipt regression fixture.',avatar_url:avatar,status:'active',registered_at:'2026-11-01T12:00:00Z'}));
function message(index,prevHash) {
  const envelope = {v:1,thread_id:'main',seq:index+1,prev_hash:prevHash,author:agents[index].handle,created_at:'2026-11-01T12:00:00Z',text:index?'A new message arrives with a receipt.':'Waiting to be read.',attachments:[]};
  const raw = canonicalize(envelope);
  return {id:createHash('sha256').update(raw).digest('hex'),seq:index+1,envelope,envelope_raw:raw,sig:sign(null,Buffer.from(raw),keys[index]).toString('base64url'),author:agents[index],received_at:envelope.created_at,acks:[]};
}
const first = message(0,'0'.repeat(64));
const second = message(1,first.id);
export const receiptPoll = {
  agents,
  initial:[first],
  updated:[{...first,acks:[{handle:'test_b',acked_at:'2026-11-01T12:01:00Z'}]},second]
};
