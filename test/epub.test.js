// node test/epub.test.js  — must print ALL PASSED
const assert = require('assert'), JSZip = require('jszip');
const E = require('../lib/epub');

(async () => {
  // Messy model-style HTML becomes well-formed XHTML and loses nothing readable.
  const x = E.toXhtml('<h2>Smith & Wesson</h2><p>One<br>two &nbsp;&mdash; three<p>x < y and 5 > 3 <em>e <strong>s</em> t</strong><script>bad()</script><img src=x onerror=1>');
  assert.ok(x.includes('Smith &amp; Wesson')); assert.ok(x.includes('<br/>')); assert.ok(x.includes('x &lt; y and 5 &gt; 3'));
  assert.ok(!/script|bad\(|onerror|<img/i.test(x)); assert.ok(!/<p><p>|<h2><p>/.test(x));
  const opens = (x.match(/<(?!\/)[a-z0-9]+(?=[ >])/g) || []).length, closes = (x.match(/<\/[a-z0-9]+>/g) || []).length;
  assert.strictEqual(opens, closes); console.log('ok messy html becomes balanced, escaped xhtml');

  // Cover: a real PNG at the right size.
  const png = E.renderCover('Sapiens: A Brief History of Humankind', 'Yuval Noah Harari');
  assert.ok(png && png.slice(1, 4).toString() === 'PNG', 'cover is not a PNG'); assert.strictEqual(png.readUInt32BE(16), E.COVER_W); assert.strictEqual(png.readUInt32BE(20), E.COVER_H);
  console.log('ok cover is a ' + E.COVER_W + 'x' + E.COVER_H + ' PNG');
  assert.deepStrictEqual(E.splitTitle('Sapiens: A Brief History of Humankind'), { main: 'Sapiens', sub: 'A Brief History of Humankind' });
  assert.deepStrictEqual(E.splitTitle('Meditations'), { main: 'Meditations', sub: '' }); console.log('ok title splits into main + subtitle');

  // Long single word is never split; year shown only when given; K drawn behind the text.
  const svgM = E.coverSvg('Meditations', 'Marcus Aurelius', null);
  assert.ok(svgM.includes('>Meditations</text>'), 'Meditations was split'); assert.ok(!/>\d{4}<\/text>/.test(svgM), 'year drawn when none given');
  const svgW = E.coverSvg('The Coming Wave', 'Mustafa Suleyman', 2023);
  assert.ok(svgW.includes('>2023</text>')); assert.ok(svgW.includes('>Mustafa Suleyman</text>')); assert.ok((svgW.match(/<path d=/g) || []).length >= 12, 'K not drawn');
  assert.ok(E.renderCover('The Coming Wave', 'Mustafa Suleyman', 2023).length > 1000);
  console.log('ok cover: no split words, author + year, embossed K');

  // The EPUB itself.
  const buf = await E.buildEpub({ title: 'Tom & Jerry: "Cat" <and> Mouse', author: 'A. N. Author', html: '<h2>One</h2><p>Text & more.</p>', cover: png });
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files);
  assert.strictEqual(names[0], 'mimetype', 'mimetype must be first'); assert.strictEqual(await zip.file('mimetype').async('string'), 'application/epub+zip');
  ['META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/toc.ncx', 'OEBPS/content.xhtml', 'OEBPS/cover.xhtml', 'OEBPS/cover.png'].forEach(n => assert.ok(zip.file(n), 'missing ' + n));
  const opf = await zip.file('OEBPS/content.opf').async('string');
  assert.ok(opf.includes('<dc:title>Tom &amp; Jerry: &quot;Cat&quot; &lt;and&gt; Mouse — KERNL</dc:title>')); assert.ok(opf.includes('<dc:creator opf:role="aut">A. N. Author</dc:creator>'));
  assert.ok(opf.includes('<meta name="cover" content="cover-image"/>')); assert.ok(/urn:uuid:[0-9a-f-]{36}/.test(opf));
  console.log('ok epub has title, author, id and cover link');

  // No cover available (renderer missing): still a complete EPUB, just without the cover entries.
  const plain = await JSZip.loadAsync(await E.buildEpub({ title: 'Meditations', author: '', html: '<p>Hi.</p>', cover: null }));
  assert.ok(!plain.file('OEBPS/cover.png')); assert.ok(!(await plain.file('OEBPS/content.opf').async('string')).includes('cover-image')); console.log('ok epub still builds without a cover');
  console.log('\nALL PASSED');
})().catch(e => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
