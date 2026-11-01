// Aux hub: one Durable Object that serves the REST API and holds every live socket and sync room.
// Users, playlists and credits live in D1. Rooms, invites and disconnect timers live in this
// object's own storage, so they survive the object hibernating between messages.
import { DurableObject } from 'cloudflare:workers';
import { ring } from './push.js';

const START_CREDITS = 5;
const MAX_SONGS = 10;
const INVITE_TTL = 60_000;
const LEAVE_GRACE = 15_000; // a page refresh shouldn't drop you from a sync
const AUDIUS = 'https://api.audius.co/v1';
const JAMENDO = 'https://api.jamendo.com/v3.0';
const APP_NAME = 'aux-music';
const SEARCH_TTL = 24 * 3600_000;
const CHAT_KEEP = 60;        // messages kept per party, so people who join see what's been said
const CHAT_LEN = 300;
const REACTIONS = new Set(['love', 'fire', 'star', 'energy']);
const HANDLE_COOLDOWN = 30 * 24 * 3600_000; // @IDs are how friends find you, so they change rarely

// A short, human label for a sign-in, from the browser's user agent.
function deviceLabel(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return `${browser} on ${os}`;
}
const songToTrack = ({ addedBy, addedAt, likes, liked, ownerLiked, ...t }) => t;

// ---------- lyrics ----------
// LRCLIB is a free, community-run lyrics database (not licensed by publishers).
// Set the LYRICS variable to "off" to switch lyrics off at once if a rights holder asks.
const LRCLIB = 'https://lrclib.net/api';
const LYRICS_TTL = 7 * 24 * 3600_000;
// Turns a YouTube-style title like "Tyla - Water (Official Music Video)" into { song: "Water", artist: "Tyla" }.
function lyricsQuery(title, author) {
  let song = String(title || '');
  let artist = cleanAuthor(author);
  song = song
    .replace(/\s*[([][^)\]]*\b(official|video|audio|lyrics?|visuali[sz]er|live|remaster(ed)?|hd|4k|mv|explicit|clean)\b[^)\]]*[)\]]/gi, '')
    .replace(/\s*[|｜].*$/, '')
    .trim();
  const dash = song.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash) { artist = dash[1].trim(); song = dash[2].trim(); }
  const noFeat = (s) => s.replace(/\s*[([]?\b(ft\.?|feat\.?|featuring)\s[^)\]]*[)\]]?/i, '').trim();
  return { song: noFeat(song), artist: noFeat(artist.split(/\s*[,&x×]\s+/)[0] || artist) };
}
async function lrclib(path) {
  try {
    const r = await fetch(`${LRCLIB}${path}`, { headers: { 'User-Agent': 'Aux/1.0 (https://music.africanspring.co.za)' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

const json = (data, status = 200) => Response.json(data, { status });
const fail = (status, error) => json({ error }, status);
const randomHex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const cleanHandle = (h) => String(h || '').toLowerCase().trim().replace(/^@/, '');
const cleanName = (n) => String(n || '').trim().slice(0, 30);
const cleanAuthor = (a) => String(a || '').replace(/ - Topic$/, '').replace(/VEVO$/, '').trim();
const decode = (s) => String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// ---------- tracks ----------
const ytArt = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
const trackOut = (r) => ({ id: r.id, source: r.source, sourceId: r.source_id, title: r.title, author: r.author, art: r.art, ...(r.license ? { license: r.license } : {}) });

function parseVideoId(input) {
  const s = String(input || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname.endsWith('youtu.be')) return u.pathname.slice(1, 12) || null;
    const v = u.searchParams.get('v');
    if (v && /^[\w-]{11}$/.test(v)) return v;
    const m = u.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{11})/);
    if (m) return m[1];
  } catch {}
  return null;
}
const isAudiusUrl = (s) => { try { return new URL(String(s).trim()).hostname.endsWith('audius.co'); } catch { return false; } };
// jamendo.com/track/1234567/some-slug
const jamendoId = (s) => { try { const u = new URL(String(s).trim()); return u.hostname.endsWith('jamendo.com') ? u.pathname.match(/\/track\/(\d+)/)?.[1] || null : null; } catch { return null; } };

// Music APIs are sometimes slow or briefly refuse bursts, so allow time and one retry.
async function fetchJson(url, ms = 8000, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
      if (r.ok) return r.json();
      if (r.status < 500 && r.status !== 429) return null; // a real "no": don't retry
    } catch (e) { if (i === tries - 1) throw e; }
    await new Promise((res) => setTimeout(res, 400 * (i + 1)));
  }
  return null;
}

const audiusTrack = (t) => t && ({
  id: `au:${t.id}`, source: 'au', sourceId: t.id, title: t.title, author: t.user?.name?.trim() || '',
  art: t.artwork?.['480x480'] || t.artwork?.['150x150'] || '', duration: t.duration,
  playable: t.is_streamable !== false && !t.is_stream_gated && !t.is_delete,
});
const jamendoTrack = (t) => t && ({
  id: `jm:${t.id}`, source: 'jm', sourceId: String(t.id), title: t.name, author: t.artist_name || '',
  art: t.image || t.album_image || '', duration: t.duration, license: t.license_ccurl || null, playable: !!t.audio,
});
const publicTrack = ({ playable, duration, ...t }) => t;

