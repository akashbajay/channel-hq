// Collects publish status, views, comments and analytics for every page in channel.json.
// A page = the default channel plus each entry under "accounts"; a new page shows up here once
// it is added to channel.json (tokens can come later — the dashboard shows "not connected").
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, QUEUE, loadEnv, loadChannel, api, readSecret, secretName } from '../publisher/lib/config.mjs';
import { auth as igAuth } from '../publisher/lib/instagram.mjs';
import { accessToken } from '../publisher/lib/youtube.mjs';

const HISTORY = path.join(ROOT, 'logs', 'stats-history.jsonl');
const SNAPSHOT_EVERY = (+process.env.SNAPSHOT_MINUTES || 10) * 60 * 1000;

export function pages() {
  const ch = loadChannel();
  return [
    { id: 'default', account: undefined, handle: ch.handle, name: ch.name || ch.handle },
    ...Object.entries(ch.accounts || {}).map(([id, a]) => ({ id, account: id, handle: a.handle, name: a.name || a.handle })),
  ];
}

function queuedPosts() {
  if (!fs.existsSync(QUEUE)) return [];
  return fs.readdirSync(QUEUE).sort().flatMap(d => {
    const f = path.join(QUEUE, d, 'post.json');
    return fs.existsSync(f) ? [JSON.parse(fs.readFileSync(f, 'utf8'))] : [];
  });
}

const settle = p => p.then(v => v, e => ({ error: e.message }));

async function instagram(page) {
  if (!readSecret(secretName('instagram', page.account))) return { connected: false };
  const env = loadEnv();
  const { access_token, user_id, host } = await igAuth(page.account);
  const v = env.IG_API_VERSION || 'v23.0';
  const q = `access_token=${access_token}`;
  const profile = await api(`${host}/${v}/${user_id}?fields=username,followers_count,media_count&${q}`);
  const media = await api(`${host}/${v}/${user_id}/media?fields=id,caption,permalink,timestamp,like_count,comments_count,media_product_type,thumbnail_url&limit=25&${q}`);
  const metrics = 'views,reach,shares,saved,ig_reels_avg_watch_time';
  const posts = await Promise.all(media.data.map(async m => {
    const [ins, com] = await Promise.all([
      settle(api(`${host}/${v}/${m.id}/insights?metric=${metrics}&${q}`)),
      m.comments_count ? settle(api(`${host}/${v}/${m.id}/comments?fields=id,text,username,timestamp&limit=10&${q}`)) : { data: [] },
    ]);
    const stats = ins.data ? Object.fromEntries(ins.data.map(x => [x.name, x.values[0].value])) : {};
    return {
      id: m.id, url: m.permalink, postedAt: m.timestamp, caption: m.caption?.split('\n')[0] || '',
      thumb: m.thumbnail_url, likes: m.like_count || 0, comments: m.comments_count || 0,
      views: stats.views ?? null, reach: stats.reach ?? null, shares: stats.shares ?? null, saved: stats.saved ?? null,
      avgWatchSec: stats.ig_reels_avg_watch_time != null ? stats.ig_reels_avg_watch_time / 1000 : null,
      insightsError: ins.error, commentList: (com.data || []).map(c => ({ ...c, url: m.permalink })),
    };
  }));
  return { connected: true, username: profile.username, followers: profile.followers_count, mediaCount: profile.media_count, posts };
}

async function youtube(page) {
  if (!readSecret(secretName('youtube', page.account))) return { connected: false };
  const headers = { Authorization: `Bearer ${await accessToken(loadEnv(), page.account)}` };
  const yt = p => api(`https://www.googleapis.com/youtube/v3/${p}`, { headers });
  const ch = (await yt('channels?part=snippet,statistics,contentDetails&mine=true')).items[0];
  const list = await yt(`playlistItems?part=contentDetails&maxResults=25&playlistId=${ch.contentDetails.relatedPlaylists.uploads}`);
  const ids = list.items.map(i => i.contentDetails.videoId);
  const vids = ids.length ? (await yt(`videos?part=snippet,statistics,status&id=${ids.join(',')}`)).items : [];
  const comments = await settle(yt(`commentThreads?part=snippet&order=time&maxResults=30&allThreadsRelatedToChannelId=${ch.id}`));

  // YouTube Analytics lags 24-48h, so fresh uploads have no row yet.
  const today = new Date().toISOString().slice(0, 10);
  const aq = new URLSearchParams({
    ids: 'channel==MINE', startDate: '2026-01-01', endDate: today, dimensions: 'video', maxResults: '50', sort: '-views',
    metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained',
  });
  const an = await settle(api(`https://youtubeanalytics.googleapis.com/v2/reports?${aq}`, { headers }));
  const cols = an.columnHeaders?.map(c => c.name) || [];
  const row = id => { const r = an.rows?.find(r => r[0] === id); return r ? Object.fromEntries(cols.map((c, i) => [c, r[i]])) : null; };

  const posts = vids.map(vd => {
    const a = row(vd.id);
    return {
      id: vd.id, url: `https://youtube.com/shorts/${vd.id}`, postedAt: vd.snippet.publishedAt, caption: vd.snippet.title,
      thumb: vd.snippet.thumbnails?.medium?.url, privacy: vd.status.privacyStatus, uploadStatus: vd.status.uploadStatus,
      views: +vd.statistics.viewCount || 0, likes: +vd.statistics.likeCount || 0, comments: +vd.statistics.commentCount || 0,
      avgWatchSec: a?.averageViewDuration ?? null, avgViewPct: a?.averageViewPercentage ?? null, subsGained: a?.subscribersGained ?? null,
    };
  });
  const commentList = (comments.items || []).map(t => {
    const s = t.snippet.topLevelComment.snippet;
    return { id: t.id, text: s.textOriginal, username: s.authorDisplayName, timestamp: s.publishedAt, url: `https://youtube.com/watch?v=${t.snippet.videoId}&lc=${t.id}`, videoId: t.snippet.videoId };
  });
  return {
    connected: true, title: ch.snippet.title, subscribers: +ch.statistics.subscriberCount || 0, totalViews: +ch.statistics.viewCount || 0,
    videoCount: +ch.statistics.videoCount || 0, posts, commentList, commentsError: comments.error, analyticsError: an.error,
  };
}

