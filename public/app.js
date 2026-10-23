/* KERNL app: library browser, reader and player.
   The server decides who may read what (api/*). This file only draws the screen and calls the API. */
'use strict';

const AMAZON_TAG = 'gd7vibe-21';
const SUPABASE_URL = 'https://peebgzfufyklxzdfnesc.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlZWJnemZ1ZnlrbHh6ZGZuZXNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxMjIwNDEsImV4cCI6MjA5MDY5ODA0MX0.TXg5ztQsoGvE5j49GRRtaNdTIVM2jS1-LmMNzu7YA5g';
// guest = anonymous visitor (no email). Mirrors LIMITS in lib/kernl.js; the server is what enforces it.
const LIMITS = { guest: 12, free: 36, pro: 200 };
const CATEGORIES = [
  'Business & Entrepreneurship', 'Personal Development', 'Psychology', 'History',
  'Science & Technology', 'Politics & Society', 'Philosophy', 'Biography & Memoir',
  'Fiction — Literary', 'Fiction — Thriller', 'Fiction — Sci-Fi', 'Fiction — Historical',
  'Health & Wellbeing', 'Economics', 'Leadership', 'Nature & Environment',
  'Crime & True Crime', 'Sport', 'Parenting & Family', 'Spirituality'
];

const $ = id => document.getElementById(id);
const { esc, icon, toast } = KUI;

// ── State ─────────────────────────────────────────────────────────────────────
let _sbClient = null;
let _currentUser = null;
let _userProfile = null;
let currentSummary = null;     // { title, author, html, plain, words }
let _allBooks = [];            // catalogue: { title, author, synopsis, categories, _cats, _s }
let _opening = false;
let _readerOpen = false;

function getSB() {
  if (!_sbClient) _sbClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _sbClient;
}

// Every API call carries the signed-in user's access token. The server decides what they may do.
async function apiHeaders() {
  const h = { 'Content-Type': 'application/json' };
  try {
    const { data } = await getSB().auth.getSession();
    if (data && data.session) h.Authorization = 'Bearer ' + data.session.access_token;
  } catch (e) { /* anonymous */ }
  return h;
}

// ── Small helpers ─────────────────────────────────────────────────────────────
function norm(s) { return String(s || '').toLowerCase().trim().replace(/\s+/g, ' '); }
// Case- and accent-insensitive form used for searching ("Charrière" matches "charriere").
function fold(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function fmtTime(secs) { if (!isFinite(secs) || secs < 0) secs = 0; const m = Math.floor(secs / 60); const s = Math.floor(secs % 60); return m + ':' + String(s).padStart(2, '0'); }
function safe(s) { return String(s).replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_').slice(0, 60); }
function countWords(plain) { return String(plain || '').split(/\s+/).filter(Boolean).length; }
function makeAmazonUrl(title, author) { return 'https://www.amazon.co.uk/s?k=' + encodeURIComponent(title + (author ? ' ' + author : '')) + '&tag=' + AMAZON_TAG; }
function tier() { return !_currentUser ? 'guest' : _currentUser.is_anonymous ? 'guest' : ((_userProfile && _userProfile.tier) || 'free'); }
function isPro() { return tier() === 'pro'; }
function parseWords(w) {
  if (Array.isArray(w)) return w;
  if (typeof w === 'string') { try { const p = JSON.parse(w); return Array.isArray(p) ? p : []; } catch (e) { /* fall through */ } }
  return [];
}
function stripGenreLine(html) { return String(html || '').replace(/^GENRE:(FICTION|NONFICTION)\s*/i, '').replace(/^<p>GENRE:(FICTION|NONFICTION)<\/p>\s*/i, ''); }

// Summaries are model-written HTML. Keep only plain formatting so nothing in them can run or load anything.
const ALLOWED_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'P', 'UL', 'OL', 'LI', 'STRONG', 'B', 'EM', 'I', 'BLOCKQUOTE', 'BR', 'HR']);
const DROP_TAGS = /^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|LINK|META|SVG|MATH|FORM|INPUT|BUTTON|TEXTAREA|SELECT|NOSCRIPT|TEMPLATE|IMG|VIDEO|AUDIO|SOURCE|BASE)$/;
function sanitizeHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html || '');
  (function walk(node) {
    Array.from(node.childNodes).forEach(ch => {
      if (ch.nodeType === 3) return;
      if (ch.nodeType !== 1) { ch.remove(); return; }
      if (!ALLOWED_TAGS.has(ch.tagName)) {
        if (DROP_TAGS.test(ch.tagName)) { ch.remove(); return; }
        walk(ch);
        while (ch.firstChild) node.insertBefore(ch.firstChild, ch);
        ch.remove();
        return;
      }
      while (ch.attributes.length) ch.removeAttribute(ch.attributes[0].name);
      walk(ch);
    });
  })(tpl.content);
  return tpl.innerHTML;
}

function setBusy(text) {
  const el = $('status');
  if (!text) { el.hidden = true; return; }
  $('status-text').textContent = text;
  el.hidden = false;
}

// ── Auth and profile ──────────────────────────────────────────────────────────
// Own profile is read-only from the browser; the server does all the counting.
async function refreshProfile() {
  if (!_currentUser) return;
  try {
    const sb = getSB();
    if (_currentUser.is_anonymous) {
      // Guests have no profile: their count is simply the books the server has opened for them.
      const { count } = await sb.from('user_library').select('id', { count: 'exact', head: true }).eq('user_id', _currentUser.id);
      _userProfile = { tier: 'guest', downloads_used: count || 0 };
    } else {
      const { data } = await sb.from('profiles').select('*').eq('id', _currentUser.id).single();
      if (data) _userProfile = data;
    }
    renderUser();
  } catch (e) { console.warn('refreshProfile failed:', e.message); }
}

async function initAuth() {
  const sb = getSB();
  let session = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { data } = await sb.auth.getSession();
    if (data && data.session) { session = data.session; break; }
    if (attempt < 3) await new Promise(r => setTimeout(r, 400));
  }
  // Nobody signed in: start a guest session (no email, no form). The server counts their free books against it.
  if (!session) {
    try {
      const { data, error } = await sb.auth.signInAnonymously();
      if (!error && data && data.session) session = data.session;
    } catch (e) { console.warn('Guest session failed:', e.message); }
  }
  if (!session) { window.location.href = '/login.html'; return; }
  _currentUser = session.user;
  if (_currentUser.is_anonymous) {
    _userProfile = { tier: 'guest', downloads_used: 0 };
    renderUser();
    refreshProfile();
  } else {
    const { data: profile } = await sb.from('profiles').select('*').eq('id', _currentUser.id).single();
    _userProfile = profile || { tier: 'free', downloads_used: 0, downloads_reset: null };
    renderUser();
  }
  loadLibrary();

  // Opened from My Books / the landing page with ?title=&author=: strip the query, then open the book.
  const params = new URLSearchParams(window.location.search);
  const autoTitle = params.get('title');
  const autoAuthor = params.get('author');
  if (autoTitle) {
    history.replaceState(null, '', window.location.pathname);
    openSummary(autoTitle, autoAuthor || '');
  }
}

