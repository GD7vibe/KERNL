const STORAGE_KEY = 'kernl_v2';
const AMAZON_TAG = 'kernl-21';
let currentVoice = 'female';
let currentSummary = null;
let isPlaying = false;
let audioEl = null;
let playbackRate = 1;
let autocompleteTimer = null;
let currentTimings = [];

function toggleDark() {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('kernl_dark', isDark ? '1' : '0');
  document.getElementById('dark-icon').textContent = isDark ? '\u2600\uFE0F' : '\uD83C\uDF19';
  document.getElementById('dark-label').textContent = isDark ? 'Light' : 'Dark';
}
function initDark() {
  const saved = localStorage.getItem('kernl_dark');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = saved !== null ? saved === '1' : prefersDark;
  if (isDark) {
    document.documentElement.classList.add('dark');
    document.getElementById('dark-icon').textContent = '\u2600\uFE0F';
    document.getElementById('dark-label').textContent = 'Light';
  }
}

async function fetchBookSuggestions(query) {
  if (!query || query.length < 3) { hideDropdown(); return; }
  try {
    const res = await fetch(`https://openlibrary.org/search.json?title=${encodeURIComponent(query)}&limit=6&fields=title,author_name,first_publish_year`);
    const data = await res.json();
    if (!data.docs || !data.docs.length) { hideDropdown(); return; }
    const results = data.docs
      .filter(d => d.title && d.author_name && d.author_name.length)
      .slice(0, 5)
      .map(d => ({ title: d.title, author: d.author_name[0], year: d.first_publish_year || '' }));
    if (results.length) showDropdown(results); else hideDropdown();
  } catch (e) { hideDropdown(); }
}
function showDropdown(results) {
  let dropdown = document.getElementById('book-dropdown');
  if (!dropdown) {
    dropdown = document.createElement('div');
    dropdown.id = 'book-dropdown';
    dropdown.className = 'book-dropdown';
    document.getElementById('book-input').parentNode.appendChild(dropdown);
  }
  dropdown.innerHTML = results.map((r, i) => `
    <div class="dropdown-item" onmousedown="selectBook(${i})" data-title="${esc(r.title)}" data-author="${esc(r.author)}">
      <div class="dropdown-title">${esc(r.title)}</div>
      <div class="dropdown-author">${esc(r.author)}${r.year ? ' \u00b7 ' + r.year : ''}</div>
    </div>`).join('');
  dropdown.style.display = 'block';
}
function hideDropdown() {
  const dropdown = document.getElementById('book-dropdown');
  if (dropdown) dropdown.style.display = 'none';
}
function selectBook(idx) {
  const dropdown = document.getElementById('book-dropdown');
  if (!dropdown) return;
  const items = dropdown.querySelectorAll('.dropdown-item');
  if (!items[idx]) return;
  const title = items[idx].getAttribute('data-title');
  const author = items[idx].getAttribute('data-author');
  document.getElementById('book-input').value = title;
  const authorInput = document.getElementById('author-input');
  authorInput.value = author;
  authorInput.classList.add('author-autofilled');
  setTimeout(() => authorInput.classList.remove('author-autofilled'), 1500);
  hideDropdown();
}

function getArchive() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch (e) { return []; } }
function saveEntry(entry) {
  const arc = getArchive();
  const key = norm(entry.title) + '||' + norm(entry.author) + '||' + (entry.spoilers ? 'spoilers' : 'nospoilers');
  const idx = arc.findIndex(e => norm(e.title) + '||' + norm(e.author) + '||' + (e.spoilers ? 'spoilers' : 'nospoilers') === key);
  if (idx >= 0) arc[idx] = entry; else arc.unshift(entry);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(arc.slice(0, 300)));
}
function clearArchive() {
  if (!confirm('Clear your entire KERNL library? This cannot be undone.')) return;
  localStorage.removeItem(STORAGE_KEY);
  renderArchive();
}
function norm(s) { return String(s || '').toLowerCase().trim().replace(/\s+/g, ' '); }
function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtDate(ts) { if (!ts) return ''; return new Date(ts).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }); }
function makeAmazonUrl(title, author) {
  const query = encodeURIComponent(title + (author ? ' ' + author : ''));
  return `https://www.amazon.co.uk/s?k=${query}&tag=${AMAZON_TAG}`;
}
function renderArchive() {
  const arc = getArchive();
  const container = document.getElementById('archive-container');
  const countEl = document.getElementById('archive-count');
  const clearBtn = document.getElementById('clear-btn');
  countEl.textContent = arc.length + ' summar' + (arc.length === 1 ? 'y' : 'ies');
  clearBtn.style.display = arc.length ? 'inline' : 'none';
  if (!arc.length) {
    container.innerHTML = '<div class="archive-empty">Your library is empty \u2014 summarise a book above to begin.</div>';
    return;
  }
  container.innerHTML = '<div class="archive-grid">' + arc.map((e, i) => `
    <div class="archive-item" onclick="loadEntry(${i})">
      <div class="archive-book-title">${esc(e.title)}</div>
      <div class="archive-book-author">by ${esc(e.author)}</div>
      <div class="archive-footer">
        <div class="archive-date">${fmtDate(e.savedAt)}</div>
        <div style="display:flex;gap:6px;align-items:center">
          <div class="archive-chip">Archived</div>
        </div>
      </div>
    </div>`).join('') + '</div>';
}
function loadEntry(idx) {
  const e = getArchive()[idx];
  if (e) displaySummary(e.title, e.author, e.html, e.plain, e.words || [], true);
}

