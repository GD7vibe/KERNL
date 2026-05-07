const STORAGE_KEY = 'kernl_v2'; const AMAZON_TAG = 'gd7vibe-21';
const SUPABASE_URL = 'https://peebgzfufyklxzdfnesc.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlZWJnemZ1ZnlrbHh6ZGZuZXNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxMjIwNDEsImV4cCI6MjA5MDY5ODA0MX0.TXg5ztQsoGvE5j49GRRtaNdTIVM2jS1-LmMNzu7YA5g';

let currentVoice = 'female'; let currentSummary = null; let isPlaying = false; let audioEl = null; let playbackRate = 1; let isGenerating = false; let streamingAudioContext = null; let streamingSources = []; let autocompleteTimer = null;

// ── Auth state ────────────────────────────────────────────────────────────────
let _sbClient = null;
let _currentUser = null;
let _userProfile = null; // { tier, downloads_used, downloads_reset }

function getSB() {
  if (!_sbClient) _sbClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _sbClient;
}

async function initAuth() {
  const sb = getSB();
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    // Not logged in — redirect to login
    window.location.href = '/login.html';
    return;
  }
  _currentUser = session.user;

  // Load profile
  const { data: profile } = await sb.from('profiles').select('*').eq('id', _currentUser.id).single();
  _userProfile = profile || { tier: 'free', downloads_used: 0, downloads_reset: null };

  renderUserBar();
  loadLibrary();

  // Check URL params — auto-load a book if passed from account page
  const params = new URLSearchParams(window.location.search);
  const autoTitle = params.get('title');
  const autoAuthor = params.get('author');
  if (autoTitle) {
    document.getElementById('book-input').value = autoTitle;
    if (autoAuthor) document.getElementById('author-input').value = autoAuthor;
    handleGenerate();
  }
}

function renderUserBar() {
  if (!_currentUser) return;
  const bar = document.getElementById('user-bar');
  const tier = _userProfile.tier || 'free';
  const used = _userProfile.downloads_used || 0;
  const limit = tier === 'pro' ? 200 : 20;
  const remaining = Math.max(0, limit - used);
  const pct = Math.min(100, (used / limit) * 100);

  // Colour: green up to 50%, amber 50-80%, red 80%+
  const colour = pct >= 80 ? '#8B1A1A' : pct >= 50 ? '#c47a3a' : '#2d6a4f';

  bar.style.display = 'flex';
  document.getElementById('user-email-display').textContent = _currentUser.email;
  document.getElementById('user-usage-display').innerHTML =
    `<span style="font-weight:600;color:${colour}">${remaining}</span> of ${limit} summaries remaining`;

  const badge = document.getElementById('user-tier-badge');
  badge.textContent = tier === 'pro' ? '★ Pro' : 'Free';
  badge.className = 'user-tier ' + tier;

  document.getElementById('upgrade-btn-wrap').innerHTML = tier === 'free'
    ? '<a href="/upgrade.html" class="user-nav-btn upgrade">Upgrade to Pro</a>'
    : '';

  // Show/hide limit bar
  const limitBar = document.getElementById('limit-bar');
  if (remaining <= 0) limitBar.classList.add('show');
  else limitBar.classList.remove('show');
}

async function handleSignOut() {
  await getSB().auth.signOut();
  window.location.href = '/login.html';
}

// ── Download / save-to-library ────────────────────────────────────────────────
async function saveToLibrary() {
  if (!currentSummary || !_currentUser) return;
  const btn = document.getElementById('save-library-btn');
  const tier = _userProfile.tier || 'free';
  const limit = tier === 'pro' ? 200 : 20;
  const used = _userProfile.downloads_used || 0;

  if (used >= limit) {
    setError('Download limit reached. Upgrade to Pro for 200 books per year.');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Saving\u2026';

  try {
    const sb = getSB();

    // Find summary ID
    const { data: rows } = await sb
      .from('summaries')
      .select('id')
      .ilike('title', currentSummary.title)
      .limit(1);

    if (!rows || !rows.length) throw new Error('Book not found in library');
    const summaryId = rows[0].id;

    // Insert into user_library (UNIQUE constraint handles duplicates gracefully)
    const { error: insertErr } = await sb.from('user_library').upsert({
      user_id: _currentUser.id,
      summary_id: summaryId,
      voice: currentVoice,
      language: 'en'
    }, { onConflict: 'user_id,summary_id,voice,language', ignoreDuplicates: true });

    if (insertErr) throw new Error(insertErr.message);

    // Increment download counter
    const newUsed = used + 1;
    await sb.from('profiles').update({ downloads_used: newUsed }).eq('id', _currentUser.id);
    _userProfile.downloads_used = newUsed;
    renderUserBar();

    btn.textContent = '\u2713 Saved to My Library';
    btn.classList.add('saved');
    btn.disabled = false;

  } catch(e) {
    btn.textContent = '+ Save to My Library';
    btn.disabled = false;
    setError('Could not save: ' + e.message);
  }
}

// ── Audio visibility (free tier only gets cached audio) ───────────────────────
async function checkAudioAvailability() {
  if (!currentSummary) return;
  const tier = _userProfile ? (_userProfile.tier || 'free') : 'free';
  const playBtn = document.getElementById('play-btn');
  const sub = document.getElementById('player-sub');

  if (tier === 'pro') {
    // Pro — always show play button, generate on demand
    ungreyPlayBtn();
    return;
  }

  // Free — only show play if audio already cached
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice: currentVoice, title: currentSummary.title, author: currentSummary.author, checkOnly: true })
    });
    if (res.ok) {
      const data = await res.json();
      if (data.url) {
        ungreyPlayBtn();
      } else {
        greyPlayBtn();
        if (sub) sub.textContent = 'Audio available on Pro';
      }
    } else {
      greyPlayBtn();
      if (sub) sub.textContent = 'Audio available on Pro';
    }
  } catch(e) {
    greyPlayBtn();
    if (sub) sub.textContent = 'Audio available on Pro';
  }
}