function renderUser() {
  if (!_currentUser) return;
  const guest = !!_currentUser.is_anonymous;
  const t = tier();
  const used = (_userProfile && _userProfile.downloads_used) || 0;
  const limit = LIMITS[t] || LIMITS.free;
  const remaining = Math.max(0, limit - used);
  const pct = Math.min(100, (used / limit) * 100);

  // Pro-only buttons
  document.querySelectorAll('.pro-audio').forEach(b => { b.hidden = !isPro(); });

  // Usage card
  $('meter').hidden = false;
  $('meter-label').textContent = remaining <= 0 ? (guest ? 'Free books used' : 'Summaries used') : (guest ? 'Free books left' : 'Summaries left');
  $('meter-num').textContent = String(remaining);
  $('meter-of').textContent = 'of ' + limit;
  $('meter-fill').style.width = (100 - pct) + '%';
  $('pro-add-wrap').hidden = !isPro();
  if (!$('hero-art').firstChild) {
    const keys = SCENES.DISPLAY, k = keys[new Date().getDate() % keys.length];
    $('hero-art').style.setProperty('--g', SCENES.byKey(k).bg);
    $('hero-art').innerHTML = SCENES.svg(k);
  }

  // Limit note
  const note = $('limit-note');
  if (remaining <= 0) {
    note.innerHTML = guest
      ? 'You have used your ' + limit + ' free books. <a href="/login.html#signup"><b>Create a free account</b></a> to keep your library and get ' + LIMITS.free + ' books, or <a href="/upgrade.html"><b>see Pro</b></a> for ' + LIMITS.pro + ' a year.'
      : t === 'pro'
        ? 'You have reached your ' + limit + ' summaries for this year.'
        : 'You have used all ' + limit + ' of your summaries. <a href="/upgrade.html"><b>See Pro</b></a> for ' + LIMITS.pro + ' a year.';
    note.hidden = false;
  } else {
    note.hidden = true;
  }

  // Account menu
  $('menu-who').textContent = guest ? 'Guest' : (_currentUser.email || 'Signed in');
  const badge = $('menu-tier');
  badge.textContent = t === 'pro' ? 'Pro' : guest ? 'Guest' : 'Free';
  badge.className = 'badge ' + (t === 'pro' ? 'pro' : 'muted');
  $('menu-usage').textContent = used + ' / ' + limit + ' used';
  $('menu-signup').hidden = !guest;
  $('menu-signin').hidden = !guest;
  $('menu-upgrade').hidden = !(t === 'free');
  $('menu-signout').hidden = guest;
}

async function handleSignOut() { await getSB().auth.signOut(); window.location.href = '/login.html'; }

// ── Library: load, shelves, search ────────────────────────────────────────────
async function loadLibrary() {
  try {
    let all = [], offset = 0;
    while (true) {
      const res = await fetch(
        SUPABASE_URL + '/rest/v1/summaries?select=title,author,synopsis,categories&limit=1000&offset=' + offset + '&order=title.asc',
        { headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY } }
      );
      if (!res.ok) throw new Error('library ' + res.status);
      const data = await res.json();
      if (!data || !data.length) break;
      all = all.concat(data);
      if (data.length < 1000) break;
      offset += 1000;
    }
    all.forEach(b => {
      let cats = [];
      try { cats = JSON.parse(b.categories || '[]'); } catch (e) { cats = []; }
      b._cats = Array.isArray(cats) ? cats : [];
      b._g = SCENES.groupFor(b._cats);
      b._t = fold(b.title);
      b._a = fold(b.author);
    });
    _allBooks = all;
    renderGenres();
  } catch (e) {
    console.warn('loadLibrary failed:', e.message);
    $('genres').className = 'genres';
    $('genres').innerHTML = '<div class="empty" style="grid-column:1/-1"><b>Could not load the library</b>Check your connection, then <a href="" onclick="location.reload();return false">try again</a>.</div>';
  }
}

function groupOfTitle(title) {
  const b = findInLibrary(title);
  if (b) return b._g;
  const keys = SCENES.DISPLAY;
  let h = 0; const s = String(title || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return keys[h % keys.length];
}
function findInLibrary(title) {
  const t = norm(title);
  return _allBooks.find(b => norm(b.title) === t) || null;
}

function renderGenres() {
  const counts = {};
  SCENES.GROUPS.forEach(g => { counts[g.key] = _allBooks.filter(b => b._cats.some(c => g.cats.indexOf(c) !== -1)).length; });
  const box = $('genres');
  box.className = 'genres';
  box.innerHTML = SCENES.DISPLAY.filter(k => counts[k]).map(k => {
    const g = SCENES.byKey(k);
    return '<button class="gcard" type="button" data-g="' + k + '" style="--g:' + g.bg + '">' +
      '<span class="art">' + SCENES.svg(k) + '</span>' +
      '<span class="meta"><span class="ct">' + counts[k].toLocaleString() + (counts[k] === 1 ? ' book' : ' books') + '</span>' +
      '<span class="nm">' + esc(g.name) + '</span></span></button>';
  }).join('');
}

// Shelf layer: one genre's books. A book's one-line synopsis opens as it scrolls to the middle of the screen.
let _shelfBooks = [], _shelfShown = 0, _shelfKey = '', _shelfCat = 'All', _rowObs = null, _moreObs = null;
const SHELF_PAGE = 60;

function openShelf(key) {
  const g = SCENES.byKey(key);
  _shelfKey = key;
  _shelfCat = 'All';
  _shelfBooks = shelfFilter();
  _shelfShown = 0;
  const layer = $('genre');
  layer.style.setProperty('--g', g.bg);
  $('genre-art').innerHTML = SCENES.svg(key) + '<h2>' + esc(g.name) + '</h2>';
  renderShelfChips();
  $('genre-list').innerHTML = '';
  layer.scrollTop = 0;
  layer.hidden = false;
  layer.classList.remove('closing');
  layer.classList.add('opening');
  setupRowObserver(layer);
  appendShelfRows();
  _genreOpen = true;
  pushLayer('genre');
}
// A shelf holds every book in any of its categories; the chips narrow it to one category.
function shelfFilter() {
  const g = SCENES.byKey(_shelfKey);
  const cats = _shelfCat === 'All' ? g.cats : [_shelfCat];
  return _allBooks.filter(b => b._cats.some(c => cats.indexOf(c) !== -1));
}
function renderShelfChips() {
  const g = SCENES.byKey(_shelfKey);
  const n = c => _allBooks.filter(b => b._cats.indexOf(c) !== -1).length;
  const all = _allBooks.filter(b => b._cats.some(c => g.cats.indexOf(c) !== -1)).length;
  $('genre-chips').innerHTML = ['All'].concat(g.cats).map(c => {
    const label = c === 'All' ? 'All' : c.replace('Fiction \u2014 ', '');
    return '<button class="sub' + (c === _shelfCat ? ' on' : '') + '" type="button" data-c="' + esc(c) + '">' + esc(label) + ' <i>' + (c === 'All' ? all : n(c)).toLocaleString() + '</i></button>';
  }).join('');
}
function setShelfCat(c) {
  _shelfCat = c;
  _shelfBooks = shelfFilter();
  _shelfShown = 0;
  renderShelfChips();
  $('genre-list').innerHTML = '';
  appendShelfRows();
}
function appendShelfRows() {
  const list = $('genre-list');
  const old = list.querySelector('.more-sentinel'); if (old) old.remove();
  const g = SCENES.byKey(_shelfKey);
  const slice = _shelfBooks.slice(_shelfShown, _shelfShown + SHELF_PAGE);
  const frag = document.createDocumentFragment();
  slice.forEach((b, i) => {
    const el = document.createElement('button');
    el.type = 'button'; el.className = 'brow'; el.dataset.i = String(_shelfShown + i);
    el.style.setProperty('--g', g.bg);
    el.innerHTML = '<div class="hd"><span class="tile">' + SCENES.svg(_shelfKey, { slice: true }) + '</span><span class="tx"><div class="tt">' + esc(b.title) + '</div><div class="au">' + esc(b.author || '') + '</div></span></div>' +
      '<div class="syn"><div><p>' + esc(b.synopsis || '') + '</p></div></div>';
    frag.appendChild(el);
    if (_rowObs) _rowObs.observe(el.querySelector('.hd'));
  });
  list.appendChild(frag);
  _shelfShown += slice.length;
  if (_shelfShown < _shelfBooks.length) {
    const s = document.createElement('div'); s.className = 'more-sentinel';
    list.appendChild(s);
    if (_moreObs) _moreObs.disconnect();
    _moreObs = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { _moreObs.disconnect(); appendShelfRows(); } }, { root: $('genre'), rootMargin: '600px 0px' });
    _moreObs.observe(s);
  }
}
function setupRowObserver(root) {
  if (_rowObs) _rowObs.disconnect();
  // A thin band across the middle of the screen: the book whose title row sits in it is the open one.
  _rowObs = new IntersectionObserver(entries => {
    entries.forEach(e => { const row = e.target.parentElement; if (row) row.classList.toggle('on', e.isIntersecting); });
  }, { root: root, rootMargin: '-44% 0px -46% 0px', threshold: 0 });
}