function setStatus(msg, show) {
  const bar = document.getElementById('status-bar');
  document.getElementById('status-text').textContent = msg;
  bar.classList.toggle('show', !!show);
}
function setError(msg) {
  const bar = document.getElementById('error-bar');
  bar.textContent = msg;
  bar.classList.toggle('show', !!msg);
}

function setSpeed(rate) {
  playbackRate = rate;
  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.classList.toggle('active', parseFloat(btn.dataset.rate) === rate);
  });
  if (audioEl) audioEl.playbackRate = rate;
}

function setVoice(v) {
  currentVoice = v;
  document.getElementById('vbf').classList.toggle('active', v === 'female');
  document.getElementById('vbm').classList.toggle('active', v === 'male');
  document.getElementById('pvf').classList.toggle('on', v === 'female');
  document.getElementById('pvm').classList.toggle('on', v === 'male');
  const wasPlaying = isPlaying;
  if (audioEl) { audioEl.pause(); audioEl.src = ''; audioEl = null; }
  isPlaying = false;
  if (currentSummary) {
    document.getElementById('player-sub').textContent = v === 'female' ? 'Female voice — press play' : 'Male voice — press play';
    if (wasPlaying) setTimeout(startOpenAIAudio, 150);
  }
}

async function handleGenerate() {
  const title = document.getElementById('book-input').value.trim();
  const author = document.getElementById('author-input').value.trim();
  const spoilers = false;
  setError('');
  hideDropdown();
  if (!title) { setError('Please enter a book title to continue.'); return; }

  const cached = getArchive().find(e =>
    norm(e.title) === norm(title) &&
    (!author || norm(e.author) === norm(author)) &&
    (e.spoilers || false) === spoilers
  );
  if (cached) {
    setStatus('Found in your library ————Â——————— loading instantly!', true);
    setTimeout(() => { setStatus('', false); displaySummary(cached.title, cached.author, cached.html, cached.plain, cached.words || [], cached.spoilers || false, true); }, 600);
    return;
  }

  document.getElementById('gen-btn').disabled = true;
  setStatus('generating…', true);

  try {
    const res = await fetch('/api/summarise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, author, spoilers })
    });
    if (!res.ok) { const data = await res.json(); throw new Error(data.error || 'Error ' + res.status); }

    const contentType = res.headers.get('content-type') || '';

    // Cached ————Â——————— plain JSON
    if (contentType.includes('application/json')) {
      const data = await res.json();
      const displayAuthor = author || data.author || 'Unknown author';
      saveEntry({ title, author: displayAuthor, html: data.html, plain: data.plain, words: data.words || [], spoilers, savedAt: Date.now() });
      setStatus('', false);
      renderArchive();
      displaySummary(title, displayAuthor, data.html, data.plain, data.words || [], false);
      return;
    }

    // Streaming SSE
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamingStarted = false;
    let finalData = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const msg = JSON.parse(line.slice(6).trim());
          if (msg.error) throw new Error(msg.error);
          if (msg.done) { finalData = msg; continue; }
          if (msg.chunk) {
            if (!streamingStarted) {
              streamingStarted = true;
              setStatus('', false);
              displaySummaryStreaming(title, author || 'Unknown author', msg.chunk);
            } else {
              updateStreamingBody(msg.chunk);
            }
          }
        } catch(e) { if (e.message && e.message !== 'Unexpected end of JSON input') throw e; }
      }
    }

    if (finalData) {
      const displayAuthor = author || 'Unknown author';
      saveEntry({ title, author: displayAuthor, html: finalData.html, plain: finalData.plain, words: finalData.words || [], spoilers, savedAt: Date.now() });
      renderArchive();
      displaySummary(title, displayAuthor, finalData.html, finalData.plain, finalData.words || [], false);
    }

  } catch (err) {
    setStatus('', false);
    setError('Could not generate summary: ' + err.message);
  } finally {
    document.getElementById('gen-btn').disabled = false;
  }
}

