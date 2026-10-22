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

function coverSvg(title, author) {
  const { main, sub } = splitTitle(title);
  const CARD = { x: 110, y: 560, w: 1380, h: 1460 };
  const textW = CARD.w - 190;                         // inner width available for text
  const X = CARD.x + 95;

  // Largest title size that fits the space (about 62% of the card height is for the title block).
  const room = Math.floor(CARD.h * 0.5);
  let fs = 88, lines = clampLines(wrapWords(main, Math.floor(textW / (88 * 0.64))), 8);
  for (const size of [176, 160, 144, 128, 114, 102, 92]) {
    const l = wrapWords(main, Math.floor(textW / (size * 0.64)));
    if (l.length * size * 1.14 <= room) { fs = size; lines = l; break; }
  }
  const leading = Math.round(fs * 1.14);
  const subFs = 62, subLines = sub ? clampLines(wrapWords(sub, Math.floor(textW / (subFs * 0.58))), 3) : [];
  const authFs = 66, authLines = clampLines(wrapWords(author ? 'by ' + author : '', Math.floor(textW / (authFs * 0.58))), 2);

  let y = CARD.y + 150 + fs * 0.82;
  const titleSvg = lines.map((ln, i) => '<text x="' + X + '" y="' + Math.round(y + i * leading) + '" font-family="Plus Jakarta Sans" font-weight="800" font-size="' + fs + '" fill="#17122b">' + esc(ln) + '</text>').join('');
  y = y + (lines.length - 1) * leading + 120;
  const subSvg = subLines.map((ln, i) => '<text x="' + X + '" y="' + Math.round(y + i * 84) + '" font-family="Plus Jakarta Sans" font-weight="500" font-size="' + subFs + '" fill="#4b4468">' + esc(ln) + '</text>').join('');
  const authY = CARD.y + CARD.h - 110 - (authLines.length - 1) * 84;
  const authSvg = authLines.map((ln, i) => '<text x="' + X + '" y="' + (authY + i * 84) + '" font-family="Plus Jakarta Sans" font-weight="500" font-size="' + authFs + '" fill="#238a83">' + esc(ln) + '</text>').join('');

  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + COVER_W + '" height="' + COVER_H + '" viewBox="0 0 ' + COVER_W + ' ' + COVER_H + '">' +
    '<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3ecfb"/><stop offset="1" stop-color="#ddd0f4"/></linearGradient></defs>' +
    '<rect width="' + COVER_W + '" height="' + COVER_H + '" fill="url(#bg)"/>' +
    '<circle cx="1430" cy="260" r="470" fill="#a98cf0" fill-opacity="0.22"/>' +
    '<circle cx="90" cy="2330" r="400" fill="#238a83" fill-opacity="0.14"/>' +
    '<text x="' + CARD.x + '" y="360" font-family="Plus Jakarta Sans" font-weight="800" font-size="60" letter-spacing="12" fill="#238a83">KERNL SUMMARY</text>' +
    '<rect x="' + CARD.x + '" y="410" width="230" height="16" rx="8" fill="#238a83"/>' +
    '<rect x="' + (CARD.x + 26) + '" y="' + (CARD.y + 26) + '" width="' + CARD.w + '" height="' + CARD.h + '" rx="56" fill="#17122b"/>' +
    '<rect x="' + CARD.x + '" y="' + CARD.y + '" width="' + CARD.w + '" height="' + CARD.h + '" rx="56" fill="#ffffff" stroke="#17122b" stroke-width="10"/>' +
    '<rect x="' + X + '" y="' + (CARD.y + 100) + '" width="120" height="12" rx="6" fill="#a98cf0"/>' +
    titleSvg + subSvg + authSvg +
    '<text x="' + CARD.x + '" y="2330" font-family="Plus Jakarta Sans" font-weight="500" font-size="54" fill="#4b4468">kernlbooks.com</text>' +
    '<text x="' + CARD.x + '" y="2400" font-family="Plus Jakarta Sans" font-weight="500" font-size="40" fill="#6f6890">AI book summaries to read or listen to</text>' +
    '</svg>';
}

// Returns a PNG Buffer, or null if the renderer is unavailable (the EPUB is then sent without a cover).
function renderCover(title, author) {
  try {
    const { Resvg } = require('@resvg/resvg-js');
    const resvg = new Resvg(coverSvg(title, author), {
      font: {
        fontFiles: [path.join(FONT_DIR, 'PlusJakartaSans_800ExtraBold.ttf'), path.join(FONT_DIR, 'PlusJakartaSans_500Medium.ttf')],
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

  const content = XHTML_HEAD + '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en-GB"><head><meta http-equiv="Content-Type" content="application/xhtml+xml; charset=utf-8"/><title>' + t + '</title><style type="text/css">' + CSS + '</style></head><body>' +
    '<h1>' + t + '</h1>' + (a ? '<div class="byline">by ' + a + ' — KERNL Summary</div>' : '<div class="byline">KERNL Summary</div>') +
    toXhtml(opts.html) + '<div class="footer">Generated by KERNL — for the curious</div></body></html>';

  const coverPage = XHTML_HEAD + '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en-GB"><head><meta http-equiv="Content-Type" content="application/xhtml+xml; charset=utf-8"/><title>Cover</title>' +
    '<style type="text/css">body{margin:0;padding:0;text-align:center}img{max-width:100%;height:auto}</style></head><body><div><img src="cover.png" alt="' + t + '"/></div></body></html>';

  const opf = '<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bid" version="2.0">\n' +
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">\n' +
    '<dc:title>' + bookTitle + '</dc:title>\n' +
    '<dc:creator opf:role="aut">' + (a || 'KERNL') + '</dc:creator>\n' +
    '<dc:publisher>KERNL</dc:publisher>\n' +
    '<dc:language>en-GB</dc:language>\n' +
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