function hideLayer(id, after) {
  const el = $(id);
  if (el.hidden) return;
  el.classList.remove('opening');
  el.classList.add('closing');
  setTimeout(() => { el.hidden = true; el.classList.remove('closing'); if (after) after(); }, 230);
}
let _genreOpen = false;
function hideShelf() {
  if (!_genreOpen) return;
  _genreOpen = false;
  if (_rowObs) _rowObs.disconnect();
  if (_moreObs) _moreObs.disconnect();
  hideLayer('genre');
}

// History: every layer that opens adds one entry, so the phone's Back gesture closes the top layer.
const _stack = [];
function pushLayer(name) { _stack.push(name); history.pushState({ kl: name }, '', window.location.href); }
function closeTop() { if (_stack.length) history.back(); }
window.addEventListener('popstate', () => {
  const top = _stack.pop();
  if (top === 'reader') hideReader();
  else if (top === 'genre') hideShelf();
});

// Search: a full-screen pop-up, so the home screen stays clear.
let _searchOpen = false;
function openSearch() {
  _searchOpen = true;
  $('search').hidden = false;
  $('search').classList.remove('closing');
  $('search').classList.add('opening');
  document.body.style.overflow = 'hidden';
  renderSearch();
  setTimeout(() => $('search-input').focus(), 60);
}
function closeSearch() {
  if (!_searchOpen) return;
  _searchOpen = false;
  document.body.style.overflow = _readerOpen || _genreOpen ? 'hidden' : '';
  hideLayer('search');
}
function renderSearch() {
  const raw = $('search-input').value, q = fold(raw);
  const out = $('search-results');
  if (!q) { out.innerHTML = '<p class="s-hint">' + (_allBooks.length ? _allBooks.length.toLocaleString() + ' books. Type a title or an author.' : 'Loading the library…') + '</p>'; return; }
  const scored = [];
  _allBooks.forEach((b, i) => {
    let s = -1;
    if (b._t.startsWith(q)) s = 0; else if (b._t.includes(q)) s = 1; else if (b._a.includes(q)) s = 2;
    if (s >= 0) scored.push([s, i]);
  });
  scored.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const top = scored.slice(0, 40).map(x => _allBooks[x[1]]);
  _searchHits = top;
  if (!top.length) {
    out.innerHTML = '<div class="empty"><b>Nothing matches “' + esc(raw.trim()) + '”</b>' +
      (isPro() ? 'It is not in the library yet, but you can have it written.<div style="margin-top:16px"><button class="btn primary" id="empty-add" type="button">Summarise “' + esc(raw.trim()) + '”</button></div>' : 'Try another title or author. Pro members can have a summary written for any book.') + '</div>';
    return;
  }
  out.innerHTML = top.map((b, i) => {
    const g = SCENES.byKey(b._g);
    return '<button class="brow" type="button" data-s="' + i + '" style="--g:' + g.bg + '"><div class="hd"><span class="tile">' + SCENES.svg(b._g, { slice: true }) + '</span><span class="tx"><div class="tt">' + esc(b.title) + '</div><div class="au">' + esc(b.author || '') + '</div></span></div></button>';
  }).join('') + (scored.length > 40 ? '<p class="s-hint">Showing 40 of ' + scored.length + '. Keep typing to narrow it down.</p>' : '');
}
let _searchHits = [];

function wireLibrary() {
  $('search-btn').addEventListener('click', openSearch);
  $('search-close').addEventListener('click', closeSearch);
  let timer = null;
  $('search-input').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(renderSearch, 80); });
  $('search-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const b = _searchHits[0];
      if (b && fold($('search-input').value)) { closeSearch(); openSummary(b.title, b.author || ''); }
      else if (isPro() && $('search-input').value.trim()) { const v = $('search-input').value.trim(); closeSearch(); openNewBookModal(v); }
    }
  });
  $('search-results').addEventListener('click', e => {
    const row = e.target.closest('[data-s]');
    if (row) { const b = _searchHits[Number(row.dataset.s)]; if (b) { closeSearch(); openSummary(b.title, b.author || ''); } return; }
    if (e.target.closest('#empty-add')) { const v = $('search-input').value.trim(); closeSearch(); openNewBookModal(v); }
  });
  $('genres').addEventListener('click', e => { const c = e.target.closest('.gcard'); if (c) openShelf(c.dataset.g); });
  $('genre-list').addEventListener('click', e => {
    const r = e.target.closest('.brow'); if (!r) return;
    // Open it in the colours of the shelf it was picked from, even when the book also sits on another shelf.
    const b = _shelfBooks[Number(r.dataset.i)]; if (b) openSummary(b.title, b.author || '', { group: _shelfKey });
  });
  $('genre-close').addEventListener('click', closeTop);
  $('genre-chips').addEventListener('click', e => { const c = e.target.closest('.sub'); if (c) setShelfCat(c.dataset.c); });
  $('pro-add').addEventListener('click', () => openNewBookModal(''));
}

