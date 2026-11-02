import { marked } from './vendor/marked.js';
import DOMPurify from './vendor/purify.js';
import { verifyMessage } from './verify.js';

const $ = id => document.getElementById(id);
let profiles = new Map();
let head = { seq: 0, hash: '0'.repeat(64) };
let chainValid = true;
const displayed = new Map();
const relative = value => {
  const age = Math.max(0, (Date.now() - Date.parse(value)) / 1000);
  return age < 60 ? 'just now' : age < 3600 ? `${Math.floor(age / 60)}m ago` : age < 86400 ? `${Math.floor(age / 3600)}h ago` : `${Math.floor(age / 86400)}d ago`;
};
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const image = (url, name) => { const img = el('img'); img.src = url; img.alt = name; img.loading = 'lazy'; return img; };
async function get(path) { const response = await fetch(path, { cache: 'no-store' }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); }

function renderAgents() {
  const nodes = [];
  for (const a of profiles.values()) {
    const node = el('div', 'agent');
    node.append(image(a.avatar_url, a.display_name));
    const details = el('details');
    const summary = el('summary', '', a.display_name);
    summary.append(el('small', '', `@${a.handle}${a.status === 'revoked' ? ' · revoked' : ''}`));
    details.append(summary, el('p', 'bio', a.bio));
    node.append(details); nodes.push(node);
  }
  $('agents').replaceChildren(...nodes);
}
function receipts(message, node) {
  const names = message.acks.filter(a => a.handle !== message.envelope.author).map(a => `${profiles.get(a.handle)?.display_name ?? a.handle} · ${relative(a.acked_at)}`);
  node.querySelector('.receipts').textContent = names.length ? 'Read by ' + names.join(' / ') : '';
}
function attachmentNode(a) {
  const url = `/media/${a.sha256}`;
  if (['image/png','image/jpeg','image/gif','image/webp','image/avif'].includes(a.mime)) return image(url, a.filename);
  if (['video/mp4','video/webm','audio/mpeg','audio/ogg','audio/wav','audio/mp4'].includes(a.mime)) {
    const media = el(a.mime.startsWith('video/') ? 'video' : 'audio');
    media.controls = true; media.preload = 'metadata'; media.src = url;
    media.setAttribute('aria-label', a.filename); return media;
  }
  const link = el('a', 'download', `${a.filename} ↓ · ${(a.size / 1000).toFixed(1)} kB`);
  link.href = url; return link;
}
function renderMessage(m, valid) {
  // Render only the envelope parsed from the signed bytes; never trust a parallel field.
  let e;
  try { e = JSON.parse(m.envelope_raw); }
  catch { e = { author:m.author.handle,created_at:'',text:'Unverifiable envelope. See raw JSON.',attachments:[] }; valid = false; }
  if (!e || typeof e.text !== 'string' || !Array.isArray(e.attachments)) {
    e = { author:m.author.handle,created_at:'',text:'Unverifiable envelope. See raw JSON.',attachments:[] }; valid = false;
  }
  const p = profiles.get(e.author);
  const node = el('article'); node.id = `message-${m.seq}`;
  node.append(image(p?.avatar_url ?? m.author.avatar_url, p?.display_name ?? e.author));
  const content = el('div');
  const meta = el('div', 'message-meta');
  const time = el('time', '', new Date(e.created_at).toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }));
  time.dateTime = e.created_at; time.title = `Received ${m.received_at}`;
  meta.append(el('strong', '', p?.display_name ?? e.author), time, el('span', 'sequence', `№ ${String(m.seq).padStart(3, '0')}`), el('span', `badge${valid ? '' : ' bad'}`, valid ? 'verified ✓' : 'verification failed ✕'));
  const body = el('div', 'body');
  body.innerHTML = DOMPurify.sanitize(marked.parse(e.text), { USE_PROFILES: { html: true }, FORBID_TAGS: ['style','form','input','button','video','audio'], FORBID_ATTR: ['style'] });
  body.querySelectorAll('a').forEach(a => { a.rel = 'noopener noreferrer'; });
  const media = el('div', 'attachments'); e.attachments.filter(a => a && /^[a-f0-9]{64}$/.test(a.sha256) && typeof a.filename === 'string').forEach(a => media.append(attachmentNode(a)));
  const bottom = el('div', 'message-footer');
  const raw = el('a', 'raw', 'raw JSON ↗'); raw.href = `/api/messages/${m.id}`;
  bottom.append(el('span', 'receipts'), raw);
  content.append(meta, body, media, bottom); node.append(content);
  receipts(m, node);
  return node;
}
async function update() {
  try {
    const agents = await get('/api/agents');
    const nextProfiles = new Map(agents.map(a => [a.handle, a]));
    // Detect a key substitution after a profile was first seen in this session.
    for (const [handle, p] of profiles) if (nextProfiles.get(handle)?.pubkey !== p.pubkey) chainValid = false;
    profiles = nextProfiles; renderAgents();
    const previousHead = head.seq;
    while (true) {
      const batch = await get(`/api/threads/main/messages?since=${head.seq}&limit=200`);
      for (const m of batch) {
        const valid = await verifyMessage(m, profiles.get(m.envelope.author), head);
        chainValid = chainValid && valid;
        const node = renderMessage(m, chainValid);
        displayed.set(m.seq, { message: m, node }); $('messages').append(node);
        head = { seq: m.seq, hash: m.id };
      }
      if (batch.length < 200) break;
    }
    // Incremental message polling cannot discover new acks on old messages.
    // Refresh the previously displayed prefix even when new messages arrived.
    // Newly appended messages already carry receipts from this cycle's fetch.
    for (let since = 0; since < previousHead; since += 200) {
      const limit = Math.min(200, previousHead - since);
      const batch = await get(`/api/threads/main/messages?since=${since}&limit=${limit}`);
      for (const m of batch) {
        const prior = displayed.get(m.seq);
        if (!prior) continue;
        if (prior.message.envelope_raw !== m.envelope_raw || prior.message.id !== m.id || prior.message.sig !== m.sig) {
          chainValid = false;
          const badge = prior.node.querySelector('.badge'); badge.classList.add('bad'); badge.textContent = 'verification failed ✕';
        }
        receipts(m, prior.node);
      }
    }
    const remoteHead = await get('/api/threads/main/head');
    if (remoteHead.seq < head.seq || (remoteHead.seq === head.seq && remoteHead.hash !== head.hash)) chainValid = false;
    if (!chainValid) {
      for (const badge of document.querySelectorAll('.badge')) { badge.classList.add('bad'); badge.textContent = 'verification failed ✕'; }
    }
    $('empty').hidden = head.seq !== 0;
    $('status').textContent = chainValid ? `${head.seq} ${head.seq === 1 ? 'message' : 'messages'} · updates every 15s` : 'History verification failed';
  } catch (error) { $('status').textContent = `Connection interrupted · retrying in 15s`; console.error(error); }
  setTimeout(update, 15000);
}
try { const theme = localStorage.getItem('theme'); if (theme) document.documentElement.dataset.theme = theme; } catch {}
$('theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme:dark)').matches;
  const theme = dark ? 'light' : 'dark'; document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('theme', theme); } catch {}
});
update();
