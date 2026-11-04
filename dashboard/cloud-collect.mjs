// Runs in GitHub Actions: rebuilds the publisher's token files from the SECRETS_JSON secret,
// restores the queue and history from the last encrypted run, collects fresh stats and writes
// the encrypted result for the phone app.
//   node dashboard/cloud-collect.mjs <previous data.enc> <queue.enc> <out data.enc>
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, QUEUE, writeSecret } from '../publisher/lib/config.mjs';
import { encrypt, decrypt } from './crypto.mjs';

const [prevFile, queueFile, outFile] = process.argv.slice(2);
const pass = process.env.DASH_PASSCODE;
if (!pass || !process.env.SECRETS_JSON) throw new Error('DASH_PASSCODE and SECRETS_JSON must be set');

for (const [name, value] of Object.entries(JSON.parse(process.env.SECRETS_JSON))) writeSecret(name, value);

if (fs.existsSync(queueFile)) {
  for (const post of decrypt(fs.readFileSync(queueFile, 'utf8'), pass)) {
    fs.mkdirSync(path.join(QUEUE, post.slug), { recursive: true });
    fs.writeFileSync(path.join(QUEUE, post.slug, 'post.json'), JSON.stringify(post));
  }
}

// data.mjs keeps its history in logs/stats-history.jsonl, so seed that from the last run.
const historyFile = path.join(ROOT, 'logs', 'stats-history.jsonl');
fs.mkdirSync(path.dirname(historyFile), { recursive: true });
let prev;
if (fs.existsSync(prevFile) && fs.statSync(prevFile).size) {
  try {
    prev = decrypt(fs.readFileSync(prevFile, 'utf8'), pass);
    fs.writeFileSync(historyFile, prev.history.map(h => JSON.stringify(h)).join('\n') + '\n');
  } catch (e) {
    console.warn(`Previous data unreadable (${e.message}); starting history fresh.`);
  }
}

const { collect } = await import('./data.mjs');
const data = await collect(prev);

// Keep every snapshot for 14 days, then one per day, so the file stays small.
const cutoff = Date.now() - 14 * 86400e3, seenDays = new Set();
data.history = data.history.filter(h => {
  if (new Date(h.at) >= cutoff) return true;
  const day = h.at.slice(0, 10);
  return !seenDays.has(day) && seenDays.add(day);
});

fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
fs.writeFileSync(outFile, encrypt(data, pass));
for (const p of data.pages) console.log(`${p.name}: ${p.totals.views} views (YT ${p.totals.ytViews} · IG ${p.totals.igViews})`);
