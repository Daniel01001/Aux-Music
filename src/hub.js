// Aux hub: one Durable Object that serves the REST API and holds every live socket and sync room.
// Users, playlists and credits live in D1. Rooms, invites and disconnect timers live in this
// object's own storage, so they survive the object hibernating between messages.
import { DurableObject } from 'cloudflare:workers';

const START_CREDITS = 5;
const MAX_SONGS = 10;
const INVITE_TTL = 60_000;
const LEAVE_GRACE = 15_000; // a page refresh shouldn't drop you from a sync
const AUDIUS = 'https://api.audius.co/v1';
const APP_NAME = 'aux-music';
const SEARCH_TTL = 24 * 3600_000;

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
const trackOut = (r) => ({ id: r.id, source: r.source, sourceId: r.source_id, title: r.title, author: r.author, art: r.art });

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

async function fetchJson(url, ms = 5000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) return null;
  return r.json();
}

const audiusTrack = (t) => t && ({
  id: `au:${t.id}`, source: 'au', sourceId: t.id, title: t.title, author: t.user?.name?.trim() || '',
  art: t.artwork?.['480x480'] || t.artwork?.['150x150'] || '', duration: t.duration,
  playable: t.is_streamable !== false && !t.is_stream_gated && !t.is_delete,
});