// ── Dark mode ─────────────────────────────────────────────────────────────────
function toggleDark() { const isDark = document.documentElement.classList.toggle('dark'); localStorage.setItem('kernl_dark', isDark ? '1' : '0'); document.getElementById('dark-icon').textContent = isDark ? '\u2600\uFE0F' : '\uD83C\uDF19'; document.getElementById('dark-label').textContent = isDark ? 'Light' : 'Dark'; }
function initDark() { const saved = localStorage.getItem('kernl_dark'); const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches; const isDark = saved !== null ? saved === '1' : prefersDark; if (isDark) { document.documentElement.classList.add('dark'); document.getElementById('dark-icon').textContent = '\u2600\uFE0F'; document.getElementById('dark-label').textContent = 'Light'; } }

// ── Autocomplete ──────────────────────────────────────────────────────────────
async function fetchBookSuggestions(query) { if (!query || query.length < 3) { hideDropdown(); return; } try { const res = await fetch(`https://openlibrary.org/search.json?title=${encodeURIComponent(query)}&limit=6&fields=title,author_name,first_publish_year`); const data = await res.json(); if (!data.docs || !data.docs.length) { hideDropdown(); return; } const results = data.docs.filter(d => d.title && d.author_name && d.author_name.length).slice(0, 5).map(d => ({ title: d.title, author: d.author_name[0], year: d.first_publish_year || '' })); if (results.length) showDropdown(results); else hideDropdown(); } catch (e) { hideDropdown(); } }
function showDropdown(results) { let dropdown = document.getElementById('book-dropdown'); if (!dropdown) { dropdown = document.createElement('div'); dropdown.id = 'book-dropdown'; dropdown.className = 'book-dropdown'; document.getElementById('book-input').parentNode.appendChild(dropdown); } dropdown.innerHTML = results.map((r, i) => `<div class="dropdown-item" onmousedown="selectBook(${i})" data-title="${esc(r.title)}" data-author="${esc(r.author)}"><div class="dropdown-title">${esc(r.title)}</div><div class="dropdown-author">${esc(r.author)}${r.year ? ' · ' + r.year : ''}</div></div>`).join(''); dropdown.style.display = 'block'; }
function hideDropdown() { const dropdown = document.getElementById('book-dropdown'); if (dropdown) dropdown.style.display = 'none'; }
function selectBook(idx) { const dropdown = document.getElementById('book-dropdown'); if (!dropdown) return; const items = dropdown.querySelectorAll('.dropdown-item'); if (!items[idx]) return; const title = items[idx].getAttribute('data-title'); const author = items[idx].getAttribute('data-author'); document.getElementById('book-input').value = title; const authorInput = document.getElementById('author-input'); authorInput.value = author; authorInput.classList.add('author-autofilled'); setTimeout(() => authorInput.classList.remove('author-autofilled'), 1500); hideDropdown(); }

// ── Archive ───────────────────────────────────────────────────────────────────
function getArchive() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch (e) { return []; } }
function saveEntry(entry) { const arc = getArchive(); const key = norm(entry.title) + '||' + norm(entry.author); const idx = arc.findIndex(e => norm(e.title) + '||' + norm(e.author) === key); if (idx >= 0) arc[idx] = entry; else arc.unshift(entry); localStorage.setItem(STORAGE_KEY, JSON.stringify(arc.slice(0, 300))); }
function clearArchive() { if (!confirm('Clear your entire KERNL library? This cannot be undone.')) return; localStorage.removeItem(STORAGE_KEY); renderArchive(); }
function renderArchive() { const arc = getArchive(); const container = document.getElementById('archive-container'); const countEl = document.getElementById('archive-count'); const clearBtn = document.getElementById('clear-btn'); countEl.textContent = arc.length + ' summar' + (arc.length === 1 ? 'y' : 'ies'); clearBtn.style.display = arc.length ? 'inline' : 'none'; if (!arc.length) { container.innerHTML = '<div class="archive-empty">Your library is empty \u2014 summarise a book above to begin.</div>'; return; } container.innerHTML = '<div class="archive-grid">' + arc.map((e, i) => `<div class="archive-item" onclick="loadEntry(${i})"><div class="archive-book-title">${esc(e.title)}</div><div class="archive-book-author">by ${esc(e.author)}</div><div class="archive-footer"><div class="archive-date">${fmtDate(e.savedAt)}</div><div style="display:flex;gap:6px;align-items:center"><div class="archive-chip">Archived</div></div></div></div>`).join('') + '</div>'; }
function loadEntry(idx) { const e = getArchive()[idx]; if (e) displaySummary(e.title, e.author, e.html, e.plain, e.words || []); }

// ── Utilities ─────────────────────────────────────────────────────────────────
function norm(s) { return String(s || '').toLowerCase().trim().replace(/\s+/g, ' '); }
function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtDate(ts) { if (!ts) return ''; return new Date(ts).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }); }
function fmtTime(secs) { if (!isFinite(secs) || secs < 0) secs = 0; const m = Math.floor(secs/60); const s = Math.floor(secs%60); return m + ':' + String(s).padStart(2,'0'); }
function safe(s) { return String(s).replace(/[^a-z0-9]/gi,'_').replace(/_+/g,'_').slice(0,60); }
function countWords(plain) { return plain.split(/\s+/).filter(w => w.length > 0).length; }
function makeAmazonUrl(title, author) { return `https://www.amazon.co.uk/s?k=${encodeURIComponent(title + (author ? ' ' + author : ''))}&tag=${AMAZON_TAG}`; }
function setStatus(msg, show) { const bar = document.getElementById('status-bar'); document.getElementById('status-text').textContent = msg; bar.classList.toggle('show', !!show); }
function setError(msg) { const bar = document.getElementById('error-bar'); bar.textContent = msg; bar.classList.toggle('show', !!msg); }
function setSpeed(rate) { playbackRate = rate; document.querySelectorAll('.speed-btn').forEach(btn => { btn.classList.toggle('active', parseFloat(btn.dataset.rate) === rate); }); if (audioEl) audioEl.playbackRate = rate; }

