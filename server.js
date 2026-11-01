// Aux MVP server: accounts, playlists, credits, and real-time sync rooms.
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const YT_API_KEY = process.env.YT_API_KEY || '';
const START_CREDITS = 5;
const MAX_SONGS = 10;

// ---------- storage ----------
let db = { users: {}, playlists: {}, listens: {} };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { seed(); }
db.listens = db.listens || {};
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(DATA_FILE, JSON.stringify(db), () => {}), 200);
}

function seed() {
  const s = (videoId, title, author) => ({ videoId, title, author, addedBy: null, addedAt: Date.now() });
  const users = [
    ['thandi', 'Thandi'], ['kabelo', 'Kabelo'], ['lerato', 'Lerato'],
  ];
  for (const [id, name] of users) {
    db.users[id] = { id, name, credits: START_CREDITS, token: crypto.randomUUID(), sample: true, createdAt: Date.now() };
  }
  const lists = [
    ['thandi', 'Sunday drive', [
      s('JGwWNGJdvx8', 'Shape of You', 'Ed Sheeran'),
      s('lp-EO5I60KA', 'Thinking Out Loud', 'Ed Sheeran'),
      s('09R8_2nJtjg', 'Sugar', 'Maroon 5'),
      s('YQHsXMglC9A', 'Hello', 'Adele'),
      s('RgKAFK5djSk', 'See You Again', 'Wiz Khalifa ft. Charlie Puth'),
    ]],
    ['kabelo', 'Throwbacks', [
      s('fJ9rUzIMcZQ', 'Bohemian Rhapsody', 'Queen'),
      s('hTWKbfoikeg', 'Smells Like Teen Spirit', 'Nirvana'),
      s('dQw4w9WgXcQ', 'Never Gonna Give You Up', 'Rick Astley'),
      s('pRpeEdMmmQ0', 'Waka Waka', 'Shakira'),
      s('9bZkp7q19f0', 'Gangnam Style', 'PSY'),
    ]],
    ['lerato', 'Gym set', [
      s('OPf0YbXqDm0', 'Uptown Funk', 'Mark Ronson ft. Bruno Mars'),
      s('CevxZvSJLk8', 'Roar', 'Katy Perry'),
      s('60ItHLz5WEA', 'Faded', 'Alan Walker'),
      s('kJQP7kiw5Fk', 'Despacito', 'Luis Fonsi ft. Daddy Yankee'),
      s('JGwWNGJdvx8', 'Shape of You', 'Ed Sheeran'),
    ]],
  ];
  for (const [owner, name, songs] of lists) {
    const id = crypto.randomBytes(5).toString('hex');
    db.playlists[id] = { id, owner, name, songs, createdAt: Date.now() };
  }
}

// ---------- helpers ----------
const publicUser = (u) => u && ({ id: u.id, name: u.name, sample: !!u.sample, online: online.has(u.id) });
const meUser = (u) => ({ ...publicUser(u), credits: u.credits });
const playlistOut = (p) => ({ ...p, ownerName: db.users[p.owner]?.name || p.owner, sample: !!db.users[p.owner]?.sample });

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const user = Object.values(db.users).find((u) => u.token === token && !u.sample);
  if (!user) return res.status(401).json({ error: 'Sign in again.' });
  req.user = user; next();
}

function parseVideoId(input) {
  if (!input) return null;
  const s = String(input).trim();
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

async function lookupVideo(videoId) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${videoId}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json();
    return { title: j.title, author: (j.author_name || '').replace(/ - Topic$/, '').replace(/VEVO$/, '') };
  } catch { return null; }
}

// ---------- REST ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/signup', (req, res) => {
  const handle = String(req.body.handle || '').toLowerCase().trim().replace(/^@/, '');
  const name = String(req.body.name || '').trim().slice(0, 30);
  if (!/^[a-z0-9_]{3,20}$/.test(handle)) return res.status(400).json({ error: 'Use 3 to 20 letters, numbers or underscores.' });
  if (!name) return res.status(400).json({ error: 'Add a display name.' });
  if (db.users[handle]) return res.status(409).json({ error: `@${handle} is taken. Try another.` });
  const user = { id: handle, name, credits: START_CREDITS, token: crypto.randomUUID(), createdAt: Date.now() };
  db.users[handle] = user; save();
  res.json({ token: user.token, user: meUser(user) });
});

app.get('/api/me', auth, (req, res) => res.json(meUser(req.user)));