function stripGenreLine(html) {
  // Remove GENRE:FICTION or GENRE:NONFICTION line if present at start
  return html.replace(/^GENRE:(FICTION|NONFICTION)\s*/i, '').replace(/^<p>GENRE:(FICTION|NONFICTION)<\/p>\s*/i, '');
}

function displaySummaryStreaming(title, author, htmlSoFar) {
  htmlSoFar = stripGenreLine(htmlSoFar);
  stopAudio();
  currentSummary = { title, author, html: htmlSoFar, plain: '', words: [] };
  document.getElementById('s-title').textContent = title;
  document.getElementById('s-author').textContent = 'by ' + author;
  document.getElementById('s-words').textContent = 'generating…';
  document.getElementById('summary-body').innerHTML = htmlSoFar + '<span class="kernl-cursor">————Â———————</span>';
  document.getElementById('player-title').textContent = title;
  document.getElementById('player-sub').textContent = currentVoice === 'female' ? 'Female voice — press play' : 'Male voice — press play';
  resetScrubUI();
  document.getElementById('megan-words-section').style.display = 'none';
  document.getElementById('summary-card').classList.add('show');
  document.getElementById('summary-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function updateStreamingBody(htmlSoFar) {
  htmlSoFar = stripGenreLine(htmlSoFar);
  const body = document.getElementById('summary-body');
  if (body) body.innerHTML = htmlSoFar + '<span class="kernl-cursor">————Â———————</span>';
}
function countWords(plain) { return plain.split(/\s+/).filter(w => w.length > 0).length; }

function renderMeganWords(words) {
  const section = document.getElementById('megan-words-section');
  if (!words || !words.length) { section.style.display = 'none'; return; }
  const seen = new Set();
  const uniqueWords = words.filter(w => {
    const key = w.word.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  section.style.display = 'block';
  const grid = document.getElementById('megan-words-grid');
  grid.innerHTML = uniqueWords.map(w => `
    <div class="megan-word-item">
      <div class="megan-word">${esc(w.word)}</div>
      <div class="megan-definition">${esc(w.definition)}</div>
    </div>`).join('');
}
function toggleMeganWords() {
  const grid = document.getElementById('megan-words-grid');
  const arrow = document.getElementById('megan-arrow');
  const isOpen = grid.classList.toggle('open');
  arrow.style.transform = isOpen ? 'rotate(180deg)' : 'rotate(0deg)';
}

function displaySummary(title, author, html, plain, words, spoilers, fromArchive) {
  stopAudio();
  unlockVoiceButtons();
  currentSummary = { title, author, html, plain, words, spoilers };
  document.getElementById('s-title').textContent = title;
  document.getElementById('s-author').textContent = 'by ' + author;
  const wc = countWords(plain);
  document.getElementById('s-words').textContent = wc.toLocaleString() + ' words';
  document.getElementById('summary-body').innerHTML = html;
  const amazonUrl = makeAmazonUrl(title, author);
  const buyBtn = document.getElementById('buy-btn');
  buyBtn.href = amazonUrl;
  document.getElementById('player-title').textContent = title;
  document.getElementById('player-sub').textContent = currentVoice === 'female' ? 'Female voice — press play' : 'Male voice — press play';
  resetScrubUI();
  const grid = document.getElementById('megan-words-grid');
  const arrow = document.getElementById('megan-arrow');
  grid.classList.remove('open');
  arrow.style.transform = 'rotate(0deg)';
  renderMeganWords(words);
  document.getElementById('summary-card').classList.add('show');
  document.getElementById('summary-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function closeSummary() {
  stopAudio();
  unlockVoiceButtons();
  document.getElementById('summary-card').classList.remove('show');
  currentSummary = null;
}

function fmtTime(secs) {
  if (!isFinite(secs) || secs < 0) secs = 0;
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return m + ':' + String(s).padStart(2, '0');
}
function setScrubActive(active) {
  const row = document.getElementById('scrub-row');
  const btn = document.getElementById('play-btn');
  const sub = document.getElementById('player-sub');
  if (row) row.classList.toggle('active', active);
  if (btn) btn.classList.toggle('playing', active);
  if (sub) sub.classList.toggle('playing', active);
}
function resetScrubUI() {
  const fill = document.getElementById('scrub-fill');
  const thumb = document.getElementById('scrub-thumb');
  if (fill) { fill.style.width = '0%'; if (thumb) thumb.style.left = '0%'; }
  const el = document.getElementById('scrub-elapsed');
  const re = document.getElementById('scrub-remaining');
  if (el) el.textContent = '0:00';
  if (re) re.textContent = '\u22120:00';
  setScrubActive(false);
}
function updateScrubUI() {
  if (!audioEl || !audioEl.duration) return;
  const pct = (audioEl.currentTime / audioEl.duration) * 100;
  const fill = document.getElementById('scrub-fill');
  const thumb = document.getElementById('scrub-thumb');
  if (fill) fill.style.width = pct + '%';
  if (thumb) thumb.style.left = pct + '%';
  const el = document.getElementById('scrub-elapsed');
  const re = document.getElementById('scrub-remaining');
  if (el) el.textContent = fmtTime(audioEl.currentTime);
  if (re) re.textContent = '\u2212' + fmtTime(audioEl.duration - audioEl.currentTime);
}

function initScrubEvents() {
  const track = document.getElementById('scrub-track');
  if (!track || track._scrubInit) return;
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
}

function skipAudio(secs) {
  if (!audioEl) return;
  audioEl.currentTime = Math.max(0, Math.min(audioEl.duration || 0, audioEl.currentTime + secs));
  updateScrubUI();
}

function lockVoiceButtons() {
  ['pvf','pvm','vbf','vbm'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.disabled = true; el.style.opacity = '0.4'; el.style.cursor = 'not-allowed'; }
  });
}
function unlockVoiceButtons() {
  ['pvf','pvm','vbf','vbm'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.disabled = false; el.style.opacity = ''; el.style.cursor = ''; }
  });
}
function setPlayerState(playing, subText) {
  isPlaying = playing;
  const icon = document.getElementById('play-icon');
  if (playing) {
    icon.innerHTML = '<rect x="5" y="3" width="5" height="18"/><rect x="14" y="3" width="5" height="18"/>';
  } else {
    icon.innerHTML = '<polygon points="6,3 20,12 6,21"/>';
  }
  if (subText) document.getElementById('player-sub').textContent = subText;
  setScrubActive(playing);
}
function stopAudio() {
  if (audioEl) { audioEl.pause(); audioEl.src = ''; audioEl = null; }
  setPlayerState(false, null);
  resetScrubUI();
}
function pauseAudio() {
  if (audioEl && !audioEl.paused) audioEl.pause();
  setPlayerState(false, 'Paused \u2014 press play to continue');
  setScrubActive(false);
}
function resumeAudio() {
  if (audioEl) {
    audioEl.play();
    setPlayerState(true, 'Now playing \u2014 ' + (currentVoice === 'female' ? 'Female' : 'Male') + ' voice');
    setScrubActive(true);
    return true;
  }
  return false;
}
async function startOpenAIAudio() {
  if (!currentSummary) return;
  setPlayerState(true, 'Loading audio—Â¦');
  lockVoiceButtons();
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: currentSummary.plain, voice: currentVoice, title: currentSummary.title, author: currentSummary.author })
    });
    if (!res.ok) throw new Error('TTS request failed');

    const contentType = res.headers.get('content-type') || '';

    // Cached —Â returns JSON with URL, play immediately
    if (contentType.includes('application/json')) {
      const data = await res.json();
      if (data.timings && data.timings.length) currentTimings = data.timings;
      playSingleAudio(data.url, null);
      return;
    }

    // Streaming SSE —Â decode base64 chunks and play via Web Audio API
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioCtx();
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let startTime = audioCtx.currentTime;
    let started = false;
    let totalDuration = 0;
    const pendingBuffers = [];
    let isScheduling = false;

    // Decode and schedule audio buffers for seamless playback
    async function scheduleBuffer(b64chunk) {
      const bytes = Uint8Array.from(atob(b64chunk), c => c.charCodeAt(0));
      try {
        const decoded = await audioCtx.decodeAudioData(bytes.buffer);
        pendingBuffers.push(decoded);
        if (!isScheduling) drainBuffers();
      } catch(e) {
        // Some partial mp3 chunks can't decode alone - collect and retry
        console.warn('Chunk decode error (may be partial):', e.message);
      }
    }

    function drainBuffers() {
      if (pendingBuffers.length === 0) { isScheduling = false; return; }
      isScheduling = true;
      const decoded = pendingBuffers.shift();
      const source = audioCtx.createBufferSource();
      source.buffer = decoded;
      source.connect(audioCtx.destination);
      const when = Math.max(startTime + totalDuration, audioCtx.currentTime);
      source.start(when);
      totalDuration += decoded.duration;

      if (!started) {
        started = true;
        // Update UI as soon as first chunk plays
        audioEl = { pause: () => audioCtx.suspend(), paused: false, src: 'streaming',
          playbackRate: playbackRate, currentTime: 0, duration: 0 };
        setPlayerState(true, (currentVoice === 'female' ? 'Female' : 'Male') + ' voice —Â now playing');
        setScrubActive(true);
      }

      source.onended = () => drainBuffers();
    }

    // Read SSE stream
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const msg = JSON.parse(line.slice(6).trim());
          if (msg.error) throw new Error(msg.error);
          if (msg.audio) await scheduleBuffer(msg.audio);
          if (msg.done) {
            // Wait for all buffers to drain then clean up
            const checkDone = setInterval(() => {
              if (pendingBuffers.length === 0 && !isScheduling) {
                clearInterval(checkDone);
                setTimeout(() => {
                  setPlayerState(false, 'Finished —Â press play to replay');
                  setScrubActive(false);
                  unlockVoiceButtons();
                  audioEl = null;
                  audioCtx.close();
                }, totalDuration * 1000);
              }
            }, 200);
          }
        } catch(e) {
          if (e.message && e.message !== 'Unexpected end of JSON input') throw e;
        }
      }
    }

  } catch (err) {
    console.warn('TTS failed:', err.message);
    setPlayerState(false, 'Audio unavailable —Â please try again');
    unlockVoiceButtons();
  }
}