// ── Player controls ───────────────────────────────────────────────────────────
function lockStreamingControls() { ['scrub-row','scrub-track'].forEach(id => { const el = document.getElementById(id); if (el) { el.style.opacity = '0.3'; el.style.pointerEvents = 'none'; } }); document.querySelectorAll('.skip-btn').forEach(btn => { btn.style.opacity = '0.3'; btn.style.pointerEvents = 'none'; }); document.querySelectorAll('.speed-btn').forEach(btn => { if (parseFloat(btn.dataset.rate) !== 1) { btn.style.opacity = '0.3'; btn.style.pointerEvents = 'none'; } }); }
function unlockStreamingControls() { ['scrub-row','scrub-track'].forEach(id => { const el = document.getElementById(id); if (el) { el.style.opacity = ''; el.style.pointerEvents = ''; } }); document.querySelectorAll('.skip-btn').forEach(btn => { btn.style.opacity = ''; btn.style.pointerEvents = ''; }); document.querySelectorAll('.speed-btn').forEach(btn => { btn.style.opacity = ''; btn.style.pointerEvents = ''; }); }
function lockAllControls() { var ids = ['vbf', 'vbm', 'send-kindle-btn', 'play-btn']; ids.forEach(function(id) { var el = document.getElementById(id); if (el) { el.disabled = true; el.style.opacity = '0.35'; el.style.cursor = 'not-allowed'; el.style.pointerEvents = 'none'; } }); document.querySelectorAll('.speed-btn').forEach(function(btn) { btn.disabled = true; btn.style.opacity = '0.35'; btn.style.cursor = 'not-allowed'; btn.style.pointerEvents = 'none'; }); document.querySelectorAll('.skip-btn').forEach(function(btn) { btn.disabled = true; btn.style.opacity = '0.35'; btn.style.cursor = 'not-allowed'; btn.style.pointerEvents = 'none'; }); document.querySelectorAll('.btn-action').forEach(function(btn) { if (btn.getAttribute('onclick') === 'printSummary()') { btn.disabled = true; btn.style.opacity = '0.35'; btn.style.cursor = 'not-allowed'; btn.style.pointerEvents = 'none'; } }); }
function unlockAllControls(keepPlayGreyed) { var ids = ['vbf', 'vbm', 'send-kindle-btn', 'play-btn']; ids.forEach(function(id) { var el = document.getElementById(id); if (el) { el.disabled = false; el.style.opacity = ''; el.style.cursor = ''; el.style.pointerEvents = ''; } }); document.querySelectorAll('.speed-btn').forEach(function(btn) { btn.disabled = false; btn.style.opacity = ''; btn.style.cursor = ''; btn.style.pointerEvents = ''; }); document.querySelectorAll('.skip-btn').forEach(function(btn) { btn.disabled = false; btn.style.opacity = ''; btn.style.cursor = ''; btn.style.pointerEvents = ''; }); document.querySelectorAll('.btn-action').forEach(function(btn) { if (btn.getAttribute('onclick') === 'printSummary()') { btn.disabled = false; btn.style.opacity = ''; btn.style.cursor = ''; btn.style.pointerEvents = ''; } }); }
function lockVoiceButtons() { ['vbf','vbm'].forEach(id => { const el = document.getElementById(id); if (el) { el.disabled = true; el.style.opacity = '0.4'; el.style.cursor = 'not-allowed'; } }); }
function unlockVoiceButtons() { ['vbf','vbm'].forEach(id => { const el = document.getElementById(id); if (el) { el.disabled = false; el.style.opacity = ''; el.style.cursor = ''; } }); }
function setPlayerState(playing, subText) { isPlaying = playing; const icon = document.getElementById('play-icon'); icon.innerHTML = playing ? '<rect x="5" y="3" width="5" height="18"/><rect x="14" y="3" width="5" height="18"/>' : '<polygon points="6,3 20,12 6,21"/>'; if (subText) document.getElementById('player-sub').textContent = subText; setScrubActive(playing); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'; }
function setScrubActive(active) { const row = document.getElementById('scrub-row'); const btn = document.getElementById('play-btn'); const sub = document.getElementById('player-sub'); if (row) row.classList.toggle('active', active); if (btn) btn.classList.toggle('playing', active); if (sub) sub.classList.toggle('playing', active); }
function resetScrubUI() { const fill = document.getElementById('scrub-fill'); const thumb = document.getElementById('scrub-thumb'); if (fill) { fill.style.width = '0%'; if (thumb) thumb.style.left = '0%'; } const el = document.getElementById('scrub-elapsed'); const re = document.getElementById('scrub-remaining'); if (el) el.textContent = '0:00'; if (re) re.textContent = '\u22120:00'; setScrubActive(false); }
function updateScrubUI() { if (!audioEl || !audioEl.duration) return; const pct = (audioEl.currentTime / audioEl.duration) * 100; const fill = document.getElementById('scrub-fill'); const thumb = document.getElementById('scrub-thumb'); if (fill) fill.style.width = pct + '%'; if (thumb) thumb.style.left = pct + '%'; const el = document.getElementById('scrub-elapsed'); const re = document.getElementById('scrub-remaining'); if (el) el.textContent = fmtTime(audioEl.currentTime); if (re) re.textContent = '\u2212' + fmtTime(audioEl.duration - audioEl.currentTime); }
function initScrubEvents() { const track = document.getElementById('scrub-track'); if (!track || track._scrubInit) return; track._scrubInit = true; let dragging = false; function seekTo(e) { if (!audioEl || !audioEl.duration) return; const rect = track.getBoundingClientRect(); const clientX = e.touches ? e.touches[0].clientX : e.clientX; const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)); audioEl.currentTime = pct * audioEl.duration; updateScrubUI(); } track.addEventListener('mousedown', e => { dragging = true; track.classList.add('dragging'); seekTo(e); }); track.addEventListener('touchstart', e => { dragging = true; track.classList.add('dragging'); seekTo(e); }, { passive: true }); document.addEventListener('mousemove', e => { if (dragging) seekTo(e); }); document.addEventListener('touchmove', e => { if (dragging) seekTo(e); }, { passive: true }); document.addEventListener('mouseup', () => { dragging = false; track.classList.remove('dragging'); }); document.addEventListener('touchend', () => { dragging = false; track.classList.remove('dragging'); }); }
function skipAudio(secs) { if (!audioEl) return; audioEl.currentTime = Math.max(0, Math.min(audioEl.duration || 0, audioEl.currentTime + secs)); updateScrubUI(); }
function registerMediaSession(title, author) { if (!('mediaSession' in navigator)) return; navigator.mediaSession.metadata = new MediaMetadata({ title: title || 'KERNL Summary', artist: author || '', album: 'KERNL \u2014 for the curious' }); navigator.mediaSession.setActionHandler('play', () => resumeAudio()); navigator.mediaSession.setActionHandler('pause', () => pauseAudio()); navigator.mediaSession.setActionHandler('stop', () => stopAudio()); navigator.mediaSession.setActionHandler('seekbackward', () => skipAudio(-10)); navigator.mediaSession.setActionHandler('seekforward', () => skipAudio(10)); }
function stopAudio() { if (audioEl) { try { audioEl.pause(); audioEl.src = ''; } catch(e) {} audioEl = null; } if (streamingSources && streamingSources.length > 0) { streamingSources.forEach(s => { try { s.stop(); } catch(e) {} }); streamingSources = []; } if (streamingAudioContext && streamingAudioContext.state !== 'closed') { try { streamingAudioContext.close(); } catch(e) {} streamingAudioContext = null; } unlockStreamingControls(); setPlayerState(false, null); resetScrubUI(); }
function pauseAudio() { if (audioEl && !audioEl.paused) audioEl.pause(); if (streamingAudioContext && streamingAudioContext.state === 'running') { streamingAudioContext.suspend(); } setPlayerState(false, 'Paused \u2014 press play to continue'); setScrubActive(false); }
function resumeAudio() { if (streamingAudioContext && streamingAudioContext.state === 'suspended') { streamingAudioContext.resume(); setPlayerState(true, (currentVoice === 'female' ? 'Female' : 'Male') + ' voice \u2014 now playing'); setScrubActive(true); return true; } if (audioEl && audioEl.paused && audioEl.src) { audioEl.play(); setPlayerState(true, (currentVoice === 'female' ? 'Female' : 'Male') + ' voice \u2014 now playing'); setScrubActive(true); return true; } return false; }
async function checkAudioCache() { if (!currentSummary) return null; try { const res = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voice: currentVoice, title: currentSummary.title, author: currentSummary.author }) }); if (res.ok) { const data = await res.json(); return data.url || null; } } catch (e) { console.warn('Cache check failed', e); } return null; }
function isSafari() { return /^((?!chrome|android).)*safari/i.test(navigator.userAgent); }
function greyPlayBtn() { const playBtn = document.getElementById('play-btn'); if (playBtn) { playBtn.disabled = true; playBtn.style.opacity = '0.45'; playBtn.style.cursor = 'not-allowed'; playBtn.style.pointerEvents = 'none'; } }
function ungreyPlayBtn() { const playBtn = document.getElementById('play-btn'); if (playBtn) { playBtn.disabled = false; playBtn.style.opacity = ''; playBtn.style.cursor = ''; playBtn.style.pointerEvents = ''; } }

