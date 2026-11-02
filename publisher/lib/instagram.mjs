// Instagram API (Instagram Login or Meta unified login): token refresh + resumable Reel upload and publish.
// Instagram-login tokens ("IG…") use graph.instagram.com and expire after 60 days, so they are refreshed weekly.
// Facebook/system-user tokens ("EAA…") use graph.facebook.com and don't expire.
import fs from 'node:fs';
import { api, readSecret, writeSecret, sleep, secretName } from './config.mjs';

const REFRESH_EVERY = 7 * 24 * 3600 * 1000;

export const hostFor = token => token.startsWith('EAA') ? 'https://graph.facebook.com' : 'https://graph.instagram.com';

export async function auth(account) {
  const name = secretName('instagram', account);
  const t = readSecret(name);
  if (!t?.access_token) throw new Error(`No Instagram token yet. Run: node publisher/ig-token.mjs${account ? ` --account ${account}` : ''}`);
  t.host ||= hostFor(t.access_token);
  if (t.host.includes('instagram') && Date.now() - (t.refreshed_at || 0) > REFRESH_EVERY) {
    const j = await api(`${t.host}/refresh_access_token?grant_type=ig_refresh_token&access_token=${t.access_token}`);
    t.access_token = j.access_token;
    t.refreshed_at = Date.now();
    t.expires_at = Date.now() + j.expires_in * 1000;
    writeSecret(name, t);
  }
  return t;
}

export async function whoami(token, userId) {
  const host = hostFor(token);
  if (host.includes('instagram')) return api(`${host}/me?fields=user_id,username&access_token=${token}`);
  const me = await api(`${host}/${userId}?fields=id,username&access_token=${token}`);
  return { user_id: me.id, username: me.username };
}

export async function publishReel(env, { file, caption, account }) {
  const { access_token, user_id, host } = await auth(account);
  const v = env.IG_API_VERSION || 'v23.0';
  const size = fs.statSync(file).size;

  const container = await api(`${host}/${v}/${user_id}/media`, {
    method: 'POST',
    body: new URLSearchParams({ media_type: 'REELS', upload_type: 'resumable', caption, share_to_feed: 'true', access_token }),
  });
  const uploadUrl = container.uri || `https://rupload.facebook.com/ig-api-upload/${v}/${container.id}`;
  await api(uploadUrl, {
    method: 'POST',
    headers: { Authorization: `OAuth ${access_token}`, offset: '0', file_size: String(size) },
    body: fs.readFileSync(file),
  });

  // Instagram transcodes the upload before it can be published.
  for (let i = 0; ; i++) {
    const s = await api(`${host}/${v}/${container.id}?fields=status_code,status&access_token=${access_token}`);
    if (s.status_code === 'FINISHED') break;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error(`Instagram processing failed: ${s.status}`);
    if (i >= 60) throw new Error('Instagram processing timed out after 10 min');
    await sleep(10_000);
  }

  const post = await api(`${host}/${v}/${user_id}/media_publish`, {
    method: 'POST',
    body: new URLSearchParams({ creation_id: container.id, access_token }),
  });
  const media = await api(`${host}/${v}/${post.id}?fields=permalink&access_token=${access_token}`);
  return { id: post.id, url: media.permalink };
}