app.get('/api/feed', auth, (req, res) => {
  const all = Object.values(db.playlists).sort((a, b) => b.createdAt - a.createdAt).map(playlistOut);
  res.json({ mine: all.filter((p) => p.owner === req.user.id), others: all.filter((p) => p.owner !== req.user.id) });
});

app.get('/api/users', auth, (req, res) => {
  const q = String(req.query.q || '').toLowerCase().replace(/^@/, '');
  const hits = Object.values(db.users)
    .filter((u) => u.id !== req.user.id && (u.id.includes(q) || u.name.toLowerCase().includes(q)))
    .sort((a, b) => (online.has(b.id) - online.has(a.id)) || a.id.localeCompare(b.id))
    .slice(0, 20).map(publicUser);
  res.json(hits);
});

app.get('/api/users/:id', auth, (req, res) => {
  const u = db.users[req.params.id];
  if (!u) return res.status(404).json({ error: 'No one has that ID.' });
  const playlists = Object.values(db.playlists).filter((p) => p.owner === u.id).map(playlistOut);
  res.json({ user: publicUser(u), playlists });
});

app.post('/api/playlists', auth, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Give the playlist a name.' });
  const id = crypto.randomBytes(5).toString('hex');
  db.playlists[id] = { id, owner: req.user.id, name, songs: [], createdAt: Date.now() };
  save(); res.json(playlistOut(db.playlists[id]));
});

app.get('/api/playlists/:id', auth, (req, res) => {
  const p = db.playlists[req.params.id];
  if (!p) return res.status(404).json({ error: 'Playlist not found.' });
  res.json(playlistOut(p));
});

app.delete('/api/playlists/:id', auth, (req, res) => {
  const p = db.playlists[req.params.id];
  if (!p || p.owner !== req.user.id) return res.status(403).json({ error: 'Only the owner can delete this playlist.' });
  delete db.playlists[p.id]; save(); res.json({ ok: true });
});

app.get('/api/resolve', auth, async (req, res) => {
  const videoId = parseVideoId(req.query.url);
  if (!videoId) return res.status(400).json({ error: 'That link does not look like a YouTube or YouTube Music song.' });
  const meta = await lookupVideo(videoId);
  res.json({ videoId, title: meta?.title || 'YouTube track', author: meta?.author || '' });
});