async function startTTS() {
  if (!currentSummary) return;

  // Free tier — only play if cached, never generate
  const tier = _userProfile ? (_userProfile.tier || 'free') : 'free';
  if (tier !== 'pro') {
    const cachedUrl = await checkAudioCache();
    if (cachedUrl) { playSingleAudio(cachedUrl, null); } else { greyPlayBtn(); document.getElementById('player-sub').textContent = 'Audio available on Pro'; }
    return;
  }

  lockVoiceButtons();
  lockStreamingControls();
  const cachedUrl = await checkAudioCache();
  if (cachedUrl) { unlockStreamingControls(); playSingleAudio(cachedUrl, null); return; }

  if (isSafari()) {
    unlockStreamingControls();
    const pollTitle = currentSummary.title; const pollAuthor = currentSummary.author; const pollVoice = currentVoice;
    let pollStopped = false;
    window._safariPollStop = function() { pollStopped = true; };
    function updateSub(msg) { const sub = document.getElementById('player-sub'); if (sub) sub.textContent = msg; }
    async function pollForAudio(attempt) {
      if (pollStopped) return;
      if (!currentSummary || currentSummary.title !== pollTitle) return;
      const elapsed = attempt * 5;
      updateSub('Audio preparing\u2026 ' + elapsed + 's');
      try {
        const res = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voice: pollVoice, title: pollTitle, author: pollAuthor }) });
        if (res.ok) { const data = await res.json(); if (data.url) { if (pollStopped) return; unlockVoiceButtons(); playSingleAudio(data.url, null); return; } }
      } catch(e) { console.warn('Poll error:', e.message); }
      if (attempt < 42) { setTimeout(() => pollForAudio(attempt + 1), 5000); } else { updateSub('Audio unavailable \u2014 tap to retry'); ungreyPlayBtn(); unlockVoiceButtons(); }
    }
    pollForAudio(1);
    return;
  }

  setPlayerState(true, 'Connecting\u2026');
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  let audioContext;
  try { audioContext = new AudioCtx(); if (audioContext.state === 'suspended') await audioContext.resume(); } catch (e) { console.warn('AudioContext failed:', e); unlockStreamingControls(); unlockVoiceButtons(); setPlayerState(false, 'Audio unavailable \u2014 tap to retry'); return; }
  streamingAudioContext = audioContext; streamingSources = [];
  let nextStartTime = audioContext.currentTime + 0.1; let started = false; let mp3Buffer = new Uint8Array(0);
  const scheduleChunk = async (base64chunk) => { const binary = atob(base64chunk); const newBytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i++) newBytes[i] = binary.charCodeAt(i); const combined = new Uint8Array(mp3Buffer.length + newBytes.length); combined.set(mp3Buffer); combined.set(newBytes, mp3Buffer.length); mp3Buffer = combined; try { const decoded = await audioContext.decodeAudioData(mp3Buffer.slice(0).buffer); const source = audioContext.createBufferSource(); source.buffer = decoded; source.playbackRate.value = playbackRate; source.connect(audioContext.destination); const when = Math.max(nextStartTime, audioContext.currentTime); source.start(when); streamingSources.push(source); nextStartTime = when + decoded.duration; mp3Buffer = new Uint8Array(0); if (!started) { started = true; setPlayerState(true, (currentVoice === 'female' ? 'Female' : 'Male') + ' voice \u2014 now playing'); registerMediaSession(currentSummary.title, currentSummary.author); initScrubEvents(); unlockStreamingControls(); } } catch (e) { /* not enough data yet */ } };
  try {
    const res = await fetch('/api/tts-stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: currentSummary.plain, voice: currentVoice, title: currentSummary.title, author: currentSummary.author }) });
    if (!res.ok) throw new Error('Stream failed: ' + res.status);
    const reader = res.body.getReader(); const decoder = new TextDecoder(); let sseBuffer = '';
    while (true) { const { done, value } = await reader.read(); if (done) break; sseBuffer += decoder.decode(value, { stream: true }); const lines = sseBuffer.split('\n'); sseBuffer = lines.pop(); for (const line of lines) { if (!line.startsWith('data: ')) continue; try { const msg = JSON.parse(line.slice(6)); if (msg.mp3) await scheduleChunk(msg.mp3); if (msg.done) { unlockStreamingControls(); if (streamingSources.length > 0) { const last = streamingSources[streamingSources.length - 1]; last.onended = () => { if (audioContext) { try { audioContext.close(); } catch(e) {} } streamingAudioContext = null; streamingSources = []; isPlaying = false; setPlayerState(false, 'Finished \u2014 press play to replay'); unlockVoiceButtons(); resetScrubUI(); }; } } } catch (e) { /* ignore */ } } }
  } catch (e) { console.warn('Chrome TTS stream error:', e.message); if (audioContext) { try { audioContext.close(); } catch(ex) {} } streamingAudioContext = null; streamingSources = []; unlockStreamingControls(); unlockVoiceButtons(); setPlayerState(false, 'Audio unavailable \u2014 tap to retry'); }
}