// ── Opening a summary ─────────────────────────────────────────────────────────
// Books already in the library come straight back from the server. A brand-new book (Pro only) is written
// and streamed in. Either way the server counts it against the allowance.
async function openSummary(title, author, opts) {
  if (_opening) return;
  _opening = true;
  const isNew = !!(opts && opts.isNew);
  const group = (opts && opts.group) || '';
  setBusy(isNew ? 'Writing your summary. This takes about 30 seconds…' : 'Opening…');
  let streamStarted = false;
  try {
    const res = await fetch('/api/summarise', { method: 'POST', headers: await apiHeaders(), body: JSON.stringify({ title, author }) });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      if (d.code === 'limit' || d.code === 'ip_limit') refreshProfile();
      throw new Error(d.error || 'Something went wrong (' + res.status + '). Please try again.');
    }
    if ((res.headers.get('content-type') || '').includes('application/json')) {
      const d = await res.json();
      setBusy('');
      showSummary(title, author || d.author || '', d.html, d.plain, parseWords(d.words), { group });
      refreshProfile();
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', finalData = null, serverError = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let msg = null;
        try { msg = JSON.parse(line.slice(6).trim()); } catch (e) { continue; }
        if (msg.error) { serverError = msg.error; continue; }
        if (msg.done) { finalData = msg; continue; }
        if (msg.chunk) {
          if (!streamStarted) { streamStarted = true; setBusy(''); showSummary(title, author, msg.chunk, '', [], { streaming: true, group }); }
          else updateStreamingBody(msg.chunk);
        }
      }
    }
    // Never present a half-written summary as if it were finished.
    if (serverError) throw new Error(serverError);
    if (!finalData) throw new Error('The connection dropped before the summary finished. It may still be saving, so try opening it again in a minute.');
    showSummary(title, author, finalData.html, finalData.plain, parseWords(finalData.words), { group });
    refreshProfile();
  } catch (err) {
    if (streamStarted && _readerOpen) closeReader();
    toast(err.message || 'Could not open that summary.', 'err', 7000);
  } finally {
    setBusy('');
    _opening = false;
  }
}

// ── Reader ────────────────────────────────────────────────────────────────────
function updateStreamingBody(htmlSoFar) {
  const body = $('summary-body');
  if (body) body.innerHTML = sanitizeHtml(stripGenreLine(htmlSoFar));
}

function showSummary(title, author, html, plain, words, opts) {
  opts = opts || {};
  stopAudio();
  const clean = sanitizeHtml(stripGenreLine(html));
  currentSummary = { title, author, html: clean, plain: plain || '', words: words || [] };

  // The shelf it was opened from wins; otherwise (search, library, links) the book's own shelf.
  const key = (opts.group && SCENES.GROUPS.some(x => x.key === opts.group)) ? opts.group : groupOfTitle(title);
  const g = SCENES.byKey(key);
  $('reader').style.setProperty('--g', g.bg);
  $('r-cover').innerHTML = SCENES.svg(key);
  $('s-title').textContent = title;
  $('s-author').textContent = author ? 'by ' + author : '';
  $('summary-body').innerHTML = clean;
  $('buy-btn').href = makeAmazonUrl(title, author);
  resetScrubUI();
  setSpeed(1);

  if (opts.streaming) {
    $('s-words').textContent = 'Writing…';
    $('s-time').textContent = '';
    $('words').hidden = true;
    setAudioState('generating');
    $('player-sub').textContent = 'Writing your summary…';
  } else {
    const n = countWords(plain);
    $('s-words').textContent = n.toLocaleString() + ' words';
    $('s-time').textContent = Math.max(1, Math.round(n / 220)) + ' min read';
    renderWords(words);
    $('player-sub').textContent = 'Checking audio…';
    setAudioState('idle');
    checkAudioAvailability();
  }
  if (!_readerOpen) openReader();
}

function renderWords(words) {
  const box = $('words');
  if (!words || !words.length) { box.hidden = true; return; }
  const seen = new Set();
  const unique = words.filter(w => { if (!w || !w.word) return false; const k = String(w.word).toLowerCase().trim(); if (seen.has(k)) return false; seen.add(k); return true; });
  box.open = false;
  box.hidden = !unique.length;
  $('megan-words-grid').innerHTML = unique.map(w => '<div class="word"><b>' + esc(w.word) + '</b><span>' + esc(w.definition) + '</span></div>').join('');
}

function openReader() {
  const r = $('reader');
  r.hidden = false;
  r.classList.remove('closing');
  r.classList.add('opening');
  r.scrollTop = 0;
  $('r-cover').style.transform = '';
  $('r-art').style.opacity = '';
  document.body.style.overflow = 'hidden';
  _readerOpen = true;
  watchCard();
  pushLayer('reader');
}

function hideReader() {
  if (!_readerOpen) return;
  _readerOpen = false;
  stopAudio();
  setAudioState('idle');
  $('mini').classList.remove('show');
  if (_cardObs) _cardObs.disconnect();
  document.body.style.overflow = _genreOpen ? 'hidden' : '';
  hideLayer('reader', () => { currentSummary = null; _waFile = null; });
}

// Mini player: shown at the top while the full player card is scrolled out of sight.
let _cardObs = null, _cardGone = false;
function watchCard() {
  if (_cardObs) _cardObs.disconnect();
  _cardGone = false;
  _cardObs = new IntersectionObserver(es => {
    const e = es[es.length - 1];
    _cardGone = !e.isIntersecting && e.boundingClientRect.top < 0;
    updateMini();
  }, { root: $('reader'), rootMargin: '-64px 0px 0px 0px', threshold: 0 });
  _cardObs.observe($('player'));
  updateMini();
}
function updateMini() {
  const can = !$('play-btn').disabled;
  const show = _readerOpen && _cardGone && can;
  $('mini').classList.toggle('show', show);
  $('mini').setAttribute('aria-hidden', show ? 'false' : 'true');
  $('mini-play').disabled = !can;
}

function closeReader() { if (_readerOpen) closeTop(); }

// The cover shrinks and fades as the summary slides up over it.
function onReaderScroll() {
  const r = $('reader');
  const h = $('r-art').offsetHeight || 300;
  const p = Math.max(0, Math.min(1, r.scrollTop / (h * 0.75)));
  $('r-cover').style.transform = 'translateY(' + (-p * 24) + 'px) scale(' + (1 - 0.18 * p) + ')';
  $('r-art').style.opacity = String(1 - 0.6 * p);
}
function onGenreScroll() {
  const r = $('genre');
  const h = $('genre-art').offsetHeight || 240;
  const p = Math.max(0, Math.min(1, r.scrollTop / (h * 0.8)));
  $('genre-art').style.opacity = String(1 - 0.7 * p);
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || document.querySelector('.overlay')) return;
  if (_searchOpen) closeSearch(); else closeTop();
});

// ── Audio state machine ───────────────────────────────────────────────────────
let isPlaying = false, audioEl = null, playbackRate = 1;
let streamingAudioContext = null, streamingSources = [];
let _audioState = 'idle';

function setAudioState(state) { _audioState = state; applyAudioStateToUI(); }

function applyAudioStateToUI() {
  switch (_audioState) {
    case 'idle':
    case 'generating':
      _setPlayBtn(false); _setSeekControls(false); _setSpeedBtn(false); _setPrintKindle(false); break;
    case 'audio-prep':
      _setPlayBtn(false); _setSeekControls(false); _setSpeedBtn(false); _setPrintKindle(true); break;
    case 'streaming':
      _setPlayBtn(true); _setSeekControls(false); _setSpeedBtn(false); _setPrintKindle(true); break;
    case 'cached':
      _setPlayBtn(true); _setSeekControls(true); _setSpeedBtn(true); _setPrintKindle(true); break;
  }
}
function _setPlayBtn(enabled) { $('play-btn').disabled = !enabled; $('play-btn').style.opacity = enabled ? '' : '.4'; updateMini(); }
function _setSeekControls(enabled) {
  $('scrub-row').classList.toggle('disabled', !enabled);
  $('skip-back').disabled = !enabled;
  $('skip-fwd').disabled = !enabled;
}
function _setSpeedBtn(enabled) { $('speed-btn').disabled = !enabled; }
function _setPrintKindle(enabled) { $('send-kindle-btn').disabled = !enabled; $('print-btn').disabled = !enabled; }
function setSub(text) { $('player-sub').textContent = text; }