function playSingleAudio(audioUrl, blobUrl) {
  audioEl = new Audio(audioUrl);
  audioEl.addEventListener('timeupdate', updateScrubUI);
  audioEl.addEventListener('ended', () => {
    const fill = document.getElementById('scrub-fill');
    if (fill) fill.style.width = '100%';
    setPlayerState(false, 'Finished —Â press play to replay');
    setScrubActive(false);
    unlockVoiceButtons();
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    audioEl = null;
  });
  audioEl.addEventListener('error', () => {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    audioEl = null;
    setPlayerState(false, 'Audio unavailable —Â please try again');
    setScrubActive(false);
    unlockVoiceButtons();
  });
  audioEl.play();
  audioEl.playbackRate = playbackRate;
  setPlayerState(true, (currentVoice === 'female' ? 'Female' : 'Male') + ' voice —Â now playing');
  setScrubActive(true);
  initScrubEvents();
}
function togglePlay() {
  if (!currentSummary) return;
  if (isPlaying) { pauseAudio(); return; }
  if (audioEl && audioEl.paused && audioEl.src) { resumeAudio(); return; }
  startOpenAIAudio();
}

function downloadEpub() {
  if (!currentSummary) return;
  const id = 'kernl-' + Date.now();
  const t = esc(currentSummary.title), a = esc(currentSummary.author);
  const contentHtml = '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><head><title>' + t + '</title><style>body{font-family:Georgia,serif;font-size:1em;line-height:1.75;margin:1.5em 2em}h1{font-size:1.8em;margin-bottom:.2em}.byline{font-style:italic;color:#777;margin-bottom:2em}h2{font-size:1.05em;font-weight:bold;margin:1.8em 0 .5em;padding-bottom:5px;border-bottom:1px solid #ddd;color:#8B4513}p{margin:0 0 .9em;text-align:justify}.footer{margin-top:3em;font-size:.8em;color:#aaa;font-style:italic}</style></head><body><h1>' + t + '</h1><div class="byline">by ' + a + ' \u2014 KERNL Summary</div>' + currentSummary.html + '<div class="footer">Generated by KERNL \u2014 for the curious</div></body></html>';
  const opf = '<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bid" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>' + t + ' \u2014 KERNL</dc:title><dc:creator>' + a + '</dc:creator><dc:language>en</dc:language><dc:identifier id="bid">' + id + '</dc:identifier></metadata><manifest><item id="c" href="content.html" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="c"/></spine></package>';
  const ncx = '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="' + id + '"/></head><docTitle><text>' + t + '</text></docTitle><navMap><navPoint id="n1" playOrder="1"><navLabel><text>Summary</text></navLabel><content src="content.html"/></navPoint></navMap></ncx>';
  const container = '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
  const script = document.createElement('script');
  script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
  script.onload = () => {
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip');
    zip.folder('META-INF').file('container.xml', container);
    const oebps = zip.folder('OEBPS');
    oebps.file('content.opf', opf); oebps.file('toc.ncx', ncx); oebps.file('content.html', contentHtml);
    zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' }).then(blob => {
      triggerDownload(blob, safe(currentSummary.title) + '_KERNL.epub');
    });
  };
  document.head.appendChild(script);
}
function printSummary() {
  if (!currentSummary) return;
  const meganGrid = document.getElementById('megan-words-grid');
  const meganOpen = meganGrid && meganGrid.classList.contains('open');
  const words = currentSummary.words || [];
  let meganSection = '';
  if (meganOpen && words.length) {
    const wordRows = words.map(w => `<tr><td style="font-weight:bold;color:#8B4513;padding:5pt 10pt 5pt 0;vertical-align:top;width:120pt">${esc(w.word)}</td><td style="padding:5pt 0;color:#444;line-height:1.5">${esc(w.definition)}</td></tr>`).join('');
    meganSection = `<div style="margin-top:2em;border-top:1pt solid #ddd;padding-top:1em"><h2 style="font-size:13pt;font-weight:bold;color:#8B4513;margin-bottom:0.75em">Mega Words</h2><table style="width:100%;border-collapse:collapse;font-family:Georgia,serif;font-size:10pt">${wordRows}</table></div>`;
  }
  const w = window.open('', '_blank');
  w.document.write('<!DOCTYPE html><html><head><title>' + esc(currentSummary.title) + ' \u2014 KERNL</title><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script><style>body{font-family:Georgia,serif;font-size:11pt;line-height:1.7;margin:2cm;color:#000}h1{font-size:18pt;margin-bottom:4pt}.byline{font-style:italic;color:#555;margin-bottom:1.5em}h2{font-size:11pt;font-weight:bold;margin-top:18pt;padding-bottom:4pt;border-bottom:1pt solid #ddd;color:#8B4513}p{margin:0 0 8pt}.footer{margin-top:2em;font-size:8pt;color:#aaa;font-style:italic;border-top:1pt solid #ddd;padding-top:8pt}.print-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.5em}.print-header-left{flex:1}.qr-block{text-align:center;font-size:8pt;color:#888;flex-shrink:0;margin-left:2em}#qr-code{margin-bottom:4pt}</style></head><body><div class="print-header"><div class="print-header-left"><h1>' + esc(currentSummary.title) + '</h1><div class="byline">by ' + esc(currentSummary.author) + ' \u2014 KERNL Summary</div></div><div class="qr-block"><div id="qr-code"></div>Scan to buy this book</div></div>' + currentSummary.html + meganSection + '<div class="footer">Generated by KERNL \u2014 for the curious</div><script>new QRCode(document.getElementById("qr-code"),{text:"' + makeAmazonUrl(currentSummary.title, currentSummary.author) + '",width:100,height:100,colorDark:"#000000",colorLight:"#ffffff"});<\/script></body></html>');
  w.document.close();
  setTimeout(() => w.print(), 400);
}
function triggerDownload(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 1000);
}
function safe(s) { return String(s).replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_').slice(0, 60); }

document.getElementById('book-input').addEventListener('input', e => {
  clearTimeout(autocompleteTimer);
  autocompleteTimer = setTimeout(() => fetchBookSuggestions(e.target.value.trim()), 500);
});
document.getElementById('book-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { hideDropdown(); handleGenerate(); }
  if (e.key === 'Escape') hideDropdown();
});
document.getElementById('author-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') handleGenerate();
});
document.addEventListener('click', e => {
  if (!e.target.closest('#book-input') && !e.target.closest('#book-dropdown')) hideDropdown();
});

initDark();
setVoice('female');
renderArchive();
