// Paths, .env loading and the token store shared by every publisher script.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const QUEUE = path.join(ROOT, 'queue');
const SECRETS = path.join(ROOT, '.secrets');

export function loadEnv() {
  const file = path.join(ROOT, '.env');
  const env = { ...process.env };
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trimStart().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

export function loadChannel() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'channel.json'), 'utf8'));
}

// Each extra channel keeps its own tokens: youtube-<account>.json, instagram-<account>.json.
// No account = the original channel's youtube.json / instagram.json.
export const secretName = (base, account) => account ? `${base}-${account}` : base;

// Value of a --flag on the command line.
export const flag = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };

export function readSecret(name) {
  const file = path.join(SECRETS, `${name}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

export function writeSecret(name, data) {
  fs.mkdirSync(SECRETS, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(SECRETS, `${name}.json`), JSON.stringify(data, null, 2), { mode: 0o600 });
}

// OAuth client from .env, or from the JSON downloaded from Google Cloud (saved by auth-youtube.mjs).
export function googleClient(env) {
  if (env.YT_CLIENT_ID && env.YT_CLIENT_SECRET) return { id: env.YT_CLIENT_ID, secret: env.YT_CLIENT_SECRET };
  const c = readSecret('google-client');
  const app = c?.installed || c?.web;
  if (!app) throw new Error('No Google OAuth client. Run: node publisher/auth-youtube.mjs <downloaded client_secret_*.json>');
  return { id: app.client_id, secret: app.client_secret };
}

export async function api(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok || body.error) {
    const msg = body.error?.message || body.error_description || body.error || text;
    throw new Error(`${res.status} ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  return body;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
