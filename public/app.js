// Aux client: views, playback engine (solo + synced), realtime socket.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const view = $('#view');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const thumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
  const hue = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const avatar = (u, size = '') => `<span class="avatar ${size} ${u?.online ? 'online' : ''}" style="--h:${hue(u?.id || '?')}">${esc((u?.name || u?.id || '?')[0])}</span>`;
  const fmt = (t) => { t = Math.max(0, Math.floor(t || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };

  let token = store.get('aux-token');
  let me = null;
  let room = null;
  let pendingInvites = [];

  // ---------- API ----------
  async function api(path, opts = {}) {
    const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: opts.body && JSON.stringify(opts.body) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { signOut(); throw new Error('Sign in again.'); }
    if (!r.ok) throw new Error(j.error || 'Something went wrong. Try again.');
    return j;
  }
  function setCredits(n) { if (me) me.credits = n; $('#creditsN').textContent = n; }

  // ---------- toasts & sheets ----------
  function toast(text) {
    const el = document.createElement('div'); el.className = 'toast'; el.textContent = text;
    $('#toasts').append(el); setTimeout(() => el.remove(), 3600);
  }
  function sheet(html, onMount) {
    const root = $('#modalRoot');
    root.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
    const close = () => { root.innerHTML = ''; };
    root.onclick = (e) => { if (e.target === root) close(); };
    root.querySelectorAll('[data-close]').forEach((b) => b.onclick = close);
    onMount?.(root.firstElementChild, close);
    return close;
  }

  // ---------- theme ----------
  const THEMES = [
    { id: 'midnight', name: 'Midnight', bg: '#0B0D12', a: '#F2A65A' },
    { id: 'graphite', name: 'Graphite', bg: '#0E0E0E', a: '#5CC8B5' },
    { id: 'wine', name: 'Wine', bg: '#120B0E', a: '#E8707E' },
    { id: 'paper', name: 'Light', bg: '#F5F4F1', a: '#C94E22' },
  ];
  function setTheme(id) {
    document.documentElement.dataset.theme = id; store.set('aux-theme', id);
    $('meta[name="theme-color"]').content = THEMES.find((t) => t.id === id)?.bg || '#0B0D12';
  }
  setTheme(store.get('aux-theme') || 'midnight');

  // ---------- covers & cards ----------
  function cover(songs) {
    const ids = [...new Set(songs.map((s) => s.videoId))].slice(0, 4);
    if (!ids.length) return `<div class="cover"><div class="empty">+</div></div>`;
    if (ids.length < 4) return `<div class="cover one"><img src="${thumb(ids[0])}" alt="" loading="lazy"></div>`;
    return `<div class="cover">${ids.map((id) => `<img src="${thumb(id)}" alt="" loading="lazy">`).join('')}</div>`;
  }
  const slots = (n) => `<div class="slots" title="${n} of 10 songs">${Array.from({ length: 10 }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</div>`;

  // ---------- router ----------
  const routes = { home: renderHome, search: renderSearch, sync: renderSync, you: renderYou };
  async function route() {
    if (!token) return renderOnboard();
    document.body.classList.remove('no-tabs');
    const h = location.hash.slice(1) || 'home';
    const tab = h.startsWith('p-') || h.startsWith('u-') ? null : h;
    document.querySelectorAll('.tabbar a').forEach((a) => a.dataset.tab === (tab || (h.startsWith('u-') ? 'search' : 'home')) ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
    try {
      if (h.startsWith('p-')) await renderPlaylist(h.slice(2));
      else if (h.startsWith('u-')) await renderUser(h.slice(2));
      else await (routes[h] || renderHome)();
    } catch (e) { view.innerHTML = `<div class="empty-state"><h3>Couldn't load this</h3><p>${esc(e.message)}</p></div>`; }
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', () => { collapsePlayer(); route(); });

  // ---------- onboarding ----------
  function renderOnboard() {
    document.body.classList.add('no-tabs');
    view.innerHTML = `
      <div class="onboard">
        <div class="wordmark" style="font-size:34px">aux<span class="dot"></span></div>
        <div>
          <h1>Hand someone the aux.</h1>
          <p class="lede">Short playlists anyone can see. Spend a credit to put a song on someone else's list, and listen together in sync.</p>
        </div>
        <ol class="how">
          <li><span><b>Make a playlist</b> of 5 to 10 songs from YouTube Music.</span></li>
          <li><span><b>Add songs to other people's playlists.</b> It costs 1 credit. Listen to songs others added to earn credits back.</span></li>
          <li><span><b>Sync</b> with a friend by their ID and hear the same song at the same moment.</span></li>
        </ol>
        <form id="signup" class="sync-card" novalidate>
          <div class="field"><label for="name">Your name</label><input class="input" id="name" autocomplete="nickname" maxlength="30" placeholder="Daniel"></div>
          <div class="field"><label for="handle">Pick your ID</label><div class="input-wrap"><span class="prefix">@</span><input class="input" id="handle" autocapitalize="none" autocomplete="off" spellcheck="false" maxlength="20" placeholder="daniel"></div></div>
          <div class="error" id="err"></div>
          <button class="btn primary block" type="submit">Get started</button>
          <p class="muted small" style="margin:0">Google sign-in comes later. For this test build, your ID is saved on this device.</p>
        </form>
      </div>`;
    $('#signup').onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button'); btn.disabled = true;
      try {
        const r = await fetch('/api/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('#name').value, handle: $('#handle').value }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        token = j.token; store.set('aux-token', token); me = j.user;
        boot();
      } catch (err) { $('#err').textContent = err.message; btn.disabled = false; }
    };
  }

  // ---------- home ----------
  async function renderHome() {
    const feed = await api('/api/feed');
    view.innerHTML = `
      <section class="section" style="margin-top:8px">
        <div class="section-head"><h2>Your playlists</h2></div>
        <div class="rail">
          ${feed.mine.map((p) => `<a class="rail-card" href="#p-${p.id}">${cover(p.songs)}<div><div class="t">${esc(p.name)}</div><div class="s">${p.songs.length} of 10 songs</div></div></a>`).join('')}
          <button class="rail-card new-card" id="newPl" type="button" style="background:none;border:0;padding:0;text-align:left"><div class="cover"><svg><use href="#i-plus"/></svg></div><div><div class="t">New playlist</div><div class="s">5 to 10 songs</div></div></button>
        </div>
      </section>
      ${room ? syncBanner() : ''}
      <section class="section">
        <div class="section-head"><h2>From people</h2><a class="link-btn" href="#search">Find someone</a></div>
        ${feed.others.length ? `<div class="feed">${feed.others.map(feedCard).join('')}</div>` : `<div class="empty-state">No one else has a playlist yet.</div>`}
      </section>`;
    $('#newPl').onclick = newPlaylist;
  }
  const feedCard = (p) => `
    <a class="feed-card" href="#p-${p.id}">
      ${cover(p.songs)}
      <div class="meta">${avatar({ id: p.owner, name: p.ownerName }, 'sm')}<div class="text"><div class="t">${esc(p.name)}</div><div class="s">@${esc(p.owner)}${p.sample ? ' <span class="tag">sample</span>' : ''}</div></div></div>
      ${slots(p.songs.length)}
    </a>`;
  const syncBanner = () => `
    <section class="section"><a href="#sync" class="sync-card" style="flex-direction:row;align-items:center">
      <div class="stack">${room.members.map((m) => avatar(m, 'sm')).join('')}</div>
      <div style="flex:1;min-width:0"><div class="live-pill">In sync</div><div class="small muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${room.state.videoId ? esc(room.state.title) : 'Pick a song to start'}</div></div>
    </a></section>`;

  function newPlaylist() {
    sheet(`
      <div class="sheet-top"><h2>New playlist</h2><button class="icon-btn" data-close aria-label="Close"><svg><use href="#i-close"/></svg></button></div>
      <form id="npf" class="field" novalidate><label for="npn">Name</label><input class="input" id="npn" maxlength="40" placeholder="Late night drive"><div class="error" id="npe"></div><button class="btn primary block" type="submit">Create</button></form>`,
    (el, close) => {
      $('#npn', el).focus();
      $('#npf', el).onsubmit = async (e) => {
        e.preventDefault();
        try { const p = await api('/api/playlists', { method: 'POST', body: { name: $('#npn', el).value } }); close(); location.hash = `p-${p.id}`; }
        catch (err) { $('#npe', el).textContent = err.message; }
      };
    });
  }

  // ---------- playlist ----------
  async function renderPlaylist(id) {
    const p = await api(`/api/playlists/${id}`);
    const mine = p.owner === me.id;
    const full = p.songs.length >= 10;
    view.innerHTML = `
      <a class="back" href="javascript:history.back()"><svg><use href="#i-back"/></svg>Back</a>
      <div class="pl-head">
        ${cover(p.songs)}
        <div style="min-width:0">
          <span class="tag">${p.songs.length} of 10 songs</span>
          <h1>${esc(p.name)}</h1>
          <a class="pl-owner" href="${mine ? '#you' : `#u-${p.owner}`}">${avatar({ id: p.owner, name: p.ownerName }, 'sm')}<span>${mine ? 'You' : '@' + esc(p.owner)}</span></a>
        </div>
      </div>
      <div class="section" style="margin-top:18px">
        <div class="row-actions">
          <button class="btn primary" id="playAll" ${p.songs.length ? '' : 'disabled'} type="button"><svg><use href="#i-play"/></svg>${room ? 'Play for the sync' : 'Play'}</button>
          <button class="btn" id="addSong" ${full ? 'disabled' : ''} type="button"><svg><use href="#i-plus"/></svg>${full ? 'Full' : mine ? 'Add a song' : 'Add a song · 1 credit'}</button>
        </div>
      </div>
      <div class="section" style="padding:0;margin-top:14px">
        ${p.songs.length ? `<ol class="songs">${p.songs.map((s, i) => `
          <li class="song ${engine.state.videoId === s.videoId ? 'now' : ''}" data-i="${i}">
            <img class="thumb" src="${thumb(s.videoId)}" alt="" loading="lazy">
            <div class="txt" data-play="${i}"><div class="st">${esc(s.title)}</div><div class="sa">${esc(s.author)}${s.addedBy ? ` · <span class="added-by">added by @${esc(s.addedBy)}</span>` : ''}</div></div>
            ${mine ? `<button class="icon-btn" data-del="${esc(s.videoId)}" aria-label="Remove ${esc(s.title)}"><svg style="width:18px;height:18px;color:var(--muted)"><use href="#i-trash"/></svg></button>` : '<span></span>'}
          </li>`).join('')}</ol>`
        : `<div class="empty-state"><h3>No songs yet</h3><p>${mine ? 'Add 5 to 10 songs so people know your taste.' : 'Be the first to add a song here.'}</p></div>`}
      </div>
      ${mine ? `<div class="section"><button class="link-btn" id="delPl" type="button" style="color:var(--muted)">Delete playlist</button></div>` : ''}`;
    const queue = p.songs.map((s) => ({ videoId: s.videoId, title: s.title, author: s.author }));
    $('#playAll').onclick = () => playQueue(queue, 0, p.id);
    view.querySelectorAll('[data-play]').forEach((el) => el.onclick = () => playQueue(queue, +el.dataset.play, p.id));
    $('#addSong').onclick = () => addSongSheet(p);
    view.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { await api(`/api/playlists/${p.id}/songs/${b.dataset.del}`, { method: 'DELETE' }); route(); });
    $('#delPl') && ($('#delPl').onclick = () => sheet(`
      <h2>Delete "${esc(p.name)}"?</h2><p class="muted" style="margin:0">Songs other people added will be gone too.</p>
      <div class="row-actions"><button class="btn" data-close style="flex:1">Keep it</button><button class="btn primary" id="yesDel" style="flex:1">Delete</button></div>`,
    (el, close) => { $('#yesDel', el).onclick = async () => { await api(`/api/playlists/${p.id}`, { method: 'DELETE' }); close(); location.hash = 'home'; }; }));
  }

  function addSongSheet(p) {
    const mine = p.owner === me.id;
    sheet(`
      <div class="sheet-top"><h2>Add to ${esc(p.name)}</h2><button class="icon-btn" data-close aria-label="Close"><svg><use href="#i-close"/></svg></button></div>
      <div class="field"><label for="sq">Search a song or paste a YouTube Music link</label><input class="input" id="sq" placeholder="music.youtube.com/watch?v=…" autocapitalize="none" autocomplete="off"></div>
      <div id="sres"></div>
      <div class="error" id="serr"></div>
      <p class="muted small" style="margin:0">${mine ? 'Adding to your own playlist is free.' : `Costs 1 credit. You have ${me.credits}.`}</p>`,
    (el, close) => {
      const q = $('#sq', el), out = $('#sres', el), err = $('#serr', el);
      q.focus();
      let t;
      q.oninput = () => { clearTimeout(t); t = setTimeout(lookup, 350); };
      async function lookup() {
        err.textContent = ''; const v = q.value.trim(); if (!v) return (out.innerHTML = '');
        if (/youtu\.?be|^[\w-]{11}$/.test(v)) {
          try { const s = await api(`/api/resolve?url=${encodeURIComponent(v)}`); show([s]); } catch (e) { out.innerHTML = ''; err.textContent = e.message; }
        } else {
          const r = await api(`/api/search?q=${encodeURIComponent(v)}`);
          if (!r.enabled) { out.innerHTML = ''; err.textContent = 'Song search needs a YouTube API key on the server. Paste a link for now: open the song in YouTube Music, tap Share, then Copy link.'; return; }
          show(r.results);
        }
      }
      function show(list) {
        out.innerHTML = `<ul class="results">${list.map((s, i) => `<li><img src="${thumb(s.videoId)}" alt=""><div style="min-width:0"><div class="pm-title">${esc(s.title)}</div><div class="pm-sub">${esc(s.author)}</div></div><button class="btn primary" data-add="${i}" type="button" style="height:36px;padding:0 14px">Add</button></li>`).join('')}</ul>`;
        out.querySelectorAll('[data-add]').forEach((b) => b.onclick = async () => {
          b.disabled = true;
          try {
            const s = list[+b.dataset.add];
            const r = await api(`/api/playlists/${p.id}/songs`, { method: 'POST', body: s });
            setCredits(r.credits); close(); toast(mine ? 'Added.' : `Added to @${p.owner}'s playlist. 1 credit spent.`); route();
          } catch (e) { err.textContent = e.message; b.disabled = false; }
        });
      }
    });
  }

  // ---------- people ----------
  async function renderSearch() {
    view.innerHTML = `
      <section class="section" style="margin-top:8px">
        <h1 style="margin-bottom:14px">Find people</h1>
        <div class="input-wrap"><span class="prefix">@</span><input class="input" id="pq" placeholder="Search by ID or name" autocapitalize="none" autocomplete="off" spellcheck="false"></div>
        <ul class="people" id="plist" style="margin-top:10px"></ul>
      </section>`;
    const q = $('#pq'); let t;
    const run = async () => {
      const list = await api(`/api/users?q=${encodeURIComponent(q.value.trim())}`);
      $('#plist').innerHTML = list.length ? list.map(personRow).join('') : `<li class="empty-state">No one matches "${esc(q.value)}".</li>`;
      wirePeople($('#plist'));
    };
    q.oninput = () => { clearTimeout(t); t = setTimeout(run, 250); };
    run();
  }
  const personRow = (u) => `
    <li class="person">
      <a href="#u-${esc(u.id)}" style="display:contents">${avatar(u)}<div class="who"><div class="n">${esc(u.name)}${u.sample ? ' <span class="tag">sample</span>' : ''}</div><div class="h">@${esc(u.id)}${u.online ? ' · online' : ''}</div></div></a>
      ${u.sample ? '' : `<button class="btn" data-sync="${esc(u.id)}" type="button" style="height:36px;padding:0 14px" ${u.online ? '' : 'disabled'}><svg><use href="#i-sync"/></svg>Sync</button>`}
    </li>`;
  const wirePeople = (root) => root.querySelectorAll('[data-sync]').forEach((b) => b.onclick = () => invite(b.dataset.sync));

  async function renderUser(id) {
    const { user, playlists } = await api(`/api/users/${id}`);
    view.innerHTML = `
      <a class="back" href="javascript:history.back()"><svg><use href="#i-back"/></svg>Back</a>
      <section class="section" style="margin-top:8px;display:flex;gap:16px;align-items:center">
        ${avatar(user, 'lg')}
        <div style="flex:1;min-width:0"><h1 style="font-size:26px">${esc(user.name)}</h1><div class="muted">@${esc(user.id)}${user.online ? ' · online' : ''}${user.sample ? ' · sample profile' : ''}</div></div>
      </section>
      ${user.sample ? '' : `<div class="section" style="margin-top:16px"><button class="btn primary" id="syncU" type="button" ${user.online ? '' : 'disabled'}><svg><use href="#i-sync"/></svg>${user.online ? `Sync with @${esc(user.id)}` : `@${esc(user.id)} is offline`}</button></div>`}
      <section class="section"><div class="section-head"><h2>Playlists</h2></div>
        ${playlists.length ? `<div class="feed">${playlists.map(feedCard).join('')}</div>` : `<div class="empty-state">@${esc(user.id)} hasn't made a playlist yet.</div>`}
      </section>`;
    $('#syncU') && ($('#syncU').onclick = () => invite(user.id));
  }

  // ---------- sync tab ----------
  function renderSync() {
    if (!room) {
      view.innerHTML = `
        <section class="section" style="margin-top:8px">
          <h1>Listen together</h1>
          <p class="muted" style="max-width:40ch">Invite someone by their ID. When they accept, you both hear the same song at the same moment. Add more people to make it a party.</p>
          ${inviteForm()}
        </section>
        <section class="section"><div class="section-head"><h2>Online now</h2></div><ul class="people" id="onl"></ul></section>`;
      wireInviteForm();
      api('/api/users?q=').then((l) => { const on = l.filter((u) => u.online); $('#onl') && ($('#onl').innerHTML = on.length ? on.map(personRow).join('') : `<li class="muted">No one else is online. Open Aux on your other phone to test.</li>`); $('#onl') && wirePeople($('#onl')); });
      return;
    }
    const st = room.state;
    view.innerHTML = `
      <section class="section" style="margin-top:8px">
        <div class="sync-card">
          <div style="display:flex;justify-content:space-between;align-items:center"><span class="live-pill">In sync · ${room.members.length}</span><button class="link-btn" id="leave" type="button" style="color:var(--bad)">Leave</button></div>
          ${st.videoId ? `<div class="preview" style="background:none;padding:0"><img src="${thumb(st.videoId)}" alt=""><div style="min-width:0"><div class="pm-title">${esc(st.title)}</div><div class="pm-sub">${esc(st.author)} · ${st.playing ? 'playing' : 'paused'}</div></div></div>` : `<p class="muted" style="margin:0">Nothing playing yet. Open any playlist and tap <b>Play for the sync</b>.</p>`}
          <ul class="people">
            ${room.members.map((m) => `<li class="person">${avatar(m)}<div class="who"><div class="n">${m.id === me.id ? 'You' : esc(m.name)}</div><div class="h">@${esc(m.id)}${m.id === room.host ? ' · started the sync' : ''}</div></div></li>`).join('')}
            ${room.pending.map((id) => `<li class="person pending">${avatar({ id, name: id })}<div class="who"><div class="n">@${esc(id)}</div><div class="h">Waiting for them to accept</div></div></li>`).join('')}
          </ul>
        </div>
        <div style="margin-top:18px"><h2 style="margin-bottom:10px">Add someone</h2>${inviteForm()}</div>
      </section>`;
    $('#leave').onclick = () => send({ type: 'leave' });
    wireInviteForm();
  }
  const inviteForm = () => `<form class="inline-form" id="invF" style="margin-top:14px" novalidate><div class="input-wrap"><span class="prefix">@</span><input class="input" id="invQ" placeholder="their ID" autocapitalize="none" autocomplete="off" spellcheck="false"></div><button class="btn primary" type="submit" style="height:48px">Invite</button></form>`;
  function wireInviteForm() { $('#invF').onsubmit = (e) => { e.preventDefault(); const v = $('#invQ').value.trim().replace(/^@/, ''); if (v) invite(v); $('#invQ').value = ''; }; }
  function invite(id) { send({ type: 'invite', to: id.toLowerCase() }); toast(`Invite sent to @${id}. Waiting for them to accept.`); }

  // ---------- you ----------
  async function renderYou() {
    me = await api('/api/me'); setCredits(me.credits);
    view.innerHTML = `
      <section class="section" style="margin-top:8px;display:flex;gap:16px;align-items:center">
        ${avatar(me, 'lg')}<div><h1 style="font-size:26px">${esc(me.name)}</h1><div class="muted">@${esc(me.id)}</div></div>
      </section>
      <section class="section">
        <div class="sync-card" style="flex-direction:row;align-items:center;gap:16px">
          <div style="font-family:var(--font-display);font-size:40px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums">${me.credits}</div>
          <div class="small muted">credits. Adding a song to someone else's playlist costs 1. Listen for 30 seconds to a song someone else added to earn 1 back.</div>
        </div>
      </section>
      <section class="section"><div class="section-head"><h2>Theme</h2></div>
        <div class="themes">${THEMES.map((t) => `<button class="swatch" type="button" data-theme-id="${t.id}" aria-pressed="${document.documentElement.dataset.theme === t.id}"><span class="sw" style="background:${t.bg};--a:${t.a};${t.id === 'paper' ? 'border:1px solid #ddd' : ''}"></span>${t.name}</button>`).join('')}</div>
      </section>
      <section class="section"><div class="section-head"><h2>Share your ID</h2></div><p class="muted" style="margin:0 0 10px">Friends search <b style="color:var(--text)">@${esc(me.id)}</b> to add songs to your playlists or sync with you.</p></section>
      <section class="section"><button class="btn" id="signOut" type="button">Sign out of this device</button></section>`;
    view.querySelectorAll('[data-theme-id]').forEach((b) => b.onclick = () => { setTheme(b.dataset.themeId); view.querySelectorAll('[data-theme-id]').forEach((x) => x.setAttribute('aria-pressed', x === b)); });
    $('#signOut').onclick = signOut;
  }
  function signOut() { store.set('aux-token', null); token = null; me = null; try { ws?.close(); } catch {} location.hash = ''; route(); }

  // =====================================================================
  // Playback engine. One state shape for solo and synced play:
  // { queue, index, videoId, title, author, playing, position, ref, playlistId }
  // Expected time = position + (now - ref)/1000 while playing. In a sync,
  // the server owns the state and "now" is the server clock.
  // =====================================================================
  const engine = { state: { queue: [], index: 0, videoId: null, playing: false, position: 0, ref: 0 }, loaded: null, lastSeek: 0, listened: 0, creditedFor: null, holding: false, bufferSince: 0 };
  let yt = null, ytReady = false, clockOffset = 0, bestRtt = Infinity;
  const now = () => (room ? Date.now() + clockOffset : Date.now());
  const expected = (st) => (st.playing ? st.position + (now() - st.ref) / 1000 : st.position);

  function initYT() {
    yt = new YT.Player('yt', {
      width: '100%', height: '100%',
      playerVars: { playsinline: 1, controls: 0, disablekb: 1, rel: 0, modestbranding: 1, fs: 0, iv_load_policy: 3 },
      events: { onReady: () => { ytReady = true; tick(); }, onStateChange: onYTState, onError: () => { toast("This song can't play outside YouTube. Skipping."); act({ type: 'next', from: engine.state.index }); } },
    });
  }
  if (window.YT && window.YT.Player) initYT(); else window.onYouTubeIframeAPIReady = initYT;

  function onYTState(e) {
    const st = engine.state;
    if (e.data === YT.PlayerState.ENDED) { act({ type: 'next', from: st.index }); }
    if (e.data === YT.PlayerState.PLAYING) { $('#tapAudio').classList.add('hidden'); if (engine.holding) { engine.holding = false; send({ type: 'release' }); } }
    updateButtons();
  }

  // Apply an action locally (solo) or send it to the room (synced).
  function act(m) {
    if (room) return send(m);
    const st = engine.state;
    if (m.type === 'load') Object.assign(st, { queue: m.queue, index: m.index, playlistId: m.playlistId, ...m.queue[m.index], playing: true, position: 0, ref: Date.now() });
    else if (m.type === 'pause') Object.assign(st, { position: expected(st), playing: false, ref: Date.now() });
    else if (m.type === 'resume') Object.assign(st, { playing: true, ref: Date.now() });
    else if (m.type === 'seek') Object.assign(st, { position: m.position, ref: Date.now() });
    else if (m.type === 'next' || m.type === 'prev') {
      if (m.type === 'next' && Number.isInteger(m.from) && m.from !== st.index) return;
      const ni = st.index + (m.type === 'next' ? 1 : -1);
      if (ni < 0 || ni >= st.queue.length) Object.assign(st, { playing: false, position: 0, ref: Date.now() });
      else Object.assign(st, { index: ni, ...st.queue[ni], playing: true, position: 0, ref: Date.now() });
    } else return;
    afterStateChange();
  }
  function playQueue(queue, index, playlistId) {
    act({ type: 'load', queue, index, playlistId });
    if (!room) expandPlayer();
  }

  function afterStateChange() {
    const st = engine.state;
    if (st.videoId) $('#player').classList.remove('hidden');
    if (st.videoId !== engine.listenId) { engine.listenId = st.videoId; engine.listened = 0; }
    renderPlayerMeta(); tick();
    if (location.hash.startsWith('#p-')) view.querySelectorAll('.song').forEach((li) => li.classList.toggle('now', li.querySelector('img')?.src.includes(`/${st.videoId}/`)));
  }

  // The sync loop: keep the YouTube player where the shared clock says it should be.
  function tick() {
    if (!ytReady || !yt?.getPlayerState) return;
    const st = engine.state;
    if (!st.videoId) return;
    const exp = expected(st);
    if (engine.loaded !== st.videoId) {
      engine.loaded = st.videoId; engine.lastSeek = Date.now();
      yt.loadVideoById({ videoId: st.videoId, startSeconds: Math.max(0, exp) });
      if (!st.playing || exp < 0) setTimeout(() => { if (!engine.state.playing || expected(engine.state) < 0) yt.pauseVideo(); }, 400);
      setTimeout(checkAutoplay, 3000);
      return;
    }
    const ps = yt.getPlayerState();
    const cur = yt.getCurrentTime() || 0;
    if (!st.playing || exp < 0) {
      if (ps === YT.PlayerState.PLAYING) yt.pauseVideo();
      const target = Math.max(0, exp < 0 ? 0 : st.position);
      if (Math.abs(cur - target) > 0.6 && Date.now() - engine.lastSeek > 800) { yt.seekTo(target, true); engine.lastSeek = Date.now(); }
      return;
    }
    if (ps !== YT.PlayerState.PLAYING && ps !== YT.PlayerState.BUFFERING) yt.playVideo();
    // Long buffering (often an ad) pauses everyone until this phone catches up.
    if (room && ps === YT.PlayerState.BUFFERING) {
      engine.bufferSince ||= Date.now();
      if (!engine.holding && Date.now() - engine.bufferSince > 3000 && Date.now() - engine.lastSeek > 4000) { engine.holding = true; send({ type: 'hold' }); }
    } else engine.bufferSince = 0;
    const drift = cur - exp;
    if (ps === YT.PlayerState.PLAYING && Math.abs(drift) > 0.35 && Date.now() - engine.lastSeek > 2000) {
      yt.seekTo(exp + 0.2, true); engine.lastSeek = Date.now(); // small lead covers the seek's own delay
    }
    // Earn credits by listening.
    if (ps === YT.PlayerState.PLAYING && st.playlistId) {
      engine.listened += 0.5;
      const key = `${st.videoId}|${st.playlistId}`;
      if (engine.listened >= 30 && engine.creditedFor !== key) {
        engine.creditedFor = key;
        api('/api/listen', { method: 'POST', body: { playlistId: st.playlistId, videoId: st.videoId } }).then((r) => { if (r.earned) { setCredits(r.credits); toast('You earned 1 credit for listening.'); } }).catch(() => {});
      }
    }
  }
  setInterval(() => { tick(); updateProgress(); }, 500);

  function checkAutoplay() {
    if (!engine.state.playing || !ytReady) return;
    if (yt.getPlayerState() !== YT.PlayerState.PLAYING && yt.getPlayerState() !== YT.PlayerState.BUFFERING) {
      $('#tapAudio').classList.remove('hidden');
      if ($('#player').classList.contains('mini')) toast('Tap the video to start the music on this phone.');
    }
  }

  // ---------- player UI ----------
  const P = $('#player');
  P.classList.add('mini');
  function expandPlayer() { P.classList.remove('mini'); P.classList.add('full'); document.body.style.overflow = 'hidden'; renderPlayerMeta(); }
  function collapsePlayer() { P.classList.remove('full'); P.classList.add('mini'); document.body.style.overflow = ''; }
  $('#playerMeta').onclick = (e) => { if (P.classList.contains('mini') && !e.target.closest('button')) expandPlayer(); };
  $('#collapseBtn').onclick = collapsePlayer;
  const toggle = () => { const st = engine.state; act(st.playing ? { type: 'pause', position: yt?.getCurrentTime?.() } : { type: 'resume', position: st.position }); };
  $('#toggleBtn').onclick = toggle; $('#miniToggle').onclick = toggle;
  $('#nextBtn').onclick = () => act({ type: 'next' }); $('#miniNext').onclick = () => act({ type: 'next' });
  $('#prevBtn').onclick = () => {
    if (expected(engine.state) > 4) act({ type: 'seek', position: 0 }); else act({ type: 'prev' });
  };
  let seeking = false;
  $('#seek').oninput = () => { seeking = true; $('#tCur').textContent = fmt($('#seek').value / 100 * (yt?.getDuration?.() || 0)); };
  $('#seek').onchange = () => { seeking = false; act({ type: 'seek', position: $('#seek').value / 100 * (yt?.getDuration?.() || 0) }); };

  function updateButtons() {
    const playing = engine.state.playing;
    for (const b of [$('#toggleBtn'), $('#miniToggle')]) { b.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play'); b.setAttribute('aria-label', playing ? 'Pause' : 'Play'); }
  }
  function updateProgress() {
    if (!ytReady || !engine.state.videoId || seeking) return;
    const d = yt.getDuration?.() || 0, c = Math.max(0, Math.min(d, expected(engine.state)));
    $('#seek').value = d ? (c / d) * 100 : 0; $('#tCur').textContent = fmt(c); $('#tDur').textContent = fmt(d);
  }
  function renderPlayerMeta() {
    const st = engine.state;
    $('#pmTitle').textContent = st.title || 'Nothing playing';
    $('#pmSub').textContent = room ? `In sync with ${room.members.filter((m) => m.id !== me?.id).map((m) => '@' + m.id).join(', ') || 'no one yet'}` : (st.author || '');
    $('#sheetLabel').textContent = room ? 'Playing in sync' : 'Now playing';
    $('#syncStrip').innerHTML = room ? `<div class="stack">${room.members.map((m) => avatar(m, 'sm')).join('')}</div><div style="flex:1;min-width:0"><div class="live-pill">In sync</div><div class="small muted">Everyone controls play, pause and skip.</div></div><a class="link-btn" href="#sync">Manage</a>` : '';
    $('#queueList').innerHTML = st.queue.map((s, i) => `<li data-q="${i}" class="${i === st.index ? 'cur' : ''}"><span class="n">${i + 1}</span><img src="${thumb(s.videoId)}" alt=""><div style="min-width:0"><div class="qt">${esc(s.title)}</div><div class="qa">${esc(s.author)}</div></div></li>`).join('');
    $('#queueList').querySelectorAll('[data-q]').forEach((li) => li.onclick = () => act({ type: 'load', queue: st.queue, index: +li.dataset.q, playlistId: st.playlistId }));
    updateButtons();
  }

  // =====================================================================
  // Realtime socket
  // =====================================================================
  let ws = null, wsRetry = 0;
  function connect() {
    if (!token) return;
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(token)}`);
    ws.onopen = () => { wsRetry = 0; bestRtt = Infinity; for (let i = 0; i < 5; i++) setTimeout(ping, i * 250); };
    ws.onmessage = (e) => onMsg(JSON.parse(e.data));
    ws.onclose = (e) => { if (e.code === 4001) return signOut(); if (token) setTimeout(connect, Math.min(8000, 500 * 2 ** wsRetry++)); };
  }
  function send(m) { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); else toast("You're offline. Reconnecting…"); }
  function ping() { send({ type: 'ping', t: Date.now() }); }
  setInterval(() => ws?.readyState === 1 && ping(), 10000);

  function onMsg(m) {
    if (m.type === 'pong') {
      const rtt = Date.now() - m.t;
      // Keep the offset from the fastest round trip: it has the least network noise.
      if (rtt <= bestRtt * 1.3) { bestRtt = Math.min(bestRtt, rtt); clockOffset = m.s - (m.t + rtt / 2); }
      return;
    }
    if (m.type === 'invite') { pendingInvites.push(m); showInvite(); return; }
    if (m.type === 'invite-expired') { pendingInvites = pendingInvites.filter((i) => i.id !== m.id); $('#modalRoot').innerHTML = ''; showInvite(); return; }
    if (m.type === 'notice' || m.type === 'error') return toast(m.text);
    if (m.type === 'room') {
      const was = room; room = m.room;
      $('#syncBadge').classList.toggle('hidden', !room);
      if (room) {
        const s = room.state;
        engine.state = { ...s };
        if (!s.videoId && was?.state?.videoId == null) { /* nothing yet */ }
      } else if (was) {
        // Leaving keeps the song going on this phone from where the room was.
        const st = engine.state; Object.assign(st, { position: Math.max(0, st.playing ? st.position + (Date.now() + clockOffset - st.ref) / 1000 : st.position), ref: Date.now() });
      }
      afterStateChange();
      const membersChanged = JSON.stringify(was?.members?.map((x) => x.id)) !== JSON.stringify(room?.members?.map((x) => x.id)) || String(was?.pending) !== String(room?.pending);
      if (location.hash === '#sync' || (membersChanged && ['#home', ''].includes(location.hash))) route();
      if (!was && room && room.members.length > 1) toast('Sync is on. Everyone hears the same thing.');
    }
  }

  function showInvite() {
    const inv = pendingInvites[0];
    if (!inv || $('#modalRoot').innerHTML) return;
    sheet(`
      <div class="invite" style="display:flex;flex-direction:column;gap:14px">
        ${avatar(inv.from, 'lg')}
        <h2>@${esc(inv.from.id)} wants to sync</h2>
        <p class="muted" style="margin:0">${inv.roomSize > 1 ? `Join ${inv.roomSize} people` : `Listen with ${esc(inv.from.name)}`} and hear the same song at the same time.</p>
        <div class="row-actions"><button class="btn" id="decl" type="button">Not now</button><button class="btn primary" id="acc" type="button">Join sync</button></div>
      </div>`,
    (el, close) => {
      const done = (accept) => { send({ type: 'respond', id: inv.id, accept }); pendingInvites.shift(); close(); setTimeout(showInvite, 300); };
      $('#acc', el).onclick = () => done(true);
      $('#decl', el).onclick = () => done(false);
    });
  }

  $('#creditsBtn').onclick = () => { location.hash = 'you'; };

  // ---------- boot ----------
  async function boot() {
    if (!token) return route();
    try { me = await api('/api/me'); } catch { return; }
    setCredits(me.credits);
    const a = $('#meAvatar'); a.style.setProperty('--h', hue(me.id)); a.textContent = me.name[0];
    connect();
    if (!location.hash) location.hash = 'home'; else route();
  }
  boot();
})();
