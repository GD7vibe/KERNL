// Tests the REAL audio code from public/app.js (extracted between two markers) against fake Audio,
// AudioContext and network objects. Run: node test/audio.test.js   (must print ALL PASSED)
const fs = require('fs'), vm = require('vm'), assert = require('assert');

const src = fs.readFileSync(process.env.APP_JS || (__dirname + '/../public/app.js'), 'utf8');
const a = src.indexOf('// ── Audio state machine'), b = src.indexOf('// ── Send to Kindle');
assert(a > 0 && b > a, 'audio block markers not found in public/app.js');
const block = src.slice(a, b);

function makeWorld(opts) {
  opts = opts || {};
  const w = { created: [], contexts: [], fetchCalls: [], channelPosts: [], now: 1000, pro: true, safari: false };
  const el = () => ({ style: {}, classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, addEventListener() {}, textContent: '', innerHTML: '', disabled: false });
  const els = {};
  w.$ = id => els[id] || (els[id] = el());

  class FakeAudio {
    constructor(url) { this.url = url; this.src = url; this.paused = true; this.listeners = {}; this.duration = 100; this.currentTime = 0; w.created.push(this); }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    emit(t) { (this.listeners[t] || []).forEach(f => f({ target: this })); }
    play() { this.paused = false; this.emit('play'); return Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute() { this.src = ''; }
    load() {}
    get playing() { return !this.paused && !!this.src; }
  }
  class FakeCtx {
    constructor() { this.state = 'running'; this.currentTime = 0; this.sources = []; this.destination = {}; w.contexts.push(this); }
    resume() { this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; }
    close() { this.state = 'closed'; }
    async decodeAudioData() { return { duration: 2 }; }
    createBufferSource() { const s = { playbackRate: {}, connect() {}, started: false, stopped: false, start() { s.started = true; }, stop() { s.stopped = true; } }; this.sources.push(s); return s; }
  }
  w.liveSources = () => w.contexts.reduce((n, c) => n + (c.state !== 'closed' ? c.sources.filter(s => s.started && !s.stopped).length : 0), 0);
  w.playingAudio = () => w.created.filter(x => x.playing).length;

  const ctx = {
    console: { warn() {}, error() {}, log() {} }, Date: { now: () => w.now }, setTimeout, clearTimeout, Promise, URL, atob: s => Buffer.from(s, 'base64').toString('binary'),
    TextDecoder, Uint8Array,
    $: w.$, icon: n => n, fmtTime: n => String(n), toast() {}, updateMini() {}, tier: () => 'free',
    currentSummary: { title: 'Meditations', author: 'Marcus Aurelius' },
    isPro: () => w.pro, apiHeaders: async () => ({}),
    Audio: FakeAudio, BroadcastChannel: class { constructor() { w.channel = this; } postMessage(m) { w.channelPosts.push(m); } },
    MediaMetadata: class {}, document: { addEventListener() {} },
    window: { AudioContext: FakeCtx },
    navigator: { userAgent: opts.safari ? 'Mozilla/5.0 Version/17 Safari/605' : 'Mozilla/5.0 Chrome/120', mediaSession: { setActionHandler() {} }, maxTouchPoints: 0 },
    fetch: async (url, o) => {
      w.fetchCalls.push(url);
      if (url === '/api/tts') { await w.delay(); return { ok: true, json: async () => ({ url: w.cachedUrl || null }) }; }
      if (url === '/api/tts-stream') { await w.delay(); return w.streamResponse(); }
      return { ok: true, json: async () => ({}) };
    }
  };
  w.delay = () => new Promise(r => setTimeout(r, 15));
  w.cachedUrl = 'https://x/audio.mp3';
  w.ctx = vm.createContext(ctx);
  // The block declares its own lets; expose what the tests need.
  vm.runInContext(block + '\nthis.__api = { togglePlay, startTTS, stopAudio, pauseAudio, state: () => ({ isPlaying, _starting: typeof _starting === \'undefined\' ? false : _starting, audioEl, streamingAudioContext }) };', w.ctx);
  w.api = ctx.__api;
  return w;
}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let w;

  // 1. Double tap (two taps inside the guard window) = exactly one voice.
  w = makeWorld();
  w.api.togglePlay(); w.api.togglePlay();
  await wait(80);
  assert.strictEqual(w.created.length, 1, 'double tap made ' + w.created.length + ' audio objects');
  assert.strictEqual(w.playingAudio(), 1); console.log('ok double tap = one voice');

  // 2. startTTS called twice in a row (e.g. mini + big play button) = one voice.
  w = makeWorld();
  w.api.startTTS(); w.api.startTTS();
  await wait(80);
  assert.strictEqual(w.playingAudio(), 1); assert.strictEqual(w.created.length, 1); console.log('ok second start ignored while starting');

  // 3. A later tap while still starting CANCELS; nothing plays when the network answers.
  w = makeWorld();
  w.api.togglePlay(); w.now += 2000; w.api.togglePlay();
  await wait(80);
  assert.strictEqual(w.created.length, 0, 'cancelled start still created audio'); assert.strictEqual(w.api.state()._starting, false); console.log('ok tap during start cancels it');

  // 4. Stop (leaving the book) while the check is in flight: nothing may start afterwards.
  w = makeWorld();
  w.api.togglePlay(); w.api.stopAudio();
  await wait(80);
  assert.strictEqual(w.playingAudio(), 0); console.log('ok stop during start leaves silence');

  // 5. Switch book while the check is in flight: the old book must not play.
  w = makeWorld();
  w.api.togglePlay(); w.ctx.currentSummary = { title: 'Dune', author: 'Frank Herbert' }; w.api.stopAudio();
  await wait(80);
  assert.strictEqual(w.playingAudio(), 0); console.log('ok old book cannot start after switching');

  // 6. Normal play then pause then resume then stop.
  w = makeWorld();
  w.api.togglePlay(); await wait(60);
  assert.strictEqual(w.playingAudio(), 1);
  w.now += 2000; w.api.togglePlay(); assert.strictEqual(w.playingAudio(), 0, 'pause failed');
  w.api.togglePlay(); assert.strictEqual(w.playingAudio(), 1, 'resume failed'); assert.strictEqual(w.created.length, 1, 'resume made a new audio object');
  w.api.stopAudio(); assert.strictEqual(w.playingAudio(), 0); console.log('ok play / pause / resume / stop');

  // 7. Orphan guard: an element that was meant to be dead but starts playing anyway is stopped on the spot.
  w = makeWorld();
  w.api.togglePlay(); await wait(60);
  const dead = w.created[0];
  w.api.stopAudio(); w.now += 2000; w.api.togglePlay(); await wait(60);   // a new player now owns the screen
  dead.src = 'https://x/audio.mp3'; dead.play();                          // e.g. a media key or buffered resume revives the old one
  assert.strictEqual(dead.playing, false, 'revived old audio kept playing'); assert.strictEqual(w.playingAudio(), 1); console.log('ok revived old audio is silenced on play');

  // 8. A stale element finishing must not wipe the live player's reference.
  w = makeWorld();
  w.api.togglePlay(); await wait(60);
  const first = w.created[0];
  w.api.stopAudio(); w.now += 2000; w.api.togglePlay(); await wait(60);
  first.emit('ended'); first.emit('error');
  assert.ok(w.api.state().audioEl, 'stale ended/error cleared the live player'); assert.strictEqual(w.playingAudio(), 1); console.log('ok stale events cannot touch the live player');

  // 9. Restarting after stop leaves exactly one voice, and the old one is dead.
  assert.strictEqual(first.playing, false); console.log('ok restart leaves one voice');

  // 10. Another tab starting makes this tab pause.
  w = makeWorld();
  w.api.togglePlay(); await wait(60);
  w.channel.onmessage({ data: { playing: true, tab: 'someone-else' } });
  assert.strictEqual(w.playingAudio(), 0); console.log('ok other tab playing pauses this tab');
  assert.ok(w.channelPosts.length >= 1); console.log('ok this tab announces when it plays');

  // 11. Streaming path: stop part-way, no more sound is scheduled and no extra context stays open.
  w = makeWorld(); w.cachedUrl = null;
  let released = 0;
  w.streamResponse = () => {
    const chunks = [1, 2, 3, 4, 5, 6].map(i => 'data: ' + JSON.stringify({ mp3: Buffer.from('chunk' + i).toString('base64') }) + '\n');
    let i = 0;
    return { ok: true, headers: { get: () => 'text/event-stream' }, body: { getReader: () => ({ read: async () => { await wait(20); return i < chunks.length ? { done: false, value: Buffer.from(chunks[i++]) } : { done: true }; }, cancel() { released++; } }) } };
  };
  w.api.togglePlay(); await wait(90);
  assert.ok(w.liveSources() >= 1, 'stream did not start');
  w.api.stopAudio(); const before = w.contexts.reduce((n, c) => n + c.sources.length, 0);
  await wait(120);
  const after = w.contexts.reduce((n, c) => n + c.sources.length, 0);
  assert.strictEqual(after, before, 'sound was scheduled after stop'); assert.strictEqual(w.liveSources(), 0); assert.ok(w.contexts.every(c => c.state === 'closed')); assert.ok(released >= 1, 'stream reader was not cancelled');
  console.log('ok stopping a live stream really stops it');

  // 12. Streaming: stop then immediately start again; only the new stream sounds.
  w = makeWorld(); w.cachedUrl = null;
  w.streamResponse = () => { const chunks = [1, 2, 3].map(i => 'data: ' + JSON.stringify({ mp3: Buffer.from('c' + i).toString('base64') }) + '\n'); let i = 0; return { ok: true, headers: { get: () => 'text/event-stream' }, body: { getReader: () => ({ read: async () => { await wait(20); return i < chunks.length ? { done: false, value: Buffer.from(chunks[i++]) } : { done: true }; }, cancel() {} }) } }; };
  w.api.togglePlay(); await wait(70); w.api.stopAudio(); w.now += 2000; w.api.togglePlay(); await wait(200);
  const open = w.contexts.filter(c => c.state !== 'closed').length;
  assert.ok(open <= 1, open + ' audio contexts left open'); console.log('ok stop then restart streaming leaves one context');

  console.log('\nALL PASSED');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
