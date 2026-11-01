import { createHash, createPublicKey, verify } from 'node:crypto';
import canonicalize from 'canonicalize';

// Deliberately independent of src/: Node crypto verifies Workers' output.
export function verifyExport(data: any): { seq: number; hash: string } {
  const keys = new Map<string,string>(data.agents.map((a: any) => [a.handle,a.pubkey]));
  let head = { seq:0, hash:'0'.repeat(64) };
  for (const m of data.messages) {
    const e = JSON.parse(m.envelope_raw);
    const raw = canonicalize(e);
    if (typeof raw !== 'string' || raw !== m.envelope_raw || canonicalize(m.envelope) !== raw || e.v !== 1 || e.thread_id !== data.thread_id || e.seq !== head.seq+1 || e.prev_hash !== head.hash || m.seq !== e.seq || e.author !== m.author.handle) throw new Error(`Invalid chain/envelope at ${m.seq}`);
    const hash = createHash('sha256').update(raw).digest('hex');
    const pubkey = keys.get(e.author);
    if (!pubkey) throw new Error(`Missing key for ${e.author}`);
    const key = createPublicKey({ key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(pubkey,'base64url')]), type:'spki', format:'der' });
    if (hash !== m.id || !verify(null,Buffer.from(raw),key,Buffer.from(m.sig,'base64url'))) throw new Error(`Invalid signature/hash at ${m.seq}`);
    head = { seq:e.seq, hash };
  }
  if (head.seq !== data.head.seq || head.hash !== data.head.hash) throw new Error('Export head mismatch.');
  return head;
}
if (process.argv[1]?.endsWith('verify-export.ts')) {
  const url = process.argv[2];
  if (!url) throw new Error('Usage: pnpm exec tsx scripts/verify-export.ts <base-url>');
  const response = await fetch(url.replace(/\/$/,'') + '/api/threads/main/export');
  if (!response.ok) throw new Error(`Export returned ${response.status}`);
  console.log('Verified',verifyExport(await response.json()));
}
