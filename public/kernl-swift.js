// ── KERNL SWIFT — Speed reader overlay v3 ─────────────────────────────────
// Words display in lockstep with main player audio.
// Swift never manages audio directly — it calls through to main player functions.
// Call: KernlSwift.open(plainText, wpm, getAudioEl, startAudioFn, pauseAudioFn)

(function(global) {

  var overlay   = null;
  var words     = [];
  var currentIdx = 0;
  var currentWpm = 250;
  var rafId     = null;
  var wordTimings = [];

  // Callbacks provided by caller
  var _getAudio  = null;
  var _startAudio = null;
  var _pauseAudio = null;

  function pivotIndex(word) {
    var len = word.replace(/[^a-zA-Z]/g,'').length || word.length;
    if (len <= 1)  return 0;
    if (len <= 5)  return 1;
    if (len <= 9)  return 2;
    if (len <= 13) return 3;
    return 4;
  }

  function buildTimings(dur) {
    wordTimings = [];
    var secPerWord = dur / words.length;
    var t = 0;
    for (var i = 0; i < words.length; i++) {
      wordTimings.push({ start: t, end: t + secPerWord });
      t += secPerWord;
    }
  }

  function wordIdxForTime(t) {
    if (!wordTimings.length) return 0;
    for (var i = 0; i < wordTimings.length; i++) {
      if (t < wordTimings[i].end) return i;
    }
    return wordTimings.length - 1;
  }

  function renderWord(word) {
    if (!word) return;
    var b = document.getElementById('ks-before');
    var p = document.getElementById('ks-pivot');
    var a = document.getElementById('ks-after');
    if (!b || !p || !a) return;
    var pi = pivotIndex(word);
    b.textContent = word.slice(0, pi);
    p.textContent = word.slice(pi, pi + 1);
    a.textContent = word.slice(pi + 1);
  }

  function fmtTime(secs) {
    if (!isFinite(secs) || secs < 0) secs = 0;
    var m = Math.floor(secs / 60);
    var s = Math.floor(secs % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  function rafLoop() {
    if (!overlay) return;
    var audio = _getAudio ? _getAudio() : null;
    if (audio && !isNaN(audio.duration) && audio.duration > 0) {
      if (!wordTimings.length) buildTimings(audio.duration);
      var t = audio.currentTime;
      var dur = audio.duration;
      var idx = wordIdxForTime(t);
      if (idx !== currentIdx) { currentIdx = idx; if (words[currentIdx]) renderWord(words[currentIdx]); }
      var wPct = words.length > 1 ? (currentIdx / (words.length - 1)) * 100 : 0;
      var pf = document.getElementById('ks-pfill'); if (pf) pf.style.width = wPct + '%';
      var ct = document.getElementById('ks-ct'); if (ct) ct.textContent = (currentIdx + 1) + ' / ' + words.length;
      var tPct = (t / dur) * 100;
      var sf = document.getElementById('ks-sfill'); if (sf) sf.style.width = tPct + '%';
      var st = document.getElementById('ks-sthumb'); if (st) st.style.left = tPct + '%';
      var el = document.getElementById('ks-elapsed'); if (el) el.textContent = fmtTime(t);
      var re = document.getElementById('ks-remaining'); if (re) re.textContent = '➒' + fmtTime(dur - t);
      setPlayState(!audio.paused && !audio.ended);
    } else { setPlayState(false); }
    rafId = requestAnimationFrame(rafLoop);
  }

  function setPlayState(playing) { var btn = document.getElementById('ks-pb'); if (btn) btn.textContent = playing ? '⏸' : '▶'; }
  function togglePlay() { var audio = _getAudio ? _getAudio() : null; if (audio && !audio.paused) { if (_pauseAudio) _pauseAudio(); } else { if (_startAudio) _startAudio(); } }
  function skipAudio(secs) { var audio = _getAudio ? _getAudio() : null; if (audio && audio.duration) { audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + secs)); } }
  function setSpeed(wpm, btn) { currentWpm = wpm; document.querySelectorAll('.ks-spd').forEach(function(b) { var active = b === btn; b.style.background = active ? 'var(--accent,#8B4513)' : 'transparent'; b.style.color = active ? '#fff' : 'var(--muted,#7a7060)'; b.style.borderColor = active ? 'var(--accent,#8B4513)' : 'var(--border,rgba(139,69,19,0.14))'; b.style.fontWeight = active ? '500' : '400'; }); var lbl = document.getElementById('ks-wl'); if (lbl) lbl.textContent = wpm + ' words per minute'; var audio = _getAudio ? _getAudio() : null; if (audio && audio.duration) buildTimings(audio.duration); }

  function initScrubEvents(track) {
    if (!track || track._ksInit) return;
    track._ksInit = true;
    var dragging = false;
    function seekTo(e) { var audio = _getAudio ? _getAudio() : null; if (!audio || !audio.duration) return; var rect = track.getBoundingClientRect(); var clientX = e.touches ? e.touches[0].clientX : e.clientX; var pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)); audio.currentTime = pct * audio.duration; }
    track.addEventListener('mousedown', function(e) { dragging = true; seekTo(e); });
    track.addEventListener('touchstart', function(e) { dragging = true; seekTo(e); }, {passive:true});
    document.addEventListener('mousemove', function(e) { if (dragging) seekTo(e); });
    document.addEventListener('touchmove', function(e) { if (dragging) seekTo(e); }, {passive:true});
    document.addEventListener('mouseup', function() { dragging = false; });
    document.addEventListener('touchend', function() { dragging = false; });
  }

  function closeOverlay() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (overlay && overlay._keyHandler) document.removeEventListener('keydown', overlay._keyHandler);
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null; wordTimings = [];
  }

  function open(plainText, wpm, getAudioFn, startAudioFn, pauseAudioFn) {
    if (overlay) closeOverlay();
    words = plainText.trim().split(/\s+/).filter(Boolean);
    currentIdx = 0; currentWpm = wpm || 250; wordTimings = [];
    _getAudio = getAudioFn || null; _startAudio = startAudioFn || null; _pauseAudio = pauseAudioFn || null;
    var audio = _getAudio ? _getAudio() : null;
    if (audio && audio.duration) buildTimings(audio.duration);
    var el = document.createElement('div');
    el.id = 'kernl-swift-overlay';
    el.style.cssText = 'position:fixed;inset:0;z-index:9999;background:var(--paper,#faf8f4);display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:"DM Sans",sans-serif;';
    el.innerHTML = '<div style="position:absolute;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;padding:1rem 1.5rem;border-bottom:1px solid var(--border,rgba(139,69,19,0.14));"><div style="display:flex;align-items:center;"><span style="font-family:Playfair Display,serif;font-size:1.1rem;font-weight:600;letter-spacing:0.1em;color:var(--ink,#1a1714);">K<span style="color:var(--accent,#8B4513);">E</span>RNL</span><span style="font-size:0.7rem;letter-spacing:0.15em;text-transform:uppercase;color:var(--accent,#8B4513);background:var(--accent-pale,rgba(139,69,19,0.08));padding:3px 10px;border-radius:20px;border:1px solid rgba(139,69,19,0.15);margin-left:10px;font-weight:500;">⚡ Swift</span></div><button id="ks-x" style="width:36px;height:36px;border-radius:50%;border:1px solid var(--border,rgba(139,69,19,0.14));background:transparent;cursor:pointer;font-size:1rem;color:var(--muted,#7a7060);">✕</button></div><div style="display:flex;flex-direction:column;align-items:center;gap:1.5rem;width:100%;max-width:640px;padding:0 2rem;"><div style="width:100%;background:var(--card,#fff);border:1px solid var(--border,rgba(139,69,19,0.14));border-radius:16px;padding:2.5rem 0;position:relative;overflow:hidden;"><div style="position:absolute;top:0;bottom:0;left:50%;width:2px;background:rgba(139,69,19,0.07);transform:translateX(-50%);"></div><div style="position:absolute;top:0;left:50%;width:2px;height:8px;background:var(--accent,#8B4513);opacity:0.5;transform:translateX(-50%);"></div><div style="display:grid;grid-template-columns:1fr auto 1fr;align-items:baseline;width:100%;font-size:clamp(2rem,5vw,35rem);font-family:Playfair Display,serif;font-weight:500;line-height:1;"><span id="ks-before" style="text-align:right;color:var(--ink,#1a1714);"></span><span id="ks-pivot" style="color:var(--accent,#8B4513);font-weight:600;text-align:center;"></span><span id="ks-after" style="text-align:left;color:var(--ink,#1a1714);"></span></div></div><div style="width:100%;height:3px;background:var(--warm,#f0ebe0);border-radius:2px;overflow:hidden;"><div id="ks-pfill" style="height:100%;background:var(--accent,#8B4513);width:0%;border-radius:2px;opacity:0.5;"></div></div><div id="ks-ct" style="font-size:0.78rem;color:var(--muted,#7a7060);font-variant-numeric:tabular-nums;">—#/ —</div><div style="display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;border-radius:10px;border:1px solid var(--border,rgba(139,69,19,0.22));background:var(--accent-pale,rgba(139,69,19,0.06));"><span id="ks-elapsed" style="font-size:0.75rem;font-weight:600;color:var(--accent,#8B4513);min-width:34px;font-variant-numeric:tabular-nums;">0:00</span><button id="ks-skip-back" style="width:34px;height:34px;flex-shrink:0;border-radius:50%;background:transparent;border:1.5px solid var(--accent,#8B4513);cursor:pointer;display:flex;align-items:center;justify-content:center;font-family:DM Sans,sans-serif;font-size:0.62rem;font-weight:700;color:var(--accent,#8B4513);">−10</button><div id="ks-strack" style="flex:1;height:6px;background:rgba(139,69,19,0.15);border-radius:3px;cursor:pointer;position:relative;overflow:visible;"><div id="ks-sfill" style="height:100%;background:var(--accent,#8B4513);border-radius:3px;width:0%;pointer-events:none;"></div><div id="ks-sthumb" style="position:absolute;top:50%;left:0%;transform:translateY(-50%) translateX(-50%);width:14px;height:14px;border-radius:50%;background:var(--accent,#8B4513);pointer-events:none;box-shadow:0 1px 4px rgba(139,69,19,0.4);"></div></div><button id="ks-skip-fwd" style="width:34px;height:34px;flex-shrink:0;border-radius:50%;background:transparent;border:1.5px solid var(--accent,#8B4513);cursor:pointer;display:flex;align-items:center;justify-content:center;font-family:DM Sans,ssans-serif;font-size:0.62rem;font-weight:700;color:var(--accent,#8B4513);">+10</button><span id="ks-remaining" style="font-size:0.75rem;font-weight:600;color:var(--accent,#8B4513);min-width:40px;text-align:right;font-variant-numeric:tabular-nums;">−0:00</span></div><div style="display:flex;align-items:center;gap:12px;"><button id="ks-rb" style="width:40px;height:40px;border-radius:50%;border:1px solid var(--border,rgba(139,69,19,0.14));background:transparent;cursor:pointer;font-size:1rem;color:var(--muted,#7a7060);">↺</button><button id="ks-pb" style="width:56px;height:56px;border-radius:50%;background:var(--accent,#8B4513);border:none;cursor:pointer;font-size:1.4rem;color:#fff;box-shadow:0 2px 10px rgba(139,69,19,0.3);">▶</button><div style="display:flex;gap:6px;"><button class="ks-spd" data-wpm="250" style="height:36px;padding:0 16px;border:1px solid var(--accent,#8B4513);border-radius:20px;background:var(--accent,#8B4513);color:#fff;font-weight:500;cursor:pointer;font-size:0.82rem;">1×</button><button class="ks-spd" data-wpm="375" style="height:36px;padding:0 16px;border:1px solid var(--border,rgba(139,69,19,0.14));border-radius:20px;background:transparent;color:var(--muted,#7a7060);cursor:pointer;font-size:0.82rem;">1.5×</button><button class="ks-spd" data-wpm="500" style="height:36px;padding:0 16px;border:1px solid var(--border,rgba(139,69,19,0.14));border-radius:20px;background:transparent;color:var(--muted,#7a7060);cursor:pointer;font-size:0.82rem;">2×</button></div></div><div id="ks-wl" style="font-size:0.75rem;color:var(--muted,#7a7060);">250 words per minute</div><div style="font-size:0.75rem;color:var(--accent,#8B4513);font-style:italic;otacity:0.85;">⚡ Words sync to audio playback</div></div>';
    document.body.appendChild(el); overlay = el;
    el.querySelectorAll('.ks-spd').forEach(function(btn) { var w = parseInt(btn.getAttribute('data-wpm'), 10); if (w === currentWpm) { btn.style.background = 'var(--accent,#8B4513)'; btn.style.borderColor = 'var(--accent,#8B4513)'; btn.style.color = '#fff'; btn.style.fontWeight = '500'; } btn.addEventListener('click', function() { setSpeed(w, btn); }); });
    initScrubEvents(document.getElementById('ks-strack'));
    document.getElementById('ks-skip-back').addEventListener('click', function() { skipAudio(-10); });
    document.getElementById('ks-skip-fwd').addEventListener('click', function() { skipAudio(10); });
    document.getElementById('ks-pb').addEventListener('click', togglePlay);
    document.getElementById('ks-rb').addEventListener('click', function() { var a = _getAudio ? _getAudio() : null; if (a) a.currentTime = 0; });
    document.getElementById('ks-x').addEventListener('click', closeOverlay);
    el._keyHandler = function(e) { if (e.key === 'Escape') { closeOverlay(); return; } if (e.key === ' ') { e.preventDefault(); togglePlay(); return; } if (e.key === 'ArrowLeft') { e.preventDefault(); skipAudio(-10); } if (e.key === 'ArrowRight') { e.preventDefault(); skipAudio(10); } };
    document.addEventListener('keydown', el._keyHandler);
    if (words.length) renderWord(words[0]);
    rafId = requestAnimationFrame(rafLoop);
    var audioNow = _getAudio ? _getAudio() : null;
    if (!audioNow || audioNow.paused) { if (_startAudio) _startAudio(); }
  }
  global.KernlSwift = { open: open, close: closeOverlay };
})(window);
