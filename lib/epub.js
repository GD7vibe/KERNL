// lib/epub.js — builds the EPUB that is emailed to a Kindle.
//
// Why this exists as its own file: Amazon's converter is strict. If the book text is not well-formed XHTML (a bare "&",
// an unclosed tag) or the package has no cover, the item arrives with no usable title or icon. So this file
//   1. rewrites the stored summary HTML into guaranteed well-formed XHTML,
//   2. writes full metadata (title, author, language, unique id, cover link), and
//   3. draws a cover image with the book name and author on it.
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');

const FONT_DIR = path.join(__dirname, 'fonts');
const COVER_W = 1600, COVER_H = 2560;
// The KERNL K (from Gary's K.pdf): four shapes in a 626-unit box starting at (150, 202).
const K_PATHS = ["M587.1 796.1L585.9 796.7L568 803.8L549.7 809.9L531 814.7L512.1 818.4L493 820.9L473.7 822.1L454.5 822.2L435.2 821L416.1 818.7L403 816.2L403 658L463.2 576.6Z M587.1 796.1", "M673.6 292.3L679.5 297.8L692.7 311.8L705.1 326.6L716.4 342.1L726.8 358.4L736.2 375.3L744.4 392.7L751.6 410.6L757.6 428.9L762.4 447.6L766.1 466.5L768.6 485.6L769.9 504.8L769.9 524.1L768.8 543.4L766.4 562.5L762.9 581.4L758.1 600.1L752.2 618.5L745.2 636.4L737 653.9L727.8 670.8L717.5 687.1L706.2 702.8L694 717.7L687.7 724.4L543.1 468.6Z M673.6 292.3", "M403 214.7L414.2 212.5L433.3 210L452.6 208.7L471.8 208.7L491.1 209.8L510.2 212.2L529.2 215.7L547.9 220.5L566.2 226.4L568.9 227.4L403 451.6Z M403 214.7", "M259.5 285.9L274.3 273.5L280.2 269.2L280.2 761.7L275.8 758.5L260.9 746.2L246.8 733.1L233.6 719.1L221.3 704.3L209.9 688.7L199.5 672.5L190.2 655.6L181.9 638.2L174.7 620.3L168.7 602L163.9 583.3L160.2 564.4L157.7 545.2L156.5 526L156.4 506.7L157.6 487.5L159.9 468.4L163.5 449.4L168.2 430.7L174.1 412.4L181.1 394.4L189.3 377L198.5 360L208.8 343.7L220.1 328.1L232.3 313.2L245.5 299.1Z M259.5 285.9"];

// ── XML helpers ──────────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const NAMED = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', trade: '™', pound: '£', euro: '€',
  eacute: 'é', egrave: 'è', agrave: 'à', aacute: 'á', uuml: 'ü', ouml: 'ö', auml: 'ä', ccedil: 'ç',
  ntilde: 'ñ', times: '×', deg: '°', middot: '·', bull: '•', laquo: '«', raquo: '»'
};
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = (e[1] === 'x' || e[1] === 'X') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return (n > 0 && n < 0x110000 && !(n >= 0xd800 && n <= 0xdfff)) ? String.fromCodePoint(n) : '';
    }
    const k = e.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED, k) ? NAMED[k] : m;
  });
}

// Turn the stored summary HTML into well-formed XHTML: only simple formatting tags survive, no attributes,
// every tag is closed and properly nested, and all text is escaped.
const KEEP = new Set(['h1', 'h2', 'h3', 'h4', 'p', 'em', 'strong', 'i', 'b', 'u', 'ul', 'ol', 'li', 'blockquote', 'br', 'hr', 'sup', 'sub']);
const VOID = new Set(['br', 'hr']);
const BLOCK = new Set(['h1', 'h2', 'h3', 'h4', 'p', 'ul', 'ol', 'blockquote', 'hr']);
function toXhtml(html) {
  const cleaned = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, '');
  const out = [], stack = [];
  const closeTop = () => out.push('</' + stack.pop() + '>');
  for (const tok of cleaned.split(/(<[^<>]*>)/)) {
    if (!tok) continue;
    const m = (tok[0] === '<' && tok[tok.length - 1] === '>') ? /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(tok) : null;
    if (m) {                                        // a real tag (a "<" followed by a space, like "x < y", stays as text)
      const name = m[2].toLowerCase();
      if (!KEEP.has(name)) continue;
      if (m[1]) {                                   // closing tag
        if (stack.indexOf(name) === -1) continue;
        while (stack[stack.length - 1] !== name) closeTop();
        closeTop();
      } else if (VOID.has(name)) {
        if (BLOCK.has(name)) while (stack.length && stack[stack.length - 1] === 'p') closeTop();
        out.push('<' + name + '/>');
      } else {
        if (BLOCK.has(name)) while (stack.length && stack[stack.length - 1] === 'p') closeTop();
        if (name === 'li') while (stack.length && stack[stack.length - 1] === 'li') closeTop();
        stack.push(name); out.push('<' + name + '>');
      }
    } else {
      out.push(esc(decodeEntities(tok)).replace(/&quot;/g, '"'));
    }
  }
  while (stack.length) closeTop();
  return out.join('');
}

