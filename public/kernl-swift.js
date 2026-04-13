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
  var usingRealTimings = false;
  var pendingTimings = null; // Whisper timings passed in from caller

  // Callbacks provided by caller
  var _getAudio  = null;  // function() returns current audioEl (may be null initially)
  var _startAudio = null; // function() starts/resumes audio on main player
  var _pauseAudio = null; // function() pauses audio on main player

  // ── Pivot index — 1 per 2 letters, covers up to 45-letter words ────────
  // 1L→0, 2L→0, 3-4L→1, 5-6L→2, 7-8L→3 ... 45L→22
  function pivotIndex(word) {
    var len = word.length;
    if (len <= 2) return 0;
    return Math.floor((len - 1) / 2);
  }

  // ── Build fallback equal-distribution timings ──────────────────────────
  function buildFallbackTimings(dur) {
    wordTimings = [];
    var secPerWord = dur / words.length;
    var t = 0;
    for (var i = 0; i < words.length; i++) {
      wordTimings.push({ start: t, end: t + secPerWord });
      t += secPerWord;
    }
    usingRealTimings = false;
  }

  // ── Normalise word for comparison ────────────────────────────────────────
  function normaliseWord(w) {
    return String(w || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  // ── Load real Whisper timings ─────────────────────────────────────────────
  // Uses a forward-search alignment: for each summary word, search ahead
  // in the Whisper array up to MAX_LOOK positions to find a text match.
  // When found, lock to that position. When not found, interpolate the gap.
  // This handles Whisper merges, splits, and skips without cumulative drift.
  function loadRealTimings(whisperTimings, audioDur) {
    wordTimings = [];
    var wt = whisperTimings;
    var wi = 0;
    var lastEnd = 0;
    var MAX_LOOK = 12; // search up to 12 Whisper words ahead for a match

    for (var i = 0; i < words.length; i++) {
      var ourWord = normaliseWord(words[i]);
      var matched = false;

      // Search ahead in Whisper timings for this word
      var searchLimit = Math.min(wi + MAX_LOOK, wt.length);
      for (var look = wi; look < searchLimit; look++) {
        if (normaliseWord(wt[look].word) === ourWord) {
          wordTimings.push({ start: wt[look].start, end: wt[look].end });
          lastEnd = wt[look].end;
          wi = look + 1;
          matched = true;
          break;
        }
      }

      if (!matched) {
        // Not found — find how many summary words until the next Whisper match
        var nextWhisperMatch = -1;
        for (var fw = wi; fw < Math.min(wi + MAX_LOOK, wt.length); fw++) {
          for (var si = i + 1; si < Math.min(i + MAX_LOOK, words.length); si++) {
            if (normaliseWord(wt[fw].word) === normaliseWord(words[si])) {
              nextWhisperMatch = fw;
              var gapWords = si - i;
              var gapTime = wt[fw].start - lastEnd;
              var durEach = Math.max(0.08, gapTime / Math.max(1, gapWords));
              wordTimings.push({ start: lastEnd, end: lastEnd + durEach });
              lastEnd += durEach;
              matched = true;
              break;
            }
          }
          if (matched) break;
        }

        if (!matched) {
          // Complete fallback — evenly distribute remaining time
          var remaining = audioDur - lastEnd;
          var wordsLeft = words.length - i;
          var dur = Math.max(0.08, remaining / Math.max(1, wordsLeft));
          wordTimings.push({ start: lastEnd, end: lastEnd + dur });
          lastEnd += dur;
        }
      }
    }

    usingRealTimings = true;
    console.log('KernlSwift: aligned ' + words.length + ' words from ' + wt.length + ' Whisper timings');
  }

  function wordIdxForTime(t) {
    if (!wordTimings.length) return 0;
    // Binary search for efficiency
    var lo = 0, hi = wordTimings.length - 1;
    while (lo < hi) {
      var mid = Math.floor((lo + hi) / 2);
      if (wordTimings[mid].end <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // ── Render word ────────────────────────────────────────────────────────
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

  // ── Format time ────────────────────────────────────────────────────────
  function fmtTime(secs) {
    if (!isFinite(secs) || secs < 0) secs = 0;
    var m = Math.floor(secs / 60);
    var s = Math.floor(secs % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  // ── RAF loop — reads audioEl.currentTime each frame ────────────────────
  function rafLoop() {
    if (!overlay) return;
    var audio = _getAudio ? _getAudio() : null;

    if (audio && !isNaN(audio.duration) && audio.duration > 0) {
      // Ensure timings built
      if (!wordTimings.length) {
        if (pendingTimings && pendingTimings.length) {
          loadRealTimings(pendingTimings, audio.duration);
        } else {
          buildFallbackTimings(audio.duration);
        }
      }

      // CRITICAL: audioEl.currentTime advances at playbackRate speed
      // but Whisper timestamps are in 1x time. Divide to compensate.
      var playRate = audio.playbackRate || 1;
      var t   = audio.currentTime / playRate;
      var dur = audio.duration;

      // Word
      var idx = wordIdxForTime(t);
      if (idx !== currentIdx) {
        currentIdx = idx;
        if (words[currentIdx]) renderWord(words[currentIdx]);
      }

      // Word progress (thin bar)
      var wPct = words.length > 1 ? (currentIdx / (words.length - 1)) * 100 : 0;
      var pf = document.getElementById('ks-pfill');
      if (pf) pf.style.width = wPct + '%';

      // Word counter
      var ct = document.getElementById('ks-ct');
      if (ct) ct.textContent = (currentIdx + 1) + ' / ' + words.length;

      // Scrub bar
      var tPct = (t / dur) * 100;
      var sf = document.getElementById('ks-sfill');
      var st = document.getElementById('ks-sthumb');
      if (sf) sf.style.width = tPct + '%';
      if (st) st.style.left  = tPct + '%';

      // Times
      var el = document.getElementById('ks-elapsed');
      var re = document.getElementById('ks-remaining');
      if (el) el.textContent = fmtTime(t);
      if (re) re.textContent = '−' + fmtTime(dur - t);

      // Play state mirrors audio
      setPlayState(!audio.paused && !audio.ended);
      // Update sync label to show mode
      var lbl = document.getElementById('ks-sync-label');
      if (lbl) lbl.textContent = usingRealTimings ? '⚡ Synced to voice — word timestamps active' : '⚡ Synced to audio (generating precise timings…)';

    } else if (audio) {
      // Audio element exists but not yet loaded — show loading
      var pv = document.getElementById('ks-pivot');
      if (pv && pv.textContent === '—') {
        var b = document.getElementById('ks-before');
        var a = document.getElementById('ks-after');
        if (b) b.textContent = 'Load';
        if (pv) pv.textContent = 'i';
        if (a) a.textContent = 'ng…';
      }
      setPlayState(false);
    } else {
      // No audio element yet — keep polling, audio will appear after togglePlay() fires
      setPlayState(false);
    }

    rafId = requestAnimationFrame(rafLoop);
  }

  // ── Play state UI ──────────────────────────────────────────────────────
  function setPlayState(playing) {
    var btn = document.getElementById('ks-pb');
    if (btn) btn.textContent = playing ? '⏸' : '▶';
  }

  // ── Toggle play — always via main player ───────────────────────────────
  function togglePlay() {
    var audio = _getAudio ? _getAudio() : null;
    if (audio && !audio.paused) {
      // Pause
      if (_pauseAudio) _pauseAudio();
    } else {
      // Start or resume
      if (_startAudio) _startAudio();
    }
  }

  // ── Skip ±10s ──────────────────────────────────────────────────────────
  function skipAudio(secs) {
    var audio = _getAudio ? _getAudio() : null;
    if (audio && audio.duration) {
      audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + secs));
    }
  }

  // ── Speed ──────────────────────────────────────────────────────────────
  function setSpeed(wpm, btn) {
    currentWpm = wpm;
    document.querySelectorAll('.ks-spd').forEach(function(b) {
      var active = b === btn;
      b.style.background  = active ? 'var(--accent,#8B4513)' : 'transparent';
      b.style.color       = active ? '#fff' : 'var(--muted,#7a7060)';
      b.style.borderColor = active ? 'var(--accent,#8B4513)' : 'var(--border,rgba(139,69,19,0.14))';
      b.style.fontWeight  = active ? '500' : '400';
    });
    var lbl = document.getElementById('ks-wl');
    if (lbl) lbl.textContent = wpm + ' words per minute';
    // Set audio playback rate: 1x=250wpm, 1.5x=375wpm, 2x=500wpm
    var audio = _getAudio ? _getAudio() : null;
    if (audio) audio.playbackRate = wpm / 250;
    // Rebuild timings to match new speed (audio duration stays same, words compress)
    if (audio && audio.duration) { if (pendingTimings && pendingTimings.length) loadRealTimings(pendingTimings, audio.duration); else buildFallbackTimings(audio.duration); }
  }

  // ── Scrub events ───────────────────────────────────────────────────────
  function initScrubEvents(track) {
    if (!track || track._ksInit) return;
    track._ksInit = true;
    var dragging = false;
    function seekTo(e) {
      var audio = _getAudio ? _getAudio() : null;
      if (!audio || !audio.duration) return;
      var rect = track.getBoundingClientRect();
      var clientX = e.touches ? e.touches[0].clientX : e.clientX;
      var pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      audio.currentTime = pct * audio.duration;
    }
    track.addEventListener('mousedown',  function(e) { dragging = true; seekTo(e); });
    track.addEventListener('touchstart', function(e) { dragging = true; seekTo(e); }, {passive:true});
    document.addEventListener('mousemove',  function(e) { if (dragging) seekTo(e); });
    document.addEventListener('touchmove',  function(e) { if (dragging) seekTo(e); }, {passive:true});
    document.addEventListener('mouseup',    function() { dragging = false; });
    document.addEventListener('touchend',   function() { dragging = false; });
  }

  // ── Close ──────────────────────────────────────────────────────────────
  function closeOverlay() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (overlay && overlay._keyHandler) document.removeEventListener('keydown', overlay._keyHandler);
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    wordTimings = [];
  }

  // ── Open ───────────────────────────────────────────────────────────────
  function open(plainText, wpm, getAudioFn, startAudioFn, pauseAudioFn, whisperTimings) {
    if (overlay) closeOverlay();

    // Expand hyphenated words so they match Whisper's word-by-word transcription
    // e.g. "self-help" → ["self", "help"], "well-known" → ["well", "known"]
    words = plainText.trim().split(/\s+/).filter(Boolean).reduce(function(acc, w) {
      if (w.indexOf('-') > 0 && w.indexOf('-') < w.length - 1) {
        // Split on hyphen but keep punctuation with last part
        var parts = w.split('-');
        parts.forEach(function(p) { if (p) acc.push(p); });
      } else {
        acc.push(w);
      }
      return acc;
    }, []);
    currentIdx     = 0;
    currentWpm     = wpm || 250;
    wordTimings    = [];
    usingRealTimings = false;
    pendingTimings = (whisperTimings && whisperTimings.length) ? whisperTimings : null;
    _getAudio      = getAudioFn   || null;
    _startAudio    = startAudioFn || null;
    _pauseAudio    = pauseAudioFn || null;

    // Pre-build timings if audio already loaded
    var audio = _getAudio ? _getAudio() : null;
    if (audio && audio.duration) { if (pendingTimings && pendingTimings.length) loadRealTimings(pendingTimings, audio.duration); else buildFallbackTimings(audio.duration); }

    var el = document.createElement('div');
    el.id = 'kernl-swift-overlay';
    el.style.cssText = 'position:fixed;inset:0;z-index:9999;background:var(--paper,#faf8f4);display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:"DM Sans",sans-serif;';

    el.innerHTML = [

      // Header
      '<div style="position:absolute;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;padding:1rem 1.5rem;border-bottom:1px solid var(--border,rgba(139,69,19,0.14));">',
        '<div style="display:flex;align-items:center;">',
          '<span style="font-family:\'Playfair Display\',serif;font-size:1.1rem;font-weight:600;letter-spacing:0.1em;color:var(--ink,#1a1714);">K<span style="color:var(--accent,#8B4513);">E</span>RNL</span>',
          '<span style="font-size:0.7rem;letter-spacing:0.15em;text-transform:uppercase;color:var(--accent,#8B4513);background:var(--accent-pale,rgba(139,69,19,0.08));padding:3px 10px;border-radius:20px;border:1px solid rgba(139,69,19,0.15);margin-left:10px;font-weight:500;">⚡ Swift</span>',
        '</div>',
        '<button id="ks-x" style="width:36px;height:36px;border-radius:50%;border:1px solid var(--border,rgba(139,69,19,0.14));background:transparent;cursor:pointer;font-size:1rem;color:var(--muted,#7a7060);">✕</button>',
      '</div>',

      // Stage
      '<div style="display:flex;flex-direction:column;align-items:center;gap:1.5rem;width:100%;max-width:640px;padding:0 2rem;">',

        // Word box — fixed pivot
        '<div style="width:100%;background:var(--card,#fff);border:1px solid var(--border,rgba(139,69,19,0.14));border-radius:16px;padding:2.5rem 0 3.5rem;position:relative;overflow:hidden;">',
          '<div style="position:absolute;top:0;bottom:0;left:50%;width:2px;background:rgba(139,69,19,0.07);transform:translateX(-50%);"></div>',
          '<div style="position:absolute;top:0;left:50%;width:2px;height:8px;background:var(--accent,#8B4513);opacity:0.5;transform:translateX(-50%);"></div>',
          '<div style="display:grid;grid-template-columns:1fr auto 1fr;align-items:baseline;width:100%;font-size:clamp(1.2rem,3.5vw,3rem);font-family:\'Playfair Display\',serif;font-weight:500;line-height:1.4;white-space:nowrap;">',
            '<span id="ks-before" style="text-align:right;color:var(--ink,#1a1714);white-space:nowrap;"></span>',
            '<span id="ks-pivot"  style="color:var(--accent,#8B4513);font-weight:600;text-align:center;"></span>',
            '<span id="ks-after"  style="text-align:left;color:var(--ink,#1a1714);white-space:nowrap;"></span>',
          '</div>',
        '</div>',

        // Word progress (thin)
        '<div style="width:100%;height:3px;background:var(--warm,#f0ebe0);border-radius:2px;overflow:hidden;">',
          '<div id="ks-pfill" style="height:100%;background:var(--accent,#8B4513);width:0%;border-radius:2px;opacity:0.5;"></div>',
        '</div>',

        // Word counter
        '<div id="ks-ct" style="font-size:0.78rem;color:var(--muted,#7a7060);font-variant-numeric:tabular-nums;">— / —</div>',

        // Scrub row — matches main player styling exactly
        '<div style="display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;border-radius:10px;border:1px solid var(--border,rgba(139,69,19,0.22));background:var(--accent-pale,rgba(139,69,19,0.06));">',
          '<span id="ks-elapsed"   style="font-size:0.75rem;font-weight:600;color:var(--accent,#8B4513);min-width:34px;font-variant-numeric:tabular-nums;">0:00</span>',
          '<button id="ks-skip-back" style="width:34px;height:34px;flex-shrink:0;border-radius:50%;background:transparent;border:1.5px solid var(--accent,#8B4513);cursor:pointer;display:flex;align-items:center;justify-content:center;font-family:\'DM Sans\',sans-serif;font-size:0.62rem;font-weight:700;color:var(--accent,#8B4513);">−10</button>',
          '<div id="ks-strack" style="flex:1;height:6px;background:rgba(139,69,19,0.15);border-radius:3px;cursor:pointer;position:relative;overflow:visible;">',
            '<div id="ks-sfill"  style="height:100%;background:var(--accent,#8B4513);border-radius:3px;width:0%;pointer-events:none;"></div>',
            '<div id="ks-sthumb" style="position:absolute;top:50%;left:0%;transform:translateY(-50%) translateX(-50%);width:14px;height:14px;border-radius:50%;background:var(--accent,#8B4513);pointer-events:none;box-shadow:0 1px 4px rgba(139,69,19,0.4);"></div>',
          '</div>',
          '<button id="ks-skip-fwd" style="width:34px;height:34px;flex-shrink:0;border-radius:50%;background:transparent;border:1.5px solid var(--accent,#8B4513);cursor:pointer;display:flex;align-items:center;justify-content:center;font-family:\'DM Sans\',sans-serif;font-size:0.62rem;font-weight:700;color:var(--accent,#8B4513);">+10</button>',
          '<span id="ks-remaining" style="font-size:0.75rem;font-weight:600;color:var(--accent,#8B4513);min-width:40px;text-align:right;font-variant-numeric:tabular-nums;">−0:00</span>',
        '</div>',

        // Controls
        '<div style="display:flex;align-items:center;gap:12px;">',
          '<button id="ks-rb" style="width:40px;height:40px;border-radius:50%;border:1px solid var(--border,rgba(139,69,19,0.14));background:transparent;cursor:pointer;font-size:1rem;color:var(--muted,#7a7060);">↺</button>',
          '<button id="ks-pb" style="width:56px;height:56px;border-radius:50%;background:var(--accent,#8B4513);border:none;cursor:pointer;font-size:1.4rem;color:#fff;box-shadow:0 2px 10px rgba(139,69,19,0.3);">▶</button>',
          '<div style="display:flex;gap:6px;">',
            '<button class="ks-spd" data-wpm="250" style="height:36px;padding:0 16px;border:1px solid var(--accent,#8B4513);border-radius:20px;background:var(--accent,#8B4513);color:#fff;font-weight:500;cursor:pointer;font-size:0.82rem;">1×</button>',
            '<button class="ks-spd" data-wpm="375" style="height:36px;padding:0 16px;border:1px solid var(--border,rgba(139,69,19,0.14));border-radius:20px;background:transparent;color:var(--muted,#7a7060);cursor:pointer;font-size:0.82rem;">1.5×</button>',
            '<button class="ks-spd" data-wpm="500" style="height:36px;padding:0 16px;border:1px solid var(--border,rgba(139,69,19,0.14));border-radius:20px;background:transparent;color:var(--muted,#7a7060);cursor:pointer;font-size:0.82rem;">2×</button>',
          '</div>',
        '</div>',

        '<div id="ks-wl" style="font-size:0.75rem;color:var(--muted,#7a7060);">250 words per minute</div>',
        '<div id="ks-sync-label" style="font-size:0.75rem;color:var(--accent,#8B4513);font-style:italic;opacity:0.85;">⚡ Words sync to audio playback</div>',

      '</div>',

    ].join('');

    document.body.appendChild(el);
    overlay = el;

    // Wire speed buttons
    el.querySelectorAll('.ks-spd').forEach(function(btn) {
      var w = parseInt(btn.getAttribute('data-wpm'), 10);
      if (w === currentWpm) {
        btn.style.background = 'var(--accent,#8B4513)';
        btn.style.borderColor = 'var(--accent,#8B4513)';
        btn.style.color = '#fff'; btn.style.fontWeight = '500';
      }
      btn.addEventListener('click', function() { setSpeed(w, btn); });
    });

    // Scrub
    initScrubEvents(document.getElementById('ks-strack'));

    // Skip
    document.getElementById('ks-skip-back').addEventListener('click', function() { skipAudio(-10); });
    document.getElementById('ks-skip-fwd').addEventListener('click',  function() { skipAudio(10); });

    // Play — controls main player
    document.getElementById('ks-pb').addEventListener('click', togglePlay);

    // Restart
    document.getElementById('ks-rb').addEventListener('click', function() {
      var a = _getAudio ? _getAudio() : null;
      if (a) a.currentTime = 0;
    });

    // Close
    document.getElementById('ks-x').addEventListener('click', closeOverlay);

    // Keyboard
    el._keyHandler = function(e) {
      if (e.key === 'Escape')     { closeOverlay(); return; }
      if (e.key === ' ')          { e.preventDefault(); togglePlay(); return; }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); skipAudio(-10); }
      if (e.key === 'ArrowRight') { e.preventDefault(); skipAudio(10); }
    };
    document.addEventListener('keydown', el._keyHandler);

    // Show first word
    if (words.length) renderWord(words[0]);

    // Start RAF loop immediately
    rafId = requestAnimationFrame(rafLoop);

    // If audio not playing yet, start it now
    var audioNow = _getAudio ? _getAudio() : null;
    if (!audioNow || audioNow.paused) {
      if (_startAudio) _startAudio();
    }
  }

  global.KernlSwift = { open: open, close: closeOverlay };

})(window);