function setSpeed(rate) {
  playbackRate = rate;
  $('speed-btn').textContent = rate + '×';
  if (audioEl) audioEl.playbackRate = rate;
}
function cycleSpeed() { setSpeed(playbackRate === 1 ? 1.5 : playbackRate === 1.5 ? 2 : 1); }

// Is there audio for this book? Everyone can play audio that exists; only Pro can have new audio made.
async function checkAudioAvailability() {
  if (!currentSummary) return;
  const mine = currentSummary.title;
  const stillHere = () => currentSummary && currentSummary.title === mine;
  const pro = isPro();
  let cached = false;
  try {
    const res = await fetch('/api/tts', { method: 'POST', headers: await apiHeaders(), body: JSON.stringify({ voice: 'female', title: currentSummary.title, author: currentSummary.author, checkOnly: true }) });
    if (res.ok) { const d = await res.json(); cached = !!d.url; }
  } catch (e) { console.warn('Audio check failed:', e.message); }
  if (!stillHere()) return;
  if (cached) { setAudioState('cached'); setSub('Press play to listen'); return; }
  if (!pro) { setAudioState('audio-prep'); setSub('Audio for this book is a Pro feature'); return; }

  // Pro: make the audio now. The server answers once the file exists.
  setAudioState('audio-prep');
  setSub('Preparing audio… about a minute');
  try {
    const res = await fetch('/api/generate-audio', { method: 'POST', headers: await apiHeaders(), body: JSON.stringify({ title: currentSummary.title, author: currentSummary.author, voice: 'female' }) });
    const d = await res.json().catch(() => ({}));
    if (!stillHere()) return;
    if (res.ok && d.ok) { setAudioState('cached'); setSub('Press play to listen'); }
    else setSub(d.error || 'Audio unavailable right now');
  } catch (e) {
    if (stillHere()) setSub('Audio unavailable right now');
  }
}

// ── Player ────────────────────────────────────────────────────────────────────
function setPlayerState(playing, subText) {
  isPlaying = playing;
  $('play-icon').innerHTML = icon(playing ? 'pause' : 'play');
  $('mini-icon').innerHTML = icon(playing ? 'pause' : 'play');
  $('play-btn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  if (subText) setSub(subText);
  setScrubActive(playing);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}
function setScrubActive(active) {
  $('scrub-row').classList.toggle('active', active);
  $('play-btn').classList.toggle('playing', active);
  $('player-sub').classList.toggle('playing', active);
}
function resetScrubUI() {
  $('scrub-fill').style.width = '0%';
  $('scrub-thumb').style.left = '0%';
  $('scrub-elapsed').textContent = '0:00';
  $('scrub-remaining').textContent = '−0:00';
  $('scrub-track').setAttribute('aria-valuenow', '0');
  $('play-icon').innerHTML = icon('play');
  $('mini-icon').innerHTML = icon('play');
  $('mini-fill').style.width = '0%';
  $('mini-time').textContent = '';
  setScrubActive(false);
}
function updateScrubUI() {
  if (!audioEl || !audioEl.duration) return;
  const pct = (audioEl.currentTime / audioEl.duration) * 100;
  $('scrub-fill').style.width = pct + '%';
  $('scrub-thumb').style.left = pct + '%';
  $('scrub-track').setAttribute('aria-valuenow', String(Math.round(pct)));
  $('scrub-elapsed').textContent = fmtTime(audioEl.currentTime);
  $('scrub-remaining').textContent = '−' + fmtTime(audioEl.duration - audioEl.currentTime);
  $('mini-fill').style.width = pct + '%';
  $('mini-time').textContent = '−' + fmtTime(audioEl.duration - audioEl.currentTime);
}
function initScrubEvents() {
  const track = $('scrub-track');
  if (track._scrubInit) return;
  track._scrubInit = true;
  let dragging = false;
  function seekTo(e) {
    if (!audioEl || !audioEl.duration) return;
    const rect = track.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    audioEl.currentTime = pct * audioEl.duration;
    updateScrubUI();
  }
  track.addEventListener('mousedown', e => { dragging = true; track.classList.add('dragging'); seekTo(e); });
  track.addEventListener('touchstart', e => { dragging = true; track.classList.add('dragging'); seekTo(e); }, { passive: true });
  document.addEventListener('mousemove', e => { if (dragging) seekTo(e); });
  document.addEventListener('touchmove', e => { if (dragging) seekTo(e); }, { passive: true });
  document.addEventListener('mouseup', () => { dragging = false; track.classList.remove('dragging'); });
  document.addEventListener('touchend', () => { dragging = false; track.classList.remove('dragging'); });
  track.addEventListener('keydown', e => { if (e.key === 'ArrowLeft') skipAudio(-10); if (e.key === 'ArrowRight') skipAudio(10); });
}
function skipAudio(secs) {
  if (!audioEl) return;
  audioEl.currentTime = Math.max(0, Math.min(audioEl.duration || 0, audioEl.currentTime + secs));
  updateScrubUI();
}
function registerMediaSession(title, author) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: title || 'KERNL Summary', artist: author || '', album: 'KERNL — for the curious' });
  navigator.mediaSession.setActionHandler('play', () => resumeAudio());
  navigator.mediaSession.setActionHandler('pause', () => pauseAudio());
  navigator.mediaSession.setActionHandler('stop', () => stopAudio());
  navigator.mediaSession.setActionHandler('seekbackward', () => skipAudio(-10));
  navigator.mediaSession.setActionHandler('seekforward', () => skipAudio(10));
}
function stopAudio() {
  if (audioEl) { try { audioEl.pause(); audioEl.src = ''; } catch (e) { /* ignore */ } audioEl = null; }
  if (streamingSources.length) { streamingSources.forEach(s => { try { s.stop(); } catch (e) { /* ignore */ } }); streamingSources = []; }
  if (streamingAudioContext && streamingAudioContext.state !== 'closed') { try { streamingAudioContext.close(); } catch (e) { /* ignore */ } streamingAudioContext = null; }
  setPlayerState(false, null);
  resetScrubUI();
}
function pauseAudio() {
  if (audioEl && !audioEl.paused) audioEl.pause();
  if (streamingAudioContext && streamingAudioContext.state === 'running') streamingAudioContext.suspend();
  setPlayerState(false, 'Paused');
}
function resumeAudio() {
  if (streamingAudioContext && streamingAudioContext.state === 'suspended') { streamingAudioContext.resume(); setPlayerState(true, 'Now playing'); return true; }
  if (audioEl && audioEl.paused && audioEl.src) { audioEl.play(); setPlayerState(true, 'Now playing'); return true; }
  return false;
}
async function checkAudioCache() {
  if (!currentSummary) return null;
  try {
    const res = await fetch('/api/tts', { method: 'POST', headers: await apiHeaders(), body: JSON.stringify({ voice: 'female', title: currentSummary.title, author: currentSummary.author }) });
    if (res.ok) { const d = await res.json(); return d.url || null; }
  } catch (e) { console.warn('Cache check failed', e); }
  return null;
}
function isSafari() { return /^((?!chrome|android).)*safari/i.test(navigator.userAgent); }

