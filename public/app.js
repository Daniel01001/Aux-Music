// Aux client: views, playback engine (solo + synced), realtime socket.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const view = $('#view');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // A song: { id: "yt:<videoId>" | "au:<audiusId>", source, sourceId, title, author, art }
  const art = (s) => esc(s?.art || '');
  const SOURCE_NAME = { yt: 'YouTube Music', au: 'Audius', jm: 'Jamendo' };
  const srcTag = (s) => (s.source && s.source !== 'yt' ? `<span class="tag">${SOURCE_NAME[s.source]}</span> ` : '');
  const eqBars = '<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>';
  const hue = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const avatar = (u, size = '') => `<span class="avatar ${size} ${u?.online ? 'online' : ''}" style="--h:${hue(u?.id || '?')}">${u?.avatar
    ? `<img src="${esc(u.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : esc((u?.name || u?.id || '?')[0])}</span>`;
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
  const routes = { home: renderHome, search: renderSearch, sync: renderSync, you: renderYou, inbox: renderInbox };
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
  // Our own history of screens, so Back never leaves the app when a link opened it directly.
  const trail = [location.hash];
  window.addEventListener('hashchange', () => {
    if (trail.length > 1 && trail[trail.length - 2] === location.hash) trail.pop(); else trail.push(location.hash);
    collapsePlayer(); route();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-back]')) return;
    if (trail.length > 1) history.back(); else location.replace('#home');
  });

  // ---------- onboarding ----------
  let config = null;
  const loadConfig = async () => (config ||= await fetch('/api/config').then((r) => r.json()).catch(() => ({})));
  const loadScript = (src) => new Promise((ok, fail) => { const s = document.createElement('script'); s.src = src; s.async = true; s.onload = ok; s.onerror = fail; document.head.append(s); });
  function signedIn(j) { token = j.token; store.set('aux-token', token); me = j.user; boot(); }

  async function renderOnboard() {
    document.body.classList.add('no-tabs');
    await loadConfig();
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
          <li><span><b>Make a playlist</b> of 5 to 10 songs from YouTube Music or independent artists.</span></li>
          <li><span><b>Add songs to other people's playlists.</b> It costs 1 credit. Listen to songs others added to earn credits back.</span></li>
          <li><span><b>Sync</b> with a friend by their ID and hear the same song at the same moment.</span></li>
        </ol>`;

  async function renderGoogleOnboard() {
    view.innerHTML = `
      <div class="onboard">${onboardIntro}
        <div class="sync-card" id="gCard">
          <div id="gBtn" class="g-btn"></div>
          <div class="error" id="err"></div>
          <p class="muted small" style="margin:0">Use the Google account you listen to YouTube Music with. By continuing you agree to the <a href="/terms.html" style="text-decoration:underline">Terms</a> and <a href="/privacy.html" style="text-decoration:underline">Privacy policy</a>.</p>
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
      <section class="section" id="disc" hidden>
        <div class="section-head"><div><h2>Fresh finds</h2><div class="small muted">Independent artists. Keeps playing with your screen off.</div></div></div>
        <div class="rail" id="discRail"></div>
      </section>
      <section class="section">
        <div class="section-head"><h2>From people</h2><a class="link-btn" href="#search">Find someone</a></div>
        ${feed.others.length ? `<div class="feed">${feed.others.map(feedCard).join('')}</div>` : `<div class="empty-state">No one else has a playlist yet.</div>`}
      </section>`;
    $('#newPl').onclick = newPlaylist;
    // Discover loads after the page so Home appears straight away.
    api('/api/discover').then(({ tracks }) => {
      const rail = $('#discRail');
      if (!rail || !tracks.length) return;
      rail.innerHTML = tracks.map((t, i) => `
        <div class="disc-card ${engine.state.track?.id === t.id ? 'now' : ''}" data-id="${esc(t.id)}">
          <button class="disc-art" type="button" data-di="${i}" aria-label="Play ${esc(t.title)}"><img src="${art(t)}" alt="" loading="lazy">${eqBars}</button>
          <button class="disc-save" type="button" data-ds="${i}" aria-label="Save ${esc(t.title)} to a playlist"><svg><use href="#i-plus"/></svg></button>
          <div class="t">${esc(t.title)}</div><div class="s">${esc(t.author)}</div>
        </div>`).join('');
      $('#disc').hidden = false;
      rail.querySelectorAll('[data-di]').forEach((b) => b.onclick = () => playQueue(tracks, +b.dataset.di, null, true));
      rail.querySelectorAll('[data-ds]').forEach((b) => b.onclick = () => saveSong(tracks[+b.dataset.ds]));
    }).catch(() => {});
  }
  const feedCard = (p) => `
    <a class="feed-card" href="#p-${p.id}">
      ${cover(p.songs)}
      <div class="meta">${avatar({ id: p.owner, name: p.ownerName, avatar: p.ownerAvatar }, 'sm')}<div class="text"><div class="t">${esc(p.name)}</div><div class="s">@${esc(p.owner)}${p.sample ? ' <span class="tag">sample</span>' : ''}</div></div></div>
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

  // Save a song you hear to one of your own playlists (always free: they're yours).
  async function saveSong(t) {
    const { mine } = await api('/api/feed');
    sheet(`
      <div class="sheet-top"><h2>Save to a playlist</h2><button class="icon-btn" data-close aria-label="Close"><svg><use href="#i-close"/></svg></button></div>
      <div class="preview"><img src="${art(t)}" alt=""><div style="min-width:0"><div class="pm-title">${esc(t.title)}</div><div class="pm-sub">${srcTag(t)}${esc(t.author)}</div></div></div>
      <ul class="pick-list">
        ${mine.map((p) => {
          const has = p.songs.some((s) => s.id === t.id), full = p.songs.length >= 10;
          return `<li><button type="button" data-pl="${p.id}" ${has || full ? 'disabled' : ''}>${cover(p.songs)}<span class="pk"><span class="t">${esc(p.name)}</span><span class="s">${has ? 'Already there' : full ? 'Full' : `${p.songs.length} of 10 songs`}</span></span></button></li>`;
        }).join('')}
        <li><button type="button" data-new><div class="cover new"><svg><use href="#i-plus"/></svg></div><span class="pk"><span class="t">New playlist</span><span class="s">Starts with this song</span></span></button></li>
      </ul>
      <div class="error" id="saveErr"></div>`,
    (el, close) => {
      const add = async (pl) => {
        try {
          await api(`/api/playlists/${pl.id}/songs`, { method: 'POST', body: { source: t.source, sourceId: t.sourceId } });
          close(); toast(`Saved to ${pl.name}.`);
          if (location.hash === `#p-${pl.id}` || ['#home', ''].includes(location.hash)) route();
        } catch (e) { $('#saveErr', el).textContent = e.message; }
      };
      el.querySelectorAll('[data-pl]').forEach((b) => b.onclick = () => add(mine.find((p) => p.id === b.dataset.pl)));
      $('[data-new]', el).onclick = async () => {
        try { add(await api('/api/playlists', { method: 'POST', body: { name: 'Saved songs' } })); } catch (e) { $('#saveErr', el).textContent = e.message; }
      };
    });
  }

  async function sharePlaylist(p) {
    const url = `${location.origin}/#p-${p.id}`;
    if (navigator.share) {
      try { await navigator.share({ title: `${p.name} on Aux`, text: `Put a song on ${p.name}`, url }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(url); toast('Link copied. Send it to a friend.'); }
    catch { toast(url); }
  }

  // ---------- playlist ----------
  async function renderPlaylist(id) {
    const p = await api(`/api/playlists/${id}`);
    const mine = p.owner === me.id;
    const full = p.songs.length >= 10;
    view.innerHTML = `
      <button class="back" type="button" data-back><svg><use href="#i-back"/></svg>Back</button>
      <div class="pl-head">
        ${cover(p.songs)}
        <div style="min-width:0">
          <span class="tag">${p.songs.length} of 10 songs</span>
          <h1>${esc(p.name)}</h1>
          <a class="pl-owner" href="${mine ? '#you' : `#u-${p.owner}`}">${avatar({ id: p.owner, name: p.ownerName, avatar: p.ownerAvatar }, 'sm')}<span>${mine ? 'You' : '@' + esc(p.owner)}</span></a>
        </div>
      </div>
      <div class="section" style="margin-top:18px">
        <div class="row-actions">
          <button class="btn primary" id="playAll" ${p.songs.length ? '' : 'disabled'} type="button"><svg><use href="#i-play"/></svg>${room ? 'Play for the sync' : 'Play'}</button>
          <button class="btn" id="addSong" ${full ? 'disabled' : ''} type="button"><svg><use href="#i-plus"/></svg>${full ? 'Full' : mine ? 'Add a song' : 'Add a song · 1 credit'}</button>
          <button class="btn icon-only" id="sharePl" type="button" aria-label="Share this playlist"><svg><use href="#i-share"/></svg></button>
        </div>
      </div>
      <div class="section" style="padding:0;margin-top:14px">
        ${p.songs.length ? `<ol class="songs">${p.songs.map((s, i) => `
          <li class="song ${engine.state.track?.id === s.id ? 'now' : ''}" data-id="${esc(s.id)}">
            <span class="thumb-wrap" data-play="${i}"><img class="thumb" src="${art(s)}" alt="" loading="lazy">${eqBars}</span>
            <div class="txt" data-play="${i}"><div class="st">${esc(s.title)}</div><div class="sa">${s.ownerLiked && s.addedBy ? '<span class="tag pick">Owner\'s pick</span> ' : ''}${srcTag(s)}${esc(s.author)}${s.addedBy ? ` · <span class="added-by">added by @${esc(s.addedBy)}</span>` : ''}</div></div>
            <button class="icon-btn like" data-like="${i}" type="button" aria-pressed="${s.liked}" aria-label="Like ${esc(s.title)}"><svg><use href="#i-heart"/></svg><span class="n">${s.likes || ''}</span></button>
            ${mine
              ? `<button class="icon-btn" data-del="${esc(s.id)}" aria-label="Remove ${esc(s.title)}"><svg style="width:18px;height:18px;color:var(--muted)"><use href="#i-trash"/></svg></button>`
              : `<button class="icon-btn" data-save="${i}" aria-label="Save ${esc(s.title)} to your playlist"><svg style="width:20px;height:20px;color:var(--muted)"><use href="#i-plus"/></svg></button>`}
          </li>`).join('')}</ol>`
        : `<div class="empty-state"><h3>No songs yet</h3><p>${mine ? 'Add 5 to 10 songs so people know your taste.' : 'Be the first to add a song here.'}</p></div>`}
      </div>
      ${mine ? `<div class="section"><button class="link-btn" id="delPl" type="button" style="color:var(--muted)">Delete playlist</button></div>` : ''}`;
    const queue = p.songs.map(({ addedBy, addedAt, ...t }) => t);
    $('#playAll').onclick = () => playQueue(queue, 0, p.id);
    view.querySelectorAll('[data-play]').forEach((el) => el.onclick = () => playQueue(queue, +el.dataset.play, p.id));
    $('#addSong').onclick = () => addSongSheet(p);
    $('#sharePl').onclick = () => sharePlaylist(p);
    view.querySelectorAll('[data-save]').forEach((b) => b.onclick = () => saveSong(queue[+b.dataset.save]));
    view.querySelectorAll('[data-like]').forEach((b) => b.onclick = async () => {
      const s = p.songs[+b.dataset.like];
      b.disabled = true;
      try {
        const r = await api(`/api/playlists/${p.id}/songs/${encodeURIComponent(s.id)}/like`, { method: 'POST' });
        Object.assign(s, { liked: r.liked, likes: r.likes });
        b.setAttribute('aria-pressed', r.liked); b.querySelector('.n').textContent = r.likes || '';
        // Liking someone's pick on your own playlist thanks them with a credit.
        if (r.liked && mine && s.addedBy && !s.ownerLiked) { s.ownerLiked = true; toast(`@${s.addedBy} earned a credit for this pick.`); }
      } catch (e) { toast(e.message); }
      b.disabled = false;
    });
    view.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { await api(`/api/playlists/${p.id}/songs/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' }); route(); });
    $('#delPl') && ($('#delPl').onclick = () => sheet(`
      <h2>Delete "${esc(p.name)}"?</h2><p class="muted" style="margin:0">Songs other people added will be gone too.</p>
      <div class="row-actions"><button class="btn" data-close style="flex:1">Keep it</button><button class="btn primary" id="yesDel" style="flex:1">Delete</button></div>`,
    (el, close) => { $('#yesDel', el).onclick = async () => { await api(`/api/playlists/${p.id}`, { method: 'DELETE' }); close(); location.hash = 'home'; }; }));
  }

  // Pick one or more songs (from search, a song link, or an album/playlist link) and add them together.
  async function addSongSheet(p) {
    const mine = p.owner === me.id;
    await loadConfig();
    // YouTube is always offered (links work without search); the others only when the server has them on.
    const sources = ['yt', 'au', 'jm'].filter((s) => s === 'yt' || config.sources?.[s]);
    const space = 10 - p.songs.length;
    const already = new Set(p.songs.map((s) => s.id));
    const limit = mine ? space : Math.min(space, me.credits);
    sheet(`
      <div class="sheet-top"><h2>Add to ${esc(p.name)}</h2><button class="icon-btn" data-close aria-label="Close"><svg><use href="#i-close"/></svg></button></div>
      <div class="seg" role="tablist" aria-label="Where to search" style="--n:${sources.length}">
        ${sources.map((s) => `<button type="button" role="tab" data-src="${s}" aria-selected="false">${SOURCE_NAME[s]}</button>`).join('')}
      </div>
      <div class="field"><label for="sq">Search, or paste a song, album or playlist link</label><input class="input" id="sq" placeholder="Song or artist" autocapitalize="none" autocomplete="off"></div>
      <div id="sres"></div>
      <div class="error" id="serr"></div>
      <p class="muted small" style="margin:0" id="snote"></p>
      <div class="sheet-foot"><button class="btn primary block" id="addSel" type="button" disabled></button></div>`,
    (el, close) => {
      const q = $('#sq', el), out = $('#sres', el), err = $('#serr', el), note = $('#snote', el), addBtn = $('#addSel', el);
      const picked = new Map(); // id -> song, kept while you search for more
      let source = sources.includes(store.get('aux-src')) ? store.get('aux-src') : 'yt';
      let shown = [];
      const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
      const cost = mine ? 'Adding to your own playlist is free.' : `Each song costs 1 credit. You have ${me.credits}.`;

      function updateFoot() {
        const n = picked.size;
        addBtn.disabled = !n;
        addBtn.textContent = n ? `Add ${plural(n, 'song')}${mine ? '' : ` · ${plural(n, 'credit')}`}`
          : !space ? 'This playlist is full' : !limit ? 'You need a credit to add songs here' : `Pick up to ${plural(limit, 'song')}`;
        out.querySelectorAll('[data-pick]').forEach((li) => li.setAttribute('aria-checked', picked.has(shown[+li.dataset.pick]?.id)));
      }
      function toggle(i) {
        const s = shown[i];
        if (!s || already.has(s.id)) return;
        err.textContent = '';
        if (picked.has(s.id)) picked.delete(s.id);
        else if (picked.size >= limit) { err.textContent = limit ? `You can add ${plural(limit, 'more song')} here.` : 'You need a credit to add songs here.'; return; }
        else picked.set(s.id, s);
        updateFoot();
      }
      const setSource = (s) => {
        source = s; store.set('aux-src', s);
        el.querySelectorAll('[data-src]').forEach((b) => b.setAttribute('aria-selected', b.dataset.src === s));
        note.textContent = s === 'yt' ? cost : `Independent artists on ${SOURCE_NAME[s]}. These keep playing when your screen is off. ${cost}`;
        lookup();
      };
      el.querySelectorAll('[data-src]').forEach((b) => b.onclick = () => setSource(b.dataset.src));
      q.focus();

      const isCollection = (v) => (/[?&]list=/.test(v) && !/[?&]v=/.test(v)) || /audius\.co\/[^/]+\/(album|playlist)\//.test(v);
      let t, seq = 0;
      q.oninput = () => { clearTimeout(t); t = setTimeout(lookup, 350); };
      async function lookup() {
        err.textContent = ''; const v = q.value.trim(); if (!v) { shown = []; out.innerHTML = ''; return; }
        const mySeq = ++seq;
        try {
          if (isCollection(v)) {
            out.innerHTML = '<p class="muted small">Opening…</p>';
            const r = await api(`/api/collection?url=${encodeURIComponent(v)}`);
            if (mySeq === seq) show(r.tracks, r.title);
          } else if (/^https?:\/\/|youtu\.?be|audius\.co|jamendo\.com|^[\w-]{11}$/.test(v)) {
            const s = await api(`/api/resolve?url=${encodeURIComponent(v)}`);
            if (mySeq === seq) { show([s]); if (!picked.has(s.id) && !already.has(s.id)) toggle(0); }
          } else {
            const r = await api(`/api/search?source=${source}&q=${encodeURIComponent(v)}`);
            if (mySeq !== seq) return;
            if (!r.enabled) { out.innerHTML = ''; err.textContent = 'YouTube search is not switched on yet. Paste a link: open the song in YouTube Music, tap Share, then Copy link.'; return; }
            if (!r.results.length) { out.innerHTML = ''; err.textContent = `Nothing found on ${SOURCE_NAME[source]}.`; return; }
            show(r.results);
          }
        } catch (e) { if (mySeq === seq) { out.innerHTML = ''; err.textContent = e.message; } }
      }
      function show(list, heading) {
        shown = list;
        const fresh = list.filter((s) => !already.has(s.id));
        const firstN = Math.min(limit - picked.size, fresh.length);
        out.innerHTML = `
          ${heading ? `<div class="res-head"><div style="min-width:0"><b>${esc(heading)}</b><div class="small muted">${plural(list.length, 'song')}. Pick the ones you want.</div></div>${firstN > 0 ? `<button class="link-btn" id="pickFirst" type="button">Pick first ${firstN}</button>` : ''}</div>` : ''}
          <ul class="results">${list.map((s, i) => {
            const here = already.has(s.id);
            return `<li class="pickable" data-pick="${i}" role="checkbox" tabindex="0" aria-checked="false" ${here ? 'aria-disabled="true"' : ''}>
              <img src="${art(s)}" alt=""><div style="min-width:0"><div class="pm-title">${esc(s.title)}</div><div class="pm-sub">${s.official ? '<span class="tag">Song</span> ' : ''}${srcTag(s)}${esc(s.author)}${here ? ' · already here' : ''}</div></div>
              <span class="check" aria-hidden="true"><svg><use href="#i-check"/></svg></span></li>`;
          }).join('')}</ul>`;
        out.querySelectorAll('[data-pick]').forEach((li) => {
          li.onclick = () => toggle(+li.dataset.pick);
          li.onkeydown = (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(+li.dataset.pick); } };
        });
        $('#pickFirst', el) && ($('#pickFirst', el).onclick = () => {
          for (let i = 0; i < list.length && picked.size < limit; i++) if (!already.has(list[i].id)) picked.set(list[i].id, list[i]);
          updateFoot();
        });
        updateFoot();
      }

      addBtn.onclick = async () => {
        addBtn.disabled = true; err.textContent = '';
        try {
          const tracks = [...picked.values()].map((s) => ({ source: s.source, sourceId: s.sourceId }));
          const r = await api(`/api/playlists/${p.id}/songs`, { method: 'POST', body: { tracks } });
          setCredits(r.credits); close();
          const spent = mine ? '' : ` ${plural(r.added, 'credit')} spent.`;
          toast(`Added ${plural(r.added, 'song')}.${spent}${r.skipped?.length ? ` ${plural(r.skipped.length, 'song')} skipped: ${r.skipped[0]}` : ''}`);
          route();
        } catch (e) { err.textContent = e.message; updateFoot(); }
      };
      setSource(source);
      updateFoot();
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
      <button class="back" type="button" data-back><svg><use href="#i-back"/></svg>Back</button>
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
    // The room card redraws on every play/pause; the chat below it stays put so typing isn't lost.
    view.innerHTML = `
      <section class="section" style="margin-top:8px"><div id="syncCard"></div></section>
      <section class="section">
        <div class="section-head"><h2>Party chat</h2></div>
        ${reactBar()}
        <ol class="chat" id="chatList" aria-live="polite"></ol>
        <form class="inline-form chat-form" id="chatF" novalidate>
          <input class="input" id="chatQ" maxlength="300" placeholder="Say something to the party" autocomplete="off" enterkeyhint="send" aria-label="Message">
          <button class="btn primary" type="submit" style="height:48px">Send</button>
        </form>
      </section>
      <section class="section"><h2 style="margin-bottom:10px">Add someone</h2>${inviteForm()}</section>`;
    renderSyncCard(); renderChat(); wireReactBar(view);
    $('#chatF').onsubmit = (e) => {
      e.preventDefault();
      const q = $('#chatQ'), text = q.value.trim();
      if (!text) return;
      send({ type: 'chat', text }); q.value = '';
    };
    chatUnread = 0; paintSyncBadge();
    wireInviteForm();
  }
  function renderSyncCard() {
    const el = $('#syncCard'); if (!el || !room) return;
    const st = room.state;
    el.innerHTML = `
        <div class="sync-card">
          <div style="display:flex;justify-content:space-between;align-items:center"><span class="live-pill">In sync · ${room.members.length}</span><button class="link-btn" id="leave" type="button" style="color:var(--bad)">Leave</button></div>
          ${st.track ? `<div class="preview" style="background:none;padding:0"><img src="${art(st.track)}" alt=""><div style="min-width:0"><div class="pm-title">${esc(st.track.title)}</div><div class="pm-sub">${esc(st.track.author)} · ${st.playing ? 'playing' : 'paused'}</div></div></div>` : `<p class="muted" style="margin:0">Nothing playing yet. Open any playlist and tap <b>Play for the sync</b>.</p>`}
          <ul class="people">
            ${room.members.map((m) => `<li class="person">${avatar(m)}<div class="who"><div class="n">${m.id === me.id ? 'You' : esc(m.name)}</div><div class="h">@${esc(m.id)}${m.id === room.host ? ' · started the sync' : ''}</div></div></li>`).join('')}
            ${room.pending.map((id) => `<li class="person pending">${avatar({ id, name: id })}<div class="who"><div class="n">@${esc(id)}</div><div class="h">Waiting for them to accept</div></div></li>`).join('')}
          </ul>
        </div>`;
    $('#leave').onclick = () => send({ type: 'leave' });
  }

  // ---------- party chat and reactions ----------
  let chat = [], chatUnread = 0;
  const REACTIONS = [['love', 'Love', 'i-heart-solid'], ['fire', 'Fire', 'i-fire'], ['star', 'Star', 'i-star'], ['energy', 'Energy', 'i-bolt']];
  const reactBar = () => `<div class="reacts" role="group" aria-label="Send a reaction">${REACTIONS.map(([k, label, icon]) => `<button type="button" class="react-btn r-${k}" data-react="${k}" aria-label="${label}"><svg><use href="#${icon}"/></svg></button>`).join('')}</div>`;
  const wireReactBar = (root) => root.querySelectorAll('[data-react]').forEach((b) => b.onclick = () => { send({ type: 'react', kind: b.dataset.react }); b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); });
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  function renderChat() {
    const list = $('#chatList'); if (!list) return;
    list.innerHTML = chat.length ? chat.map((c) => c.from
      ? `<li class="${c.from === me?.id ? 'mine' : ''}">${c.from === me?.id ? '' : avatar({ id: c.from, name: c.name }, 'sm')}<div class="bubble">${c.from === me?.id ? '' : `<div class="who">${esc(c.name || c.from)}</div>`}<div>${esc(c.text)}</div><time>${clock(c.at)}</time></div></li>`
      : `<li class="system">${esc(c.text)} · ${clock(c.at)}</li>`).join('')
      : '<li class="system">No messages yet. Say hi, or send a reaction.</li>';
    list.scrollTop = list.scrollHeight;
  }
  function paintSyncBadge() { $('#syncBadge').classList.toggle('chat', chatUnread > 0); }

  // A reaction floats up over the screen with who sent it.
  function floatReaction(kind, from) {
    const r = REACTIONS.find(([k]) => k === kind); if (!r) return;
    const el = document.createElement('div');
    el.className = `float-react r-${kind}`;
    el.style.left = `${55 + Math.random() * 30}%`;
    el.innerHTML = `<svg><use href="#${r[2]}"/></svg><span>${from === me?.id ? 'You' : '@' + esc(from)}</span>`;
    $('#reactLayer').append(el);
    setTimeout(() => el.remove(), 2600);
  }
  const inviteForm = () => `<form class="inline-form" id="invF" style="margin-top:14px" novalidate><div class="input-wrap"><span class="prefix">@</span><input class="input" id="invQ" placeholder="their ID" autocapitalize="none" autocomplete="off" spellcheck="false"></div><button class="btn primary" type="submit" style="height:48px">Invite</button></form>`;
  function wireInviteForm() { $('#invF').onsubmit = (e) => { e.preventDefault(); const v = $('#invQ').value.trim().replace(/^@/, ''); if (v) invite(v); $('#invQ').value = ''; }; }
  function invite(id) { send({ type: 'invite', to: id.toLowerCase() }); toast(`Invite sent to @${id}. Waiting for them to accept.`); }

  // ---------- you ----------
  const ago = (t) => {
    const s = Math.max(1, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
    return new Date(t).toLocaleDateString();
  };
  function paintMeAvatar() {
    const a = $('#meAvatar');
    a.style.setProperty('--h', hue(me.id));
    a.innerHTML = me.avatar ? `<img src="${esc(me.avatar)}" alt="" referrerpolicy="no-referrer">` : esc(me.name[0]);
  }
  function setUnread(n) {
    $('#inboxDot').classList.toggle('hidden', !n);
    $('#inboxBtn').setAttribute('aria-label', n ? `Inbox, ${n} new` : 'Inbox');
  }

  async function renderYou() {
    me = await api('/api/me'); setCredits(me.credits); setUnread(me.unread); paintMeAvatar();
    await loadConfig();
    view.innerHTML = `
      <section class="section profile">
        ${avatar(me, 'lg')}
        <div class="who"><h1>${esc(me.name)}</h1><div class="muted">@${esc(me.id)}</div>${me.bio ? `<p class="bio">${esc(me.bio)}</p>` : ''}</div>
        <button class="btn" id="editMe" type="button">Edit</button>
      </section>
      <section class="section">
        <div class="sync-card" style="flex-direction:row;align-items:center;gap:16px">
          <div style="font-family:var(--font-display);font-size:40px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums">${me.credits}</div>
          <div class="small muted">credits. Adding a song to someone else's playlist costs 1. Earn them back by listening 30 seconds to songs others added, or when an owner likes a song you added.</div>
        </div>
      </section>
      <section class="section"><div class="section-head"><h2>Notifications</h2></div>
        <div class="setting-row">
          <div><div class="n">Push notifications</div><div class="small muted" id="pushHint">When someone adds a song to your playlist or likes a song you added.</div></div>
          <button class="toggle" id="pushT" type="button" role="switch" aria-checked="false" aria-label="Push notifications" disabled><span></span></button>
        </div>
      </section>
      <section class="section"><div class="section-head"><h2>Theme</h2></div>
        <div class="themes">${THEMES.map((t) => `<button class="swatch" type="button" data-theme-id="${t.id}" aria-pressed="${document.documentElement.dataset.theme === t.id}"><span class="sw" style="background:${t.bg};--a:${t.a};${t.id === 'paper' ? 'border:1px solid #ddd' : ''}"></span>${t.name}</button>`).join('')}</div>
      </section>
      <section class="section"><div class="section-head"><h2>Share your ID</h2></div><p class="muted" style="margin:0 0 10px">Friends search <b style="color:var(--text)">@${esc(me.id)}</b> to add songs to your playlists or sync with you.</p></section>
      <section class="section"><div class="section-head"><h2>Devices</h2><button class="link-btn" id="outOthers" type="button" hidden>Sign out of the others</button></div><ul class="people" id="devs"><li class="muted small">Loading…</li></ul></section>
      <section class="section"><div class="section-head"><h2>Account</h2></div>
        ${me.email ? `<p class="small muted" style="margin:0 0 12px">Signed in with Google as ${esc(me.email)}</p>` : ''}
        <div class="row-actions"><button class="btn" id="signOut" type="button">Sign out</button><button class="btn" id="exportMe" type="button">Download my data</button></div>
        <button class="link-btn" id="delMe" type="button" style="color:var(--bad);margin-top:18px">Delete my account</button>
      </section>
      <p class="section small muted legal"><a href="/privacy.html">Privacy policy</a> · <a href="/terms.html">Terms</a></p>`;
    view.querySelectorAll('[data-theme-id]').forEach((b) => b.onclick = () => { setTheme(b.dataset.themeId); view.querySelectorAll('[data-theme-id]').forEach((x) => x.setAttribute('aria-pressed', x === b)); });
    $('#signOut').onclick = signOut;
    $('#editMe').onclick = editProfile;
    $('#exportMe').onclick = exportData;
    $('#delMe').onclick = deleteAccount;
    loadDevices();
    setupPushToggle();
  }

  function editProfile() {
    const canHandle = Date.now() >= me.canChangeHandleAt;
    sheet(`
      <div class="sheet-top"><h2>Edit profile</h2><button class="icon-btn" data-close aria-label="Close"><svg><use href="#i-close"/></svg></button></div>
      <form id="pf" class="form-stack" novalidate>
        ${me.hasGooglePhoto ? `<label class="setting-row"><span class="n">Show my Google photo</span><input type="checkbox" id="pfPhoto" class="checkbox" ${me.avatar ? 'checked' : ''}></label>` : ''}
        <div class="field"><label for="pfName">Name</label><input class="input" id="pfName" maxlength="30" value="${esc(me.name)}" autocomplete="nickname"></div>
        <div class="field"><label for="pfBio">About you</label><textarea class="input textarea" id="pfBio" maxlength="160" rows="3" placeholder="What do you listen to?">${esc(me.bio || '')}</textarea></div>
        <div class="field"><label for="pfHandle">Your ID</label><div class="input-wrap"><span class="prefix">@</span><input class="input" id="pfHandle" maxlength="20" value="${esc(me.id)}" autocapitalize="none" spellcheck="false" ${canHandle ? '' : 'disabled'}></div>
          <div class="small muted">${canHandle ? 'Friends find you by this. You can change it once every 30 days.' : `You can change it again on ${new Date(me.canChangeHandleAt).toDateString()}.`}</div></div>
        <div class="error" id="pfErr"></div>
        <button class="btn primary block" type="submit">Save</button>
      </form>`,
    (el, close) => {
      $('#pf', el).onsubmit = async (e) => {
        e.preventDefault();
        const btn = e.target.querySelector('[type=submit]'); btn.disabled = true;
        try {
          const photo = $('#pfPhoto', el);
          me = { ...me, ...(await api('/api/me', { method: 'PATCH', body: { name: $('#pfName', el).value, bio: $('#pfBio', el).value, ...(photo ? { photo: photo.checked } : {}) } })) };
          const handle = $('#pfHandle', el).value.trim().toLowerCase().replace(/^@/, '');
          if (canHandle && handle && handle !== me.id) me = { ...me, ...(await api('/api/me/handle', { method: 'POST', body: { handle } })) };
          paintMeAvatar(); close(); toast('Profile saved.'); route();
        } catch (err) { $('#pfErr', el).textContent = err.message; btn.disabled = false; }
      };
    });
  }

  async function loadDevices() {
    const list = await api('/api/sessions').catch(() => []);
    const ul = $('#devs'); if (!ul) return;
    ul.innerHTML = list.map((d) => `
      <li class="person"><span class="dev-icon" aria-hidden="true"><svg><use href="#i-device"/></svg></span>
        <div class="who"><div class="n">${esc(d.device)}</div><div class="h">${d.current ? 'This device' : `Last active ${ago(d.lastSeen)}`}</div></div>
        ${d.current ? '' : `<button class="btn" data-dev="${d.id}" type="button" style="height:36px;padding:0 14px">Sign out</button>`}
      </li>`).join('');
    $('#outOthers').hidden = list.filter((d) => !d.current).length < 2;
    ul.querySelectorAll('[data-dev]').forEach((b) => b.onclick = async () => { await api(`/api/sessions/${b.dataset.dev}`, { method: 'DELETE' }); toast('Signed out of that device.'); loadDevices(); });
    $('#outOthers').onclick = async () => { await api('/api/sessions/others', { method: 'POST' }); toast('Signed out of your other devices.'); loadDevices(); };
  }

  async function exportData() {
    const r = await fetch('/api/me/export', { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return toast("Couldn't prepare your data. Try again.");
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await r.blob()), download: `aux-${me.id}.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function deleteAccount() {
    sheet(`
      <h2>Delete your account?</h2>
      <p class="muted" style="margin:0">This removes your profile, your playlists, the songs you added to other people's playlists, your likes and your credits. It can't be undone.</p>
      <div class="field"><label for="delQ">Type <b style="color:var(--text)">@${esc(me.id)}</b> to confirm</label><input class="input" id="delQ" autocapitalize="none" autocomplete="off" spellcheck="false"></div>
      <div class="error" id="delErr"></div>
      <div class="row-actions"><button class="btn" data-close type="button" style="flex:1">Keep it</button><button class="btn danger" id="yesDelMe" type="button" style="flex:1" disabled>Delete forever</button></div>`,
    (el, close) => {
      const q = $('#delQ', el), b = $('#yesDelMe', el);
      q.oninput = () => { b.disabled = q.value.trim().replace(/^@/, '').toLowerCase() !== me.id; };
      b.onclick = async () => {
        b.disabled = true;
        try { await api('/api/me', { method: 'DELETE' }); close(); signOut(); toast('Your account has been deleted.'); }
        catch (e) { $('#delErr', el).textContent = e.message; b.disabled = false; }
      };
    });
  }

  // ---------- push notifications ----------
  const b64ToBytes = (s) => Uint8Array.from(atob((s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  async function setupPushToggle() {
    const t = $('#pushT'), hint = $('#pushHint');
    if (!config.pushKey) { hint.textContent = 'Not available yet.'; return; }
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      hint.textContent = /iPhone|iPad/.test(navigator.userAgent) ? 'On iPhone, add Aux to your Home Screen first (Share, then Add to Home Screen), then open it from there.' : "This browser doesn't support notifications.";
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    const paint = () => t.setAttribute('aria-checked', !!sub);
    paint(); t.disabled = false;
    t.onclick = async () => {
      t.disabled = true;
      try {
        if (sub) {
          await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
          await sub.unsubscribe(); sub = null;
        } else {
          if (await Notification.requestPermission() !== 'granted') { hint.textContent = 'Notifications are blocked. Allow them for this site in your browser settings.'; return; }
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(config.pushKey) });
          await api('/api/push/subscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
          toast("Notifications are on for this device.");
        }
      } catch { toast("Couldn't change notifications. Try again."); }
      finally { paint(); t.disabled = false; }
    };
  }

  // ---------- inbox ----------
  async function renderInbox() {
    const { items } = await api('/api/inbox');
    view.innerHTML = `
      <button class="back" type="button" data-back><svg><use href="#i-back"/></svg>Back</button>
      <section class="section" style="margin-top:8px"><h1 style="margin-bottom:14px">Inbox</h1>
        ${items.length ? `<ul class="inbox">${items.map((i) => `
          <li class="${i.read ? '' : 'unread'}"><a href="${esc(i.url || '#home')}">${avatar({ id: i.actor || 'aux', name: i.actor || 'a' }, 'sm')}
            <div style="min-width:0"><div class="txt">${esc(i.text)}</div><div class="small muted">${ago(i.at)}</div></div></a></li>`).join('')}</ul>`
        : `<div class="empty-state"><h3>Nothing yet</h3><p>When someone adds a song to your playlist or likes a song you added, it shows up here.</p></div>`}
      </section>`;
    if (items.some((i) => !i.read)) api('/api/inbox/read', { method: 'POST' }).then(() => setUnread(0)).catch(() => {});
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
  // Independent-music servers sometimes fail for a moment, so try a song once more before skipping it.
  let audioRetried = null;
  audio.addEventListener('error', () => {
    const t = engine.state.track;
    if (!t || t.source === 'yt' || !audio.getAttribute('src')) return;
    if (audioRetried !== t.id) {
      audioRetried = t.id;
      setTimeout(() => { if (engine.state.track?.id === t.id) { audio.src = streamUrl(t); if (engine.state.playing) audio.play().catch(() => {}); } }, 1200);
      return;
    }
    skipBroken();
  });
  // Audio can't seek until it knows the length, so jump to the shared position once it does.
  audio.addEventListener('loadedmetadata', () => { audio.currentTime = Math.max(0, expected(engine.state)); engine.lastSeek = Date.now(); });

  // Both outputs share one small interface, so the sync loop doesn't care where a song comes from.
  const ytStatus = () => ({ [YT.PlayerState.PLAYING]: 'playing', [YT.PlayerState.BUFFERING]: 'buffering', [YT.PlayerState.ENDED]: 'ended' })[yt.getPlayerState()] || 'paused';
  const streamUrl = (t) => (t.source === 'jm'
    ? `https://prod-1.storage.jamendo.com/?trackid=${encodeURIComponent(t.sourceId)}&format=mp32`
    : `https://api.audius.co/v1/tracks/${encodeURIComponent(t.sourceId)}/stream?app_name=aux-music`);
  const outputs = {
    yt: {
      ready: () => ytReady && !!yt?.getPlayerState,
      load: (t, at) => yt.loadVideoById({ videoId: t.sourceId, startSeconds: Math.max(0, at) }),
      play: () => yt.playVideo(), pause: () => yt.pauseVideo(), seek: (s) => yt.seekTo(s, true),
      time: () => yt.getCurrentTime() || 0, duration: () => yt.getDuration?.() || 0, status: ytStatus,
      stop: () => { try { yt.stopVideo(); } catch {} },
    },
    audio: {
      ready: () => true,
      load: (t) => { audio.src = streamUrl(t); },
      play: () => audio.play().catch(() => {}), pause: () => audio.pause(), seek: (s) => { audio.currentTime = s; },
      time: () => audio.currentTime || 0, duration: () => (Number.isFinite(audio.duration) ? audio.duration : 0),
      status: () => (audio.ended ? 'ended' : audio.paused ? 'paused' : audio.readyState < 3 ? 'buffering' : 'playing'),
      stop: () => { audio.pause(); audio.removeAttribute('src'); audio.load(); },
    },
  };
  const out = () => (!engine.state.track ? null : engine.state.track.source === 'yt' ? outputs.yt : outputs.audio);

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
  // discover: the queue is the Discover row, which the server can rebuild for a sync.
  function playQueue(queue, index, playlistId, discover = false) {
    act({ type: 'load', queue, index, playlistId, discover });
    if (!room) expandPlayer();
  }

  function afterStateChange() {
    const st = engine.state;
    if (st.track) $('#player').classList.remove('hidden');
    if (st.track?.id !== engine.listenId) { engine.listenId = st.track?.id; engine.listened = 0; }
    renderPlayerMeta(); tick();
    view.querySelectorAll('.song, .disc-card').forEach((li) => li.classList.toggle('now', li.dataset.id === st.track?.id));
  }

  // Show the video for YouTube songs and the cover for everything else.
  function showOutput(t) {
    const isAudio = t.source !== 'yt';
    $('#videoWrap').classList.toggle('audio', isAudio);
    if (isAudio) $('#artBig').src = t.art || '';
    $('#tapAudio').textContent = isAudio ? 'Tap the cover to start the music' : 'Tap the video to start the music';
  }
  $('#videoWrap').addEventListener('click', () => { if (engine.state.track && engine.state.track.source !== 'yt' && engine.state.playing) audio.play().catch(() => {}); });

  // YouTube stops when the screen sleeps, so keep it awake while a YouTube song plays.
  let wakeLock = null;
  async function syncWakeLock() {
    const want = engine.state.playing && engine.state.track?.source === 'yt' && document.visibilityState === 'visible';
    if (!('wakeLock' in navigator)) return;
    try {
      if (want && !wakeLock) {
        wakeLock = 'pending';
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!want && wakeLock && wakeLock !== 'pending') { await wakeLock.release(); wakeLock = null; }
    } catch { wakeLock = null; }
  }
  document.addEventListener('visibilitychange', syncWakeLock);

  // The sync loop: keep the active output where the shared clock says it should be.
  function tick() {
    const st = engine.state, o = out();
    if (!st.track || !o?.ready()) return;
    const exp = expected(st);
    if (engine.loaded !== st.track.id) {
      for (const other of Object.values(outputs)) if (other !== o && other.ready()) other.stop();
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
  $('#saveBtn').onclick = () => engine.state.track && saveSong(engine.state.track);
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
    document.body.classList.toggle('is-playing', !!(playing && engine.state.track));
    syncWakeLock();
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
    P.style.setProperty('--art', t?.art ? `url("${t.art.replace(/"/g, '%22')}")` : 'none');
    const lic = $('#pmLicense');
    lic.classList.toggle('hidden', !t?.license);
    if (t?.license) lic.href = t.license;
    $('#saveBtn').hidden = !t;
    $('#pmSub').textContent = room ? `In sync with ${room.members.filter((m) => m.id !== me?.id).map((m) => '@' + m.id).join(', ') || 'no one yet'}` : (t?.author || '');
    $('#sheetLabel').textContent = room ? 'Playing in sync' : 'Now playing';
    $('#syncStrip').innerHTML = room ? `<div class="strip-top"><div class="stack">${room.members.map((m) => avatar(m, 'sm')).join('')}</div><div style="flex:1;min-width:0"><div class="live-pill">In sync</div><div class="small muted">Everyone controls play, pause and skip.</div></div><a class="link-btn" href="#sync">Chat</a></div>${reactBar()}` : '';
    if (room) wireReactBar($('#syncStrip'));
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
    ws.onclose = (e) => {
      if (e.code === 4001) return signOut();
      if (e.code === 4002) { api('/api/me').then((u) => { me = u; paintMeAvatar(); }).catch(() => {}); return connect(); } // your @ID changed
      if (token) setTimeout(connect, Math.min(8000, 500 * 2 ** wsRetry++));
    };
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
    if (m.type === 'inbox') return setUnread(m.unread);
    if (m.type === 'chat-history') { chat = m.messages; return renderChat(); }
    if (m.type === 'chat') {
      chat.push(m.msg); if (chat.length > 60) chat.shift();
      if ($('#chatList')) return renderChat();
      // Away from the Sync page: count it, and show other people's messages briefly.
      if (m.msg.from && m.msg.from !== me?.id) { chatUnread++; paintSyncBadge(); toast(`${m.msg.name || '@' + m.msg.from}: ${m.msg.text}`); }
      return;
    }
    if (m.type === 'react') return floatReaction(m.kind, m.from);
    if (m.type === 'room') {
      const was = room; room = m.room;
      if (!room) { chat = []; chatUnread = 0; paintSyncBadge(); }
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
      if (location.hash === '#sync') { if (room && was && $('#syncCard')) renderSyncCard(); else route(); }
      else if (membersChanged && ['#home', ''].includes(location.hash)) route();
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
    paintMeAvatar(); setUnread(me.unread);
    connect();
    if (!location.hash) location.hash = 'home'; else route();
  }
  boot();

  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
})();
