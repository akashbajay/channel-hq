// YouTube Data API v3: OAuth refresh + resumable upload of a Short.
import fs from 'node:fs';
import { api, readSecret, writeSecret, googleClient, secretName } from './config.mjs';

export const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl', // read comment text (and reply to comments later)
  'https://www.googleapis.com/auth/yt-analytics.readonly',
];

export async function accessToken(env, account) {
  const name = secretName('youtube', account);
  const t = readSecret(name);
  if (!t?.refresh_token) throw new Error(`No YouTube login yet. Run: node publisher/auth-youtube.mjs${account ? ` --account ${account}` : ''}`);
  if (t.access_token && t.expires_at > Date.now() + 60_000) return t.access_token;
  const client = googleClient(env);
  const j = await api('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: client.id,
      client_secret: client.secret,
      refresh_token: t.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  writeSecret(name, { ...t, access_token: j.access_token, expires_at: Date.now() + j.expires_in * 1000 });
  return j.access_token;
}

export async function uploadShort(env, { file, title, description, tags = [], privacy = 'public', categoryId = '23', account }) {
  const token = await accessToken(env, account);
  const size = fs.statSync(file).size;
  const meta = {
    snippet: { title: title.slice(0, 100), description, tags, categoryId }, // 23 = Comedy, 1 = Film & Animation, 27 = Education
    status: { privacyStatus: privacy, selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
  };
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'video/mp4',
      'X-Upload-Content-Length': String(size),
    },
    body: JSON.stringify(meta),
  });
  if (!init.ok) throw new Error(`YouTube upload start failed: ${init.status} ${await init.text()}`);
  const video = await api(init.headers.get('location'), {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size) },
    body: fs.readFileSync(file),
  });
  return { id: video.id, url: `https://youtube.com/shorts/${video.id}`, privacy: video.status?.privacyStatus };
}