// Joins the queue (what was planned) with what each platform reports (what actually went out).
function tracker(page, queue, ig, yt) {
  const mine = queue.filter(p => (p.account || 'default') === page.id);
  const igById = Object.fromEntries((ig.posts || []).map(p => [p.id, p]));
  const ytById = Object.fromEntries((yt.posts || []).map(p => [p.id, p]));
  const rows = mine.map(p => {
    const plat = name => {
      if (!p.platforms?.includes(name)) return { state: 'skip' };
      const r = p.results?.[name];
      if (r?.id) return { state: 'live', ...r, live: (name === 'instagram' ? igById : ytById)[r.id] || null };
      if (r?.error) return { state: 'failed', error: r.error };
      return { state: p.approved ? 'scheduled' : 'needs-approval' };
    };
    // Once it has gone out, show when it actually posted rather than the planned slot.
    const posted = Object.values(p.results || {}).map(r => r.postedAt).filter(Boolean).sort()[0];
    return { slug: p.slug, title: p.youtube?.title?.replace(/\s*#Shorts$/i, '') || p.slug, publishAt: posted || p.publishAt, approved: p.approved, youtube: plat('youtube'), instagram: plat('instagram') };
  });
  // Posts made outside the queue (by hand in the app) still count.
  const known = new Set(mine.flatMap(p => [p.results?.youtube?.id, p.results?.instagram?.id]).filter(Boolean));
  for (const x of ig.posts || []) if (!known.has(x.id)) rows.push({ slug: null, title: x.caption, publishAt: x.postedAt, manual: true, youtube: { state: 'skip' }, instagram: { state: 'live', url: x.url, live: x } });
  for (const x of yt.posts || []) if (!known.has(x.id)) rows.push({ slug: null, title: x.caption, publishAt: x.postedAt, manual: true, youtube: { state: 'live', url: x.url, live: x }, instagram: { state: 'skip' } });
  return rows.sort((a, b) => new Date(b.publishAt) - new Date(a.publishAt));
}

const sum = (xs, k) => xs.reduce((n, x) => n + (x[k] || 0), 0);

export async function collect() {
  const queue = queuedPosts();
  const out = await Promise.all(pages().map(async page => {
    const [ig, yt] = await Promise.all([settle(instagram(page)), settle(youtube(page))]);
    const igPosts = ig.posts || [], ytPosts = yt.posts || [];
    // Every number is kept per platform; the combined figures are just their sums.
    // YouTube's channel counter lags the per-video counts, so take whichever is higher.
    const totals = {
      ytViews: Math.max(yt.totalViews || 0, sum(ytPosts, 'views')), igViews: sum(igPosts, 'views'),
      ytSubs: yt.subscribers || 0, igFollowers: ig.followers || 0,
      ytLikes: sum(ytPosts, 'likes'), igLikes: sum(igPosts, 'likes'),
      ytComments: sum(ytPosts, 'comments'), igComments: sum(igPosts, 'comments'),
      ytPosts: ytPosts.length, igPosts: igPosts.length,
    };
    for (const k of ['Views', 'Likes', 'Comments', 'Posts']) totals[k.toLowerCase()] = totals[`yt${k}`] + totals[`ig${k}`];
    totals.followers = totals.ytSubs + totals.igFollowers;
    const comments = [
      ...igPosts.flatMap(p => p.commentList.map(c => ({ ...c, platform: 'instagram', post: p.caption }))),
      ...(yt.commentList || []).map(c => ({ ...c, platform: 'youtube', post: ytPosts.find(p => p.id === c.videoId)?.caption })),
    ];
    return { ...page, instagram: ig, youtube: yt, totals, tracker: tracker(page, queue, ig, yt), comments };
  }));
  const snap = { at: new Date().toISOString(), pages: out };
  snapshot(snap);
  return { ...snap, history: history() };
}

// A light history (totals + per-post views) so the dashboard can show growth and the race over time.
function snapshot(snap) {
  const last = history().at(-1);
  if (last && Date.now() - new Date(last.at) < SNAPSHOT_EVERY) return;
  const row = {
    at: snap.at,
    pages: Object.fromEntries(snap.pages.map(p => [p.id, {
      ...p.totals,
      postViews: Object.fromEntries([...(p.instagram.posts || []), ...(p.youtube.posts || [])].map(x => [x.id, x.views || 0])),
    }])),
  };
  fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
  fs.appendFileSync(HISTORY, JSON.stringify(row) + '\n');
}

export function history() {
  if (!fs.existsSync(HISTORY)) return [];
  return fs.readFileSync(HISTORY, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}
