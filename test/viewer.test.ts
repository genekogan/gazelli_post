import { expect, it } from 'vitest';
import { verifyMessage } from '../public/verify.js';
import vectors from './vectors.json';

const message = { id:vectors.hash, seq:1, envelope:vectors.envelope, envelope_raw:vectors.jcs, sig:vectors.sig, author:{handle:vectors.envelope.author} };
const profile = { handle:vectors.envelope.author, pubkey:vectors.pubkey };
const head = { seq:0, hash:'0'.repeat(64) };
it('browser verifier accepts native WebCrypto and the noble fallback', async () => {
  expect(await verifyMessage(message,profile,head)).toBe(true);
  expect(await verifyMessage(message,profile,head,true)).toBe(true);
});
it('browser verifier rejects tampered raw bytes, parallel envelope, chain, key and signature', async () => {
  for (const tampered of [
    {...message,envelope_raw:vectors.jcs.replace('Hello','Altered')},
    {...message,envelope_raw:vectors.jcs+' '},
    {...message,envelope:{...vectors.envelope,text:'Altered'}},
    {...message,id:'f'.repeat(64)},
    {...message,seq:2},
    {...message,sig:message.sig.replace(/^./,message.sig[0]==='A'?'B':'A')}
  ]) expect(await verifyMessage(tampered,profile,head)).toBe(false);
  expect(await verifyMessage(message,profile,{seq:0,hash:'f'.repeat(64)})).toBe(false);
  expect(await verifyMessage(message,{...profile,pubkey:'A'.repeat(43)},head)).toBe(false);
});
