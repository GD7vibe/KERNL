// api/dedupe.js — weekly library clean-up: finds duplicate summaries and removes the extra copies.
//
// Who can run it: Vercel Cron (Authorization: Bearer $CRON_SECRET), or an admin script holding the service key.
// GET /api/dedupe          -> clean up (the weekly run)
// GET /api/dedupe?dry=1    -> report only, change nothing
//
// What counts as a duplicate (deliberately strict, because this deletes rows):
//   same author surname AND either the same title once case, punctuation, accents and a leading "The/A/An"
//   are ignored, or the same main title where one copy simply has no subtitle
//   ("Sapiens" and "Sapiens: A Brief History of Humankind").
//
// For each group of copies it keeps the best one (complete text, then has audio, then the oldest),
// and for every other copy:
//   1. moves each reader's saved-library entry onto the kept copy (or drops it if they already have that copy),
//   2. copies over a synopsis or categories the kept copy is missing,
//   3. records the removed row in sync_errors ('dedupe_removed') so it can be traced or restored,
//   4. deletes the duplicate.
// Safety: if more than MAX_REMOVALS copies would be removed in one run, nothing is changed and the run is
// recorded as 'dedupe_held' for a person to look at.
const K = require('../lib/kernl');

const MAX_REMOVALS = 25;
const enc = encodeURIComponent;

