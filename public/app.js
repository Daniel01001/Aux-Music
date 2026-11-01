// Aux client: views, playback engine (solo + synced), realtime socket.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const view = $('#view');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // A song: { id: "yt:<videoId>" | "au:<audiusId>", source, sourceId, title, author, art }
  const art = (s) => esc(s?.art || '');
  const SOURCE_NAME = { yt: 'YouTube Music', au: 'Audius' };
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
    const arts = [...new Set(songs.map((s) => s.art).filter(Boolean))].slice(0, 4);
    if (!arts.length) return `<div class="cover"><div class="empty">+</div></div>`;
    if (arts.length < 4) return `<div class="cover one"><img src="${esc(arts[0])}" alt="" loading="lazy"></div>`;
    return `<div class="cover">${arts.map((a) => `<img src="${esc(a)}" alt="" loading="lazy">`).join('')}</div>`;
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
  let config = null;
  const loadScript = (src) => new Promise((ok, fail) => { const s = document.createElement('script'); s.src = src; s.async = true; s.onload = ok; s.onerror = fail; document.head.append(s); });
  function signedIn(j) { token = j.token; store.set('aux-token', token); me = j.user; boot(); }

  async function renderOnboard() {
    document.body.classList.add('no-tabs');
    if (!config) config = await fetch('/api/config').then((r) => r.json()).catch(() => ({}));
    if (config.googleClientId) return renderGoogleOnboard();
    renderIdOnboard();
  }

  const onboardIntro = `
        <div class="wordmark" style="font-size:34px">aux<span class="dot"></span></div>
        <div>
          <h1>Hand someone the aux.</h1>
          <p class="lede">Short playlists anyone can see. Spend a credit to put a song on someone else's list, and listen together in sync.</p>
        </div>
        <ol class="how">
          <li><span><b>Make a playlist</b> of 5 to 10 songs from YouTube Music.</span></li>
          <li><span><b>Add songs to other people's playlists.</b> It costs 1 credit. Listen to songs others added to earn credits back.</span></li>
          <li><span><b>Sync</b> with a friend by their ID and hear the same song at the same moment.</span></li>
        </ol>`;

  async function renderGoogleOnboard() {
    view.innerHTML = `
      <div class="onboard">${onboardIntro}
        <div class="sync-card" id="gCard">
          <div id="gBtn" class="g-btn"></div>
          <div class="error" id="err"></div>
          <p class="muted small" style="margin:0">Use the Google account you listen to YouTube Music with.</p>
        </div>
      </div>`;
    try {
      if (!window.google?.accounts?.id) await loadScript('https://accounts.google.com/gsi/client');
      google.accounts.id.initialize({ client_id: config.googleClientId, callback: (r) => googleStep(r.credential) });
      const light = document.documentElement.dataset.theme === 'paper';
      google.accounts.id.renderButton($('#gBtn'), { theme: light ? 'outline' : 'filled_black', shape: 'pill', size: 'large', text: 'continue_with', width: Math.min(360, $('#gBtn').clientWidth || 320) });
    } catch { $('#err').textContent = "Couldn't load Google sign-in. Check your connection and reload."; }
  }

  async function googleStep(credential, extra) {
    const err = $('#err'); if (err) err.textContent = '';
    try {
      const r = await fetch('/api/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential, ...extra }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      if (j.needsHandle) return renderPickHandle(credential, j.name);
      signedIn(j);
    } catch (e) { const el = $('#err'); if (el) el.textContent = e.message; const b = $('#pick button'); if (b) b.disabled = false; }
  }

  // First Google sign-in: choose the @ID people will find you by.
  function renderPickHandle(credential, suggested) {
    $('#gCard').outerHTML = `
      <form id="pick" class="sync-card" novalidate>
        <div class="field"><label for="name">Your name</label><input class="input" id="name" autocomplete="nickname" maxlength="30" value="${esc(suggested)}"></div>
        <div class="field"><label for="handle">Pick your ID</label><div class="input-wrap"><span class="prefix">@</span><input class="input" id="handle" autocapitalize="none" autocomplete="off" spellcheck="false" maxlength="20" placeholder="${esc(String(suggested || 'daniel').toLowerCase().replace(/[^a-z0-9_]/g, '') || 'daniel')}"></div></div>
        <div class="error" id="err"></div>
        <button class="btn primary block" type="submit">Finish</button>
        <p class="muted small" style="margin:0">Friends use your ID to add songs to your playlists and to sync with you.</p>
      </form>`;
    $('#handle').focus();
    $('#pick').onsubmit = (e) => {
      e.preventDefault(); e.target.querySelector('button').disabled = true;
      googleStep(credential, { handle: $('#handle').value, name: $('#name').value });
    };
  }

  function renderIdOnboard() {
    view.innerHTML = `
      <div class="onboard">${onboardIntro}
        <form id="signup" class="sync-card" novalidate>
          <div class="field"><label for="name">Your name</label><input class="input" id="name" autocomplete="nickname" maxlength="30" placeholder="Daniel"></div>
          <div class="field"><label for="handle">Pick your ID</label><div class="input-wrap"><span class="prefix">@</span><input class="input" id="handle" autocapitalize="none" autocomplete="off" spellcheck="false" maxlength="20" placeholder="daniel"></div></div>
          <div class="error" id="err"></div>
          <button class="btn primary block" type="submit">Get started</button>
          <p class="muted small" style="margin:0">Test build without Google sign-in. Your ID is saved on this device.</p>
        </form>
      </div>`;
    $('#signup').onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button'); btn.disabled = true;
      try {
        const r = await fetch('/api/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('#name').value, handle: $('#handle').value }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        signedIn(j);
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
      <div style="flex:1;min-width:0"><div class="live-pill">In sync</div><div class="small muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${room.state.track ? esc(room.state.track.title) : 'Pick a song to start'}</div></div>
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
          <li class="song ${engine.state.track?.id === s.id ? 'now' : ''}" data-id="${esc(s.id)}">
            <img class="thumb" src="${art(s)}" alt="" loading="lazy">
            <div class="txt" data-play="${i}"><div class="st">${esc(s.title)}</div><div class="sa">${s.source === 'au' ? '<span class="tag">Audius</span> ' : ''}${esc(s.author)}${s.addedBy ? ` · <span class="added-by">added by @${esc(s.addedBy)}</span>` : ''}</div></div>
            ${mine ? `<button class="icon-btn" data-del="${esc(s.id)}" aria-label="Remove ${esc(s.title)}"><svg style="width:18px;height:18px;color:var(--muted)"><use href="#i-trash"/></svg></button>` : '<span></span>'}
          </li>`).join('')}</ol>`
        : `<div class="empty-state"><h3>No songs yet</h3><p>${mine ? 'Add 5 to 10 songs so people know your taste.' : 'Be the first to add a song here.'}</p></div>`}
      </div>
      ${mine ? `<div class="section"><button class="link-btn" id="delPl" type="button" style="color:var(--muted)">Delete playlist</button></div>` : ''}`;
    const queue = p.songs.map(({ addedBy, addedAt, ...t }) => t);
    $('#playAll').onclick = () => playQueue(queue, 0, p.id);
    view.querySelectorAll('[data-play]').forEach((el) => el.onclick = () => playQueue(queue, +el.dataset.play, p.id));
    $('#addSong').onclick = () => addSongSheet(p);
    view.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { await api(`/api/playlists/${p.id}/songs/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' }); route(); });
    $('#delPl') && ($('#delPl').onclick = () => sheet(`
      <h2>Delete "${esc(p.name)}"?</h2><p class="muted" style="margin:0">Songs other people added will be gone too.</p>
      <div class="row-actions"><button class="btn" data-close style="flex:1">Keep it</button><button class="btn primary" id="yesDel" style="flex:1">Delete</button></div>`,
    (el, close) => { $('#yesDel', el).onclick = async () => { await api(`/api/playlists/${p.id}`, { method: 'DELETE' }); close(); location.hash = 'home'; }; }));
  }

  function addSongSheet(p) {
    const mine = p.owner === me.id;
    sheet(`
      <div class="sheet-top"><h2>Add to ${esc(p.name)}</h2><button class="icon-btn" data-close aria-label="Close"><svg><use href="#i-close"/></svg></button></div>
      <div class="seg" role="tablist" aria-label="Where to search">
        <button type="button" role="tab" data-src="yt" aria-selected="true">YouTube Music</button>
        <button type="button" role="tab" data-src="au" aria-selected="false">Independent artists</button>
      </div>
      <div class="field"><label for="sq" id="sql">Search a song or paste a link</label><input class="input" id="sq" placeholder="Song or artist" autocapitalize="none" autocomplete="off"></div>
      <div id="sres"></div>
      <div class="error" id="serr"></div>
      <p class="muted small" style="margin:0" id="snote"></p>`,
    (el, close) => {
      const q = $('#sq', el), out = $('#sres', el), err = $('#serr', el), note = $('#snote', el);
      let source = store.get('aux-src') === 'au' ? 'au' : 'yt';
      const cost = mine ? 'Adding to your own playlist is free.' : `Costs 1 credit. You have ${me.credits}.`;
      const setSource = (s) => {
        source = s; store.set('aux-src', s);
        el.querySelectorAll('[data-src]').forEach((b) => b.setAttribute('aria-selected', b.dataset.src === s));
        note.textContent = s === 'au' ? `Songs from independent artists on Audius. They keep playing when your screen is off. ${cost}` : cost;
        lookup();
      };
      el.querySelectorAll('[data-src]').forEach((b) => b.onclick = () => setSource(b.dataset.src));
      q.focus();
      let t, seq = 0;
      q.oninput = () => { clearTimeout(t); t = setTimeout(lookup, 350); };
      async function lookup() {
        err.textContent = ''; const v = q.value.trim(); if (!v) return (out.innerHTML = '');
        const mySeq = ++seq;
        try {
          if (/^https?:\/\/|youtu\.?be|audius\.co|^[\w-]{11}$/.test(v)) {
            const s = await api(`/api/resolve?url=${encodeURIComponent(v)}`);
            if (mySeq === seq) show([s]);
          } else {
            const r = await api(`/api/search?source=${source}&q=${encodeURIComponent(v)}`);
            if (mySeq !== seq) return;
            if (!r.enabled) { out.innerHTML = ''; err.textContent = 'YouTube search is not switched on yet. Paste a link: open the song in YouTube Music, tap Share, then Copy link.'; return; }
            if (!r.results.length) { out.innerHTML = ''; err.textContent = `Nothing found on ${SOURCE_NAME[source]}.`; return; }
            show(r.results);
          }
        } catch (e) { if (mySeq === seq) { out.innerHTML = ''; err.textContent = e.message; } }
      }
      function show(list) {
        out.innerHTML = `<ul class="results">${list.map((s, i) => `<li><img src="${art(s)}" alt=""><div style="min-width:0"><div class="pm-title">${esc(s.title)}</div><div class="pm-sub">${s.official ? '<span class="tag">Song</span> ' : ''}${s.source === 'au' ? '<span class="tag">Audius</span> ' : ''}${esc(s.author)}</div></div><button class="btn primary" data-add="${i}" type="button" style="height:36px;padding:0 14px">Add</button></li>`).join('')}</ul>`;
        out.querySelectorAll('[data-add]').forEach((b) => b.onclick = async () => {
          b.disabled = true;
          try {
            const s = list[+b.dataset.add];
            const r = await api(`/api/playlists/${p.id}/songs`, { method: 'POST', body: { source: s.source, sourceId: s.sourceId } });
            setCredits(r.credits); close(); toast(mine ? 'Added.' : `Added to @${p.owner}'s playlist. 1 credit spent.`); route();
          } catch (e) { err.textContent = e.message; b.disabled = false; }
        });
      }
      setSource(source);
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
          ${st.track ? `<div class="preview" style="background:none;padding:0"><img src="${art(st.track)}" alt=""><div style="min-width:0"><div class="pm-title">${esc(st.track.title)}</div><div class="pm-sub">${esc(st.track.author)} · ${st.playing ? 'playing' : 'paused'}</div></div></div>` : `<p class="muted" style="margin:0">Nothing playing yet. Open any playlist and tap <b>Play for the sync</b>.</p>`}
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
  // { queue, index, track, playing, position, ref, playlistId }
  // Expected time = position + (now - ref)/1000 while playing. In a sync,
  // the server owns the state and "now" is the server clock.
  // YouTube songs play in the iframe; Audius songs play in an <audio> element,
  // which keeps going with the screen off.
  // =====================================================================
  const engine = { state: { queue: [], index: 0, track: null, playing: false, position: 0, ref: 0 }, loaded: null, lastSeek: 0, lastTick: 0, listened: 0, creditedFor: null, holding: false, bufferSince: 0 };
  let yt = null, ytReady = false, clockOffset = 0, bestRtt = Infinity;
  const now = () => (room ? Date.now() + clockOffset : Date.now());
  const expected = (st) => (st.playing ? st.position + (now() - st.ref) / 1000 : st.position);
  const audio = $('#au');

  function initYT() {
    yt = new YT.Player('yt', {
      width: '100%', height: '100%',
      playerVars: { playsinline: 1, controls: 0, disablekb: 1, rel: 0, modestbranding: 1, fs: 0, iv_load_policy: 3 },
      events: { onReady: () => { ytReady = true; tick(); }, onStateChange: onYTState, onError: () => { if (engine.state.track?.source === 'yt') skipBroken(); } },
    });
  }
  if (window.YT && window.YT.Player) initYT(); else window.onYouTubeIframeAPIReady = initYT;

  function skipBroken() { toast("This song can't play here. Skipping."); act({ type: 'next', from: engine.state.index }); }
  function startedPlaying() { $('#tapAudio').classList.add('hidden'); if (engine.holding) { engine.holding = false; send({ type: 'release' }); } updateButtons(); }

  function onYTState(e) {
    if (engine.state.track?.source !== 'yt') return;
    if (e.data === YT.PlayerState.ENDED) act({ type: 'next', from: engine.state.index });
    if (e.data === YT.PlayerState.PLAYING) startedPlaying();
    updateButtons();
  }
  audio.addEventListener('ended', () => act({ type: 'next', from: engine.state.index }));
  audio.addEventListener('playing', startedPlaying);
  audio.addEventListener('error', () => { if (engine.state.track?.source === 'au' && audio.getAttribute('src')) skipBroken(); });
  // Audio can't seek until it knows the length, so jump to the shared position once it does.
  audio.addEventListener('loadedmetadata', () => { audio.currentTime = Math.max(0, expected(engine.state)); engine.lastSeek = Date.now(); });

  // Both outputs share one small interface, so the sync loop doesn't care where a song comes from.
  const ytStatus = () => ({ [YT.PlayerState.PLAYING]: 'playing', [YT.PlayerState.BUFFERING]: 'buffering', [YT.PlayerState.ENDED]: 'ended' })[yt.getPlayerState()] || 'paused';
  const outputs = {
    yt: {
      ready: () => ytReady && !!yt?.getPlayerState,
      load: (t, at) => yt.loadVideoById({ videoId: t.sourceId, startSeconds: Math.max(0, at) }),
      play: () => yt.playVideo(), pause: () => yt.pauseVideo(), seek: (s) => yt.seekTo(s, true),
      time: () => yt.getCurrentTime() || 0, duration: () => yt.getDuration?.() || 0, status: ytStatus,
      stop: () => { try { yt.stopVideo(); } catch {} },
    },
    au: {
      ready: () => true,
      load: (t) => { audio.src = `https://api.audius.co/v1/tracks/${encodeURIComponent(t.sourceId)}/stream?app_name=aux-music`; },
      play: () => audio.play().catch(() => {}), pause: () => audio.pause(), seek: (s) => { audio.currentTime = s; },
      time: () => audio.currentTime || 0, duration: () => (Number.isFinite(audio.duration) ? audio.duration : 0),
      status: () => (audio.ended ? 'ended' : audio.paused ? 'paused' : audio.readyState < 3 ? 'buffering' : 'playing'),
      stop: () => { audio.pause(); audio.removeAttribute('src'); audio.load(); },
    },
  };
  const out = () => outputs[engine.state.track?.source] || null;

  // Apply an action locally (solo) or send it to the room (synced).
  function act(m) {
    if (room) return send(m);
    const st = engine.state;
    if (m.type === 'load') Object.assign(st, { queue: m.queue, index: m.index, playlistId: m.playlistId, track: m.queue[m.index], playing: true, position: 0, ref: Date.now() });
    else if (m.type === 'pause') Object.assign(st, { position: expected(st), playing: false, ref: Date.now() });
    else if (m.type === 'resume') Object.assign(st, { playing: true, ref: Date.now() });
    else if (m.type === 'seek') Object.assign(st, { position: m.position, ref: Date.now() });
    else if (m.type === 'next' || m.type === 'prev') {
      if (m.type === 'next' && Number.isInteger(m.from) && m.from !== st.index) return;
      const ni = st.index + (m.type === 'next' ? 1 : -1);
      if (ni < 0 || ni >= st.queue.length) Object.assign(st, { playing: false, position: 0, ref: Date.now() });
      else Object.assign(st, { index: ni, track: st.queue[ni], playing: true, position: 0, ref: Date.now() });
    } else return;
    afterStateChange();
  }
  function playQueue(queue, index, playlistId) {
    act({ type: 'load', queue, index, playlistId });
    if (!room) expandPlayer();
  }

  function afterStateChange() {
    const st = engine.state;
    if (st.track) $('#player').classList.remove('hidden');
    if (st.track?.id !== engine.listenId) { engine.listenId = st.track?.id; engine.listened = 0; }
    renderPlayerMeta(); tick();
    if (location.hash.startsWith('#p-')) view.querySelectorAll('.song').forEach((li) => li.classList.toggle('now', li.dataset.id === st.track?.id));
  }

  // Show the video for YouTube songs and the cover for Audius songs.
  function showOutput(t) {
    $('#videoWrap').classList.toggle('audio', t.source === 'au');
    if (t.source === 'au') $('#artBig').src = t.art || '';
    $('#tapAudio').textContent = t.source === 'au' ? 'Tap the cover to start the music' : 'Tap the video to start the music';
  }
  $('#videoWrap').addEventListener('click', () => { if (engine.state.track?.source === 'au' && engine.state.playing) audio.play().catch(() => {}); });

  // The sync loop: keep the active output where the shared clock says it should be.
  function tick() {
    const st = engine.state, o = out();
    if (!st.track || !o?.ready()) return;
    const exp = expected(st);
    if (engine.loaded !== st.track.id) {
      for (const [k, other] of Object.entries(outputs)) if (k !== st.track.source && other.ready()) other.stop();
      engine.loaded = st.track.id; engine.lastSeek = Date.now();
      showOutput(st.track);
      o.load(st.track, exp);
      if (st.playing && exp >= 0) o.play();
      if (!st.playing || exp < 0) setTimeout(() => { if (!engine.state.playing || expected(engine.state) < 0) out()?.pause(); }, 400);
      setTimeout(checkAutoplay, 3000);
      return;
    }
    const status = o.status(), cur = o.time();
    if (!st.playing || exp < 0) {
      if (status === 'playing' || status === 'buffering') o.pause();
      const target = Math.max(0, exp < 0 ? 0 : st.position);
      if (Math.abs(cur - target) > 0.6 && Date.now() - engine.lastSeek > 800) { o.seek(target); engine.lastSeek = Date.now(); }
      return;
    }
    if (status === 'paused') o.play();
    // Long buffering (often an ad) pauses everyone until this phone catches up.
    if (room && status === 'buffering') {
      engine.bufferSince ||= Date.now();
      if (!engine.holding && Date.now() - engine.bufferSince > 3000 && Date.now() - engine.lastSeek > 4000) { engine.holding = true; send({ type: 'hold' }); }
    } else engine.bufferSince = 0;
    const drift = cur - exp;
    if (status === 'playing' && Math.abs(drift) > 0.35 && Date.now() - engine.lastSeek > 2000) {
      o.seek(exp + 0.2); engine.lastSeek = Date.now(); // small lead covers the seek's own delay
    }
    // Earn credits by listening. Timers slow down with the screen off, so count real time.
    const dt = Math.min(60, (Date.now() - (engine.lastTick || Date.now())) / 1000);
    engine.lastTick = Date.now();
    if (status === 'playing' && st.playlistId) {
      engine.listened += dt;
      const key = `${st.track.id}|${st.playlistId}`;
      if (engine.listened >= 30 && engine.creditedFor !== key) {
        engine.creditedFor = key;
        api('/api/listen', { method: 'POST', body: { playlistId: st.playlistId, trackId: st.track.id } }).then((r) => { if (r.earned) { setCredits(r.credits); toast('You earned 1 credit for listening.'); } }).catch(() => {});
      }
    }
  }
  setInterval(() => { tick(); updateProgress(); }, 500);

  function checkAutoplay() {
    const o = out();
    if (!engine.state.playing || !o?.ready()) return;
    if (!['playing', 'buffering'].includes(o.status())) {
      $('#tapAudio').classList.remove('hidden');
      if ($('#player').classList.contains('mini')) toast('Tap the player to start the music on this phone.');
    }
  }

  // ---------- player UI ----------
  const P = $('#player');
  P.classList.add('mini');
  function expandPlayer() { P.classList.remove('mini'); P.classList.add('full'); document.body.style.overflow = 'hidden'; renderPlayerMeta(); }
  function collapsePlayer() { P.classList.remove('full'); P.classList.add('mini'); document.body.style.overflow = ''; }
  $('#playerMeta').onclick = (e) => { if (P.classList.contains('mini') && !e.target.closest('button')) expandPlayer(); };
  $('#collapseBtn').onclick = collapsePlayer;
  const toggle = () => { const st = engine.state; act(st.playing ? { type: 'pause', position: out()?.time() } : { type: 'resume', position: st.position }); };
  const prev = () => { if (expected(engine.state) > 4) act({ type: 'seek', position: 0 }); else act({ type: 'prev' }); };
  $('#toggleBtn').onclick = toggle; $('#miniToggle').onclick = toggle;
  $('#nextBtn').onclick = () => act({ type: 'next' }); $('#miniNext').onclick = () => act({ type: 'next' });
  $('#prevBtn').onclick = prev;
  let seeking = false;
  $('#seek').oninput = () => { seeking = true; $('#tCur').textContent = fmt($('#seek').value / 100 * (out()?.duration() || 0)); };
  $('#seek').onchange = () => { seeking = false; act({ type: 'seek', position: $('#seek').value / 100 * (out()?.duration() || 0) }); };

  // Lock-screen and headphone controls.
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => { if (!engine.state.playing) toggle(); });
    ms.setActionHandler('pause', () => { if (engine.state.playing) toggle(); });
    ms.setActionHandler('nexttrack', () => act({ type: 'next' }));
    ms.setActionHandler('previoustrack', prev);
  }

  function updateButtons() {
    const playing = engine.state.playing;
    for (const b of [$('#toggleBtn'), $('#miniToggle')]) { b.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play'); b.setAttribute('aria-label', playing ? 'Pause' : 'Play'); }
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = engine.state.track ? (playing ? 'playing' : 'paused') : 'none';
  }
  function updateProgress() {
    const o = out();
    if (!o?.ready() || seeking) return;
    const d = o.duration(), c = Math.max(0, Math.min(d, expected(engine.state)));
    $('#seek').value = d ? (c / d) * 100 : 0; $('#tCur').textContent = fmt(c); $('#tDur').textContent = fmt(d);
  }
  function renderPlayerMeta() {
    const st = engine.state, t = st.track;
    $('#pmTitle').textContent = t?.title || 'Nothing playing';
    $('#pmSub').textContent = room ? `In sync with ${room.members.filter((m) => m.id !== me?.id).map((m) => '@' + m.id).join(', ') || 'no one yet'}` : (t?.author || '');
    $('#sheetLabel').textContent = room ? 'Playing in sync' : 'Now playing';
    $('#syncStrip').innerHTML = room ? `<div class="stack">${room.members.map((m) => avatar(m, 'sm')).join('')}</div><div style="flex:1;min-width:0"><div class="live-pill">In sync</div><div class="small muted">Everyone controls play, pause and skip.</div></div><a class="link-btn" href="#sync">Manage</a>` : '';
    $('#queueList').innerHTML = st.queue.map((s, i) => `<li data-q="${i}" class="${i === st.index ? 'cur' : ''}"><span class="n">${i + 1}</span><img src="${art(s)}" alt=""><div style="min-width:0"><div class="qt">${esc(s.title)}</div><div class="qa">${esc(s.author)}</div></div></li>`).join('');
    $('#queueList').querySelectorAll('[data-q]').forEach((li) => li.onclick = () => act({ type: 'load', queue: st.queue, index: +li.dataset.q, playlistId: st.playlistId }));
    if ('mediaSession' in navigator && t) navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.author, album: 'Aux', artwork: t.art ? [{ src: t.art, sizes: '480x480', type: 'image/jpeg' }] : [] });
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

  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
})();