async function startTTS() {
  if (!currentSummary) return;
  const cachedUrl = await checkAudioCache();
  if (cachedUrl) { setAudioState('cached'); playSingleAudio(cachedUrl, null); return; }
  if (!isPro()) { setAudioState('audio-prep'); setSub('Audio for this book is a Pro feature'); return; }

  if (isSafari()) {
    // Safari can't play the live stream: wait for the file to be built, then play it.
    setAudioState('audio-prep');
    const pollTitle = currentSummary.title, pollAuthor = currentSummary.author;
    const pollForAudio = async attempt => {
      if (!currentSummary || currentSummary.title !== pollTitle) return;
      setSub('Audio preparing… ' + (attempt * 5) + 's');
      try {
        const res = await fetch('/api/tts', { method: 'POST', headers: await apiHeaders(), body: JSON.stringify({ voice: 'female', title: pollTitle, author: pollAuthor }) });
        if (res.ok) { const d = await res.json(); if (d.url) { setAudioState('cached'); playSingleAudio(d.url, null); return; } }
      } catch (e) { console.warn('Poll error:', e.message); }
      if (attempt < 42) setTimeout(() => pollForAudio(attempt + 1), 5000);
      else { setSub('Audio unavailable. Tap play to retry'); setAudioState('cached'); }
    };
    try { fetch('/api/generate-audio', { method: 'POST', headers: await apiHeaders(), body: JSON.stringify({ title: pollTitle, author: pollAuthor, voice: 'female' }) }).catch(() => {}); } catch (e) { /* ignore */ }
    pollForAudio(1);
    return;
  }

  setAudioState('streaming');
  setSpeed(1);
  setPlayerState(true, 'Connecting…');
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  let audioContext;
  try {
    audioContext = new AudioCtx();
    if (audioContext.state === 'suspended') await audioContext.resume();
  } catch (e) {
    console.warn('AudioContext failed:', e);
    setAudioState('audio-prep');
    setPlayerState(false, 'Audio unavailable. Tap play to retry');
    return;
  }
  streamingAudioContext = audioContext;
  streamingSources = [];
  let nextStartTime = audioContext.currentTime + 0.1;
  let started = false;
  let mp3Buffer = new Uint8Array(0);
  const scheduleChunk = async base64chunk => {
    const binary = atob(base64chunk);
    const newBytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) newBytes[i] = binary.charCodeAt(i);
    const combined = new Uint8Array(mp3Buffer.length + newBytes.length);
    combined.set(mp3Buffer); combined.set(newBytes, mp3Buffer.length);
    mp3Buffer = combined;
    try {
      const decoded = await audioContext.decodeAudioData(mp3Buffer.slice(0).buffer);
      const source = audioContext.createBufferSource();
      source.buffer = decoded;
      source.playbackRate.value = playbackRate;
      source.connect(audioContext.destination);
      const when = Math.max(nextStartTime, audioContext.currentTime);
      source.start(when);
      streamingSources.push(source);
      nextStartTime = when + decoded.duration;
      mp3Buffer = new Uint8Array(0);
      if (!started) {
        started = true;
        setPlayerState(true, 'Now playing');
        registerMediaSession(currentSummary.title, currentSummary.author);
        initScrubEvents();
      }
    } catch (e) { /* not enough data yet */ }
  };
  try {
    const res = await fetch('/api/tts-stream', { method: 'POST', headers: await apiHeaders(), body: JSON.stringify({ voice: 'female', title: currentSummary.title, author: currentSummary.author }) });
    if (!res.ok) throw new Error('Stream failed: ' + res.status);
    if ((res.headers.get('content-type') || '').includes('application/json')) {
      const j = await res.json();
      try { audioContext.close(); } catch (ex) { /* ignore */ }
      streamingAudioContext = null; streamingSources = [];
      if (j.url) { setAudioState('cached'); playSingleAudio(j.url, null); return; }
      throw new Error('No audio');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const msg = JSON.parse(line.slice(6));
          if (msg.mp3) await scheduleChunk(msg.mp3);
          if (msg.done) {
            setAudioState('cached');
            if (streamingSources.length) {
              const last = streamingSources[streamingSources.length - 1];
              last.onended = () => {
                try { audioContext.close(); } catch (e) { /* ignore */ }
                streamingAudioContext = null; streamingSources = []; isPlaying = false;
                setPlayerState(false, 'Finished. Press play to replay');
                setAudioState('cached');
              };
            }
          }
        } catch (e) { /* ignore */ }
      }
    }
  } catch (e) {
    console.warn('TTS stream error:', e.message);
    try { audioContext.close(); } catch (ex) { /* ignore */ }
    streamingAudioContext = null; streamingSources = [];
    setAudioState('audio-prep');
    setPlayerState(false, 'Audio unavailable. Tap play to retry');
  }
}

function _attachAudioHandlers(blobUrl) {
  if (!audioEl) return;
  audioEl.addEventListener('timeupdate', updateScrubUI);
  audioEl.addEventListener('ended', () => {
    $('scrub-fill').style.width = '100%';
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    setPlayerState(false, 'Finished. Press play to replay');
    audioEl = null;
  });
  audioEl.addEventListener('error', e => {
    console.error('Audio error:', e.target.error);
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    audioEl = null;
    setPlayerState(false, 'Audio unavailable. Tap play to retry');
  });
}
function playSingleAudio(audioUrl, blobUrl) {
  audioEl = new Audio(audioUrl);
  audioEl.playbackRate = playbackRate;
  _attachAudioHandlers(blobUrl);
  const p = audioEl.play();
  if (p) p.catch(err => { console.warn('play() failed:', err.message); setPlayerState(false, 'Tap play to listen'); });
  setPlayerState(true, 'Now playing');
  initScrubEvents();
  if (currentSummary) registerMediaSession(currentSummary.title, currentSummary.author);
}
function togglePlay() {
  if (!currentSummary) return;
  if (isPlaying) { pauseAudio(); return; }
  if (streamingAudioContext && streamingAudioContext.state === 'suspended') { resumeAudio(); return; }
  if (audioEl && audioEl.paused && audioEl.src) { resumeAudio(); return; }
  startTTS();
}

