// ── KERNL SWIFT — Speed reader overlay ────────────────────────────────────
// Pivot letter stays fixed at screen centre. Words flow either side.
// Call: KernlSwift.open(plainText, wpm)

(function(global) {

  var overlay = null;
  var words = [];
  var currentIdx = 0;
  var timer = null;
  var currentWpm = 250;
  var isRunning = false;

  // ── Pivot index (Spritz algorithm) ─────────────────────────────────────
  function pivotIndex(word) {
    var len = word.replace(/[^a-zA-Z]/g,'').length || word.length;
    if (len <= 1)  return 0;
    if (len <= 5)  return 1;
    if (len <= 9)  return 2;
    if (len <= 13) return 3;
    return 4;
  }

  // ── Render a word into the three fixed columns ─────────────────────────
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
    // Progress
    var pct = words.length > 1 ? Math.round((currentIdx / (words.length - 1)) * 100) : 0;
    var bar = document.getElementById('ks-pfill');
    if (bar) bar.style.width = pct + '%';
    var ct = document.getElementById('ks-ct');
    if (ct) ct.textContent = (currentIdx + 1) + ' / ' + words.length;
  }

  // ── Timer ──────────────────────────────────────────────────────────────
  function startTimer() {
    if (timer) clearInterval(timer);
    var delay = Math.round(60000 / currentWpm);
    timer = setInterval(function() {
      if (currentIdx >= words.length) { stopTimer(); setPlayState(false); return; }
      renderWord(words[currentIdx]);
      currentIdx++;
    }, delay);
    isRunning = true;
    setPlayState(true);
  }
  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
    isRunning = false;
  }
  function setPlayState(playing) {
    var btn = document.getElementById('ks-pb');
    if (btn) btn.textContent = playing ? '⏸' : '▶';
  }
  function togglePlay() {
    if (isRunning) { stopTimer(); setPlayState(false); }
    else { if (currentIdx >= words.length) currentIdx = 0; startTimer(); }
  }
  function setSpeed(wpm, btn) {
    currentWpm = wpm;
    document.querySelectorAll('.ks-spd').forEach(function(b) {
      var active = b === btn;
      b.style.background   = active ? 'var(--accent,#8B4513)' : 'transparent';
      b.style.color        = active ? '#fff' : 'var(--muted,#7a7060)';
      b.style.borderColor  = active ? 'var(--accent,#8B4513)' : 'var(--border,rgba(139,69,19,0.14))';
      b.style.fontWeight   = active ? '500' : '400';
    });
    var lbl = document.getElementById('ks-wl');
    if (lbl) lbl.textContent = wpm + ' words per minute';
    if (isRunning) { stopTimer(); startTimer(); }
  }

  // ── Close ──────────────────────────────────────────────────────────────
  function closeOverlay() {
    stopTimer();
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
  }

  // ── Open ───────────────────────────────────────────────────────────────
  function open(plainText, wpm) {
    if (overlay) closeOverlay();
    words = plainText.trim().split(/\s+/).filter(function(w) { return w.length > 0; });
    currentIdx = 0;
    currentWpm = wpm || 250;
    isRunning = false;

    var el = document.createElement('div');
    el.id = 'kernl-swift-overlay';
    el.style.cssText = [
      'position:fixed;inset:0;z-index:9999;',
      'background:var(--paper,#faf8f4);',
      'display:flex;flex-direction:column;align-items:center;justify-content:center;',
      'font-family:"DM Sans",sans-serif;',
    ].join('');

    el.innerHTML = [

      // ── Header ──
      '<div style="position:absolute;top:0;left:0;right:0;',
        'display:flex;align-items:center;justify-content:space-between;',
        'padding:1rem 1.5rem;',
        'border-bottom:1px solid var(--border,rgba(139,69,19,0.14));">',
        '<div style="display:flex;align-items:center;">',
          '<span style="font-family:\'Playfair Display\',serif;font-size:1.1rem;font-weight:600;',
            'letter-spacing:0.1em;color:var(--ink,#1a1714);">',
            'K<span style="color:var(--accent,#8B4513);">E</span>RNL',
          '</span>',
          '<span style="font-size:0.7rem;letter-spacing:0.15em;text-transform:uppercase;',
            'color:var(--accent,#8B4513);background:var(--accent-pale,rgba(139,69,19,0.08));',
            'padding:3px 10px;border-radius:20px;border:1px solid rgba(139,69,19,0.15);',
            'margin-left:10px;font-weight:500;">⚡ Swift</span>',
        '</div>',
        '<button id="ks-x" style="width:36px;height:36px;border-radius:50%;',
          'border:1px solid var(--border,rgba(139,69,19,0.14));',
          'background:transparent;cursor:pointer;font-size:1rem;',
          'color:var(--muted,#7a7060);">✕</button>',
      '</div>',

      // ── Stage ──
      '<div style="display:flex;flex-direction:column;align-items:center;',
        'gap:1.75rem;width:100%;max-width:640px;padding:0 2rem;">',

        // Word box — three-column fixed-pivot layout
        '<div style="width:100%;background:var(--card,#fff);',
          'border:1px solid var(--border,rgba(139,69,19,0.14));',
          'border-radius:16px;padding:2.5rem 0;position:relative;overflow:hidden;">',
          // Vertical guide line at centre (marks pivot position)
          '<div style="position:absolute;top:0;bottom:0;left:50%;width:2px;',
            'background:rgba(139,69,19,0.07);transform:translateX(-50%);"></div>',
          // Accent tick at top of guide
          '<div style="position:absolute;top:0;left:50%;width:2px;height:8px;',
            'background:var(--accent,#8B4513);opacity:0.5;transform:translateX(-50%);"></div>',
          // Three columns: before (right-align) | pivot (fixed centre) | after (left-align)
          '<div style="display:grid;grid-template-columns:1fr auto 1fr;',
            'align-items:baseline;width:100%;',
            'font-size:clamp(2rem,5vw,3rem);',
            'font-family:\'Playfair Display\',serif;font-weight:500;line-height:1;">',
            '<span id="ks-before" style="text-align:right;',
              'color:var(--ink,#1a1714);"></span>',
            '<span id="ks-pivot" style="color:var(--accent,#8B4513);',
              'font-weight:600;text-align:center;"></span>',
            '<span id="ks-after" style="text-align:left;',
              'color:var(--ink,#1a1714);"></span>',
          '</div>',
        '</div>',

        // Progress bar
        '<div style="width:100%;height:4px;background:var(--warm,#f0ebe0);',
          'border-radius:2px;overflow:hidden;">',
          '<div id="ks-pfill" style="height:100%;background:var(--accent,#8B4513);',
            'width:0%;transition:width 0.1s linear;border-radius:2px;"></div>',
        '</div>',

        // Word counter
        '<div id="ks-ct" style="font-size:0.78rem;color:var(--muted,#7a7060);',
          'font-variant-numeric:tabular-nums;">— / —</div>',

        // Controls
        '<div style="display:flex;align-items:center;gap:12px;">',
          '<button id="ks-rb" style="width:40px;height:40px;border-radius:50%;',
            'border:1px solid var(--border,rgba(139,69,19,0.14));',
            'background:transparent;cursor:pointer;font-size:1rem;',
            'color:var(--muted,#7a7060);">↺</button>',
          '<button id="ks-pb" style="width:56px;height:56px;border-radius:50%;',
            'background:var(--accent,#8B4513);border:none;cursor:pointer;',
            'font-size:1.4rem;color:#fff;',
            'box-shadow:0 2px 10px rgba(139,69,19,0.3);">▶</button>',
          '<div style="display:flex;gap:6px;">',
            '<button class="ks-spd" data-wpm="250" style="height:36px;padding:0 16px;',
              'border:1px solid var(--accent,#8B4513);border-radius:20px;',
              'background:var(--accent,#8B4513);color:#fff;font-weight:500;',
              'cursor:pointer;font-size:0.82rem;">1×</button>',
            '<button class="ks-spd" data-wpm="375" style="height:36px;padding:0 16px;',
              'border:1px solid var(--border,rgba(139,69,19,0.14));border-radius:20px;',
              'background:transparent;color:var(--muted,#7a7060);',
              'cursor:pointer;font-size:0.82rem;">1.5×</button>',
            '<button class="ks-spd" data-wpm="500" style="height:36px;padding:0 16px;',
              'border:1px solid var(--border,rgba(139,69,19,0.14));border-radius:20px;',
              'background:transparent;color:var(--muted,#7a7060);',
              'cursor:pointer;font-size:0.82rem;">2×</button>',
          '</div>',
        '</div>',

        '<div id="ks-wl" style="font-size:0.75rem;color:var(--muted,#7a7060);">',
          '250 words per minute',
        '</div>',
        '<div style="font-size:0.75rem;color:var(--muted,#7a7060);font-style:italic;opacity:0.7;">',
          'Focus on the highlighted letter — let the words come to you',
        '</div>',
      '</div>',

    ].join('');

    document.body.appendChild(el);
    overlay = el;

    // Wire events
    el.querySelectorAll('.ks-spd').forEach(function(btn) {
      var w = parseInt(btn.getAttribute('data-wpm'), 10);
      btn.classList.toggle('ks-active', w === currentWpm);
      btn.addEventListener('click', function() { setSpeed(w, btn); });
    });
    document.getElementById('ks-pb').addEventListener('click', togglePlay);
    document.getElementById('ks-rb').addEventListener('click', function() {
      stopTimer(); currentIdx = 0;
      if (words.length) renderWord(words[0]);
      setPlayState(false);
    });
    document.getElementById('ks-x').addEventListener('click', closeOverlay);

    // Keyboard shortcuts
    el._keyHandler = function(e) {
      if (e.key === 'Escape')     { closeOverlay(); return; }
      if (e.key === ' ')          { e.preventDefault(); togglePlay(); return; }
      if (e.key === 'ArrowLeft')  {
        stopTimer(); currentIdx = Math.max(0, currentIdx - 11);
        renderWord(words[currentIdx]); currentIdx++; setPlayState(false);
      }
      if (e.key === 'ArrowRight') {
        stopTimer(); currentIdx = Math.min(words.length - 1, currentIdx + 9);
        renderWord(words[currentIdx]); currentIdx++; setPlayState(false);
      }
    };
    document.addEventListener('keydown', el._keyHandler);

    // Show first word, auto-start after brief pause
    if (words.length) renderWord(words[0]);
    setTimeout(function() { startTimer(); }, 800);
  }

  global.KernlSwift = { open: open, close: closeOverlay };

})(window);
