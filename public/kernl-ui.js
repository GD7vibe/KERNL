/* KERNL shared UI helpers. Loaded in <head> on every page so the theme is applied before first paint. */
(function () {
  'use strict';

  // ── Theme ────────────────────────────────────────────────────────────────
  // 'kernl_dark' is '1' / '0' once the visitor has chosen; before that we follow the device.
  function isDark() { return document.documentElement.classList.contains('dark'); }
  (function applyInitialTheme() {
    var saved = null;
    try { saved = localStorage.getItem('kernl_dark'); } catch (e) {}
    var prefers = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (saved === '1' || (saved === null && prefers)) document.documentElement.classList.add('dark');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', isDark() ? '#15112a' : '#f3ecfb');
  })();

  // ── Icons (stroke icons, 24x24) ──────────────────────────────────────────
  var ICONS = {
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    play: '<path class="f" d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    download: '<path d="M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    print: '<path d="M6 9V3h12v6M6 18H4a1 1 0 0 1-1-1v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6a1 1 0 0 1-1 1h-2"/><rect x="6" y="14" width="12" height="7" rx="1"/>',
    send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>',
    cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h3l2.7 12.4a1 1 0 0 0 1 .8h8.8a1 1 0 0 0 1-.8L20 7H6"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    back: '<path d="M15 18l-6-6 6-6"/>',
    more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    library: '<path d="M4 4v16M9 4v16M14 6l5 14M4 20h10"/>',
    headphones: '<path d="M3 14v-2a9 9 0 0 1 18 0v2"/><rect x="3" y="14" width="4" height="7" rx="1.5"/><rect x="17" y="14" width="4" height="7" rx="1.5"/>',
    chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
    sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.7 1.8L21.5 18.5l-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z"/>',
    book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5M9 7h6"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>'
  };
  function icon(name, cls) {
    var body = ICONS[name] || '';
    var fill = name === 'play';
    return '<svg class="icon' + (fill ? ' fill' : '') + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + body.replace('class="f" ', '') + '</svg>';
  }

  // ── Text helpers ─────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtDate(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // ── Book covers: a stable colour per title, from a restrained, warm palette ──
  var COVERS = ['#f5c04a', '#f4a3bf', '#f2a07b', '#8ed2f5', '#86d9b8', '#b8a5f3', '#6cc4bd', '#f28f8f'];
  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function coverStyle(title) {
    return 'background:' + COVERS[hash(String(title || '').toLowerCase()) % COVERS.length];
  }

  // ── Toasts ───────────────────────────────────────────────────────────────
  function toast(msg, type, ms) {
    var host = document.getElementById('toasts');
    if (!host) { host = document.createElement('div'); host.id = 'toasts'; host.className = 'toasts'; host.setAttribute('role', 'status'); host.setAttribute('aria-live', 'polite'); document.body.appendChild(host); }
    var t = document.createElement('div');
    t.className = 'toast' + (type ? ' ' + type : '');
    t.textContent = msg;
    host.appendChild(t);
    setTimeout(function () { t.style.transition = 'opacity .25s'; t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 260); }, ms || 4200);
  }

  // ── Modals ───────────────────────────────────────────────────────────────
  // modal(innerHtml, {sheet}) -> { el, close }. Escape and a click on the backdrop close it.
  var openModals = 0;
  function modal(innerHtml, opts) {
    opts = opts || {};
    var ov = document.createElement('div');
    ov.className = 'overlay' + (opts.sheet === false ? '' : ' sheet');
    ov.innerHTML = '<div class="modal" role="dialog" aria-modal="true">' + innerHtml + '</div>';
    document.body.appendChild(ov);
    openModals++;
    document.body.style.overflow = 'hidden';
    var prevFocus = document.activeElement;
    function close() {
      if (!ov.parentNode) return;
      ov.remove();
      document.removeEventListener('keydown', onKey, true);
      openModals = Math.max(0, openModals - 1);
      if (!openModals) document.body.style.overflow = '';
      if (opts.onClose) opts.onClose();
      if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (e) {} }
    }
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
    var first = ov.querySelector('[autofocus],input,textarea,button.primary');
    if (first) setTimeout(function () { try { first.focus(); } catch (e) {} }, 40);
    return { el: ov, close: close };
  }
  // confirm(title, text, okLabel, {danger}) -> Promise<boolean>. Replaces the browser's confirm().
  function confirmDialog(title, text, okLabel, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var done = false;
      var m = modal(
        '<h3>' + esc(title) + '</h3><p class="sub">' + esc(text) + '</p>' +
        '<div class="modal-actions"><button class="btn" data-no>Cancel</button><button class="btn ' + (opts.danger ? 'danger' : 'primary') + '" data-yes>' + esc(okLabel || 'OK') + '</button></div>',
        { onClose: function () { if (!done) { done = true; resolve(false); } } }
      );
      m.el.querySelector('[data-no]').onclick = function () { m.close(); };
      m.el.querySelector('[data-yes]').onclick = function () { done = true; resolve(true); m.close(); };
    });
  }

  // ── Popover menus ────────────────────────────────────────────────────────
  // popover(triggerButton, menuElement): toggles on click, closes on outside click / Escape.
  function popover(trigger, menu) {
    function close() { menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); }
    function open() { menu.hidden = false; trigger.setAttribute('aria-expanded', 'true'); }
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('click', function (e) { e.stopPropagation(); if (menu.hidden) open(); else close(); });
    menu.addEventListener('click', function (e) { if (e.target.closest('.menu-item')) close(); });
    document.addEventListener('click', function (e) { if (!menu.hidden && !menu.contains(e.target) && !trigger.contains(e.target)) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !menu.hidden) { close(); trigger.focus(); } });
    return { open: open, close: close };
  }

  // ── Theme toggle buttons: any element with [data-theme-toggle] ───────────
  function paintToggles() {
    var dark = isDark();
    document.querySelectorAll('[data-theme-toggle]').forEach(function (b) {
      b.innerHTML = icon(dark ? 'sun' : 'moon');
      b.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
      b.setAttribute('title', dark ? 'Light mode' : 'Dark mode');
    });
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#15112a' : '#f3ecfb');
  }
  function toggleTheme() {
    var dark = document.documentElement.classList.toggle('dark');
    try { localStorage.setItem('kernl_dark', dark ? '1' : '0'); } catch (e) {}
    paintToggles();
  }
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-theme-toggle]').forEach(function (b) { b.addEventListener('click', toggleTheme); });
    paintToggles();
    // Fill any <span data-icon="name"> placeholders so pages can use icons in plain markup.
    document.querySelectorAll('[data-icon]').forEach(function (el) { el.innerHTML = icon(el.getAttribute('data-icon')); el.style.display = 'inline-flex'; });
  });

  window.KUI = { esc: esc, icon: icon, fmtDate: fmtDate, coverStyle: coverStyle, toast: toast, modal: modal, confirm: confirmDialog, popover: popover, toggleTheme: toggleTheme, isDark: isDark };
})();