function normTitle(t) {
  return K.fold(t).replace(/[‘’'`]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/^(the|a|an) /, '');
}
function mainTitle(t) { return normTitle(String(t || '').split(/\s*[:—(]\s*|\s+[-–]\s+/)[0]); }
function surname(a) {
  const parts = K.fold(a).replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

// Groups rows that are copies of the same book. Exported for tests.
function findGroups(rows) {
  const byFull = new Map();
  for (const r of rows) {
    const s = surname(r.author);
    if (!s || !normTitle(r.title)) continue;            // no author or no title: never auto-matched
    const k = normTitle(r.title) + '|' + s;
    if (!byFull.has(k)) byFull.set(k, []);
    byFull.get(k).push(r);
  }
  // Join a no-subtitle copy with its subtitled twin (same main title, same surname).
  const byMain = new Map();
  for (const [k, list] of byFull) {
    const r = list[0], mk = mainTitle(r.title) + '|' + surname(r.author);
    if (!byMain.has(mk)) byMain.set(mk, []);
    byMain.get(mk).push(k);
  }
  for (const keys of byMain.values()) {
    // Only merge a pair where exactly one variant is the bare main title.
    // Two different subtitles (or three variants) stay separate books.
    if (keys.length !== 2) continue;
    const bare = keys.filter(k => k.split('|')[0] === mainTitle(byFull.get(k)[0].title));
    if (bare.length !== 1) continue;
    const other = keys.find(k => k !== bare[0]);
    byFull.set(bare[0], byFull.get(bare[0]).concat(byFull.get(other)));
    byFull.delete(other);
  }
  return [...byFull.values()].filter(g => g.length > 1);
}

function score(r, hasAudio) {
  const problems = K.summaryProblems(r.plain, r.html);
  const complete = !problems.includes('too_short') && !problems.includes('abrupt_end');
  // Synopsis and categories are not scored: a missing one is copied over from the duplicate anyway.
  return (complete ? 1000 : 0) + (hasAudio ? 100 : 0);
}

async function loadAll() {
  const all = [];
  for (let offset = 0; ; offset += 500) {
    const r = await K.sb('/rest/v1/summaries?select=id,title,author,lookup_key,synopsis,categories,plain,html&order=id.asc&limit=500&offset=' + offset);
    if (!r.ok) throw new Error('Could not read the library (' + r.status + ')');
    all.push(...(r.data || []));
    if (!r.data || r.data.length < 500) break;
  }
  return all;
}

async function moveReaders(fromId, toId) {
  const r = await K.sb('/rest/v1/user_library?select=id,user_id&summary_id=eq.' + fromId + '&limit=10000');
  const links = r.ok && Array.isArray(r.data) ? r.data : [];
  let moved = 0, merged = 0;
  for (const l of links) {
    const has = await K.sb('/rest/v1/user_library?select=id&user_id=eq.' + enc(l.user_id) + '&summary_id=eq.' + toId + '&limit=1');
    if (has.ok && Array.isArray(has.data) && has.data.length) {
      await K.sb('/rest/v1/user_library?id=eq.' + enc(l.id), { method: 'DELETE', prefer: 'return=minimal' });
      merged++;
    } else {
      await K.sb('/rest/v1/user_library?id=eq.' + enc(l.id), { method: 'PATCH', prefer: 'return=minimal', body: { summary_id: toId } });
      moved++;
    }
  }
  return { moved, merged };
}

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const token = K.bearer(req);
  const ctx = await K.authenticate(req);
  const cronOk = !!(secret && token && token === secret);
  if (!cronOk && !(ctx && ctx.admin)) return res.status(401).json({ error: 'Not allowed' });

  const dry = String((req.query && req.query.dry) || '') === '1';
  try {
    const rows = await loadAll();
    const groups = findGroups(rows);

    const plan = [];
    for (const g of groups) {
      const withAudio = await Promise.all(g.map(r => K.storageHas(K.audioKey(r.title, r.author, 'female')).catch(() => false)));
      const ranked = g.map((r, i) => ({ r, s: score(r, withAudio[i]) })).sort((a, b) => b.s - a.s || a.r.id - b.r.id);
      plan.push({ keep: ranked[0].r, remove: ranked.slice(1).map(x => x.r) });
    }
    const toRemove = plan.reduce((n, p) => n + p.remove.length, 0);
    const report = plan.map(p => ({ keep: { id: p.keep.id, title: p.keep.title, author: p.keep.author }, remove: p.remove.map(r => ({ id: r.id, title: r.title, author: r.author })) }));

    if (dry) return res.status(200).json({ dry: true, books: rows.length, groups: plan.length, toRemove, plan: report });

    if (toRemove > MAX_REMOVALS) {
      await K.logSyncError({ title: 'Library clean-up', author: '' }, null, 'dedupe_held',
        'Found ' + toRemove + ' duplicates (limit ' + MAX_REMOVALS + ' per run), so nothing was changed. Plan: ' + JSON.stringify(report).slice(0, 8000));
      return res.status(200).json({ held: true, books: rows.length, groups: plan.length, toRemove, plan: report });
    }

    let removed = 0;
    const done = [];
    for (const p of plan) {
      for (const dup of p.remove) {
        const readers = await moveReaders(dup.id, p.keep.id);
        const fill = {};
        if (!p.keep.synopsis && dup.synopsis) fill.synopsis = p.keep.synopsis = dup.synopsis;
        if ((!p.keep.categories || p.keep.categories === '[]') && dup.categories && dup.categories !== '[]') fill.categories = p.keep.categories = dup.categories;
        if (Object.keys(fill).length) await K.sb('/rest/v1/summaries?id=eq.' + p.keep.id, { method: 'PATCH', prefer: 'return=minimal', body: fill });
        await K.logSyncError({ title: dup.title, author: dup.author }, null, 'dedupe_removed', JSON.stringify({
          removed_id: dup.id, kept_id: p.keep.id, kept_title: p.keep.title, lookup_key: dup.lookup_key,
          synopsis: dup.synopsis || null, categories: dup.categories || null, readers_moved: readers.moved, readers_merged: readers.merged
        }));
        const del = await K.sb('/rest/v1/summaries?id=eq.' + dup.id, { method: 'DELETE', prefer: 'return=minimal' });
        if (del.ok) { removed++; done.push({ removed: dup.id, kept: p.keep.id, title: p.keep.title, readers }); }
        else console.error('[dedupe] delete failed for', dup.id, del.status);
      }
    }
    console.log('[dedupe] books', rows.length, 'groups', plan.length, 'removed', removed);
    return res.status(200).json({ books: rows.length, groups: plan.length, removed, done });
  } catch (e) {
    console.error('[dedupe] error:', e.message);
    return res.status(500).json({ error: 'Clean-up failed: ' + e.message });
  }
};
module.exports.findGroups = findGroups;