function _attachAudioHandlers(blobUrl) { if (!audioEl) return; audioEl.addEventListener('timeupdate', updateScrubUI); audioEl.addEventListener('ended', () => { const fill = document.getElementById('scrub-fill'); if (fill) fill.style.width = '100%'; if (blobUrl) URL.revokeObjectURL(blobUrl); setPlayerState(false, 'Finished \u2014 press play to replay'); setScrubActive(false); unlockVoiceButtons(); audioEl = null; }); audioEl.addEventListener('error', e => { console.error('Audio error:', e.target.error); if (blobUrl) URL.revokeObjectURL(blobUrl); audioEl = null; setPlayerState(false, 'Audio unavailable \u2014 tap to retry'); setScrubActive(false); unlockVoiceButtons(); }); }
function playSingleAudio(audioUrl, blobUrl) { audioEl = new Audio(audioUrl); audioEl.playbackRate = playbackRate; _attachAudioHandlers(blobUrl); const p = audioEl.play(); if (p) p.catch(err => { console.warn('play() failed:', err.message); setPlayerState(false, 'Tap play to listen'); unlockVoiceButtons(); }); setPlayerState(true, (currentVoice === 'female' ? 'Female' : 'Male') + ' voice \u2014 now playing'); setScrubActive(true); initScrubEvents(); if (currentSummary) registerMediaSession(currentSummary.title, currentSummary.author); }
function togglePlay() { if (!currentSummary) return; if (isPlaying) { pauseAudio(); return; } if (streamingAudioContext && streamingAudioContext.state === 'suspended') { resumeAudio(); return; } if (audioEl && audioEl.paused && audioEl.src) { resumeAudio(); return; } startTTS(); }
function setVoice(v) { currentVoice = v; document.getElementById('vbf').classList.toggle('active', v === 'female'); document.getElementById('vbm').classList.toggle('active', v === 'male'); const wasPlaying = isPlaying; stopAudio(); isPlaying = false; if (currentSummary) { document.getElementById('player-sub').textContent = v === 'female' ? 'Female voice \u2014 press play' : 'Male voice \u2014 press play'; if (wasPlaying) setTimeout(startTTS, 150); } }

// ── Generate ──────────────────────────────────────────────────────────────────
async function handleGenerate() {
  const title = document.getElementById('book-input').value.trim();
  const author = document.getElementById('author-input').value.trim();
  setError(''); hideDropdown();
  if (!title) { setError('Please enter a book title to continue.'); return; }

  const cached = getArchive().find(e => norm(e.title) === norm(title) && (!author || norm(e.author) === norm(author)));
  if (cached) { setStatus('Found in your library \u2014 loading instantly!', true); setTimeout(async () => { setStatus('', false); let words = cached.words || []; if (!words.length) { try { const r = await fetch('/api/get-summary?title=' + encodeURIComponent(cached.title) + '&author=' + encodeURIComponent(cached.author || '')); if (r.ok) { const d = await r.json(); if (d.words) { try { words = typeof d.words === 'string' ? JSON.parse(d.words) : d.words; } catch(e) {} } } } catch(e) {} } displaySummary(cached.title, cached.author, cached.html, cached.plain, words, cached.spoilers || false, true); }, 600); return; }

  document.getElementById('gen-btn').disabled = true;
  isGenerating = true;
  lockAllControls();
  setStatus('Generating summary \u2014 appearing shortly\u2026', true);

  try {
    const res = await fetch('/api/summarise', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, author }) });
    if (!res.ok) { const data = await res.json(); throw new Error(data.error || 'Error ' + res.status); }
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) { const data = await res.json(); const displayAuthor = author || data.author || 'Unknown author'; saveEntry({ title, author: displayAuthor, html: data.html, plain: data.plain, words: data.words || [], savedAt: Date.now() }); setStatus('', false); renderArchive(); displaySummary(title, displayAuthor, data.html, data.plain, data.words || [], false); return; }
    const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let streamingStarted = false; let finalData = null; let lastHtml = '';
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop(); for (const line of lines) { if (!line.startsWith('data: ')) continue; try { const msg = JSON.parse(line.slice(6).trim()); if (msg.error) throw new Error(msg.error); if (msg.done) { finalData = msg; continue; } if (msg.chunk) { lastHtml = msg.chunk; if (!streamingStarted) { streamingStarted = true; setStatus('', false); displaySummaryStreaming(title, author || 'Unknown author', msg.chunk); } else { updateStreamingBody(msg.chunk); } } } catch(e) { if (e.message && e.message !== 'Unexpected end of JSON input') throw e; } } }
    } catch (streamErr) { if (!streamingStarted) throw streamErr; console.warn('Stream dropped early:', streamErr.message); }
    const displayAuthor = author || 'Unknown author';
    if (finalData) {
      saveEntry({ title, author: displayAuthor, html: finalData.html, plain: finalData.plain, words: finalData.words || [], savedAt: Date.now() });
      renderArchive();
      displaySummary(title, displayAuthor, finalData.html, finalData.plain, finalData.words || [], false);
      fetch('/api/generate-audio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, author: displayAuthor, plain: finalData.plain, voice: currentVoice }) }).catch(e => console.warn('generate-audio fire-and-forget failed:', e.message));
    } else if (streamingStarted && lastHtml) {
      const plainText = lastHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      saveEntry({ title, author: displayAuthor, html: lastHtml, plain: plainText, words: [], savedAt: Date.now() });
      renderArchive();
      displaySummary(title, displayAuthor, lastHtml, plainText, [], false);
    }
  } catch (err) { setStatus('', false); setError('Could not generate summary: ' + err.message); }
  finally { document.getElementById('gen-btn').disabled = false; isGenerating = false; unlockAllControls(); }
}