// ── Send to Kindle, EPUB, Print ───────────────────────────────────────────────
function showKindleModal() {
  if (!currentSummary) return;
  const m = KUI.modal(
    '<h3>Send to Kindle</h3>' +
    '<p class="sub">Enter your Kindle email address. You will find it in your Amazon account under <b>Manage Your Content and Devices</b>. First add <b>kindle@kernlbooks.com</b> to your approved senders.</p>' +
    '<label class="label" for="kindle-email-input">Kindle email</label>' +
    '<input class="input" id="kindle-email-input" type="email" placeholder="yourname@kindle.com" autocomplete="email" inputmode="email">' +
    '<div class="note" id="kindle-status" hidden style="margin-top:14px"></div>' +
    '<div class="modal-actions" style="justify-content:space-between">' +
      '<button class="btn" id="kindle-epub" type="button"><span data-icon="download"></span>Download EPUB</button>' +
      '<span class="row"><button class="btn" data-cancel type="button">Cancel</button><button class="btn primary" id="kindle-send-btn" type="button">Send</button></span>' +
    '</div>'
  );
  m.el.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.getAttribute('data-icon')); el.style.display = 'inline-flex'; });
  m.el.querySelector('[data-cancel]').onclick = m.close;
  m.el.querySelector('#kindle-epub').onclick = downloadEpub;
  const input = m.el.querySelector('#kindle-email-input');
  const status = m.el.querySelector('#kindle-status');
  const btn = m.el.querySelector('#kindle-send-btn');
  const say = (msg, kind) => { status.hidden = false; status.className = 'note' + (kind ? ' ' + kind : ''); status.textContent = msg; };
  async function send() {
    const email = input.value.trim();
    if (!email || !email.includes('@')) { say('Please enter a valid Kindle email address.', 'err'); return; }
    btn.disabled = true; btn.textContent = 'Sending…';
    say('Making the EPUB and sending it…');
    try {
      const res = await fetch('/api/send-to-kindle', { method: 'POST', headers: await apiHeaders(), body: JSON.stringify({ title: currentSummary.title, author: currentSummary.author, kindleEmail: email }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Send failed');
      say('Sent. Check your Kindle in a few minutes.', 'ok');
      btn.textContent = 'Sent';
      setTimeout(m.close, 2500);
    } catch (err) {
      say('Could not send: ' + err.message, 'err');
      btn.disabled = false; btn.textContent = 'Send';
    }
  }
  btn.onclick = send;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}
async function downloadEpub() {
  if (!currentSummary) return;
  try { if (typeof JSZip === 'undefined') await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'); }
  catch (e) { toast('Could not prepare the EPUB. Check your connection and try again.', 'err'); return; }
  const id = 'kernl-' + Date.now();
  const t = esc(currentSummary.title), a = esc(currentSummary.author);
  const body = currentSummary.html.replace(/<br>/g, '<br/>').replace(/<hr>/g, '<hr/>');
  const contentHtml = '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><head><title>' + t + '</title><style>body{font-family:Georgia,serif;font-size:1em;line-height:1.75;margin:1.5em 2em}h1{font-size:1.8em;margin-bottom:.2em}.byline{font-style:italic;color:#777;margin-bottom:2em}h2{font-size:1.05em;font-weight:bold;margin:1.8em 0 .5em;padding-bottom:5px;border-bottom:1px solid #ddd;color:#8B4513}p{margin:0 0 .9em;text-align:justify}.footer{margin-top:3em;font-size:.8em;color:#aaa;font-style:italic}</style></head><body><h1>' + t + '</h1><div class="byline">by ' + a + ' — KERNL Summary</div>' + body + '<div class="footer">Generated by KERNL — for the curious</div></body></html>';
  const opf = '<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bid" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>' + t + ' — KERNL</dc:title><dc:creator>' + a + '</dc:creator><dc:language>en</dc:language><dc:identifier id="bid">' + id + '</dc:identifier></metadata><manifest><item id="c" href="content.html" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="c"/></spine></package>';
  const ncx = '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="' + id + '"/></head><docTitle><text>' + t + '</text></docTitle><navMap><navPoint id="n1" playOrder="1"><navLabel><text>Summary</text></navLabel><content src="content.html"/></navPoint></navMap></ncx>';
  const container = '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.folder('META-INF').file('container.xml', container);
  const oebps = zip.folder('OEBPS');
  oebps.file('content.opf', opf); oebps.file('toc.ncx', ncx); oebps.file('content.html', contentHtml);
  const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE' });
  triggerDownload(blob, safe(currentSummary.title) + '_KERNL.epub');
}

function printSummary() {
  if (!currentSummary) return;
  const words = currentSummary.words || [];
  const wordsOpen = $('words').open;
  let wordsSection = '';
  if (wordsOpen && words.length) {
    const rows = words.map(w => '<tr><td style="font-weight:bold;color:#8B4513;padding:5pt 10pt 5pt 0;vertical-align:top;width:120pt">' + esc(w.word) + '</td><td style="padding:5pt 0;color:#444;line-height:1.5">' + esc(w.definition) + '</td></tr>').join('');
    wordsSection = '<div style="margin-top:2em;border-top:1pt solid #ddd;padding-top:1em"><h2 style="font-size:13pt;font-weight:bold;color:#8B4513;margin-bottom:0.75em">Mega Words</h2><table style="width:100%;border-collapse:collapse;font-family:Georgia,serif;font-size:10pt">' + rows + '</table></div>';
  }
  const w = window.open('', '_blank');
  if (!w) { toast('Please allow pop-ups for kernlbooks.com to print.', 'err'); return; }
  const buyUrl = makeAmazonUrl(currentSummary.title, currentSummary.author).replace(/"/g, '%22');
  w.document.write('<!DOCTYPE html><html><head><title>' + esc(currentSummary.title) + ' — KERNL</title><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script><style>body{font-family:Georgia,serif;font-size:11pt;line-height:1.7;margin:2cm;color:#000}h1{font-size:18pt;margin-bottom:4pt}.byline{font-style:italic;color:#555;margin-bottom:1.5em}h2{font-size:11pt;font-weight:bold;margin-top:18pt;padding-bottom:4pt;border-bottom:1pt solid #ddd;color:#8B4513}p{margin:0 0 8pt}.footer{margin-top:2em;font-size:8pt;color:#aaa;font-style:italic;border-top:1pt solid #ddd;padding-top:8pt}.print-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.5em}.print-header-left{flex:1}.qr-block{text-align:center;font-size:8pt;color:#888;flex-shrink:0;margin-left:2em}#qr-code{margin-bottom:4pt}<\/style><\/head><body><div class="print-header"><div class="print-header-left"><h1>' + esc(currentSummary.title) + '<\/h1><div class="byline">by ' + esc(currentSummary.author) + ' — KERNL Summary<\/div><\/div><div class="qr-block"><div id="qr-code"><\/div>Scan to buy this book<\/div><\/div>' + currentSummary.html + wordsSection + '<div class="footer">Generated by KERNL — for the curious<\/div><script>new QRCode(document.getElementById("qr-code"),{text:"' + buyUrl + '",width:100,height:100,colorDark:"#000000",colorLight:"#ffffff"});<\/script><\/body><\/html>');
  w.document.close();
  setTimeout(() => w.print(), 800);
}
function triggerDownload(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 1000);
}

// ── Pro: save / email / WhatsApp the audio ────────────────────────────────────
let _waFile = null; // { title, file } once the MP3 has been fetched for sharing
async function _audioShare(action) {
  if (!currentSummary) return null;
  const res = await fetch('/api/share-audio', { method: 'POST', headers: await apiHeaders(), body: JSON.stringify({ title: currentSummary.title, author: currentSummary.author, action }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { toast(data.error || 'Could not do that. Try again.', 'err'); return null; }
  return data;
}
async function saveAudio() {
  const d = await _audioShare('link');
  if (d) { const a = document.createElement('a'); a.href = d.downloadUrl; a.download = d.name; document.body.appendChild(a); a.click(); a.remove(); }
}
async function emailAudio() {
  const d = await _audioShare('email');
  if (d && d.sent) toast('Sent to ' + d.to + '. If it is not in your inbox, check Junk.', 'ok', 6000);
}
function _canShareFiles() {
  // Phones and tablets only: the Mac/PC share menu has no WhatsApp, so desktops use download + WhatsApp Web instead.
  if (!(navigator.maxTouchPoints > 1)) return false;
  try { return !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'a.mp3', { type: 'audio/mpeg' })] })); } catch (e) { return false; }
}
async function whatsappAudio() {
  if (!currentSummary) return;
  const btn = $('wa-audio-btn'), label = $('wa-label');
  // Step 2 (phone): the file is ready, so this tap opens the share sheet.
  if (_waFile && _waFile.title === currentSummary.title) {
    const f = _waFile.file; _waFile = null; label.textContent = 'WhatsApp';
    try { await navigator.share({ files: [f], title: currentSummary.title + ' — KERNL audio' }); }
    catch (e) { if (e && e.name !== 'AbortError') toast('Sharing failed. Use Save audio, then attach the file in WhatsApp.', 'err'); }
    return;
  }
  const d = await _audioShare('link');
  if (!d) return;
  if (!_canShareFiles()) {
    // Desktop browsers can't attach files to WhatsApp: download it and open WhatsApp Web to attach by hand.
    const a = document.createElement('a'); a.href = d.downloadUrl; a.download = d.name; document.body.appendChild(a); a.click(); a.remove();
    window.open('https://web.whatsapp.com/', '_blank', 'noopener');
    return;
  }
  // Step 1 (phone): fetch the MP3, then ask for a second tap (phones only allow sharing straight after a tap).
  label.textContent = 'Preparing…'; btn.disabled = true;
  try {
    const r = await fetch(d.downloadUrl);
    if (!r.ok) throw new Error('fetch failed');
    const blob = await r.blob();
    _waFile = { title: currentSummary.title, file: new File([blob], d.name, { type: blob.type || 'audio/mpeg' }) };
    label.textContent = 'Tap again to share';
  } catch (e) {
    label.textContent = 'WhatsApp'; toast('Could not prepare the audio. Try again.', 'err');
  }
  btn.disabled = false;
}

// ── Pro: summarise a book that is not in the library yet ──────────────────────
function openNewBookModal(prefillTitle) {
  const m = KUI.modal(
    '<h3>Summarise a new book</h3>' +
    '<p class="sub">This writes a fresh summary and uses one of your ' + LIMITS.pro + ' summaries.</p>' +
    '<label class="label" for="nb-title">Book title</label>' +
    '<input class="input" id="nb-title" autocomplete="off" placeholder="e.g. Papillon">' +
    '<div class="suggest" id="nb-suggest" hidden></div>' +
    '<div style="height:14px"></div>' +
    '<label class="label" for="nb-author">Author</label>' +
    '<input class="input" id="nb-author" autocomplete="off" placeholder="e.g. Henri Charrière">' +
    '<div class="note warn" id="nb-warn" hidden style="margin-top:14px"></div>' +
    '<div class="modal-actions"><button class="btn" data-cancel type="button">Cancel</button><button class="btn primary" id="nb-go" type="button">Generate summary</button></div>'
  );
  const titleIn = m.el.querySelector('#nb-title'), authorIn = m.el.querySelector('#nb-author');
  const sugg = m.el.querySelector('#nb-suggest'), warn = m.el.querySelector('#nb-warn'), go = m.el.querySelector('#nb-go');
  m.el.querySelector('[data-cancel]').onclick = m.close;
  if (prefillTitle) titleIn.value = prefillTitle;
  let acknowledged = false, timer = null;

  titleIn.addEventListener('input', () => {
    acknowledged = false; warn.hidden = true; go.textContent = 'Generate summary';
    clearTimeout(timer);
    const q = titleIn.value.trim();
    if (q.length < 3) { sugg.hidden = true; return; }
    timer = setTimeout(async () => {
      try {
        const res = await fetch('https://openlibrary.org/search.json?title=' + encodeURIComponent(q) + '&limit=6&fields=title,author_name,first_publish_year');
        const data = await res.json();
        const rows = (data.docs || []).filter(d => d.title && d.author_name && d.author_name.length).slice(0, 5);
        if (!rows.length || titleIn.value.trim() !== q) { sugg.hidden = true; return; }
        sugg.innerHTML = rows.map(d => '<button type="button" data-t="' + esc(d.title) + '" data-a="' + esc(d.author_name[0]) + '"><b>' + esc(d.title) + '</b><span>' + esc(d.author_name[0]) + (d.first_publish_year ? ' · ' + d.first_publish_year : '') + '</span></button>').join('');
        sugg.hidden = false;
      } catch (e) { sugg.hidden = true; }
    }, 300);
  });
  authorIn.addEventListener('input', () => { acknowledged = false; warn.hidden = true; go.textContent = 'Generate summary'; });
  sugg.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    titleIn.value = b.dataset.t; authorIn.value = b.dataset.a; sugg.hidden = true; acknowledged = true;
  });

  async function submit() {
    const title = titleIn.value.trim(), author = authorIn.value.trim();
    warn.hidden = true;
    if (!title) { titleIn.focus(); return; }
    // Already in the library? Open it, no new summary needed.
    const existing = findInLibrary(title);
    if (existing) { m.close(); openSummary(existing.title, existing.author || author); return; }
    if (!author || /^unknown/i.test(author)) { warn.hidden = false; warn.textContent = 'Please enter the author’s name. A summary cannot be written without one.'; authorIn.focus(); return; }
    if (!acknowledged) {
      go.disabled = true; go.textContent = 'Checking…';
      let found = true;
      try {
        const res = await fetch('https://openlibrary.org/search.json?title=' + encodeURIComponent(title) + '&author=' + encodeURIComponent(author) + '&limit=3&fields=title,author_name', { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const data = await res.json();
          found = !!(data.docs && data.docs.some(d => d.title && d.title.toLowerCase().includes(title.toLowerCase().slice(0, 15))));
        }
      } catch (e) { found = true; } // could not check (timeout, offline): do not block
      go.disabled = false;
      if (!found) {
        acknowledged = true;
        warn.hidden = false;
        warn.textContent = 'We could not find this book in Open Library. Generating anyway may produce an inaccurate summary. Carry on only if the title and author are right.';
        go.textContent = 'Generate anyway';
        return;
      }
    }
    m.close();
    openSummary(title, author, { isNew: true });
  }
  go.onclick = submit;
  [titleIn, authorIn].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); }));
}