// ---------- Durable Object ----------
export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.db = env.DB;
    this.rooms = new Map();   // roomId -> { id, host, members:Set, pending:Set, names:{}, state }
    this.invites = new Map(); // inviteId -> { from, fromName, to, roomId, at }
    this.leaving = new Map(); // userId -> time to drop them from their room
    this.recent = new Map();  // `${userId}:${kind}` -> recent send times, for flood limits
    ctx.blockConcurrencyWhile(async () => {
      const s = await ctx.storage.get('rt');
      if (!s) return;
      for (const r of s.rooms) this.rooms.set(r.id, { ...r, members: new Set(r.members), pending: new Set(r.pending) });
      this.invites = new Map(s.invites);
      this.leaving = new Map(s.leaving);
    });
  }

  persist() {
    this.ctx.storage.put('rt', {
      rooms: [...this.rooms.values()].map((r) => ({ ...r, members: [...r.members], pending: [...r.pending] })),
      invites: [...this.invites], leaving: [...this.leaving],
    });
    const due = [...[...this.invites.values()].map((i) => i.at + INVITE_TTL), ...this.leaving.values()];
    if (due.length) this.ctx.storage.setAlarm(Math.min(...due)); else this.ctx.storage.deleteAlarm();
  }

  // ---------- users ----------
  isOnline(uid) { return this.ctx.getWebSockets(uid).length > 0; }
  publicUser(u) { return u && { id: u.id, name: u.name, sample: !!u.sample, online: this.isOnline(u.id), avatar: u.avatar || null, bio: u.bio || '' }; }
  meUser(u) {
    return { ...this.publicUser(u), credits: u.credits, email: u.email || null, hasGooglePhoto: !!u.google_picture,
      canChangeHandleAt: (u.handle_changed_at || 0) + HANDLE_COOLDOWN };
  }
  getUser(id) { return this.db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first(); }
  // The user plus session_hash, so we know which device is asking.
  async userByToken(token) {
    if (!token) return null;
    return this.db.prepare('SELECT u.*, s.token_hash AS session_hash FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND u.sample = 0').bind(await sha256(token)).first();
  }
  async sessionStmt(uid, device) {
    const token = crypto.randomUUID();
    const now = Date.now();
    return [token, this.db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, device, last_seen) VALUES (?, ?, ?, ?, ?)').bind(await sha256(token), uid, now, device || null, now)];
  }
  async createUser(handle, name, extra = {}) {
    const now = Date.now();
    const [token, session] = await this.sessionStmt(handle, extra.device);
    await this.db.batch([
      this.db.prepare('INSERT INTO users (id, name, credits, google_sub, email, google_picture, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(handle, name, START_CREDITS, extra.googleSub || null, extra.email || null, extra.picture || null, extra.picture || null, now),
      session,
      this.db.prepare('INSERT INTO credit_ledger (user_id, delta, reason, at) VALUES (?, ?, ?, ?)').bind(handle, START_CREDITS, 'start', now),
    ]);
    return { token, user: this.meUser(await this.getUser(handle)) };
  }
  async checkNewUser(handle, name) {
    if (!/^[a-z0-9_]{3,20}$/.test(handle)) return [400, 'Use 3 to 20 letters, numbers or underscores.'];
    if (!name) return [400, 'Add a display name.'];
    if (await this.getUser(handle)) return [409, `@${handle} is taken. Try another.`];
    return null;
  }
  // A new session per sign-in, so each device stays signed in on its own.
  async newSession(uid, device) {
    const [token, session] = await this.sessionStmt(uid, device);
    await session.run();
    return token;
  }

  // ---------- playlists ----------
  // meId: who's asking, for their own likes. where: SQL on aliases p (playlists) and u (owner).
  async loadPlaylists(meId, where = '', ...args) {
    const { results: pls } = await this.db.prepare(
      `SELECT p.id, p.owner, p.name, p.created_at, u.name AS owner_name, u.sample, u.avatar AS owner_avatar FROM playlists p JOIN users u ON u.id = p.owner ${where} ORDER BY p.created_at DESC LIMIT 200`,
    ).bind(...args).all();
    const likesOf = (who) => `EXISTS (SELECT 1 FROM likes l WHERE l.playlist_id = ps.playlist_id AND l.track_id = ps.track_id AND l.user_id = ${who})`;
    const { results: songs } = await this.db.prepare(
      `SELECT ps.playlist_id, ps.added_by, ps.added_at, t.*,
         (SELECT count(*) FROM likes l WHERE l.playlist_id = ps.playlist_id AND l.track_id = ps.track_id) AS likes,
         ${likesOf('?')} AS liked, ${likesOf('p.owner')} AS owner_liked
       FROM playlist_songs ps JOIN tracks t ON t.id = ps.track_id
       JOIN playlists p ON p.id = ps.playlist_id JOIN users u ON u.id = p.owner ${where} ORDER BY ps.added_at`,
    ).bind(meId || '', ...args).all();
    const byId = new Map(pls.map((p) => [p.id, { id: p.id, owner: p.owner, ownerName: p.owner_name, ownerAvatar: p.owner_avatar, sample: !!p.sample, name: p.name, createdAt: p.created_at, songs: [] }]));
    for (const s of songs) {
      byId.get(s.playlist_id)?.songs.push({ ...trackOut(s), addedBy: s.added_by, addedAt: s.added_at, likes: s.likes, liked: !!s.liked, ownerLiked: !!s.owner_liked });
    }
    return [...byId.values()];
  }
  async playlist(id, meId = null) { return (await this.loadPlaylists(meId, 'WHERE p.id = ?', id))[0] || null; }

  // ---------- song lookup ----------
  // Always fetches the song's details from its source, so clients can't add made-up titles.
  async resolveTrack(source, sourceId) {
    if (source === 'au') {
      const j = await fetchJson(`${AUDIUS}/tracks/${encodeURIComponent(sourceId)}?app_name=${APP_NAME}`).catch(() => null);
      const t = audiusTrack(j?.data);
      if (!t) throw new Error("Couldn't find that song on Audius.");
      if (!t.playable) throw new Error("That Audius song can't be streamed. Try another.");
      return t;
    }
    if (source === 'jm') {
      if (!this.env.JAMENDO_CLIENT_ID) throw new Error('Jamendo is not switched on yet.');
      if (!/^\d+$/.test(sourceId)) throw new Error("Couldn't find that song on Jamendo.");
      const j = await fetchJson(`${JAMENDO}/tracks/?client_id=${this.env.JAMENDO_CLIENT_ID}&format=json&imagesize=300&id=${sourceId}`).catch(() => null);
      const t = jamendoTrack(j?.results?.[0]);
      if (!t?.playable) throw new Error("Couldn't find that song on Jamendo.");
      return t;
    }
    if (source === 'yt') {
      if (!/^[\w-]{11}$/.test(sourceId)) throw new Error('That link does not look like a YouTube or YouTube Music song.');
      if (this.env.YT_API_KEY) {
        const j = await fetchJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet,status&id=${sourceId}&key=${this.env.YT_API_KEY}`).catch(() => null);
        const v = j?.items?.[0];
        if (j && !v) throw new Error("Couldn't find that video on YouTube.");
        if (v) {
          if (v.status?.embeddable === false) throw new Error("This song's label doesn't let it play outside YouTube. Try another version.");
          return { id: `yt:${sourceId}`, source: 'yt', sourceId, title: v.snippet.title, author: cleanAuthor(v.snippet.channelTitle), art: ytArt(sourceId) };
        }
      }
      const o = await fetchJson(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${sourceId}`, 6000).catch(() => null);
      if (!o) throw new Error("Couldn't load that video. It may be private or blocked from playing outside YouTube.");
      return { id: `yt:${sourceId}`, source: 'yt', sourceId, title: o.title, author: cleanAuthor(o.author_name), art: ytArt(sourceId) };
    }
    throw new Error('Unknown song source.');
  }
  async resolveLink(input) {
    if (isAudiusUrl(input)) {
      const j = await fetchJson(`${AUDIUS}/resolve?url=${encodeURIComponent(String(input).trim())}&app_name=${APP_NAME}`).catch(() => null);
      if (!j?.data?.id || !j.data.title) throw new Error('That Audius link is not a song.');
      return this.resolveTrack('au', j.data.id);
    }
    const jm = jamendoId(input);
    if (jm) return this.resolveTrack('jm', jm);
    const vid = parseVideoId(input);
    if (!vid) throw new Error('Paste a YouTube, YouTube Music, Audius or Jamendo song link.');
    return this.resolveTrack('yt', vid);
  }

  async cached(key, ttl, load) {
    const hit = await this.db.prepare('SELECT results, at FROM search_cache WHERE key = ?').bind(key).first();
    if (hit && Date.now() - hit.at < ttl) return JSON.parse(hit.results);
    const results = await load();
    await this.db.prepare('INSERT OR REPLACE INTO search_cache (key, results, at) VALUES (?, ?, ?)').bind(key, JSON.stringify(results), Date.now()).run();
    return results;
  }

  async search(q, source) {
    if (source === 'au') {
      return this.cached(`au:${q.toLowerCase()}`, 6 * 3600_000, async () => {
        const j = await fetchJson(`${AUDIUS}/tracks/search?query=${encodeURIComponent(q)}&limit=15&app_name=${APP_NAME}`);
        return (j?.data || []).map(audiusTrack).filter((t) => t.playable).slice(0, 10).map(publicTrack);
      });
    }
    if (source === 'jm') {
      return this.cached(`jm:${q.toLowerCase()}`, 6 * 3600_000, async () => {
        const j = await fetchJson(`${JAMENDO}/tracks/?client_id=${this.env.JAMENDO_CLIENT_ID}&format=json&imagesize=300&limit=10&boost=popularity_total&search=${encodeURIComponent(q)}`);
        return (j?.results || []).map(jamendoTrack).filter((t) => t.playable).map(publicTrack);
      });
    }
    // search.list costs 100 quota units, so every query is cached for a day.
    return this.cached(`yt:${q.toLowerCase()}`, SEARCH_TTL, async () => {
      const j = await fetchJson(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&videoEmbeddable=true&maxResults=10&q=${encodeURIComponent(q)}&key=${this.env.YT_API_KEY}`);
      if (!j?.items) throw new Error('search failed');
      const list = j.items.map((i) => ({
        id: `yt:${i.id.videoId}`, source: 'yt', sourceId: i.id.videoId, title: decode(i.snippet.title),
        author: cleanAuthor(decode(i.snippet.channelTitle)), art: ytArt(i.id.videoId),
        // "- Topic" channels are YouTube Music's official audio uploads: the song, not a music video.
        official: / - Topic$/.test(i.snippet.channelTitle),
      }));
      return [...list.filter((t) => t.official), ...list.filter((t) => !t.official)];
    });
  }

  // Fresh songs that play with the screen off, for the Discover row on Home. Refreshed hourly.
  async discover() {
    return this.cached('discover', 3600_000, async () => {
      const [au, jm] = await Promise.all([
        fetchJson(`${AUDIUS}/tracks/trending?time=week&limit=30&app_name=${APP_NAME}`).catch(() => null),
        this.env.JAMENDO_CLIENT_ID
          ? fetchJson(`${JAMENDO}/tracks/?client_id=${this.env.JAMENDO_CLIENT_ID}&format=json&imagesize=300&limit=12&order=popularity_week`).catch(() => null)
          : null,
      ]);
      const a = (au?.data || []).map(audiusTrack).filter((t) => t.playable && t.duration > 60 && t.duration < 600).slice(0, 12);
      const b = (jm?.results || []).map(jamendoTrack).filter((t) => t.playable);
      // Alternate the two sources so the row doesn't feel like one catalogue.
      const mixed = [];
      for (let i = 0; i < Math.max(a.length, b.length); i++) { if (a[i]) mixed.push(a[i]); if (b[i]) mixed.push(b[i]); }
      return mixed.slice(0, 16).map(publicTrack);
    });
  }

  // The songs on a YouTube Music album or playlist, or an Audius album or playlist, to pick from.
  async collection(input) {
    const s = String(input || '').trim();
    let u;
    try { u = new URL(s); } catch { throw new Error('Paste an album or playlist link.'); }
    const list = u.searchParams.get('list');
    if (list && /(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(u.hostname)) {
      if (!this.env.YT_API_KEY) throw new Error('Album import needs YouTube search switched on.');
      // playlists + playlistItems cost 1 quota unit each, and the result is cached for a day.
      return this.cached(`ytl:${list}`, SEARCH_TTL, async () => {
        const key = this.env.YT_API_KEY, id = encodeURIComponent(list);
        const [meta, items] = await Promise.all([
          fetchJson(`https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${id}&key=${key}`),
          fetchJson(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,status&maxResults=50&playlistId=${id}&key=${key}`),
        ]);
        if (!items?.items) throw new Error("Couldn't open that playlist. It may be private.");
        const tracks = items.items
          .filter((i) => i.snippet?.resourceId?.videoId && i.status?.privacyStatus !== 'private' && !/^(Deleted|Private) video$/.test(i.snippet.title))
          .map((i) => {
            const v = i.snippet.resourceId.videoId;
            return { id: `yt:${v}`, source: 'yt', sourceId: v, title: decode(i.snippet.title), author: cleanAuthor(decode(i.snippet.videoOwnerChannelTitle || '')), art: ytArt(v) };
          });
        return { title: (meta?.items?.[0]?.snippet?.title || 'YouTube playlist').replace(/^Album - /, ''), tracks };
      });
    }
    if (isAudiusUrl(s)) {
      const j = await fetchJson(`${AUDIUS}/resolve?url=${encodeURIComponent(s)}&app_name=${APP_NAME}`).catch(() => null);
      const d = Array.isArray(j?.data) ? j.data[0] : j?.data;
      if (!d?.playlist_name) throw new Error('That Audius link is not an album or playlist.');
      const t = await fetchJson(`${AUDIUS}/playlists/${encodeURIComponent(d.id)}/tracks?app_name=${APP_NAME}`).catch(() => null);
      return { title: d.playlist_name, tracks: (t?.data || []).map(audiusTrack).filter((x) => x.playable).map(publicTrack) };
    }
    throw new Error('Paste a YouTube Music album or playlist link, or an Audius album.');
  }

  // Lyrics for a song, preferring time-synced ones whose length matches what's playing.
  async lyrics(id, title, author, duration) {
    const { song, artist } = lyricsQuery(title, author);
    if (!song) return { status: 'none' };
    return this.cached(`ly:${id || `${artist}|${song}`}`.toLowerCase(), LYRICS_TTL, async () => {
      let hits = await lrclib(`/search?${new URLSearchParams({ track_name: song, ...(artist ? { artist_name: artist } : {}) })}`);
      if (!hits.length) hits = await lrclib(`/search?${new URLSearchParams({ q: `${artist} ${song}`.trim() })}`);
      if (!hits.length) return { status: 'none' };
      const near = (h) => !duration || Math.abs((h.duration || 0) - duration) <= 5;
      const best = hits.find((h) => h.syncedLyrics && near(h)) || hits.find((h) => h.instrumental && near(h)) || hits.find((h) => h.plainLyrics && near(h));
      // A different version (say, an extended mix) would be out of time, so only offer its plain text.
      const fallback = !best && hits.find((h) => h.plainLyrics);
      const h = best || fallback;
      if (!h) return { status: 'none' };
      if (h.instrumental) return { status: 'instrumental' };
      return { status: 'ok', synced: best ? h.syncedLyrics || null : null, plain: h.plainLyrics || null, match: `${h.artistName} · ${h.trackName}` };
    });
  }

  // ---------- HTTP ----------
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') return this.connect(req, url);
    try { return await this.api(req, url); }
    catch (e) { console.error(e?.stack || e); return fail(500, 'Something went wrong. Try again.'); }
  }

  async api(req, url) {
    const m = req.method, path = url.pathname;
    const body = m === 'POST' || m === 'PATCH' ? await req.json().catch(() => ({})) : {};
    const device = deviceLabel(req.headers.get('User-Agent') || '');

    if (m === 'POST' && path === '/api/signup') {
      if (this.env.GOOGLE_CLIENT_ID) return fail(403, 'Sign in with Google.');
      const handle = cleanHandle(body.handle), name = cleanName(body.name);
      const bad = await this.checkNewUser(handle, name);
      if (bad) return fail(...bad);
      return json(await this.createUser(handle, name, { device }));
    }

    if (m === 'POST' && path === '/api/auth/google') return this.googleAuth(body, device);

    // The service worker has no sign-in token; it proves who it is with its own push subscription.
    if (m === 'POST' && path === '/api/push/latest') {
      const sub = await this.db.prepare('SELECT user_id FROM push_subs WHERE endpoint = ?').bind(String(body.endpoint || '')).first();
      const item = sub && await this.db.prepare('SELECT text, url FROM inbox WHERE user_id = ? ORDER BY at DESC LIMIT 1').bind(sub.user_id).first();
      return json({ title: 'Aux', body: item?.text || 'Something new happened on Aux.', url: item?.url || '#inbox' });
    }

    const me = await this.userByToken((req.headers.get('Authorization') || '').replace('Bearer ', ''));
    if (!me) return fail(401, 'Sign in again.');

    // ----- account -----
    if (m === 'GET' && path === '/api/me') {
      await this.db.prepare('UPDATE sessions SET last_seen = ?, device = coalesce(device, ?) WHERE token_hash = ?').bind(Date.now(), device, me.session_hash).run();
      return json({ ...this.meUser(me), unread: await this.unread(me.id) });
    }
    if (m === 'PATCH' && path === '/api/me') {
      const name = body.name === undefined ? me.name : cleanName(body.name);
      if (!name) return fail(400, 'Add a display name.');
      const bio = body.bio === undefined ? me.bio : String(body.bio || '').trim().slice(0, 160);
      const avatar = body.photo === undefined ? me.avatar : (body.photo ? me.google_picture : null);
      await this.db.prepare('UPDATE users SET name = ?, bio = ?, avatar = ? WHERE id = ?').bind(name, bio || null, avatar || null, me.id).run();
      return json(this.meUser(await this.getUser(me.id)));
    }
    if (m === 'POST' && path === '/api/me/handle') return this.changeHandle(me, body.handle);
    if (m === 'DELETE' && path === '/api/me') return this.deleteAccount(me);
    if (m === 'GET' && path === '/api/me/export') return this.exportData(me);

    if (m === 'GET' && path === '/api/sessions') {
      const { results } = await this.db.prepare('SELECT token_hash, device, created_at, last_seen FROM sessions WHERE user_id = ? ORDER BY last_seen DESC').bind(me.id).all();
      return json(results.map((s) => ({ id: s.token_hash.slice(0, 16), device: s.device || 'Unknown device', createdAt: s.created_at, lastSeen: s.last_seen || s.created_at, current: s.token_hash === me.session_hash })));
    }
    if (m === 'POST' && path === '/api/sessions/others') {
      await this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(me.id, me.session_hash).run();
      this.closeSockets(me.id, (sh) => sh !== me.session_hash);
      return json({ ok: true });
    }
    let p = path.match(/^\/api\/sessions\/([0-9a-f]{16})$/);
    if (p && m === 'DELETE') {
      await this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND substr(token_hash, 1, 16) = ?').bind(me.id, p[1]).run();
      this.closeSockets(me.id, (sh) => sh?.startsWith(p[1]));
      return json({ ok: true });
    }

    // ----- inbox and push -----
    if (m === 'GET' && path === '/api/inbox') {
      const { results } = await this.db.prepare('SELECT id, kind, actor, text, url, at, read FROM inbox WHERE user_id = ? ORDER BY at DESC LIMIT 50').bind(me.id).all();
      return json({ items: results.map((r) => ({ ...r, read: !!r.read })), unread: results.filter((r) => !r.read).length });
    }
    if (m === 'POST' && path === '/api/inbox/read') {
      await this.db.prepare('UPDATE inbox SET read = 1 WHERE user_id = ? AND read = 0').bind(me.id).run();
      return json({ unread: 0 });
    }
    if (m === 'POST' && path === '/api/push/subscribe') {
      const endpoint = String(body.endpoint || '');
      if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000) return fail(400, 'That subscription looks wrong.');
      await this.db.prepare('INSERT OR REPLACE INTO push_subs (endpoint, user_id, created_at) VALUES (?, ?, ?)').bind(endpoint, me.id, Date.now()).run();
      return json({ ok: true });
    }
    if (m === 'POST' && path === '/api/push/unsubscribe') {
      await this.db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').bind(String(body.endpoint || ''), me.id).run();
      return json({ ok: true });
    }

    // ----- people and playlists -----
    if (m === 'GET' && path === '/api/feed') {
      const all = await this.loadPlaylists(me.id);
      return json({ mine: all.filter((x) => x.owner === me.id), others: all.filter((x) => x.owner !== me.id) });
    }

    if (m === 'GET' && path === '/api/users') {
      const q = cleanHandle(url.searchParams.get('q'));
      const { results } = await this.db.prepare('SELECT * FROM users WHERE id != ? AND (id LIKE ? OR lower(name) LIKE ?) LIMIT 200')
        .bind(me.id, `%${q}%`, `%${q}%`).all();
      const list = results.map((u) => this.publicUser(u)).sort((a, b) => (b.online - a.online) || a.id.localeCompare(b.id)).slice(0, 20);
      return json(list);
    }

    p = path.match(/^\/api\/users\/([a-z0-9_]+)$/);
    if (m === 'GET' && p) {
      const u = await this.getUser(p[1]);
      if (!u) return fail(404, 'No one has that ID.');
      return json({ user: this.publicUser(u), playlists: await this.loadPlaylists(me.id, 'WHERE p.owner = ?', u.id) });
    }

    if (m === 'POST' && path === '/api/playlists') {
      const name = String(body.name || '').trim().slice(0, 40);
      if (!name) return fail(400, 'Give the playlist a name.');
      const id = randomHex(5);
      await this.db.prepare('INSERT INTO playlists (id, owner, name, created_at) VALUES (?, ?, ?, ?)').bind(id, me.id, name, Date.now()).run();
      return json(await this.playlist(id, me.id));
    }

    p = path.match(/^\/api\/playlists\/([0-9a-f]{10})$/);
    if (p && m === 'GET') {
      const pl = await this.playlist(p[1], me.id);
      return pl ? json(pl) : fail(404, 'Playlist not found.');
    }
    if (p && m === 'DELETE') {
      const owned = await this.db.prepare('SELECT 1 FROM playlists WHERE id = ? AND owner = ?').bind(p[1], me.id).first();
      if (!owned) return fail(403, 'Only the owner can delete this playlist.');
      await this.db.batch([
        this.db.prepare('DELETE FROM likes WHERE playlist_id = ?').bind(p[1]),
        this.db.prepare('DELETE FROM playlists WHERE id = ?').bind(p[1]),
      ]);
      return json({ ok: true });
    }

    // ----- songs -----
    if (m === 'GET' && path === '/api/resolve') {
      try { return json(await this.resolveLink(url.searchParams.get('url'))); }
      catch (e) { return fail(400, e.message); }
    }
    if (m === 'GET' && path === '/api/collection') {
      try { return json(await this.collection(url.searchParams.get('url'))); }
      catch (e) { return fail(400, e.message); }
    }

    if (m === 'GET' && path === '/api/search') {
      const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
      const source = ['au', 'jm'].includes(url.searchParams.get('source')) ? url.searchParams.get('source') : 'yt';
      if ((source === 'yt' && !this.env.YT_API_KEY) || (source === 'jm' && !this.env.JAMENDO_CLIENT_ID)) return json({ enabled: false, results: [] });
      if (!q) return json({ enabled: true, results: [] });
      try { return json({ enabled: true, results: await this.search(q, source) }); }
      catch { return fail(502, 'Song search is unavailable right now. Paste a link instead.'); }
    }

    if (m === 'GET' && path === '/api/lyrics') {
      if (this.env.LYRICS === 'off') return json({ status: 'off' });
      const q = url.searchParams;
      try { return json(await this.lyrics(String(q.get('id') || '').slice(0, 60), String(q.get('title') || '').slice(0, 200), String(q.get('author') || '').slice(0, 120), Math.round(Number(q.get('duration')) || 0))); }
      catch { return json({ status: 'none' }); }
    }

    if (m === 'GET' && path === '/api/discover') {
      try { return json({ tracks: await this.discover() }); }
      catch { return json({ tracks: [] }); }
    }

    p = path.match(/^\/api\/playlists\/([0-9a-f]{10})\/songs$/);
    if (p && m === 'POST') return this.addSongs(me, p[1], body);

    p = path.match(/^\/api\/playlists\/([0-9a-f]{10})\/songs\/([^/]+)\/like$/);
    if (p && m === 'POST') return this.toggleLike(me, p[1], decodeURIComponent(p[2]));

    p = path.match(/^\/api\/playlists\/([0-9a-f]{10})\/songs\/([^/]+)$/);
    if (p && m === 'DELETE') {
      const pl = await this.db.prepare('SELECT owner FROM playlists WHERE id = ?').bind(p[1]).first();
      if (!pl || pl.owner !== me.id) return fail(403, 'Only the owner can remove songs.');
      const trackId = decodeURIComponent(p[2]);
      await this.db.batch([
        this.db.prepare('DELETE FROM playlist_songs WHERE playlist_id = ? AND track_id = ?').bind(p[1], trackId),
        this.db.prepare('DELETE FROM likes WHERE playlist_id = ? AND track_id = ?').bind(p[1], trackId),
      ]);
      return json(await this.playlist(p[1], me.id));
    }

    if (m === 'POST' && path === '/api/listen') return this.listen(me, body);

    return fail(404, 'Not found.');
  }

  async googleAuth(body, device) {
    const clientId = this.env.GOOGLE_CLIENT_ID;
    if (!clientId) return fail(400, 'Google sign-in is not set up on this server.');
    const c = await fetchJson(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(String(body.credential || ''))}`).catch(() => null);
    const valid = c && c.aud === clientId && ['accounts.google.com', 'https://accounts.google.com'].includes(c.iss) && Number(c.exp) * 1000 > Date.now() && c.sub;
    if (!valid) return fail(401, 'Google sign-in failed. Try again.');
    const existing = await this.db.prepare('SELECT * FROM users WHERE google_sub = ?').bind(c.sub).first();
    if (existing) {
      // Keep the offered Google photo fresh; only the shown photo if they're already using it.
      if (c.picture && c.picture !== existing.google_picture) {
        const showing = existing.avatar && existing.avatar === existing.google_picture;
        await this.db.prepare('UPDATE users SET google_picture = ?, avatar = ? WHERE id = ?').bind(c.picture, showing ? c.picture : existing.avatar, existing.id).run();
      }
      return json({ token: await this.newSession(existing.id, device), user: this.meUser(await this.getUser(existing.id)) });
    }
    // First sign-in: the client asks for an @ID, then sends the same credential back with it.
    if (!body.handle) return json({ needsHandle: true, name: cleanName(c.given_name || c.name) });
    const handle = cleanHandle(body.handle), name = cleanName(body.name);
    const bad = await this.checkNewUser(handle, name);
    if (bad) return fail(...bad);
    return json(await this.createUser(handle, name, { googleSub: c.sub, email: c.email, picture: c.picture, device }));
  }

  // ---------- account changes ----------
  async changeHandle(me, raw) {
    const handle = cleanHandle(raw);
    if (handle === me.id) return fail(400, 'That is already your ID.');
    const nextAllowed = (me.handle_changed_at || 0) + HANDLE_COOLDOWN;
    if (Date.now() < nextAllowed) return fail(429, `You can change your ID again on ${new Date(nextAllowed).toDateString()}.`);
    const bad = await this.checkNewUser(handle, me.name);
    if (bad) return fail(...bad);
    const old = me.id;
    const u = await this.getUser(old);
    const move = (sql) => this.db.prepare(sql).bind(handle, old);
    // One transaction: copy the user to the new ID, repoint everything, then remove the old row.
    await this.db.batch([
      this.db.prepare('UPDATE users SET google_sub = NULL WHERE id = ?').bind(old),
      this.db.prepare(`INSERT INTO users (id, name, credits, google_sub, email, sample, created_at, bio, avatar, google_picture, handle_changed_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`).bind(handle, u.name, u.credits, u.google_sub, u.email, u.created_at, u.bio, u.avatar, u.google_picture, Date.now()),
      move('UPDATE sessions SET user_id = ? WHERE user_id = ?'),
      move('UPDATE playlists SET owner = ? WHERE owner = ?'),
      move('UPDATE playlist_songs SET added_by = ? WHERE added_by = ?'),
      move('UPDATE credit_ledger SET user_id = ? WHERE user_id = ?'),
      move('UPDATE listens SET user_id = ? WHERE user_id = ?'),
      move('UPDATE likes SET user_id = ? WHERE user_id = ?'),
      move('UPDATE inbox SET user_id = ? WHERE user_id = ?'),
      move('UPDATE inbox SET actor = ? WHERE actor = ?'),
      move('UPDATE push_subs SET user_id = ? WHERE user_id = ?'),
      this.db.prepare('DELETE FROM users WHERE id = ?').bind(old),
    ]);
    // Live sync state still uses the old ID, so drop it and let the sockets reconnect.
    this.leaveRoom(old);
    this.persist();
    this.closeSockets(old, () => true, 4002, 'renamed');
    return json(this.meUser(await this.getUser(handle)));
  }

  async deleteAccount(me) {
    const id = me.id;
    const del = (sql) => this.db.prepare(sql).bind(id);
    await this.db.batch([
      del('DELETE FROM playlist_songs WHERE added_by = ?'),
      del('DELETE FROM likes WHERE user_id = ? OR playlist_id IN (SELECT id FROM playlists WHERE owner = ?1)'),
      del('DELETE FROM listens WHERE user_id = ? OR playlist_id IN (SELECT id FROM playlists WHERE owner = ?1)'),
      del('DELETE FROM inbox WHERE user_id = ?'),
      del('DELETE FROM credit_ledger WHERE user_id = ?'),
      del('DELETE FROM push_subs WHERE user_id = ?'),
      del('DELETE FROM sessions WHERE user_id = ?'),
      del('DELETE FROM playlists WHERE owner = ?'),
      del('DELETE FROM users WHERE id = ?'),
    ]);
    this.leaveRoom(id);
    for (const [iid, inv] of this.invites) if (inv.from === id || inv.to === id) this.invites.delete(iid);
    this.persist();
    this.closeSockets(id, () => true, 4001, 'deleted');
    return json({ ok: true });
  }

  async exportData(me) {
    const all = async (sql) => (await this.db.prepare(sql).bind(me.id).all()).results;
    const user = await this.getUser(me.id);
    const data = {
      exportedAt: new Date().toISOString(),
      account: { id: user.id, name: user.name, bio: user.bio, email: user.email, credits: user.credits, createdAt: user.created_at, photo: user.avatar },
      playlists: await this.loadPlaylists(me.id, 'WHERE p.owner = ?', me.id),
      songsYouAddedToOthers: await all('SELECT ps.playlist_id, ps.track_id, ps.added_at FROM playlist_songs ps WHERE ps.added_by = ?'),
      likes: await all('SELECT playlist_id, track_id, at FROM likes WHERE user_id = ?'),
      creditHistory: await all('SELECT delta, reason, ref, at FROM credit_ledger WHERE user_id = ? ORDER BY at'),
      listeningCredits: await all('SELECT playlist_id, track_id, at FROM listens WHERE user_id = ?'),
      inbox: await all('SELECT kind, actor, text, at, read FROM inbox WHERE user_id = ? ORDER BY at'),
      devices: await all('SELECT device, created_at, last_seen FROM sessions WHERE user_id = ?'),
    };
    return new Response(JSON.stringify(data, null, 2), {
      headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="aux-${me.id}.json"` },
    });
  }

  // Closes this user's sockets whose session matches; their app reconnects or signs out by code.
  closeSockets(uid, match, code = 4001, reason = 'signed out') {
    for (const ws of this.ctx.getWebSockets(uid)) {
      const { sh } = ws.deserializeAttachment() || {};
      if (match(sh)) { try { ws.close(code, reason); } catch {} }
    }
  }

  // ---------- inbox ----------
  async unread(uid) {
    return (await this.db.prepare('SELECT count(*) AS n FROM inbox WHERE user_id = ? AND read = 0').bind(uid).first()).n;
  }
  // Saves a note to someone's inbox. Online: a live toast. Offline: a push to their devices.
  async notify(uid, { kind, actor, text, url }) {
    await this.db.prepare('INSERT INTO inbox (user_id, kind, actor, text, url, at) VALUES (?, ?, ?, ?, ?, ?)').bind(uid, kind, actor, text, url, Date.now()).run();
    if (this.isOnline(uid)) {
      this.sendTo(uid, { type: 'inbox', unread: await this.unread(uid) });
      this.sendTo(uid, { type: 'notice', text });
      return;
    }
    const { results } = await this.db.prepare('SELECT endpoint FROM push_subs WHERE user_id = ?').bind(uid).all();
    const work = Promise.all(results.map(async ({ endpoint }) => {
      if (await ring(endpoint, this.env) === 'gone') await this.db.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(endpoint).run();
    }));
    this.ctx.waitUntil?.(work);
  }

  // ---------- songs ----------
  // Adds one song ({source, sourceId} or {url}) or several ({tracks: [...]}) in one go.
  async addSongs(me, playlistId, body) {
    const pl = await this.playlist(playlistId);
    if (!pl) return fail(404, 'Playlist not found.');
    const space = MAX_SONGS - pl.songs.length;
    if (space <= 0) return fail(400, `This playlist is full (${MAX_SONGS} songs).`);
    const wanted = Array.isArray(body.tracks) ? body.tracks.slice(0, MAX_SONGS) : [body.url ? { url: body.url } : { source: body.source, sourceId: body.sourceId }];
    const resolved = await Promise.all(wanted.map((w) => (w.url ? this.resolveLink(w.url) : this.resolveTrack(w.source, String(w.sourceId || '')))
      .then((t) => ({ t }), (e) => ({ err: e.message }))));
    const have = new Set(pl.songs.map((s) => s.id));
    const tracks = [], skipped = [];
    for (const r of resolved) {
      if (r.err) skipped.push(r.err);
      else if (have.has(r.t.id)) skipped.push(`"${r.t.title}" is already on this playlist.`);
      else if (tracks.length >= space) skipped.push(`No room for "${r.t.title}".`);
      else { have.add(r.t.id); tracks.push(r.t); }
    }
    if (!tracks.length) return fail(400, skipped[0] || 'Nothing to add.');
    const n = tracks.length;
    const isOwner = pl.owner === me.id;
    const now = Date.now();
    if (!isOwner) {
      // Conditional update so a balance can't go below zero.
      const r = await this.db.prepare('UPDATE users SET credits = credits - ? WHERE id = ? AND credits >= ?').bind(n, me.id, n).run();
      if (!r.meta.changes) return fail(402, n === 1 ? 'You need 1 credit. Listen to songs other people added to earn more.' : `You need ${n} credits and have ${me.credits}. Pick fewer songs, or listen to earn more.`);
    }
    try {
      await this.db.batch(tracks.flatMap((t, i) => [
        this.db.prepare(`INSERT INTO tracks (id, source, source_id, title, author, art, duration, license, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET title = excluded.title, author = excluded.author, art = excluded.art, license = excluded.license`)
          .bind(t.id, t.source, t.sourceId, String(t.title).slice(0, 160), String(t.author).slice(0, 100), t.art, t.duration || null, t.license || null, now),
        // +i keeps the chosen order when songs are sorted by time added.
        this.db.prepare('INSERT INTO playlist_songs (playlist_id, track_id, added_by, added_at) VALUES (?, ?, ?, ?)').bind(playlistId, t.id, isOwner ? null : me.id, now + i),
        ...(isOwner ? [] : [this.db.prepare('INSERT INTO credit_ledger (user_id, delta, reason, ref, at) VALUES (?, -1, ?, ?, ?)').bind(me.id, 'add_song', `${playlistId}:${t.id}`, now)]),
      ]));
    } catch {
      if (!isOwner) await this.db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').bind(n, me.id).run();
      return fail(400, 'Someone just changed this playlist. Try again.');
    }
    if (!isOwner) {
      await this.notify(pl.owner, {
        kind: 'added', actor: me.id, url: `#p-${playlistId}`,
        text: n === 1 ? `@${me.id} added "${tracks[0].title}" to ${pl.name}` : `@${me.id} added ${n} songs to ${pl.name}`,
      });
    }
    const credits = (await this.getUser(me.id)).credits;
    return json({ playlist: await this.playlist(playlistId, me.id), credits, added: n, skipped });
  }

  // Like or unlike a song on a playlist. When the owner likes a song someone else added,
  // that person earns a credit, once: good picks pay off, not just paying to get in.
  async toggleLike(me, playlistId, trackId) {
    const row = await this.db.prepare(`SELECT ps.added_by, p.owner, p.name, t.title FROM playlist_songs ps
      JOIN playlists p ON p.id = ps.playlist_id JOIN tracks t ON t.id = ps.track_id WHERE ps.playlist_id = ? AND ps.track_id = ?`).bind(playlistId, trackId).first();
    if (!row) return fail(404, 'That song is not on this playlist any more.');
    const now = Date.now();
    const ins = await this.db.prepare('INSERT OR IGNORE INTO likes (user_id, playlist_id, track_id, at) VALUES (?, ?, ?, ?)').bind(me.id, playlistId, trackId, now).run();
    const liked = !!ins.meta.changes;
    if (!liked) await this.db.prepare('DELETE FROM likes WHERE user_id = ? AND playlist_id = ? AND track_id = ?').bind(me.id, playlistId, trackId).run();
    const adder = row.added_by;
    if (liked && me.id === row.owner && adder && adder !== me.id) {
      const ref = `${playlistId}:${trackId}`;
      const r = await this.db.prepare(`INSERT INTO credit_ledger (user_id, delta, reason, ref, at)
        SELECT ?1, 1, 'liked', ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM credit_ledger WHERE user_id = ?1 AND reason = 'liked' AND ref = ?2)`).bind(adder, ref, now).run();
      if (r.meta.changes) {
        await this.db.prepare('UPDATE users SET credits = credits + 1 WHERE id = ?').bind(adder).run();
        await this.notify(adder, { kind: 'liked', actor: me.id, url: `#p-${playlistId}`, text: `@${me.id} liked "${row.title}", the song you added to ${row.name}. You earned 1 credit.` });
      }
    }
    const { n } = await this.db.prepare('SELECT count(*) AS n FROM likes WHERE playlist_id = ? AND track_id = ?').bind(playlistId, trackId).first();
    return json({ liked, likes: n });
  }

  // Earn a credit for listening 30s+ to a song someone else put on a playlist (once per song).
  async listen(me, body) {
    const playlistId = String(body.playlistId || ''), trackId = String(body.trackId || '');
    const row = await this.db.prepare('SELECT ps.added_by, p.owner FROM playlist_songs ps JOIN playlists p ON p.id = ps.playlist_id WHERE ps.playlist_id = ? AND ps.track_id = ?')
      .bind(playlistId, trackId).first();
    if (!row || (row.added_by || row.owner) === me.id) return json({ earned: 0, credits: me.credits });
    const now = Date.now();
    const r = await this.db.prepare('INSERT OR IGNORE INTO listens (user_id, playlist_id, track_id, at) VALUES (?, ?, ?, ?)').bind(me.id, playlistId, trackId, now).run();
    if (!r.meta.changes) return json({ earned: 0, credits: me.credits });
    await this.db.batch([
      this.db.prepare('UPDATE users SET credits = credits + 1 WHERE id = ?').bind(me.id),
      this.db.prepare('INSERT INTO credit_ledger (user_id, delta, reason, ref, at) VALUES (?, 1, ?, ?, ?)').bind(me.id, 'listen', `${playlistId}:${trackId}`, now),
    ]);
    return json({ earned: 1, credits: me.credits + 1 });
  }

  // ---------- realtime ----------
  async connect(req, url) {
    if (req.headers.get('Upgrade') !== 'websocket') return fail(426, 'Expected a WebSocket.');
    const [client, server] = Object.values(new WebSocketPair());
    const user = await this.userByToken(url.searchParams.get('token'));
    if (!user) { server.accept(); server.close(4001, 'auth'); return new Response(null, { status: 101, webSocket: client }); }
    const uid = user.id;
    this.ctx.acceptWebSocket(server, [uid]);
    server.serializeAttachment({ uid, name: user.name, sh: user.session_hash });
    if (this.leaving.delete(uid)) this.persist();
    const r0 = this.userRoom(uid);
    server.send(JSON.stringify({ type: 'room', room: r0 ? this.roomOut(r0) : null }));
    if (r0) server.send(JSON.stringify({ type: 'chat-history', messages: r0.chat || [] }));
    for (const [id, inv] of this.invites) {
      if (inv.to === uid) server.send(JSON.stringify({ type: 'invite', id, from: { id: inv.from, name: inv.fromName, online: true }, roomSize: this.rooms.get(inv.roomId)?.members.size || 1 }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  sendTo(uid, msg) {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets(uid)) { try { ws.send(s); } catch {} }
  }
  roomOut(room) {
    return {
      id: room.id, host: room.host,
      members: [...room.members].map((id) => ({ id, name: room.names[id] || id, online: this.isOnline(id) })),
      pending: [...room.pending], state: room.state, serverTime: Date.now(),
    };
  }
  broadcastRoom(room) {
    const out = { type: 'room', room: this.roomOut(room) };
    for (const id of room.members) this.sendTo(id, out);
  }
  userRoom(uid) {
    for (const r of this.rooms.values()) if (r.members.has(uid)) return r;
    return null;
  }
  leaveRoom(uid) {
    const r = this.userRoom(uid);
    if (!r) return;
    r.members.delete(uid);
    this.sendTo(uid, { type: 'room', room: null });
    if (r.members.size === 0) { this.rooms.delete(r.id); return; }
    if (r.host === uid) r.host = [...r.members][0];
    if (r.members.size === 1 && r.pending.size === 0) {
      const last = [...r.members][0];
      this.rooms.delete(r.id);
      this.sendTo(last, { type: 'room', room: null });
      this.sendTo(last, { type: 'notice', text: 'Everyone left the sync.' });
      return;
    }
    this.roomSay(r, `@${uid} left`);
    this.broadcastRoom(r);
  }

  // ---------- party chat ----------
  // A message from a member, or a system note when `from` is null. Kept in the room, sent to everyone in it.
  roomSay(r, text, from = null) {
    const msg = { id: randomHex(4), from, name: from ? r.names[from] || from : null, text, at: Date.now() };
    (r.chat ||= []).push(msg);
    if (r.chat.length > CHAT_KEEP) r.chat.splice(0, r.chat.length - CHAT_KEEP);
    for (const id of r.members) this.sendTo(id, { type: 'chat', msg });
  }
  // True if this user has sent `limit` of this kind within `ms`.
  flooding(uid, kind, limit, ms) {
    const key = `${uid}:${kind}`, now = Date.now();
    const times = (this.recent.get(key) || []).filter((t) => now - t < ms);
    if (times.length >= limit) return true;
    times.push(now);
    this.recent.set(key, times);
    return false;
  }
  closeIfEmpty(r, notify) {
    if (r.members.size <= 1 && r.pending.size === 0 && !r.state.track) {
      this.rooms.delete(r.id);
      this.sendTo(notify, { type: 'room', room: null });
      return true;
    }
    return false;
  }

  async webSocketMessage(ws, raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const { uid, name } = ws.deserializeAttachment();
    const err = (text) => ws.send(JSON.stringify({ type: 'error', text }));

    if (m.type === 'ping') return ws.send(JSON.stringify({ type: 'pong', t: m.t, s: Date.now() }));

    if (m.type === 'invite') {
      const to = cleanHandle(m.to);
      const target = to && to !== uid ? await this.getUser(to) : null;
      if (!target) return err('No one has that ID.');
      if (target.sample) return err(`@${to} is a sample profile and can't join syncs.`);
      if (!this.isOnline(to)) return err(`@${to} isn't online right now.`);
      if (this.userRoom(to)) return err(`@${to} is already in a sync.`);
      let r = this.userRoom(uid);
      if (!r) {
        r = { id: randomHex(4), host: uid, members: new Set([uid]), pending: new Set(), names: { [uid]: name },
          state: { track: null, playing: false, position: 0, ref: Date.now(), queue: [], index: 0, playlistId: null, heldBy: null }, chat: [] };
        this.rooms.set(r.id, r);
      }
      if (r.pending.has(to)) return;
      r.pending.add(to);
      r.names[to] = target.name;
      const id = randomHex(4);
      this.invites.set(id, { from: uid, fromName: name, to, roomId: r.id, at: Date.now() });
      this.sendTo(to, { type: 'invite', id, from: { id: uid, name, online: true }, roomSize: r.members.size });
      this.broadcastRoom(r);
      return this.persist();
    }

    if (m.type === 'respond') {
      const inv = this.invites.get(m.id);
      if (!inv || inv.to !== uid) return;
      this.invites.delete(m.id);
      const r = this.rooms.get(inv.roomId);
      if (!r) { ws.send(JSON.stringify({ type: 'notice', text: 'That sync has ended.' })); return this.persist(); }
      r.pending.delete(uid);
      if (m.accept) {
        this.leaveRoom(uid);
        r.members.add(uid);
        r.names[uid] = name;
        for (const id of r.members) if (id !== uid) this.sendTo(id, { type: 'notice', text: `@${uid} joined the sync.` });
        this.sendTo(uid, { type: 'chat-history', messages: r.chat || [] });
        this.roomSay(r, `@${uid} joined`);
      } else {
        this.sendTo(inv.from, { type: 'notice', text: `@${uid} declined the sync.` });
        if (this.closeIfEmpty(r, inv.from)) return this.persist();
      }
      this.broadcastRoom(r);
      return this.persist();
    }

    const room = this.userRoom(uid);
    if (!room) return;
    const st = room.state;
    const now = Date.now();
    const positionNow = () => (st.playing ? st.position + (now - st.ref) / 1000 : st.position);

    if (m.type === 'leave') { this.leaveRoom(uid); return this.persist(); }
    if (m.type === 'chat') {
      const text = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, CHAT_LEN);
      if (!text) return;
      if (this.flooding(uid, 'chat', 5, 10_000)) return err('Slow down a little. Try again in a few seconds.');
      this.roomSay(room, text, uid);
      return this.persist();
    }
    if (m.type === 'react') {
      // Reactions float across everyone's screen and aren't stored.
      if (!REACTIONS.has(m.kind) || this.flooding(uid, 'react', 4, 3000)) return;
      for (const id of room.members) this.sendTo(id, { type: 'react', kind: m.kind, from: uid });
      return;
    }
    if (m.type === 'load') {
      // The queue always comes from a stored playlist or the Discover row, never from the client.
      const pl = m.discover ? null : await this.playlist(String(m.playlistId || ''));
      const queue = m.discover ? await this.discover() : (pl?.songs || []).map(songToTrack);
      const index = Math.max(0, Math.min(queue.length - 1, m.index | 0));
      if (!queue[index]) return;
      // A start time in the future gives every phone a moment to load before the clock starts.
      Object.assign(st, { queue, index, playlistId: pl?.id || null, track: queue[index], playing: true, position: 0, ref: now + 1500 });
    } else if (m.type === 'pause') {
      Object.assign(st, { position: Math.max(0, Number(m.position) || positionNow()), playing: false, ref: now });
    } else if (m.type === 'resume') {
      Object.assign(st, { position: Math.max(0, Number(m.position) || st.position), playing: true, ref: now + 600 });
    } else if (m.type === 'seek') {
      Object.assign(st, { position: Math.max(0, Number(m.position) || 0), ref: now + (st.playing ? 600 : 0) });
    } else if (m.type === 'next' || m.type === 'prev') {
      if (m.type === 'next' && Number.isInteger(m.from) && m.from !== st.index) return; // another phone already skipped
      const ni = st.index + (m.type === 'next' ? 1 : -1);
      if (ni < 0 || ni >= st.queue.length) Object.assign(st, { playing: false, position: 0, ref: now });
      else Object.assign(st, { index: ni, track: st.queue[ni], playing: true, position: 0, ref: now + 1500 });
    } else if (m.type === 'hold') {
      // Someone hit an ad or long buffering: pause everyone at the current point.
      if (!st.playing) return;
      Object.assign(st, { position: positionNow(), playing: false, ref: now, heldBy: uid });
      for (const id of room.members) if (id !== uid) this.sendTo(id, { type: 'notice', text: `Waiting for @${uid} (ad or buffering)` });
    } else if (m.type === 'release') {
      if (st.heldBy !== uid || st.playing) return;
      Object.assign(st, { heldBy: null, playing: true, ref: now + 800 });
    } else return;
    if (m.type !== 'hold' && m.type !== 'release') st.heldBy = null;
    this.broadcastRoom(room);
    this.persist();
  }

  async webSocketClose(ws) { this.socketGone(ws); }
  async webSocketError(ws) { this.socketGone(ws); }
  socketGone(ws) {
    const { uid } = ws.deserializeAttachment() || {};
    if (!uid) return;
    if (this.ctx.getWebSockets(uid).some((w) => w !== ws && w.readyState === WebSocket.OPEN)) return;
    this.leaving.set(uid, Date.now() + LEAVE_GRACE);
    // If the phone that paused everyone for an ad is gone, don't leave the room stuck.
    const r = this.userRoom(uid);
    if (r?.state.heldBy === uid) { Object.assign(r.state, { heldBy: null, playing: true, ref: Date.now() + 800 }); this.broadcastRoom(r); }
    this.persist();
  }

  async alarm() {
    const now = Date.now();
    for (const [id, inv] of this.invites) {
      if (now - inv.at < INVITE_TTL) continue;
      this.invites.delete(id);
      const r = this.rooms.get(inv.roomId);
      if (r) { r.pending.delete(inv.to); if (!this.closeIfEmpty(r, inv.from)) this.broadcastRoom(r); }
      this.sendTo(inv.to, { type: 'invite-expired', id });
      this.sendTo(inv.from, { type: 'notice', text: `@${inv.to} didn't answer the sync invite.` });
    }
    for (const [uid, at] of this.leaving) {
      if (at > now) continue;
      this.leaving.delete(uid);
      if (!this.isOnline(uid)) this.leaveRoom(uid);
    }
    this.persist();
  }
}