// ── Display ───────────────────────────────────────────────────────────────────
function stripGenreLine(html) { return html.replace(/^GENRE:(FICTION|NONFICTION)\s*/i, '').replace(/^<p>GENRE:(FICTION|NONFICTION)<\/p>\s*/i, ''); }
function displaySummaryStreaming(title, author, htmlSoFar) { htmlSoFar = stripGenreLine(htmlSoFar); stopAudio(); currentSummary = { title, author, html: htmlSoFar, plain: '', words: [] }; document.getElementById('s-title').textContent = title; document.getElementById('s-author').textContent = 'by ' + author; document.getElementById('s-words').textContent = 'generating\u2026'; document.getElementById('summary-body').innerHTML = htmlSoFar; document.getElementById('player-title').textContent = title; document.getElementById('player-sub').textContent = (currentVoice === 'female' ? 'Female' : 'Male') + ' voice'; resetScrubUI(); document.getElementById('megan-words-section').style.display = 'none'; document.getElementById('summary-card').classList.add('show'); document.getElementById('summary-card').scrollIntoView({ behavior: 'smooth', block: 'start' }); if (isGenerating) lockAllControls(); }
function updateStreamingBody(htmlSoFar) { htmlSoFar = stripGenreLine(htmlSoFar); const body = document.getElementById('summary-body'); if (body) body.innerHTML = htmlSoFar; }
function renderMeganWords(words) { const section = document.getElementById('megan-words-section'); if (!words || !words.length) { section.style.display = 'none'; return; } const seen = new Set(); const uniqueWords = words.filter(w => { const key = w.word.toLowerCase().trim(); if (seen.has(key)) return false; seen.add(key); return true; }); section.style.display = 'block'; document.getElementById('megan-words-grid').innerHTML = uniqueWords.map(w => `<div class="megan-word-item"><div class="megan-word">${esc(w.word)}</div><div class="megan-definition">${esc(w.definition)}</div></div>`).join(''); }
function toggleMeganWords() { const grid = document.getElementById('megan-words-grid'); const arrow = document.getElementById('megan-arrow'); const isOpen = grid.classList.toggle('open'); arrow.style.transform = isOpen ? 'rotate(180deg)' : 'rotate(0deg)'; }

function displaySummary(title, author, html, plain, words, spoilers, fromArchive) {
  stopAudio();
  if (!isGenerating) unlockVoiceButtons();
  currentSummary = { title, author, html, plain, words, spoilers };
  const playBtn = document.getElementById('play-btn');
  if (playBtn && !isGenerating) { playBtn.disabled = false; playBtn.style.opacity = ''; playBtn.style.cursor = ''; playBtn.style.pointerEvents = ''; }
  document.getElementById('s-title').textContent = title;
  document.getElementById('s-author').textContent = 'by ' + author;
  document.getElementById('s-words').textContent = countWords(plain).toLocaleString() + ' words';
  document.getElementById('summary-body').innerHTML = html;
  const buyBtn = document.getElementById('buy-btn');
  buyBtn.href = makeAmazonUrl(title, author);
  const kindleBtn = document.getElementById('send-kindle-btn');
  if (kindleBtn) kindleBtn.onclick = showKindleModal;

  // Save to library button — only show for logged in Pro users (free shows but greyed if at limit)
  const saveBtn = document.getElementById('save-library-btn');
  if (saveBtn && _currentUser) {
    saveBtn.style.display = 'flex';
    saveBtn.classList.remove('saved');
    saveBtn.textContent = '+ Save to My Library';
    saveBtn.disabled = false;
  }

  document.getElementById('player-title').textContent = title;
  document.getElementById('player-sub').textContent = currentVoice === 'female' ? 'Female voice \u2014 press play' : 'Male voice \u2014 press play';
  resetScrubUI();
  const grid = document.getElementById('megan-words-grid'); const arrow = document.getElementById('megan-arrow');
  grid.classList.remove('open'); arrow.style.transform = 'rotate(0deg)';
  renderMeganWords(words);
  document.getElementById('summary-card').classList.add('show');
  document.getElementById('summary-card').scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Check audio availability based on tier
  checkAudioAvailability();
}

function closeSummary() { stopAudio(); unlockVoiceButtons(); document.getElementById('summary-card').classList.remove('show'); currentSummary = null; }

