// ── KERNL SWIFT — Speed reader overlay v4 ─────────────────────────────────
// Words display in exact lockstep with audio using Whisper word timestamps.
// When Whisper timings are available, the Whisper words ARE the display words —
// no mapping needed, perfect sync by definition.
// Call: KernlSwift.open(plainText, wpm, getAudioFn, startAudioFn, pauseAudioFn, whisperTimings)

(function(global) {

  var overlay      = null;
  var words        = [];        // display words — either whisper words or summary words
  var wordTimings  = [];        // [{start, end}] in seconds at 1x speed
  var currentIdx   = 0;
  var currentWpm   = 250;
  var rafId        = null;
  var usingRealTimings = false;

  var _getAudio   = null;
  var _startAudio = null;
  var _pauseAudio = null;

  // ── Pivot index ────────────────────────────────────────────────────────────
  // 1-2 letters → 0, 3-4 → 1, 5-6 → 2 ... up to 45 letters → 22
  function pivotIndex(word) {
    var len = word.length;
    if (len <= 2) return 0;
    return Math.floor((len - 1) / 2);
  }

  // ── Render word with fixed pivot ───────────────────────────────────────────
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

  // ── Format time ────────────────────────────────────────────────────────────
  function fmtTime(secs) {
    if (!isFinite(secs) || secs < 0) secs = 0;
    var m = Math.floor(secs / 60);
    var s = Math.floor(secs % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  // ── Load Whisper timings — Whisper words become the display words ──────────
  function loadWhisperTimings(whisperTimings) {
    words = whisperTimings.map(function(w) { return w.word; });
    wordTimings = whisperTimings.map(function(w, i) {
      var start = w.start;
      var end = w.end;
      // Fix zero-duration words — extend to next word's start or add 100ms
      if (end <= start) {
        var next = whisperTimings[i + 1];
        end = next ? Math.min(next.start, start + 0.15) : start + 0.15;
      }
      return { start: start, end: end };
    });
    usingRealTimings = true;
    console.log('KernlSwift v4: using ' + words.length + ' Whisper words with exact timestamps');
  }

  // ── Fallback: equal distribution from summary text ─────────────────────────
  function loadFallbackTimings(plainText, audioDuration) {
    // Expand hyphens so display matches speech
    words = plainText.trim().split(/\s+/).filter(Boolean).reduce(function(acc, w) {
      if (w.indexOf('-') > 0 && w.indexOf('-') < w.length - 1) {
        w.split('-').forEach(function(p) { if (p) acc.push(p); });
      } else {
        acc.push(w);
      }
      return acc;
    }, []);
    var secPerWord = audioDuration / words.length;
    var t = 0;
    wordTimings = words.map(function() {
      var timing = { start: t, end: t + secPerWord };
      t += secPerWord;
      return timing;
    });
    usingRealTimings = false;
    console.log('KernlSwift v4: fallback timing for ' + words.length + ' words');
  }

  // ── Find word index for a given audio time ─────────────────────────────────
  // Use word.start as the trigger: a word appears exactly when its start time
  // is reached. During silence gaps, the previous word stays on screen.
  function wordIdxForTime(t) {
    if (!wordTimings.length) return 0;
    // Find the last word whose start <= t
    var result = 0;
    var lo = 0, hi = wordTimings.length - 1;
    while (lo <= hi) {
      var mid = Math.floor((lo + hi) / 2);
      if (wordTimings[mid].start <= t) {
        result = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return result;
  }

  // ── RAF loop ───────────────────────────────────────────────────────────────
  function rafLoop() {
    if (!overlay) return;
    var audio = _getAudio ? _getAudio() : null;

    if (audio && !isNaN(audio.duration) && audio.duration > 0) {

      // Build timings if not yet done
      if (!wordTimings.length) {
        if (usingRealTimings) {
          // already loaded in open()
        } else {
          // Shouldn't happen but safety net
          loadFallbackTimings(words.join(' '), audio.duration);
        }
      }

      // currentTime advances at playbackRate — divide to get 1x-equivalent position
      var playRate = audio.playbackRate || 1;
      var t   = audio.currentTime / playRate;
      var dur = audio.duration;

      // Word display
      var idx = wordIdxForTime(t);
      if (idx !== currentIdx) {
        currentIdx = idx;
        if (words[currentIdx]) renderWord(words[currentIdx]);
      }

      // Word progress bar
      var wPct = words.length > 1 ? (currentIdx / (words.length - 1)) * 100 : 0;
      var pf = document.getElementById('ks-pfill');
      if (pf) pf.style.width = wPct + '%';

      // Word counter
      var ct = document.getElementById('ks-ct');
      if (ct) ct.textContent = (currentIdx + 1) + ' / ' + words.length;

      // Scrub bar (time-based)
      var tPct = (audio.currentTime / dur) * 100;
      var sf = document.getElementById('ks-sfill');
      var st = document.getElementById('ks-sthumb');
      if (sf) sf.style.width = tPct + '%';
      if (st) st.style.left  = tPct + '%';

      // Times
      var el = document.getElementById('ks-elapsed');
      var re = document.getElementById('ks-remaining');
      if (el) el.textContent = fmtTime(audio.currentTime);
      if (re) re.textContent = '−' + fmtTime(dur - audio.currentTime);

      // Play state + sync label
      setPlayState(!audio.paused && !audio.ended);
      var lbl = document.getElementById('ks-sync-label');
      if (lbl) lbl.textContent = usingRealTimings
        ? '⚡ Synced to voice — exact word timestamps'
        : '⚡ Synced to audio (estimated timing)';

    } else if (audio) {
      setPlayState(false);
    } else {
      setPlayState(false);
    }

    rafId = requestAnimationFrame(rafLoop);
  }

  // ── Play state ─────────────────────────────────────────────────────────────
  function setPlayState(playing) {
    var btn = document.getElementById('ks-pb');
    if (btn) btn.textContent = playing ? '⏸' : '▶';
  }

  function togglePlay() {
    var audio = _getAudio ? _getAudio() : null;
    if (audio && !audio.paused) {
      if (_pauseAudio) _pauseAudio();
    } else {
      if (_startAudio) _startAudio();
    }
  }

  function skipAudio(secs) {
    var audio = _getAudio ? _getAudio() : null;
    if (audio && audio.duration) {
      audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + secs));
    }
  }

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
  }

  // ── Scrub events ───────────────────────────────────────────────────────────
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

  // ── Close ──────────────────────────────────────────────────────────────────
  function closeOverlay() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (overlay && overlay._keyHandler) document.removeEventListener('keydown', overlay._keyHandler);
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
  }

  // ── Open ───────────────────────────────────────────────────────────────────
  function open(plainText, wpm, getAudioFn, startAudioFn, pauseAudioFn, whisperTimings) {
    if (overlay) closeOverlay();

    currentIdx      = 0;
    currentWpm      = wpm || 250;
    wordTimings     = [];
    usingRealTimings = false;
    _getAudio       = getAudioFn   || null;
    _startAudio     = startAudioFn || null;
    _pauseAudio     = pauseAudioFn || null;

    // Use Whisper timings if available — these are the actual spoken words
    if (whisperTimings && whisperTimings.length) {
      loadWhisperTimings(whisperTimings);
    } else {
      // Fallback: use summary text with estimated timing
      var audio = _getAudio ? _getAudio() : null;
      var dur = audio && audio.duration ? audio.duration : 600;
      loadFallbackTimings(plainText, dur);
    }

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

        // Word progress
        '<div style="width:100%;height:3px;background:var(--warm,#f0ebe0);border-radius:2px;overflow:hidden;">',
          '<div id="ks-pfill" style="height:100%;background:var(--accent,#8B4513);width:0%;border-radius:2px;opacity:0.5;"></div>',
        '</div>',

        // Word counter
        '<div id="ks-ct" style="font-size:0.78rem;color:var(--muted,#7a7060);font-variant-numeric:tabular-nums;">— / —</div>',

        // Scrub row
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

    initScrubEvents(document.getElementById('ks-strack'));
    document.getElementById('ks-skip-back').addEventListener('click', function() { skipAudio(-10); });
    document.getElementById('ks-skip-fwd').addEventListener('click',  function() { skipAudio(10); });
    document.getElementById('ks-pb').addEventListener('click', togglePlay);
    document.getElementById('ks-rb').addEventListener('click', function() {
      var a = _getAudio ? _getAudio() : null;
      if (a) a.currentTime = 0;
    });
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

    // Start RAF
    rafId = requestAnimationFrame(rafLoop);

    // Start audio if not already playing
    var audioNow = _getAudio ? _getAudio() : null;
    if (!audioNow || audioNow.paused) {
      if (_startAudio) _startAudio();
    }
  }

  global.KernlSwift = { open: open, close: closeOverlay };

})(window);
