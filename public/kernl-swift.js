// ── KERNL SWIFT — Speed reader overlay v2 ─────────────────────────────────
// - Pivot letter fixed at screen centre, words flow either side
// - Syncs word display to audio currentTime when audio is playing
// - Full scrub bar with elapsed/remaining time and ±10s skip
// Call: KernlSwift.open(plainText, wpm, audioElRef)

(function(global) {

  var overlay = null;
  var words = [];
  var currentIdx = 0;
  var currentWpm = 250;
  var isRunning = false;
  var rafId = null;

  // ── Audio reference (set by caller) ───────────────────────────────────
  var audioRef = null;       // the Audio element from the main player
  var wordTimings = [];      // [{start, end, idx}] seconds per word
  var totalDuration = 0;

  // ── Pivot index (Spritz algorithm) ────────────────────────────────────
  function pivotIndex(word) {
    var len = word.replace(/[^a-zA-Z]/g,'').length || word.length;
    if (len <= 1)  return 0;
    if (len <= 5)  return 1;
    if (len <= 9)  return 2;
    if (len <= 13) return 3;
    return 4;
  }

  // ── Build word timings from wpm ────────────────────────────────────────
  // Each word gets a proportional slice of the audio duration
  function buildTimings(wordList, audioDuration) {
    // Distribute time proportionally — longer words get slightly more time
    var timings = [];
    var secPerWord = audioDuration / wordList.length;
    var t = 0;
    for (var i = 0; i < wordList.length; i++) {
      var dur = secPerWord;
      timings.push({ start: t, end: t + dur, idx: i });
      t += dur;
    }
    return timings;
  }

  // ── Find word index for a given audio time ─────────────────────────────
  function wordIdxForTime(t) {
    if (!wordTimings.length) return 0;
    for (var i = 0; i < wordTimings.length; i++) {
      if (t < wordTimings[i].end) return i;
    }
    return wordTimings.length - 1;
  }

  // ── Render a word ──────────────────────────────────────────────────────
  function renderWord(word) {
    if (!word) return;
    var elBefore = document.getElementById('ks-before');
    var elPivot  = document.getElementById('ks-pivot');
    var elAfter  = document.getElementById('ks-after');
    if (!elBefore || !elPivot || !elAfter) return;
    var p = pivotIndex(word);
    elBefore.textContent = word.slice(0, p);
    elPivot.textContent  = word.slice(p, p + 1);
    elAfter.textContent  = word.slice(p + 1);
  }

  // ── Update all UI from audio time ──────────────────────────────────────
  function updateFromAudio() {
    if (!audioRef || !overlay) return;
    var t = audioRef.currentTime;
    var dur = audioRef.duration || totalDuration || 1;

    // Word display
    var idx = wordIdxForTime(t);
    if (idx !== currentIdx) {
      currentIdx = idx;
      if (words[currentIdx]) renderWord(words[currentIdx]);
    }

    // Progress bar (word-based)
    var wordPct = words.length > 1 ? (currentIdx / (words.length - 1)) * 100 : 0;
    var pfill = document.getElementById('ks-pfill');
    if (pfill) pfill.style.width = wordPct + '%';

    // Word counter
    var ct = document.getElementById('ks-ct');
    if (ct) ct.textContent = (currentIdx + 1) + ' / ' + words.length;

    // Scrub bar (time-based)
    var timePct = (t / dur) * 100;
    var sfill = document.getElementById('ks-sfill');
    var sthumb = document.getElementById('ks-sthumb');
    if (sfill) sfill.style.width = timePct + '%';
    if (sthumb) sthumb.style.left = timePct + '%';

    // Time displays
    var el = document.getElementById('ks-elapsed');
    var re = document.getElementById('ks-remaining');
    if (el) el.textContent = fmtTime(t);
    if (re) re.textContent = '−' + fmtTime(Math.max(0, dur - t));

    rafId = requestAnimationFrame(updateFromAudio);
  }

  // ── Freerunning timer (used when no audio) ─────────────────────────────
  var freeTimer = null;

  function startFreeTimer() {
    if (freeTimer) clearInterval(freeTimer);
    var delay = Math.round(60000 / currentWpm);
    freeTimer = setInterval(function() {
      if (currentIdx >= words.length) {
        stopFreeTimer();
        setPlayState(false);
        return;
      }
      renderWord(words[currentIdx]);
      var pfill = document.getElementById('ks-pfill');
      var pct = words.length > 1 ? Math.round((currentIdx / (words.length - 1)) * 100) : 0;
      if (pfill) pfill.style.width = pct + '%';
      var ct = document.getElementById('ks-ct');
      if (ct) ct.textContent = (currentIdx + 1) + ' / ' + words.length;
      currentIdx++;
    }, delay);
    isRunning = true;
    setPlayState(true);
  }

  function stopFreeTimer() {
    if (freeTimer) { clearInterval(freeTimer); freeTimer = null; }
    isRunning = false;
  }

  // ── Formatting ─────────────────────────────────────────────────────────
  function fmtTime(secs) {
    if (!isFinite(secs) || secs < 0) secs = 0;
    var m = Math.floor(secs / 60);
    var s = Math.floor(secs % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  // ── Play state ─────────────────────────────────────────────────────────
  function setPlayState(playing) {
    isRunning = playing;
    var btn = document.getElementById('ks-pb');
    if (btn) btn.textContent = playing ? '⏸' : '▶';
  }

  function togglePlay() {
    if (audioRef) {
      // Sync to audio
      if (!audioRef.paused) {
        audioRef.pause();
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        setPlayState(false);
      } else {
        audioRef.play();
        rafId = requestAnimationFrame(updateFromAudio);
        setPlayState(true);
      }
    } else {
      // Freerunning
      if (isRunning) {
        stopFreeTimer();
        setPlayState(false);
      } else {
        if (currentIdx >= words.length) currentIdx = 0;
        startFreeTimer();
      }
    }
  }

  function skipAudio(secs) {
    if (audioRef) {
      audioRef.currentTime = Math.max(0, Math.min(audioRef.duration || 0, audioRef.currentTime + secs));
    } else {
      // Skip words instead
      stopFreeTimer();
      currentIdx = Math.max(0, Math.min(words.length - 1, currentIdx + Math.round(secs * currentWpm / 60)));
      if (words[currentIdx]) renderWord(words[currentIdx]);
      setPlayState(false);
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
    // If freerunning, restart at new speed
    if (!audioRef && isRunning) { stopFreeTimer(); startFreeTimer(); }
    // If audio, just update rebuild timings
    if (audioRef && audioRef.duration) {
      wordTimings = buildTimings(words, audioRef.duration);
    }
  }

  // ── Close ──────────────────────────────────────────────────────────────
  function closeOverlay() {
    stopFreeTimer();
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (overlay && overlay._keyHandler) {
      document.removeEventListener('keydown', overlay._keyHandler);
    }
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    audioRef = null;
  }

  // ── Scrub track interaction ────────────────────────────────────────────
  function initScrubEvents(track) {
    if (!track || track._ksInit) return;
    track._ksInit = true;
    var dragging = false;
    function seekTo(e) {
      var rect = track.getBoundingClientRect();
      var clientX = e.touches ? e.touches[0].clientX : e.clientX;
      var pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      if (audioRef && audioRef.duration) {
        audioRef.currentTime = pct * audioRef.duration;
      } else {
        currentIdx = Math.round(pct * (words.length - 1));
        if (words[currentIdx]) renderWord(words[currentIdx]);
      }
    }
    track.addEventListener('mousedown', function(e) { dragging = true; track.classList.add('dragging'); seekTo(e); });
    track.addEventListener('touchstart', function(e) { dragging = true; seekTo(e); }, {passive: true});
    document.addEventListener('mousemove', function(e) { if (dragging) seekTo(e); });
    document.addEventListener('touchmove', function(e) { if (dragging) seekTo(e); }, {passive: true});
    document.addEventListener('mouseup', function() { dragging = false; track.classList.remove('dragging'); });
    document.addEventListener('touchend', function() { dragging = false; });
  }

  // ── Open ───────────────────────────────────────────────────────────────
  function open(plainText, wpm, audioEl) {
    if (overlay) closeOverlay();

    words = plainText.trim().split(/\s+/).filter(function(w) { return w.length > 0; });
    currentIdx = 0;
    currentWpm = wpm || 250;
    isRunning = false;
    audioRef = audioEl || null;

    // Build timings if audio already has duration
    if (audioRef && audioRef.duration) {
      wordTimings = buildTimings(words, audioRef.duration);
      totalDuration = audioRef.duration;
    } else if (audioRef) {
      audioRef.addEventListener('loadedmetadata', function() {
        wordTimings = buildTimings(words, audioRef.duration);
        totalDuration = audioRef.duration;
      });
    }

    var el = document.createElement('div');
    el.id = 'kernl-swift-overlay';
    el.style.cssText = 'position:fixed;inset:0;z-index:9999;background:var(--paper,#faf8f4);display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:"DM Sans",sans-serif;';

    el.innerHTML = [

      // ── Header ──
      '<div style="position:absolute;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;padding:1rem 1.5rem;border-bottom:1px solid var(--border,rgba(139,69,19,0.14));">',
        '<div style="display:flex;align-items:center;">',
          '<span style="font-family:\'Playfair Display\',serif;font-size:1.1rem;font-weight:600;letter-spacing:0.1em;color:var(--ink,#1a1714);">K<span style="color:var(--accent,#8B4513);">E</span>RNL</span>',
          '<span style="font-size:0.7rem;letter-spacing:0.15em;text-transform:uppercase;color:var(--accent,#8B4513);background:var(--accent-pale,rgba(139,69,19,0.08));padding:3px 10px;border-radius:20px;border:1px solid rgba(139,69,19,0.15);margin-left:10px;font-weight:500;">⚡ Swift</span>',
        '</div>',
        '<button id="ks-x" style="width:36px;height:36px;border-radius:50%;border:1px solid var(--border,rgba(139,69,19,0.14));background:transparent;cursor:pointer;font-size:1rem;color:var(--muted,#7a7060);">✕</button>',
      '</div>',

      // ── Stage ──
      '<div style="display:flex;flex-direction:column;align-items:center;gap:1.5rem;width:100%;max-width:640px;padding:0 2rem;">',

        // Word box
        '<div style="width:100%;background:var(--card,#fff);border:1px solid var(--border,rgba(139,69,19,0.14));border-radius:16px;padding:2.5rem 0;position:relative;overflow:hidden;">',
          '<div style="position:absolute;top:0;bottom:0;left:50%;width:2px;background:rgba(139,69,19,0.07);transform:translateX(-50%);"></div>',
          '<div style="position:absolute;top:0;left:50%;width:2px;height:8px;background:var(--accent,#8B4513);opacity:0.5;transform:translateX(-50%);"></div>',
          '<div style="display:grid;grid-template-columns:1fr auto 1fr;align-items:baseline;width:100%;font-size:clamp(2rem,5vw,3rem);font-family:\'Playfair Display\',serif;font-weight:500;line-height:1;">',
            '<span id="ks-before" style="text-align:right;color:var(--ink,#1a1714);"></span>',
            '<span id="ks-pivot"  style="color:var(--accent,#8B4513);font-weight:600;text-align:center;"></span>',
            '<span id="ks-after"  style="text-align:left;color:var(--ink,#1a1714);"></span>',
          '</div>',
        '</div>',

        // Word progress bar
        '<div style="width:100%;height:3px;background:var(--warm,#f0ebe0);border-radius:2px;overflow:hidden;">',
          '<div id="ks-pfill" style="height:100%;background:var(--accent,#8B4513);width:0%;transition:width 0.1s linear;border-radius:2px;opacity:0.4;"></div>',
        '</div>',

        // Word counter
        '<div id="ks-ct" style="font-size:0.78rem;color:var(--muted,#7a7060);font-variant-numeric:tabular-nums;">— / —</div>',

        // ── SCRUB ROW (mirrors main player) ──
        '<div style="display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;border-radius:10px;border:1px solid var(--border,rgba(139,69,19,0.14));background:var(--accent-pale,rgba(139,69,19,0.06));">',
          '<span id="ks-elapsed" style="font-size:0.75rem;font-weight:600;color:var(--accent,#8B4513);min-width:34px;font-variant-numeric:tabular-nums;">0:00</span>',
          '<button id="ks-skip-back" style="width:34px;height:34px;flex-shrink:0;border-radius:50%;background:transparent;border:1.5px solid var(--accent,#8B4513);cursor:pointer;display:flex;align-items:center;justify-content:center;font-family:\'DM Sans\',sans-serif;font-size:0.62rem;font-weight:700;color:var(--accent,#8B4513);">−10</button>',
          '<div id="ks-strack" style="flex:1;height:6px;background:rgba(139,69,19,0.15);border-radius:3px;cursor:pointer;position:relative;overflow:visible;">',
            '<div id="ks-sfill" style="height:100%;background:var(--accent,#8B4513);border-radius:3px;width:0%;pointer-events:none;"></div>',
            '<div id="ks-sthumb" style="position:absolute;top:50%;left:0%;transform:translateY(-50%) translateX(-50%);width:14px;height:14px;border-radius:50%;background:var(--accent,#8B4513);pointer-events:none;box-shadow:0 1px 4px rgba(139,69,19,0.4);"></div>',
          '</div>',
          '<button id="ks-skip-fwd" style="width:34px;height:34px;flex-shrink:0;border-radius:50%;background:transparent;border:1.5px solid var(--accent,#8B4513);cursor:pointer;display:flex;align-items:center;justify-content:center;font-family:\'DM Sans\',sans-serif;font-size:0.62rem;font-weight:700;color:var(--accent,#8B4513);">+10</button>',
          '<span id="ks-remaining" style="font-size:0.75rem;font-weight:600;color:var(--accent,#8B4513);min-width:40px;text-align:right;font-variant-numeric:tabular-nums;">−0:00</span>',
        '</div>',

        // ── Controls ──
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
        audioRef
          ? '<div style="font-size:0.75rem;color:var(--accent,#8B4513);font-style:italic;opacity:0.8;">⚡ Synced to audio</div>'
          : '<div style="font-size:0.75rem;color:var(--muted,#7a7060);font-style:italic;opacity:0.7;">Focus on the highlighted letter — let the words come to you</div>',

      '</div>',

    ].join('');

    document.body.appendChild(el);
    overlay = el;

    // Speed buttons
    el.querySelectorAll('.ks-spd').forEach(function(btn) {
      var w = parseInt(btn.getAttribute('data-wpm'), 10);
      if (w === currentWpm) {
        btn.style.background = 'var(--accent,#8B4513)';
        btn.style.color = '#fff';
        btn.style.borderColor = 'var(--accent,#8B4513)';
        btn.style.fontWeight = '500';
      }
      btn.addEventListener('click', function() { setSpeed(w, btn); });
    });

    // Scrub
    initScrubEvents(document.getElementById('ks-strack'));

    // Skip buttons
    document.getElementById('ks-skip-back').addEventListener('click', function() { skipAudio(-10); });
    document.getElementById('ks-skip-fwd').addEventListener('click',  function() { skipAudio(10); });

    // Play/pause
    document.getElementById('ks-pb').addEventListener('click', togglePlay);

    // Restart
    document.getElementById('ks-rb').addEventListener('click', function() {
      if (audioRef) {
        audioRef.currentTime = 0;
      } else {
        stopFreeTimer();
        currentIdx = 0;
        if (words.length) renderWord(words[0]);
        setPlayState(false);
      }
    });

    // Close
    document.getElementById('ks-x').addEventListener('click', closeOverlay);

    // Keyboard
    el._keyHandler = function(e) {
      if (e.key === 'Escape')    { closeOverlay(); return; }
      if (e.key === ' ')         { e.preventDefault(); togglePlay(); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); skipAudio(-10); }
      if (e.key === 'ArrowRight'){ e.preventDefault(); skipAudio(10); }
    };
    document.addEventListener('keydown', el._keyHandler);

    // Show first word
    if (words.length) renderWord(words[0]);

    // Start
    if (audioRef) {
      // Sync mode — kick off RAF loop, mirror audio state
      if (!audioRef.paused) {
        rafId = requestAnimationFrame(updateFromAudio);
        setPlayState(true);
      } else {
        // Show current position
        if (audioRef.duration) {
          wordTimings = buildTimings(words, audioRef.duration);
          currentIdx = wordIdxForTime(audioRef.currentTime);
          if (words[currentIdx]) renderWord(words[currentIdx]);
        }
        setPlayState(false);
      }
      // Listen for play/pause from main player
      audioRef.addEventListener('play',  function() {
        if (audioRef.duration) wordTimings = buildTimings(words, audioRef.duration);
        if (!rafId) rafId = requestAnimationFrame(updateFromAudio);
        setPlayState(true);
      });
      audioRef.addEventListener('pause', function() {
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        setPlayState(false);
      });
      audioRef.addEventListener('ended', function() {
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        setPlayState(false);
      });
    } else {
      // Free-run mode
      setTimeout(function() { startFreeTimer(); }, 800);
    }
  }

  global.KernlSwift = { open: open, close: closeOverlay };

})(window);
