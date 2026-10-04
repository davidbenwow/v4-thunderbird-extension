// Reply linking for the Today triage page: which earlier message an inbound
// message answers, and whether anything was sent to that correspondent later.
// Pure — no WebExtension APIs — and total: missing fields never throw.
//
// Only an explicit reply header (In-Reply-To / References) is a link. A short
// reply attached to the wrong earlier message can read as approval of the wrong
// proof, and "latest message to the same person" is wrong too often to use, so
// same-subject matches are suggestions only and are never returned as the
// parent. A header parent is often not written by the mailbox owner, so the
// role of the parent's author is always reported.
//
// Requires triage-schema.js (TRISTATE) to be loaded first.

var TriageLink = (function () {
  'use strict';

  const DAY_MS = 86400000;
  const MIN_SUBJECT = 4;

  function normalizeHmid(id) {
    if (typeof id !== 'string') return '';
    let s = id.trim();
    if (s.length >= 2 && s.charAt(0) === '<' && s.charAt(s.length - 1) === '>') {
      s = s.slice(1, -1).trim();
    }
    return s.toLowerCase();
  }

  function normAddr(a) { return typeof a === 'string' ? a.trim().toLowerCase() : ''; }
  function fromAddr(e) { return e && e.from ? normAddr(e.from.address) : ''; }
  function dateOf(e) { return e && typeof e.date === 'number' && isFinite(e.date) ? e.date : null; }
  function sortKey(e) { const d = dateOf(e); return d === null ? -Infinity : d; }
  function nonNegative(v, fallback) { return typeof v === 'number' && isFinite(v) && v >= 0 ? v : fallback; }

  function recipients(e) {
    return (Array.isArray(e.to) ? e.to : []).concat(Array.isArray(e.cc) ? e.cc : []);
  }

  function buildIndex(entries) {
    const byHmid = new Map();
    const outboundTo = new Map();
    const outbound = [];
    let count = 0, oldest = null, newest = null;

    for (const e of Array.isArray(entries) ? entries : []) {
      if (!e || typeof e !== 'object') continue;
      const h = normalizeHmid(e.hmid);
      if (!h) continue;
      count++;
      const copies = byHmid.get(h);
      if (copies) copies.push(e); else byHmid.set(h, [e]);
      const d = dateOf(e);
      if (d !== null) {
        if (oldest === null || d < oldest) oldest = d;
        if (newest === null || d > newest) newest = d;
      }
      if (e.dir === 'outbound') outbound.push(e);
    }

    // One sort up front keeps every per-address list date-ascending, which the
    // lookups below binary-search. Undated entries sort first and can never
    // satisfy a date comparison.
    outbound.sort((a, b) => {
      const x = sortKey(a), y = sortKey(b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    for (const e of outbound) {
      const seen = new Set();
      for (const raw of recipients(e)) {
        const addr = normAddr(raw);
        if (!addr || seen.has(addr)) continue;
        seen.add(addr);
        const list = outboundTo.get(addr);
        if (list) list.push(e); else outboundTo.set(addr, [e]);
      }
    }

    return { byHmid, outboundTo, count, oldest, newest };
  }

  function outboundFor(index, addr) {
    const m = index && index.outboundTo;
    if (!addr || !m || typeof m.get !== 'function') return [];
    const list = m.get(addr);
    return Array.isArray(list) ? list : [];
  }

  // First position dated after t (strict) or at/after t.
  function bound(list, t, strict) {
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const k = sortKey(list[mid]);
      if (strict ? k <= t : k < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function lookup(index, id, acct) {
    const h = normalizeHmid(id);
    const m = index && index.byHmid;
    if (!h || !m || typeof m.get !== 'function') return null;
    const copies = m.get(h);
    if (!Array.isArray(copies)) return null;
    return copies.find((c) => c && c.acct === acct) || copies.find(Boolean) || null;
  }

  function roleOf(entry) {
    if (entry.dir !== 'outbound') return 'other';
    return entry.auto === true ? 'editor_automated' : 'editor';
  }

  // Header ids only. No subject or participant fallback, on purpose.
  function findExplicitParent(bodyFacts, index, acct) {
    if (!bodyFacts) return null;
    let entry = lookup(index, bodyFacts.irt, acct);
    if (entry) return { entry, role: roleOf(entry), via: 'in_reply_to' };
    const refs = Array.isArray(bodyFacts.refs) ? bodyFacts.refs : [];
    for (let i = refs.length - 1; i >= 0; i--) {
      entry = lookup(index, refs[i], acct);
      if (entry) return { entry, role: roleOf(entry), via: 'references' };
    }
    return null;
  }

  function findSuggestions(entry, index, opts) {
    const addr = fromAddr(entry);
    const date = dateOf(entry);
    const subj = entry && typeof entry.subjN === 'string' ? entry.subjN : '';
    if (!addr || date === null || subj.trim().length < MIN_SUBJECT) return [];

    const o = opts || {};
    const max = Math.floor(nonNegative(o.max, 3));
    const earliest = date - nonNegative(o.days, 90) * DAY_MS;
    const exclude = normalizeHmid(o.excludeHmid);
    const list = outboundFor(index, addr);

    const out = [];
    const slot = new Map();
    for (let i = bound(list, date, false) - 1; i >= 0; i--) {
      const c = list[i];
      const d = dateOf(c);
      if (d === null || d < earliest) break;
      if (c.subjN !== subj) continue;
      const h = normalizeHmid(c.hmid);
      if (exclude && h === exclude) continue;
      if (h && slot.has(h)) {
        // Second copy of a message already listed: keep the one in this account.
        const j = slot.get(h);
        if (out[j].acct !== entry.acct && c.acct === entry.acct) out[j] = c;
        continue;
      }
      if (out.length >= max) break;
      if (h) slot.set(h, out.length);
      out.push(c);
    }
    return out;
  }

  // "Did anything go out to this person BEFORE they wrote?" — the question
  // behind "do they still need the brochure?". An outreach mail the platform
  // sent under the editor's address counts as the introduction; a message she
  // wrote herself only shows they are not a cold contact. Both are observations
  // about the scanned folders, never proof.
  function earlierOutbound(entry, index, scope) {
    const T = TriageSchema.TRISTATE;
    const addr = fromAddr(entry);
    const date = dateOf(entry);
    if (!addr || date === null) return { state: T.UNKNOWN, hmid: null, auto: null };
    const list = outboundFor(index, addr);
    let intro = null, human = null;
    for (let i = bound(list, date, false) - 1; i >= 0; i--) {
      const c = list[i];
      if (!c) continue;
      if (c.auto === true) { intro = c; break; }
      if (!human) human = c;
    }
    const best = intro || human;
    if (best) return { state: T.FOUND, hmid: typeof best.hmid === 'string' ? best.hmid : null, auto: best.auto === true };
    const scanned = !!scope && scope.sentLikeScanned === true;
    return { state: scanned ? T.NOT_FOUND : T.UNKNOWN, hmid: null, auto: null };
  }

  // An observation ("a later message to this correspondent was located"), not
  // proof that the inbound message was answered.
  function laterOutbound(entry, index, scope) {
    const T = TriageSchema.TRISTATE;
    const addr = fromAddr(entry);
    const date = dateOf(entry);
    if (!addr || date === null) return { state: T.UNKNOWN, hmid: null, auto: null };

    const list = outboundFor(index, addr);
    let best = null, unknown = null, automated = null;
    for (let i = bound(list, date, true); i < list.length; i++) {
      const c = list[i];
      if (!c) continue;
      if (c.auto === false) { best = c; break; }
      if (c.auto === true) { if (!automated) automated = c; }
      else if (!unknown) unknown = c;
    }
    best = best || unknown || automated;
    if (best) {
      return {
        state: T.FOUND,
        hmid: typeof best.hmid === 'string' ? best.hmid : null,
        auto: best.auto === true || best.auto === false ? best.auto : null
      };
    }
    const scanned = !!scope && scope.sentLikeScanned === true;
    return { state: scanned ? T.NOT_FOUND : T.UNKNOWN, hmid: null, auto: null };
  }

  // The later messages from the editor to this correspondent that could be the
  // reply to `entry`, nearest first, never automated ones. Whether one of them
  // really answers it is decided by its reply headers, which the header index
  // does not hold — the scanner reads them for these few messages only.
  // `more` = there were further candidates beyond `max` that were not returned.
  function laterOutboundCandidates(entry, index, max) {
    const addr = fromAddr(entry);
    const date = dateOf(entry);
    const out = { list: [], more: false };
    if (!addr || date === null) return out;
    const limit = typeof max === 'number' && max > 0 ? max : 5;
    const list = outboundFor(index, addr);
    for (let i = bound(list, date, true); i < list.length; i++) {
      const c = list[i];
      if (!c || c.auto === true) continue;
      if (out.list.length >= limit) { out.more = true; break; }
      out.list.push(c);
    }
    return out;
  }

  return Object.freeze({ normalizeHmid, buildIndex, findExplicitParent, findSuggestions, laterOutbound, laterOutboundCandidates, earlierOutbound });
})();