const searchCache = new Map();
app.get('/api/search', auth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!YT_API_KEY) return res.json({ enabled: false, results: [] });
  if (!q) return res.json({ enabled: true, results: [] });
  if (searchCache.has(q.toLowerCase())) return res.json({ enabled: true, results: searchCache.get(q.toLowerCase()) });
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=8&q=${encodeURIComponent(q)}&key=${YT_API_KEY}`;
    const j = await (await fetch(url)).json();
    const results = (j.items || []).map((i) => ({ videoId: i.id.videoId, title: decode(i.snippet.title), author: decode(i.snippet.channelTitle).replace(/ - Topic$/, '') }));
    searchCache.set(q.toLowerCase(), results);
    res.json({ enabled: true, results });
  } catch { res.status(502).json({ error: 'Song search is unavailable right now. Paste a link instead.' }); }
});
const decode = (s) => String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

app.post('/api/playlists/:id/songs', auth, async (req, res) => {
  const p = db.playlists[req.params.id];
  if (!p) return res.status(404).json({ error: 'Playlist not found.' });
  const videoId = parseVideoId(req.body.videoId || req.body.url);
  if (!videoId) return res.status(400).json({ error: 'That link does not look like a YouTube or YouTube Music song.' });
  if (p.songs.length >= MAX_SONGS) return res.status(400).json({ error: `This playlist is full (${MAX_SONGS} songs).` });
  if (p.songs.some((s) => s.videoId === videoId)) return res.status(400).json({ error: 'That song is already on this playlist.' });
  const isOwner = p.owner === req.user.id;
  if (!isOwner && req.user.credits < 1) return res.status(402).json({ error: 'You need 1 credit. Listen to songs other people added to earn more.' });
  let { title, author } = req.body;
  if (!title) { const meta = await lookupVideo(videoId); title = meta?.title || 'YouTube track'; author = meta?.author || ''; }
  if (!isOwner) req.user.credits -= 1;
  p.songs.push({ videoId, title: String(title).slice(0, 120), author: String(author || '').slice(0, 80), addedBy: isOwner ? null : req.user.id, addedAt: Date.now() });
  save();
  if (!isOwner) sendTo(p.owner, { type: 'notice', text: `@${req.user.id} added "${title}" to ${p.name}` });
  res.json({ playlist: playlistOut(p), credits: req.user.credits });
});

app.delete('/api/playlists/:id/songs/:videoId', auth, (req, res) => {
  const p = db.playlists[req.params.id];
  if (!p || p.owner !== req.user.id) return res.status(403).json({ error: 'Only the owner can remove songs.' });
  p.songs = p.songs.filter((s) => s.videoId !== req.params.videoId); save();
  res.json(playlistOut(p));
});

// Earn a credit for listening 30s+ to a song someone else added (once per song).
app.post('/api/listen', auth, (req, res) => {
  const p = db.playlists[req.body.playlistId];
  const song = p?.songs.find((s) => s.videoId === req.body.videoId);
  const key = `${req.user.id}:${p?.id}:${req.body.videoId}`;
  const putThereBy = song && (song.addedBy || p.owner);
  if (!song || putThereBy === req.user.id || db.listens[key]) {
    return res.json({ earned: 0, credits: req.user.credits });
  }
  db.listens[key] = Date.now(); req.user.credits += 1; save();
  res.json({ earned: 1, credits: req.user.credits });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------- realtime ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const online = new Map(); // userId -> Set<ws>
const rooms = new Map();  // roomId -> room
const invites = new Map(); // inviteId -> { from, to, roomId, at }

function sendTo(userId, msg) {
  for (const ws of online.get(userId) || []) ws.readyState === 1 && ws.send(JSON.stringify(msg));
}
function roomOut(room) {
  return {
    id: room.id, host: room.host,
    members: [...room.members].map((id) => publicUser(db.users[id])),
    pending: [...room.pending],
    state: room.state, serverTime: Date.now(),
  };
}
function broadcastRoom(room) {
  const out = { type: 'room', room: roomOut(room) };
  for (const id of room.members) sendTo(id, out);
}
function userRoom(userId) {
  for (const r of rooms.values()) if (r.members.has(userId)) return r;
  return null;
}
function leaveRoom(userId) {
  const r = userRoom(userId);
  if (!r) return;
  r.members.delete(userId);
  sendTo(userId, { type: 'room', room: null });
  if (r.members.size === 0) { rooms.delete(r.id); return; }
  if (r.host === userId) r.host = [...r.members][0];
  if (r.members.size === 1 && r.pending.size === 0) { const last = [...r.members][0]; rooms.delete(r.id); sendTo(last, { type: 'room', room: null }); sendTo(last, { type: 'notice', text: 'Everyone left the sync.' }); return; }
  broadcastRoom(r);
}
function positionNow(state) {
  if (!state.playing) return state.position;
  return state.position + (Date.now() - state.ref) / 1000;
}

wss.on('connection', (ws, req) => {
  const token = new URL(req.url, 'http://x').searchParams.get('token');
  const user = Object.values(db.users).find((u) => u.token === token && !u.sample);
  if (!user) return ws.close(4001, 'auth');
  const uid = user.id;
  if (!online.has(uid)) online.set(uid, new Set());
  online.get(uid).add(ws);
  const r0 = userRoom(uid);
  ws.send(JSON.stringify({ type: 'room', room: r0 ? roomOut(r0) : null }));
  for (const [iid, inv] of invites) if (inv.to === uid) ws.send(JSON.stringify({ type: 'invite', id: iid, from: publicUser(db.users[inv.from]), roomSize: rooms.get(inv.roomId)?.members.size || 1 }));

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const room = userRoom(uid);

    if (m.type === 'ping') return ws.send(JSON.stringify({ type: 'pong', t: m.t, s: Date.now() }));

    if (m.type === 'invite') {
      const to = String(m.to || '').toLowerCase();
      const target = db.users[to];
      if (!target || to === uid) return ws.send(JSON.stringify({ type: 'error', text: 'No one has that ID.' }));
      if (target.sample) return ws.send(JSON.stringify({ type: 'error', text: `@${to} is a sample profile and can't join syncs.` }));
      if (!online.has(to)) return ws.send(JSON.stringify({ type: 'error', text: `@${to} isn't online right now.` }));
      if (userRoom(to)) return ws.send(JSON.stringify({ type: 'error', text: `@${to} is already in a sync.` }));
      let r = room;
      if (!r) {
        r = { id: crypto.randomBytes(4).toString('hex'), host: uid, members: new Set([uid]), pending: new Set(), state: { videoId: null, title: '', author: '', playing: false, position: 0, ref: Date.now(), queue: [], index: 0, playlistId: null } };
        rooms.set(r.id, r);
      }
      if (r.pending.has(to)) return;
      r.pending.add(to);
      const iid = crypto.randomBytes(4).toString('hex');
      invites.set(iid, { from: uid, to, roomId: r.id, at: Date.now() });
      sendTo(to, { type: 'invite', id: iid, from: publicUser(user), roomSize: r.members.size });
      broadcastRoom(r);
      return;
    }

    if (m.type === 'respond') {
      const inv = invites.get(m.id);
      if (!inv || inv.to !== uid) return;
      invites.delete(m.id);
      const r = rooms.get(inv.roomId);
      if (!r) return ws.send(JSON.stringify({ type: 'notice', text: 'That sync has ended.' }));
      r.pending.delete(uid);
      if (m.accept) {
        leaveRoom(uid);
        r.members.add(uid);
        for (const id of r.members) if (id !== uid) sendTo(id, { type: 'notice', text: `@${uid} joined the sync.` });
      } else {
        sendTo(inv.from, { type: 'notice', text: `@${uid} declined the sync.` });
        if (r.members.size <= 1 && r.pending.size === 0 && !r.state.videoId) { rooms.delete(r.id); sendTo(inv.from, { type: 'room', room: null }); return; }
      }
      broadcastRoom(r);
      return;
    }

    if (!room) return;
    const st = room.state;
    if (m.type === 'leave') return leaveRoom(uid);
    if (m.type === 'load') {
      const queue = Array.isArray(m.queue) ? m.queue.slice(0, MAX_SONGS).map((s) => ({ videoId: String(s.videoId), title: String(s.title || ''), author: String(s.author || '') })) : [];
      const index = Math.max(0, Math.min(queue.length - 1, m.index | 0));
      if (!queue[index]) return;
      Object.assign(st, { queue, index, playlistId: m.playlistId || null, videoId: queue[index].videoId, title: queue[index].title, author: queue[index].author, playing: true, position: 0, ref: Date.now() + 1500 });
      // ref in the future gives every device a moment to load before the clock starts.
      st.position = 0; st.startAt = st.ref;
    } else if (m.type === 'pause') {
      st.position = Math.max(0, Number(m.position) || positionNow(st)); st.playing = false; st.ref = Date.now();
    } else if (m.type === 'resume') {
      st.position = Math.max(0, Number(m.position) || st.position); st.playing = true; st.ref = Date.now() + 600;
    } else if (m.type === 'seek') {
      st.position = Math.max(0, Number(m.position) || 0); st.ref = Date.now() + (st.playing ? 600 : 0);
    } else if (m.type === 'next' || m.type === 'prev') {
      if (m.type === 'next' && Number.isInteger(m.from) && m.from !== st.index) return; // already advanced
      const ni = st.index + (m.type === 'next' ? 1 : -1);
      if (ni < 0 || ni >= st.queue.length) { st.playing = false; st.position = 0; st.ref = Date.now(); }
      else Object.assign(st, { index: ni, videoId: st.queue[ni].videoId, title: st.queue[ni].title, author: st.queue[ni].author, playing: true, position: 0, ref: Date.now() + 1500 });
    } else if (m.type === 'hold') {
      // Someone hit an ad or buffering: pause everyone at the current point.
      if (!st.playing) return;
      st.position = positionNow(st); st.playing = false; st.ref = Date.now(); st.heldBy = uid;
      for (const id of room.members) if (id !== uid) sendTo(id, { type: 'notice', text: `Waiting for @${uid} (ad or buffering)` });
    } else if (m.type === 'release') {
      if (st.heldBy !== uid || st.playing) return;
      st.heldBy = null; st.playing = true; st.ref = Date.now() + 800;
    } else return;
    if (m.type !== 'hold' && m.type !== 'release') st.heldBy = null;
    broadcastRoom(room);
  });

  ws.on('close', () => {
    const set = online.get(uid);
    set?.delete(ws);
    if (set && set.size === 0) {
      online.delete(uid);
      setTimeout(() => { if (!online.has(uid)) leaveRoom(uid); }, 15000);
    }
  });
});

// Expire stale invites after 60s.
setInterval(() => {
  for (const [iid, inv] of invites) if (Date.now() - inv.at > 60000) {
    invites.delete(iid);
    const r = rooms.get(inv.roomId);
    if (r) { r.pending.delete(inv.to); if (r.members.size <= 1 && r.pending.size === 0 && !r.state.videoId) { rooms.delete(r.id); sendTo(inv.from, { type: 'room', room: null }); } else broadcastRoom(r); }
    sendTo(inv.to, { type: 'invite-expired', id: iid });
    sendTo(inv.from, { type: 'notice', text: `@${inv.to} didn't answer the sync invite.` });
  }
}, 5000);

server.listen(PORT, () => console.log(`Aux running on http://localhost:${PORT}`));
