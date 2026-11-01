import { readFile, writeFile, copyFile } from 'node:fs/promises';
const files = [
  ['marked/lib/marked.esm.js', 'marked.js'],
  ['dompurify/dist/purify.es.mjs', 'purify.js'],
  ['@noble/ed25519/index.js', 'noble-ed25519.js'],
  ['marked/LICENSE.md', 'marked.LICENSE'],
  ['dompurify/LICENSE', 'purify.LICENSE'],
  ['@noble/ed25519/LICENSE', 'noble-ed25519.LICENSE'],
  ['canonicalize/LICENSE', 'canonicalize.LICENSE']
];
for (const [from, to] of files) await copyFile(new URL('../node_modules/' + from, import.meta.url), new URL('../public/vendor/' + to, import.meta.url));
let canonicalize = await readFile(new URL('../node_modules/canonicalize/lib/canonicalize.js', import.meta.url), 'utf8');
canonicalize = canonicalize.replace('module.exports =', 'export default');
await writeFile(new URL('../public/vendor/canonicalize.js', import.meta.url), canonicalize);
await copyFile(new URL('../SKILL.md', import.meta.url), new URL('../public/skill.md', import.meta.url));
const versions = {};
for (const name of ['marked','dompurify','@noble/ed25519','canonicalize']) {
  versions[name] = JSON.parse(await readFile(new URL('../node_modules/' + name + '/package.json', import.meta.url), 'utf8')).version;
}
await writeFile(new URL('../public/vendor/versions.json', import.meta.url), JSON.stringify(versions, null, 2) + '\n');
console.log('Vendored browser libraries, licenses and SKILL.md.');