// ── Kindle / EPUB / Print (unchanged) ────────────────────────────────────────
function showKindleModal() { if (!currentSummary) return; const existing = document.getElementById('kindle-modal'); if (existing) existing.remove(); const modal = document.createElement('div'); modal.id = 'kindle-modal'; modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:1000;display:flex;align-items:center;justify-content:center;padding:1rem'; modal.innerHTML = '<div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:2rem;max-width:480px;width:100%;box-shadow:0 8px 40px rgba(0,0,0,0.3)"><h3 style="font-family:\'Playfair Display\',serif;font-size:1.2rem;color:var(--ink);margin-bottom:0.5rem">Send to Kindle</h3><p style="font-size:0.82rem;color:var(--muted);margin-bottom:1.25rem;line-height:1.5">Enter your Kindle email address. Find it in your Amazon account under <strong>Manage Your Content and Devices</strong>. First add <strong>kindle@kernlbooks.com</strong> to your approved senders.</p><input id="kindle-email-input" type="email" placeholder="yourname@kindle.com" style="width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--warm);color:var(--ink);font-family:\'DM Sans\',sans-serif;font-size:0.9rem;margin-bottom:1rem;box-sizing:border-box"><div style="display:flex;gap:10px;align-items:center;justify-content:space-between"><button onclick="downloadEpub()" style="height:38px;padding:0 16px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--card);color:var(--muted);cursor:pointer;font-family:\'DM Sans\',sans-serif;font-size:0.82rem;display:flex;align-items:center;gap:6px">\uD83D\uDCDA Download EPUB</button><div style="display:flex;gap:10px"><button onclick="document.getElementById(\'kindle-modal\').remove()" style="height:38px;padding:0 18px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--card);color:var(--muted);cursor:pointer;font-family:\'DM Sans\',sans-serif;font-size:0.82rem">Cancel</button><button onclick="sendToKindle()" id="kindle-send-btn" style="height:38px;padding:0 18px;border:none;border-radius:var(--radius-sm);background:var(--accent);color:#fff;cursor:pointer;font-family:\'DM Sans\',sans-serif;font-size:0.82rem;font-weight:500">Send \u2192</button></div></div><div id="kindle-status" style="font-size:0.8rem;color:var(--muted);margin-top:0.75rem;text-align:center;display:none"></div></div>'; document.body.appendChild(modal); setTimeout(() => document.getElementById('kindle-email-input').focus(), 100); }
async function sendToKindle() { const email = document.getElementById('kindle-email-input').value.trim(); const status = document.getElementById('kindle-status'); const btn = document.getElementById('kindle-send-btn'); if (!email || !email.includes('@')) { status.style.display = 'block'; status.style.color = 'var(--error-fg)'; status.textContent = 'Please enter a valid Kindle email address.'; return; } btn.disabled = true; btn.textContent = 'Sending\u2026'; status.style.display = 'block'; status.style.color = 'var(--muted)'; status.textContent = 'Generating EPUB and sending\u2026'; try { const res = await fetch('/api/send-to-kindle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: currentSummary.title, author: currentSummary.author, html: currentSummary.html, kindleEmail: email }) }); const data = await res.json(); if (!res.ok) throw new Error(data.error || 'Send failed'); status.style.color = 'var(--success-fg)'; status.textContent = '\u2713 Sent! Check your Kindle in a few minutes.'; btn.textContent = 'Sent \u2713'; setTimeout(() => { const m = document.getElementById('kindle-modal'); if(m) m.remove(); }, 3000); } catch(err) { status.style.color = 'var(--error-fg)'; status.textContent = 'Error: ' + err.message; btn.disabled = false; btn.textContent = 'Send \u2192'; } }
function downloadEpub() { if (!currentSummary) return; if (typeof JSZip === 'undefined') { alert('Please wait a moment and try again.'); return; } const id = 'kernl-' + Date.now(); const t = esc(currentSummary.title), a = esc(currentSummary.author); const contentHtml = '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><head><title>' + t + '</title><style>body{font-family:Georgia,serif;font-size:1em;line-height:1.75;margin:1.5em 2em}h1{font-size:1.8em;margin-bottom:.2em}.byline{font-style:italic;color:#777;margin-bottom:2em}h2{font-size:1.05em;font-weight:bold;margin:1.8em 0 .5em;padding-bottom:5px;border-bottom:1px solid #ddd;color:#8B4513}p{margin:0 0 .9em;text-align:justify}.footer{margin-top:3em;font-size:.8em;color:#aaa;font-style:italic}</style></head><body><h1>' + t + '</h1><div class="byline">by ' + a + ' \u2014 KERNL Summary</div>' + currentSummary.html + '<div class="footer">Generated by KERNL \u2014 for the curious</div></body></html>'; const opf = '<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bid" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>' + t + ' \u2014 KERNL</dc:title><dc:creator>' + a + '</dc:creator><dc:language>en</dc:language><dc:identifier id="bid">' + id + '</dc:identifier></metadata><manifest><item id="c" href="content.html" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="c"/></spine></package>'; const ncx = '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="' + id + '"/></head><docTitle><text>' + t + '</text></docTitle><navMap><navPoint id="n1" playOrder="1"><navLabel><text>Summary</text></navLabel><content src="content.html"/></navPoint></navMap></ncx>'; const container = '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'; const zip = new JSZip(); (async () => { zip.file('mimetype', 'application/epub+zip'); zip.folder('META-INF').file('container.xml', container); const oebps = zip.folder('OEBPS'); oebps.file('content.opf', opf); oebps.file('toc.ncx', ncx); oebps.file('content.html', contentHtml); const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' }); triggerDownload(blob, safe(currentSummary.title) + '_KERNL.epub'); })(); }
function printSummary() { if (!currentSummary) return; const meganGrid = document.getElementById('megan-words-grid'); const meganOpen = meganGrid && meganGrid.classList.contains('open'); const words = currentSummary.words || []; let meganSection = ''; if (meganOpen && words.length) { const wordRows = words.map(w => `<tr><td style="font-weight:bold;color:#8B4513;padding:5pt 10pt 5pt 0;vertical-align:top;width:120pt">${esc(w.word)}</td><td style="padding:5pt 0;color:#444;line-height:1.5">${esc(w.definition)}</td></tr>`).join(''); meganSection = `<div style="margin-top:2em;border-top:1pt solid #ddd;padding-top:1em"><h2 style="font-size:13pt;font-weight:bold;color:#8B4513;margin-bottom:0.75em">Mega Words</h2><table style="width:100%;border-collapse:collapse;font-family:Georgia,serif;font-size:10pt">${wordRows}</table></div>`; } const w = window.open('', '_blank'); if (!w) { alert('Please allow popups for kernlbooks.com to use Print.'); return; } w.document.write('<!DOCTYPE html><html><head><title>' + esc(currentSummary.title) + ' \u2014 KERNL</title><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script><style>body{font-family:Georgia,serif;font-size:11pt;line-height:1.7;margin:2cm;color:#000}h1{font-size:18pt;margin-bottom:4pt}.byline{font-style:italic;color:#555;margin-bottom:1.5em}h2{font-size:11pt;font-weight:bold;margin-top:18pt;padding-bottom:4pt;border-bottom:1pt solid #ddd;color:#8B4513}p{margin:0 0 8pt}.footer{margin-top:2em;font-size:8pt;color:#aaa;font-style:italic;border-top:1pt solid #ddd;padding-top:8pt}.print-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.5em}.print-header-left{flex:1}.qr-block{text-align:center;font-size:8pt;color:#888;flex-shrink:0;margin-left:2em}#qr-code{margin-bottom:4pt}<\/style><\/head><body><div class="print-header"><div class="print-header-left"><h1>' + esc(currentSummary.title) + '<\/h1><div class="byline">by ' + esc(currentSummary.author) + ' \u2014 KERNL Summary<\/div><\/div><div class="qr-block"><div id="qr-code"><\/div>Scan to buy this book<\/div><\/div>' + currentSummary.html + meganSection + '<div class="footer">Generated by KERNL \u2014 for the curious<\/div><script>new QRCode(document.getElementById("qr-code"),{text:"' + makeAmazonUrl(currentSummary.title, currentSummary.author) + '",width:100,height:100,colorDark:"#000000",colorLight:"#ffffff"});<\/script><\/body><\/html>'); w.document.close(); setTimeout(() => w.print(), 500); }
function triggerDownload(blob, filename) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click(); setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 1000); }

// ── Library browser ──────────────────────────────────────────────────────────
const CATEGORIES = [
  'Business & Entrepreneurship','Personal Development','Psychology','History',
  'Science & Technology','Politics & Society','Philosophy','Biography & Memoir',
  'Fiction — Literary','Fiction — Thriller','Fiction — Sci-Fi','Fiction — Historical',
  'Health & Wellbeing','Economics','Leadership','Nature & Environment',
  'Crime & True Crime','Sport','Parenting & Family','Spirituality'
];

let _allBooks = [];
let _activeCategory = 'All';

async function loadLibrary() {
  try {
    const sb = getSB();
    let all = [], offset = 0;
    while (true) {
      const { data, error } = await sb
        .from('summaries')
        .select('title,author,synopsis,categories')
        .range(offset, offset + 999)
        .order('title', { ascending: true });
      if (error || !data || !data.length) break;
      all = all.concat(data);
      if (data.length < 1000) break;
      offset += 1000;
    }
    _allBooks = all;

    // Build category filter buttons
    const row = document.getElementById('cat-filter-row');
    row.innerHTML = '<button class="cat-btn active" data-cat="All" onclick="filterLibrary(\'All\')">All</button>';
    CATEGORIES.forEach(cat => {
      const count = all.filter(b => {
        try { return (JSON.parse(b.categories||'[]')).includes(cat); } catch { return false; }
      }).length;
      if (count > 0) {
        const btn = document.createElement('button');
        btn.className = 'cat-btn';
        btn.dataset.cat = cat;
        btn.onclick = () => filterLibrary(cat);
        btn.textContent = cat + ' (' + count + ')';
        row.appendChild(btn);
      }
    });

    renderLibraryGrid(_allBooks);
  } catch(e) {
    document.getElementById('lib-grid-container').innerHTML =
      '<div class="lib-empty">Could not load library — please refresh.</div>';
  }
}

function filterLibrary(cat) {
  _activeCategory = cat;
  // Update active button
  document.querySelectorAll('.cat-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.cat === cat);
  });
  const filtered = cat === 'All' ? _allBooks : _allBooks.filter(b => {
    try { return (JSON.parse(b.categories||'[]')).includes(cat); } catch { return false; }
  });
  renderLibraryGrid(filtered);
}

function renderLibraryGrid(books) {
  const container = document.getElementById('lib-grid-container');
  const countEl = document.getElementById('lib-count');
  countEl.textContent = books.length.toLocaleString() + ' books';

  if (!books.length) {
    container.innerHTML = '<div class="lib-empty">No books in this category yet.</div>';
    return;
  }

  container.innerHTML = '<div class="lib-grid">' + books.map(b => {
    const synopsis = b.synopsis ? esc(b.synopsis) : '';
    return `<div class="lib-card" onclick="loadLibraryBook('${esc(b.title)}','${esc(b.author||'')}')">
      <div class="lib-card-title">${esc(b.title)}</div>
      <div class="lib-card-author">by ${esc(b.author||'Unknown')}</div>
      ${synopsis ? `<div class="lib-card-synopsis">${synopsis}</div>` : ''}
    </div>`;
  }).join('') + '</div>';
}

function loadLibraryBook(title, author) {
  // Decode HTML entities back to plain text
  const ta = document.createElement('textarea');
  ta.innerHTML = title; const t = ta.value;
  ta.innerHTML = author; const a = ta.value;
  document.getElementById('book-input').value = t;
  document.getElementById('author-input').value = a;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  handleGenerate();
}

// ── Event listeners ───────────────────────────────────────────────────────────
document.getElementById('book-input').addEventListener('input', e => { clearTimeout(autocompleteTimer); autocompleteTimer = setTimeout(() => fetchBookSuggestions(e.target.value.trim()), 500); });
document.getElementById('book-input').addEventListener('keydown', e => { if (e.key === 'Enter') { hideDropdown(); handleGenerate(); } if (e.key === 'Escape') hideDropdown(); });
document.getElementById('author-input').addEventListener('keydown', e => { if (e.key === 'Enter') handleGenerate(); });
document.addEventListener('click', e => { if (!e.target.closest('#book-input') && !e.target.closest('#book-dropdown')) hideDropdown(); });

// ── Init ──────────────────────────────────────────────────────────────────────
initDark();
setVoice('female');
renderArchive();
initAuth();
