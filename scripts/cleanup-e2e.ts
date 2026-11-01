import { readFileSync } from 'node:fs';

// Generates reviewable SQL only. Does not contact Cloudflare or delete anything.
const path = process.argv[2];
if (!path) throw new Error('Usage: pnpm exec tsx scripts/cleanup-e2e.ts <manifest.json>');
const manifest = JSON.parse(readFileSync(path,'utf8'));
if (!Array.isArray(manifest.handles) || manifest.handles.length !== 2 || !manifest.handles.every((h: unknown) => typeof h === 'string' && /^(?:e2e_[a-z0-9]+|test)_[ab]$/.test(h))) throw new Error('Not an E2E manifest.');
if (!Array.isArray(manifest.pubkeys) || manifest.pubkeys.length !== 2 || !manifest.pubkeys.every((p: unknown) => typeof p === 'string' && /^[A-Za-z0-9_-]{43}$/.test(p))) throw new Error('Manifest must pin both public keys.');
if (manifest.initialHead?.seq !== 0 || manifest.initialHead?.hash !== '0'.repeat(64)) throw new Error('Refusing cleanup of a board that was not initially empty.');
const quote = (value: string) => "'" + value.replace(/'/g,"''") + "'";
const identities = manifest.handles.map((h: string,i: number) => `(handle=${quote(h)} AND pubkey=${quote(manifest.pubkeys[i])})`).join(' OR ');
const ids = `SELECT id FROM agents WHERE ${identities}`;
console.log(`-- One-time removal of explicitly authorized throwaway E2E data.
-- Guard refuses ANY other agent or any non-test-authored message.
-- Do not apply after real agents register. Review the pinned identities below.
UPDATE settings SET value='false' WHERE key='registration_open';
CREATE TABLE _e2e_cleanup_guard (ok INTEGER CHECK(ok=1));
INSERT INTO _e2e_cleanup_guard SELECT CASE WHEN
  (SELECT count(*) FROM agents WHERE NOT (${identities})) = 0
  AND (SELECT count(*) FROM messages WHERE author_id NOT IN (${ids})) = 0
  AND (SELECT count(*) FROM messages WHERE thread_id != 'main') = 0
THEN 1 ELSE 0 END;
DELETE FROM acks WHERE agent_id IN (${ids}) OR message_id IN (SELECT id FROM messages WHERE author_id IN (${ids}));
DELETE FROM messages WHERE author_id IN (${ids});
DELETE FROM upload_sessions WHERE agent_id IN (${ids});
DELETE FROM attachments WHERE uploader_id IN (${ids});
DELETE FROM writes WHERE identity IN (${manifest.pubkeys.map(quote).join(',')});
DELETE FROM agents WHERE ${identities};
DELETE FROM threads WHERE id='main';
INSERT INTO threads VALUES ('main','main',strftime('%Y-%m-%dT%H:%M:%SZ','now'));
UPDATE settings SET value='true' WHERE key='registration_open';
DROP TABLE _e2e_cleanup_guard;`);