// ── Cover image ──────────────────────────────────────────────────────────────
function wrapWords(text, maxChars) {
  const lines = []; let cur = '';
  for (let word of String(text).split(/\s+/).filter(Boolean)) {
    while (word.length > maxChars) { if (cur) { lines.push(cur); cur = ''; } lines.push(word.slice(0, maxChars)); word = word.slice(maxChars); }
    if (!cur) cur = word;
    else if ((cur + ' ' + word).length <= maxChars) cur += ' ' + word;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines;
}
function clampLines(lines, max) {
  if (lines.length <= max) return lines;
  const out = lines.slice(0, max);
  out[max - 1] = out[max - 1].replace(/[\s,;:.\-–—]+$/, '') + '…';
  return out;
}
// "Sapiens: A Brief History of Humankind" -> main "Sapiens", sub "A Brief History of Humankind"
function splitTitle(title) {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  const m = /^(.{3,}?)\s*(?::|\s[—–-]\s)\s*(.{3,})$/.exec(t);
  return m ? { main: m[1].trim(), sub: m[2].trim() } : { main: t, sub: '' };
}

function coverSvg(title, author, year) {
  const { main, sub } = splitTitle(title);
  const CARD = { x: 110, y: 560, w: 1380, h: 1460 };
  const textW = CARD.w - 190;
  const X = CARD.x + 95;

  // Author block at the bottom of the card: big dark name, year underneath.
  const authFs = 84, authLead = 100;
  const authLines = clampLines(wrapWords(author || '', Math.floor(textW / (authFs * 0.6))), 2);
  const yearFs = 64, hasYear = !!year;
  const blockBottom = CARD.y + CARD.h - 105;
  const yearY = blockBottom;
  const authLastY = hasYear ? yearY - 96 : blockBottom;
  const authFirstY = authLastY - (authLines.length - 1) * authLead;
  const ruleY = authFirstY - authFs - 34;

  // Title gets whatever space is left above the author block.
  const room = (ruleY - 70) - (CARD.y + 150);
  let fs = 88, lines = clampLines(wrapWords(main, Math.floor(textW / (88 * 0.64))), 7);
  for (const size of [176, 160, 144, 128, 114, 102, 92]) {
    const maxChars = Math.floor(textW / (size * 0.64));
    if (main.split(/\s+/).some(w => w.length > maxChars)) continue;   // never break a word: try a smaller size
    const l = wrapWords(main, maxChars);
    const subH = sub ? 120 + 84 * Math.min(3, wrapWords(sub, Math.floor(textW / (62 * 0.58))).length) : 0;
    if (l.length * size * 1.14 + subH <= room) { fs = size; lines = l; break; }
  }
  const leading = Math.round(fs * 1.14);
  const subFs = 62, subLines = sub ? clampLines(wrapWords(sub, Math.floor(textW / (subFs * 0.58))), 3) : [];

  let y = CARD.y + 150 + fs * 0.82;
  const T = (x, yy, w, size, fill, txt, extra) => '<text x="' + x + '" y="' + Math.round(yy) + '" font-family="Plus Jakarta Sans" font-weight="' + w + '" font-size="' + size + '" fill="' + fill + '"' + (extra || '') + '>' + esc(txt) + '</text>';
  const titleSvg = lines.map((ln, i) => T(X, y + i * leading, 800, fs, '#17122b', ln)).join('');
  y = y + (lines.length - 1) * leading + 110;
  const subSvg = subLines.map((ln, i) => T(X, y + i * 84, 500, subFs, '#3d3658', ln)).join('');
  const authSvg = authLines.map((ln, i) => T(X, authFirstY + i * authLead, 700, authFs, '#17122b', ln)).join('');
  const yearSvg = hasYear ? T(X, yearY, 600, yearFs, '#1b726c', String(year), ' letter-spacing="3"') : '';
  const rule = '<rect x="' + X + '" y="' + ruleY + '" width="120" height="10" rx="5" fill="#238a83"/>';

  // Large embossed K in the middle of the card, behind the text: a pale fill with a darker edge
  // bottom-right and a lighter edge top-left, so it reads as pressed into the paper.
  const kSize = 1060, kx = CARD.x + (CARD.w - kSize) / 2, ky = CARD.y + (CARD.h - kSize) / 2;
  const kShape = K_PATHS.map(d => '<path d="' + d + '"/>').join('');
  const kAt = (dx, dy, fill) => '<g transform="translate(' + (kx + dx) + ' ' + (ky + dy) + ') scale(' + (kSize / 626).toFixed(5) + ') translate(-150 -202)" fill="' + fill + '">' + kShape + '</g>';
  const kEmboss = kAt(7, 9, '#e2dbee') + kAt(-5, -5, '#ffffff') + kAt(0, 0, '#f1ecf8');

  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + COVER_W + '" height="' + COVER_H + '" viewBox="0 0 ' + COVER_W + ' ' + COVER_H + '">' +
    '<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3ecfb"/><stop offset="1" stop-color="#ddd0f4"/></linearGradient>' +
    '<clipPath id="card"><rect x="' + CARD.x + '" y="' + CARD.y + '" width="' + CARD.w + '" height="' + CARD.h + '" rx="56"/></clipPath></defs>' +
    '<rect width="' + COVER_W + '" height="' + COVER_H + '" fill="url(#bg)"/>' +
    '<circle cx="1430" cy="260" r="470" fill="#a98cf0" fill-opacity="0.22"/>' +
    '<circle cx="90" cy="2330" r="400" fill="#238a83" fill-opacity="0.14"/>' +
    T(CARD.x, 360, 800, 60, '#238a83', 'RESUMEN KERNL', ' letter-spacing="12"') +
    '<rect x="' + CARD.x + '" y="410" width="230" height="16" rx="8" fill="#238a83"/>' +
    '<rect x="' + (CARD.x + 26) + '" y="' + (CARD.y + 26) + '" width="' + CARD.w + '" height="' + CARD.h + '" rx="56" fill="#17122b"/>' +
    '<rect x="' + CARD.x + '" y="' + CARD.y + '" width="' + CARD.w + '" height="' + CARD.h + '" rx="56" fill="#fdfcff"/>' +
    '<g clip-path="url(#card)">' + kEmboss + '</g>' +
    '<rect x="' + CARD.x + '" y="' + CARD.y + '" width="' + CARD.w + '" height="' + CARD.h + '" rx="56" fill="none" stroke="#17122b" stroke-width="10"/>' +
    '<rect x="' + X + '" y="' + (CARD.y + 100) + '" width="120" height="12" rx="6" fill="#a98cf0"/>' +
    titleSvg + subSvg + rule + authSvg + yearSvg +
    T(CARD.x, 2330, 500, 54, '#4b4468', 'kernlbooks.com') +
    T(CARD.x, 2400, 500, 40, '#6f6890', 'Resúmenes de libros con IA para leer o escuchar') +
    '</svg>';
}

// Returns a PNG Buffer, or null if the renderer is unavailable (the EPUB is then sent without a cover).
function renderCover(title, author, year) {
  try {
    const { Resvg } = require('@resvg/resvg-js');
    const resvg = new Resvg(coverSvg(title, author, year), {
      font: {
        fontFiles: ['800ExtraBold', '700Bold', '500Medium'].map(n => path.join(FONT_DIR, 'PlusJakartaSans_' + n + '.ttf')),
        loadSystemFonts: false, defaultFontFamily: 'Plus Jakarta Sans'
      },
      fitTo: { mode: 'width', value: COVER_W }
    });
    return Buffer.from(resvg.render().asPng());
  } catch (e) {
    console.error('[epub] cover not made:', e.message);
    return null;
  }
}

// ── EPUB ─────────────────────────────────────────────────────────────────────
const CSS = 'body{font-family:Georgia,serif;font-size:1em;line-height:1.75;margin:1.5em 2em}h1{font-size:1.8em;margin-bottom:.2em}' +
  '.byline{font-style:italic;color:#777;margin-bottom:2em}h2{font-size:1.05em;font-weight:bold;margin:1.8em 0 .5em;padding-bottom:5px;border-bottom:1px solid #ddd;color:#8B4513}' +
  'p{margin:0 0 .9em;text-align:justify}.footer{margin-top:3em;font-size:.8em;color:#aaa;font-style:italic}';

const XHTML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">\n';

// opts: { title, author, html, cover (PNG Buffer or null) }  ->  Buffer (the .epub file)
async function buildEpub(opts) {
  const title = String(opts.title || '').trim(), author = String(opts.author || '').trim();
  const t = esc(title), a = esc(author), cover = opts.cover || null;
  const id = 'urn:uuid:' + crypto.randomUUID();
  const bookTitle = esc(title + ' — KERNL');
  const date = new Date().toISOString().slice(0, 10);

  const content = XHTML_HEAD + '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="es-419"><head><meta http-equiv="Content-Type" content="application/xhtml+xml; charset=utf-8"/><title>' + t + '</title><style type="text/css">' + CSS + '</style></head><body>' +
    '<h1>' + t + '</h1>' + (a ? '<div class="byline">de ' + a + ' — Resumen KERNL</div>' : '<div class="byline">Resumen KERNL</div>') +
    toXhtml(opts.html) + '<div class="footer">Creado por KERNL — Lee menos. Sabe más.</div></body></html>';

  const coverPage = XHTML_HEAD + '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="es-419"><head><meta http-equiv="Content-Type" content="application/xhtml+xml; charset=utf-8"/><title>Portada</title>' +
    '<style type="text/css">body{margin:0;padding:0;text-align:center}img{max-width:100%;height:auto}</style></head><body><div><img src="cover.png" alt="' + t + '"/></div></body></html>';

  const opf = '<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bid" version="2.0">\n' +
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">\n' +
    '<dc:title>' + bookTitle + '</dc:title>\n' +
    '<dc:creator opf:role="aut">' + (a || 'KERNL') + '</dc:creator>\n' +
    '<dc:publisher>KERNL</dc:publisher>\n' +
    '<dc:language>es-419</dc:language>\n' +
    '<dc:date>' + date + '</dc:date>\n' +
    '<dc:identifier id="bid">' + id + '</dc:identifier>\n' +
    (cover ? '<meta name="cover" content="cover-image"/>\n' : '') +
    '</metadata>\n<manifest>\n' +
    (cover ? '<item id="cover-image" href="cover.png" media-type="image/png"/>\n<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>\n' : '') +
    '<item id="c" href="content.xhtml" media-type="application/xhtml+xml"/>\n' +
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n</manifest>\n' +
    '<spine toc="ncx">' + (cover ? '<itemref idref="cover"/>' : '') + '<itemref idref="c"/></spine>\n' +
    (cover ? '<guide><reference type="cover" title="Cover" href="cover.xhtml"/></guide>\n' : '') +
    '</package>';

  const ncx = '<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n' +
    '<head><meta name="dtb:uid" content="' + id + '"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>\n' +
    '<docTitle><text>' + bookTitle + '</text></docTitle>' + (a ? '<docAuthor><text>' + a + '</text></docAuthor>' : '') + '\n' +
    '<navMap><navPoint id="n1" playOrder="1"><navLabel><text>' + t + '</text></navLabel><content src="content.xhtml"/></navPoint></navMap>\n</ncx>';

  const container = '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
    '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n</container>';

  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });   // must be first and uncompressed
  zip.folder('META-INF').file('container.xml', container);
  const oebps = zip.folder('OEBPS');
  oebps.file('content.opf', opf);
  oebps.file('toc.ncx', ncx);
  oebps.file('content.xhtml', content);
  if (cover) { oebps.file('cover.xhtml', coverPage); oebps.file('cover.png', cover); }
  return await zip.generateAsync({ type: 'nodebuffer', mimeType: 'application/epub+zip', compression: 'DEFLATE' });
}

module.exports = { buildEpub, toXhtml, renderCover, coverSvg, splitTitle, esc, COVER_W, COVER_H };