// ── Wire up ───────────────────────────────────────────────────────────────────
function wire() {
  KUI.popover($('acct-btn'), $('acct-menu'));
  $('menu-signout').addEventListener('click', handleSignOut);
  $('reader-close').addEventListener('click', closeReader);
  $('reader').addEventListener('scroll', onReaderScroll, { passive: true });
  $('genre').addEventListener('scroll', onGenreScroll, { passive: true });
  $('play-btn').addEventListener('click', togglePlay);
  $('mini-play').addEventListener('click', togglePlay);
  $('mini-up').addEventListener('click', () => $('reader').scrollTo({ top: 0, behavior: 'smooth' }));
  $('mini-track').addEventListener('click', e => {
    if (!audioEl || !audioEl.duration) return;
    const r = $('mini-track').getBoundingClientRect();
    audioEl.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * audioEl.duration;
    updateScrubUI();
  });
  $('speed-btn').addEventListener('click', cycleSpeed);
  $('skip-back').addEventListener('click', () => skipAudio(-10));
  $('skip-fwd').addEventListener('click', () => skipAudio(10));
  $('send-kindle-btn').addEventListener('click', showKindleModal);
  $('print-btn').addEventListener('click', printSummary);
  $('save-audio-btn').addEventListener('click', saveAudio);
  $('email-audio-btn').addEventListener('click', emailAudio);
  $('wa-audio-btn').addEventListener('click', whatsappAudio);
  wireLibrary();
  initScrubEvents();
  resetScrubUI();
  setAudioState('idle');
}
try { localStorage.removeItem('kernl_v2'); } catch (e) { /* old local summary cache: the server is the only source of truth now */ }
wire();
initAuth();