// ---------- Durable Object ----------
export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.db = env.DB;
    this.rooms = new Map();   // roomId -> { id, host, members:Set, pending:Set, names:{}, state }
    this.invites = new Map(); // inviteId -> { from, fromName, to, roomId, at }
    this.leaving = new Map(); // userId -> time to drop them from their room
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
  publicUser(u) { return u && { id: u.id, name: u.name, sample: !!u.sample, online: this.isOnline(u.id) }; }
  meUser(u) { return { ...this.publicUser(u), credits: u.credits }; }
  getUser(id) { return this.db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first(); }
  async userByToken(token) {
    if (!token) return null;
    return this.db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND u.sample = 0').bind(await sha256(token)).first();
  }
  async sessionStmt(uid) {
    const token = crypto.randomUUID();
    return [token, this.db.prepare('INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)').bind(await sha256(token), uid, Date.now())];
  }
  async createUser(handle, name, extra = {}) {
    const now = Date.now();
    const [token, session] = await this.sessionStmt(handle);
    await this.db.batch([
      this.db.prepare('INSERT INTO users (id, name, credits, google_sub, email, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(handle, name, START_CREDITS, extra.googleSub || null, extra.email || null, now),
      session,
      this.db.prepare('INSERT INTO credit_ledger (user_id, delta, reason, at) VALUES (?, ?, ?, ?)').bind(handle, START_CREDITS, 'start', now),
    ]);
    return { token, user: this.meUser({ id: handle, name, credits: START_CREDITS }) };
  }
  async checkNewUser(handle, name) {
    if (!/^[a-z0-9_]{3,20}$/.test(handle)) return [400, 'Use 3 to 20 letters, numbers or underscores.'];
    if (!name) return [400, 'Add a display name.'];
    if (await this.getUser(handle)) return [409, `@${handle} is taken. Try another.`];
    return null;
  }
  // A new session per sign-in, so each device stays signed in on its own.
  async newSession(uid) {
    const [token, session] = await this.sessionStmt(uid);
    await session.run();
    return token;
  }

  // ---------- playlists ----------
  // where: SQL on aliases p (playlists) and u (owner).
  async loadPlaylists(where = '', ...args) {
    const { results: pls } = await this.db.prepare(
      `SELECT p.id, p.owner, p.name, p.created_at, u.name AS owner_name, u.sample FROM playlists p JOIN users u ON u.id = p.owner ${where} ORDER BY p.created_at DESC LIMIT 200`,
    ).bind(...args).all();
    const { results: songs } = await this.db.prepare(
      `SELECT ps.playlist_id, ps.added_by, ps.added_at, t.* FROM playlist_songs ps JOIN tracks t ON t.id = ps.track_id
       JOIN playlists p ON p.id = ps.playlist_id JOIN users u ON u.id = p.owner ${where} ORDER BY ps.added_at`,
    ).bind(...args).all();
    const byId = new Map(pls.map((p) => [p.id, { id: p.id, owner: p.owner, ownerName: p.owner_name, sample: !!p.sample, name: p.name, createdAt: p.created_at, songs: [] }]));
    for (const s of songs) byId.get(s.playlist_id)?.songs.push({ ...trackOut(s), addedBy: s.added_by, addedAt: s.added_at });
    return [...byId.values()];
  }
  async playlist(id) { return (await this.loadPlaylists('WHERE p.id = ?', id))[0] || null; }

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
      const o = await fetchJson(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${sourceId}`, 4000).catch(() => null);
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
    const vid = parseVideoId(input);
    if (!vid) throw new Error('Paste a YouTube, YouTube Music or Audius song link.');
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
        return (j?.data || []).map(audiusTrack).filter((t) => t.playable).slice(0, 10).map(({ playable, duration, ...t }) => t);
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

  // ---------- HTTP ----------
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') return this.connect(req, url);
    try { return await this.api(req, url); }
    catch (e) { console.error(e?.stack || e); return fail(500, 'Something went wrong. Try again.'); }
  }

  async api(req, url) {
    const m = req.method, path = url.pathname;
    const body = m === 'POST' ? await req.json().catch(() => ({})) : {};

    if (m === 'POST' && path === '/api/signup') {
      if (this.env.GOOGLE_CLIENT_ID) return fail(403, 'Sign in with Google.');
      const handle = cleanHandle(body.handle), name = cleanName(body.name);
      const bad = await this.checkNewUser(handle, name);
      if (bad) return fail(...bad);
      return json(await this.createUser(handle, name));
    }

    if (m === 'POST' && path === '/api/auth/google') return this.googleAuth(body);

    const me = await this.userByToken((req.headers.get('Authorization') || '').replace('Bearer ', ''));
    if (!me) return fail(401, 'Sign in again.');

    if (m === 'GET' && path === '/api/me') return json(this.meUser(me));

    if (m === 'GET' && path === '/api/feed') {
      const all = await this.loadPlaylists();
      return json({ mine: all.filter((p) => p.owner === me.id), others: all.filter((p) => p.owner !== me.id) });
    }

    if (m === 'GET' && path === '/api/users') {
      const q = cleanHandle(url.searchParams.get('q'));
      const { results } = await this.db.prepare('SELECT * FROM users WHERE id != ? AND (id LIKE ? OR lower(name) LIKE ?) LIMIT 200')
        .bind(me.id, `%${q}%`, `%${q}%`).all();
      const list = results.map((u) => this.publicUser(u)).sort((a, b) => (b.online - a.online) || a.id.localeCompare(b.id)).slice(0, 20);
      return json(list);
    }

    let p = path.match(/^\/api\/users\/([a-z0-9_]+)$/);
    if (m === 'GET' && p) {
      const u = await this.getUser(p[1]);
      if (!u) return fail(404, 'No one has that ID.');
      return json({ user: this.publicUser(u), playlists: await this.loadPlaylists('WHERE p.owner = ?', u.id) });
    }

    if (m === 'POST' && path === '/api/playlists') {
      const name = String(body.name || '').trim().slice(0, 40);
      if (!name) return fail(400, 'Give the playlist a name.');
      const id = randomHex(5);
      await this.db.prepare('INSERT INTO playlists (id, owner, name, created_at) VALUES (?, ?, ?, ?)').bind(id, me.id, name, Date.now()).run();
      return json(await this.playlist(id));
    }

    p = path.match(/^\/api\/playlists\/([0-9a-f]{10})$/);
    if (p && m === 'GET') {
      const pl = await this.playlist(p[1]);
      return pl ? json(pl) : fail(404, 'Playlist not found.');
    }
    if (p && m === 'DELETE') {
      const r = await this.db.prepare('DELETE FROM playlists WHERE id = ? AND owner = ?').bind(p[1], me.id).run();
      return r.meta.changes ? json({ ok: true }) : fail(403, 'Only the owner can delete this playlist.');
    }

    if (m === 'GET' && path === '/api/resolve') {
      try { return json(await this.resolveLink(url.searchParams.get('url'))); }
      catch (e) { return fail(400, e.message); }
    }

    if (m === 'GET' && path === '/api/search') {
      const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
      const source = url.searchParams.get('source') === 'au' ? 'au' : 'yt';
      if (source === 'yt' && !this.env.YT_API_KEY) return json({ enabled: false, results: [] });
      if (!q) return json({ enabled: true, results: [] });
      try { return json({ enabled: true, results: await this.search(q, source) }); }
      catch { return fail(502, 'Song search is unavailable right now. Paste a link instead.'); }
    }

    p = path.match(/^\/api\/playlists\/([0-9a-f]{10})\/songs$/);
    if (p && m === 'POST') return this.addSong(me, p[1], body);

    p = path.match(/^\/api\/playlists\/([0-9a-f]{10})\/songs\/([^/]+)$/);
    if (p && m === 'DELETE') {
      const pl = await this.db.prepare('SELECT owner FROM playlists WHERE id = ?').bind(p[1]).first();
      if (!pl || pl.owner !== me.id) return fail(403, 'Only the owner can remove songs.');
      await this.db.prepare('DELETE FROM playlist_songs WHERE playlist_id = ? AND track_id = ?').bind(p[1], decodeURIComponent(p[2])).run();
      return json(await this.playlist(p[1]));
    }

    if (m === 'POST' && path === '/api/listen') return this.listen(me, body);

    return fail(404, 'Not found.');
  }

  async googleAuth(body) {
    const clientId = this.env.GOOGLE_CLIENT_ID;
    if (!clientId) return fail(400, 'Google sign-in is not set up on this server.');
    const c = await fetchJson(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(String(body.credential || ''))}`).catch(() => null);
    const valid = c && c.aud === clientId && ['accounts.google.com', 'https://accounts.google.com'].includes(c.iss) && Number(c.exp) * 1000 > Date.now() && c.sub;
    if (!valid) return fail(401, 'Google sign-in failed. Try again.');
    const existing = await this.db.prepare('SELECT * FROM users WHERE google_sub = ?').bind(c.sub).first();
    if (existing) return json({ token: await this.newSession(existing.id), user: this.meUser(existing) });
    // First sign-in: the client asks for an @ID, then sends the same credential back with it.
    if (!body.handle) return json({ needsHandle: true, name: cleanName(c.given_name || c.name) });
    const handle = cleanHandle(body.handle), name = cleanName(body.name);
    const bad = await this.checkNewUser(handle, name);
    if (bad) return fail(...bad);
    return json(await this.createUser(handle, name, { googleSub: c.sub, email: c.email }));
  }

  async addSong(me, playlistId, body) {
    const pl = await this.playlist(playlistId);
    if (!pl) return fail(404, 'Playlist not found.');
    let track;
    try {
      track = body.url ? await this.resolveLink(body.url) : await this.resolveTrack(body.source, String(body.sourceId || ''));
    } catch (e) { return fail(400, e.message); }
    if (pl.songs.length >= MAX_SONGS) return fail(400, `This playlist is full (${MAX_SONGS} songs).`);
    if (pl.songs.some((s) => s.id === track.id)) return fail(400, 'That song is already on this playlist.');
    const isOwner = pl.owner === me.id;
    const now = Date.now();
    if (!isOwner) {
      // Conditional update so a balance can't go below zero.
      const r = await this.db.prepare('UPDATE users SET credits = credits - 1 WHERE id = ? AND credits >= 1').bind(me.id).run();
      if (!r.meta.changes) return fail(402, 'You need 1 credit. Listen to songs other people added to earn more.');
    }
    try {
      await this.db.batch([
        this.db.prepare(`INSERT INTO tracks (id, source, source_id, title, author, art, duration, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET title = excluded.title, author = excluded.author, art = excluded.art`)
          .bind(track.id, track.source, track.sourceId, String(track.title).slice(0, 160), String(track.author).slice(0, 100), track.art, track.duration || null, now),
        this.db.prepare('INSERT INTO playlist_songs (playlist_id, track_id, added_by, added_at) VALUES (?, ?, ?, ?)').bind(playlistId, track.id, isOwner ? null : me.id, now),
        ...(isOwner ? [] : [this.db.prepare('INSERT INTO credit_ledger (user_id, delta, reason, ref, at) VALUES (?, -1, ?, ?, ?)').bind(me.id, 'add_song', `${playlistId}:${track.id}`, now)]),
      ]);
    } catch (e) {
      if (!isOwner) await this.db.prepare('UPDATE users SET credits = credits + 1 WHERE id = ?').bind(me.id).run();
      return fail(400, 'That song is already on this playlist.');
    }
    if (!isOwner) this.sendTo(pl.owner, { type: 'notice', text: `@${me.id} added "${track.title}" to ${pl.name}` });
    const credits = (await this.getUser(me.id)).credits;
    return json({ playlist: await this.playlist(playlistId), credits });
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
    server.serializeAttachment({ uid, name: user.name });
    if (this.leaving.delete(uid)) this.persist();
    const r0 = this.userRoom(uid);
    server.send(JSON.stringify({ type: 'room', room: r0 ? this.roomOut(r0) : null }));
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
    this.broadcastRoom(r);
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
          state: { track: null, playing: false, position: 0, ref: Date.now(), queue: [], index: 0, playlistId: null, heldBy: null } };
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
    if (m.type === 'load') {
      // The queue always comes from the stored playlist, never from the client.
      const pl = await this.playlist(String(m.playlistId || ''));
      const queue = (pl?.songs || []).map(({ addedBy, addedAt, ...t }) => t);
      const index = Math.max(0, Math.min(queue.length - 1, m.index | 0));
      if (!queue[index]) return;
      // A start time in the future gives every phone a moment to load before the clock starts.
      Object.assign(st, { queue, index, playlistId: pl.id, track: queue[index], playing: true, position: 0, ref: now + 1500 });
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
