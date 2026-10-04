// Persistence for the Today triage page. Everything lives under `triage:v1:*`
// in storage.local and is deliberately small: background.js reads the whole
// storage area at startup, so nothing large and no mail text is ever stored
// here. The header index is rebuilt in memory each session (message ids are
// session-scoped anyway).
//
//   triage:v1:config    settings
//   triage:v1:coverage  what the last scan covered
//   triage:v1:user      { <acct|hmid>: { state, until?, at, priorityOverride?, corrected? } }
//   triage:v1:undo      last 20 changes to user state, newest last, each named
//   triage:v1:verdicts  { <acct|hmid>: { hash, at, model, answers } }  capped LRU
//                       (`at` is last use: putVerdict writes it, touchVerdicts refreshes it)
//   triage:v1:followups { <acct|hmid>: { untilIso, at } }   rows the model parked until a date
//   triage:v1:rescue    { <acct|hmid>: { at, tries, misses } }  when each was last looked for
//
// `create(storage)` takes a storage.local-like object so tests can pass a fake.

var TriageStore = (function () {
  'use strict';

  const K = Object.freeze({
    config: 'triage:v1:config',
    coverage: 'triage:v1:coverage',
    user: 'triage:v1:user',
    undo: 'triage:v1:undo',
    verdicts: 'triage:v1:verdicts',
    followups: 'triage:v1:followups',
    rescue: 'triage:v1:rescue'
  });

  const DEFAULT_CONFIG = Object.freeze({
    enabled: false,           // switched on automatically the first time the add-on runs (see setupDone)
    setupDone: false,         // once true, "off" is the editor's choice and is respected
    folderMode: 'all',        // 'all' = every mail folder except Sent/Drafts/Trash/Junk/…; 'chosen' = config.folders
    accounts: [],
    folders: [],
    candidateDays: 30,
    lookbackDays: 180,
    modelOff: false,          // the editor's own switch: true = nothing is sent for classification
    shadow: false,            // true = answers shown as evidence only, rows grouped by code alone
    showNewsletters: false    // newsletters are hidden from the page; the count stays on the coverage line
  });

  // Comfortably more than a busy multi-mailbox 30-day queue (251 rows measured
  // across five mailboxes), so the working set of one scan fits with room to
  // spare. Answers only, rounded to two decimals: a few hundred KB at the cap.
  const MAX_VERDICTS = 500;
  const VERDICT_TTL_MS = 90 * 86400000;
  const MAX_UNDO = 20;
  // Six times the widest candidate window: a mark this old cannot belong to a
  // message Today would still look at.
  const USER_STATE_TTL_MS = 180 * 86400000;
  // `pinned` = added by hand ("Add to Today"): a candidate whatever its folder or age.
  const USER_FIELDS = ['state', 'until', 'priorityOverride', 'corrected', 'pinned'];

  function create(storage, nowFn) {
    const now = typeof nowFn === 'function' ? nowFn : () => Date.now();
    // One chain for every read-modify-write: two quick clicks must not lose
    // each other's change.
    let chain = Promise.resolve();
    function locked(fn) {
      const run = chain.then(fn, fn);
      chain = run.then(() => {}, () => {});
      return run;
    }

    async function read(key, fallback) {
      const got = await storage.get(key);
      const v = got && got[key];
      return v === undefined || v === null ? fallback : v;
    }
    function write(key, value) { return storage.set({ [key]: value }); }

    async function getConfig() {
      const saved = await read(K.config, {});
      const cfg = Object.assign({}, DEFAULT_CONFIG, saved && typeof saved === 'object' ? saved : {});
      // Fields of the test builds that held a model key on the editor's machine.
      delete cfg.backend; delete cfg.consentAt;
      return cfg;
    }

    function setConfig(patch) {
      return locked(async () => {
        const next = Object.assign(await getConfig(), patch || {});
        await write(K.config, next);
        return next;
      });
    }

    // Classification runs through the OmniReply service with the editor's V4
    // key, so there is nothing to set up: it is on unless Today or the editor's
    // own switch is off. Whether the service is READY is asked before each scan
    // (the scanner's `modelReady`), not stored here.
    function mayCallModel(config) {
      return !!config && config.enabled === true && config.modelOff !== true;
    }

    async function getCoverage() { return read(K.coverage, null); }
    function setCoverage(coverage) { return write(K.coverage, coverage); }

    async function getUserStates() {
      const all = await read(K.user, {});
      return all && typeof all === 'object' ? all : {};
    }

    // changes: [{ key, patch }] — one undo entry per call, so a bulk action is
    // undone in one step.
    function applyUserChanges(changes, label) {
      return locked(async () => {
        const all = await getUserStates();
        const before = [];
        for (const c of Array.isArray(changes) ? changes : []) {
          if (!c || typeof c.key !== 'string') continue;
          before.push({ key: c.key, prev: all[c.key] === undefined ? null : all[c.key] });
          const next = Object.assign({}, all[c.key] || {});
          for (const f of USER_FIELDS) if (c.patch && f in c.patch) {
            if (c.patch[f] === null || c.patch[f] === undefined) delete next[f]; else next[f] = c.patch[f];
          }
          next.at = now();
          if (Object.keys(next).length === 1) delete all[c.key]; else all[c.key] = next;
        }
        if (!before.length) return { changed: 0, undoId: null };
        const undo = await read(K.undo, []);
        // Every entry is named, so an Undo attached to one particular action
        // (putting an archived message back) reverses that action and not
        // whatever the editor happened to do afterwards in another tab.
        const id = 'u' + now().toString(36) + Math.random().toString(36).slice(2, 8);
        undo.push({ id, at: now(), label: String(label || ''), before });
        while (undo.length > MAX_UNDO) undo.shift();
        await storage.set({ [K.user]: all, [K.undo]: undo });
        return { changed: before.length, undoId: id };
      });
    }

    function revert(pick) {
      return locked(async () => {
        const undo = await read(K.undo, []);
        const at = pick(undo);
        if (at === -1) return null;
        const entry = undo[at];
        undo.splice(at, 1);
        const all = await getUserStates();
        for (const b of entry.before) { if (b.prev === null) delete all[b.key]; else all[b.key] = b.prev; }
        await storage.set({ [K.user]: all, [K.undo]: undo });
        return { label: entry.label, restored: entry.before.length };
      });
    }

    function undoLast() { return revert((undo) => undo.length - 1); }

    // Undo one named change wherever it now sits in the stack. Returns null if
    // it has already been undone or has aged out, so the caller can say so
    // rather than silently reversing something else.
    function undoById(id) {
      if (typeof id !== 'string' || !id) return Promise.resolve(null);
      return revert((undo) => undo.findIndex((e) => e && e.id === id));
    }

    // Two pieces of bookkeeping the scanner keeps, apart from the editor's own
    // marks: they are derived, not her judgement, so they are never undone,
    // never restored and never shown as something she did.
    //
    //  followUps  a row the model parked until a date. Without it the message
    //             ages out of the candidate window while it waits, and the
    //             follow-up the page promised never comes back.
    //  rescueLog  when a message was last looked for by name, and how often it
    //             was not found — so marks whose message has been deleted stop
    //             eating the lookup budget that live ones need.
    async function getFollowUps() {
      const all = await read(K.followups, {});
      return all && typeof all === 'object' ? all : {};
    }
    function setFollowUps(map) { return locked(() => write(K.followups, map || {})); }

    async function getRescueLog() {
      const all = await read(K.rescue, {});
      return all && typeof all === 'object' ? all : {};
    }
    // results: [{ key, found }] — plus the keys still worth remembering, so the
    // log cannot outgrow the marks it is about.
    function noteRescue(results, keepKeys) {
      return locked(async () => {
        const all = await getRescueLog();
        for (const r of Array.isArray(results) ? results : []) {
          if (!r || typeof r.key !== 'string') continue;
          const prev = all[r.key] || { tries: 0, misses: 0 };
          all[r.key] = { at: now(), tries: (prev.tries || 0) + 1, misses: r.found ? 0 : (prev.misses || 0) + 1 };
        }
        const keep = new Set(Array.isArray(keepKeys) ? keepKeys : []);
        for (const k of Object.keys(all)) if (!keep.has(k)) delete all[k];
        await write(K.rescue, all);
      });
    }

    async function getVerdict(key, hash) {
      const all = await read(K.verdicts, {});
      const v = all[key];
      if (!v || v.hash !== hash || now() - v.at > VERDICT_TTL_MS) return null;
      return v;
    }

    // `keep` is the set of keys the caller is still working through. Without it
    // a scan a little larger than the cache evicted its own upcoming hits: each
    // miss threw out the next message's entry, so every message missed and the
    // whole mailbox was classified again on the shared quota. Entries in `keep`
    // are evicted last.
    function putVerdict(key, hash, model, answers, keep) {
      return locked(async () => {
        const all = await read(K.verdicts, {});
        all[key] = { hash, at: now(), model: model || null, answers: roundAnswers(answers) };
        const over = Object.keys(all).length - MAX_VERDICTS;
        if (over > 0) {
          const spare = (k) => !(keep && typeof keep.has === 'function' && keep.has(k));
          const order = Object.keys(all).sort((a, b) =>
            (spare(a) === spare(b) ? 0 : spare(a) ? -1 : 1) || all[a].at - all[b].at);
          for (const k of order.slice(0, over)) if (k !== key) delete all[k];
        }
        await write(K.verdicts, all);
      });
    }

    // A cache hit is a use: without this, reading an entry left it as old as it
    // was and the next scan evicted the answers it had just relied on. Called
    // once at the end of a scan rather than on every read.
    function touchVerdicts(keys) {
      const list = Array.isArray(keys) ? keys : Array.from(keys || []);
      if (!list.length) return Promise.resolve(0);
      return locked(async () => {
        const all = await read(K.verdicts, {});
        let n = 0;
        for (const k of list) if (all[k]) { all[k].at = now(); n++; }
        if (n) await write(K.verdicts, all);
        return n;
      });
    }

    // Marks accumulate for as long as Today is used and nothing ever removed
    // one. A "done" mark that old belongs to a message far outside the
    // candidate window, so dropping it cannot make anything reappear — while a
    // snooze, a pin, a priority the editor set or a correction she made is
    // outstanding work or her own judgement, and is kept however old it is.
    function pruneUserStates() {
      return locked(async () => {
        const all = await getUserStates();
        let removed = 0;
        for (const k of Object.keys(all)) {
          const u = all[k] || {};
          const outstanding = u.pinned || u.priorityOverride || u.corrected || u.state === 'snoozed';
          if (!outstanding && typeof u.at === 'number' && now() - u.at > USER_STATE_TTL_MS) { delete all[k]; removed++; }
        }
        if (removed) await write(K.user, all);
        return removed;
      });
    }

    function pruneVerdicts() {
      return locked(async () => {
        const all = await read(K.verdicts, {});
        let removed = 0;
        for (const k of Object.keys(all)) if (now() - all[k].at > VERDICT_TTL_MS) { delete all[k]; removed++; }
        if (removed) await write(K.verdicts, all);
        return removed;
      });
    }

    function dropVerdicts() { return locked(() => storage.remove(K.verdicts)); }

    // "Delete Today data": every key this feature ever wrote, nothing else.
    function deleteAll() { return locked(() => storage.remove(Object.keys(K).map((k) => K[k]))); }

    return Object.freeze({
      getConfig, setConfig, mayCallModel, getCoverage, setCoverage,
      getUserStates, applyUserChanges, undoLast, undoById,
      getFollowUps, setFollowUps, getRescueLog, noteRescue,
      getVerdict, putVerdict, touchVerdicts, pruneVerdicts, pruneUserStates, dropVerdicts, deleteAll
    });
  }

  function roundAnswers(answers) {
    const out = {};
    const r = (n) => (typeof n === 'number' ? Math.round(n * 100) / 100 : n);
    for (const id of Object.keys(answers || {})) {
      const a = answers[id];
      out[id] = typeof a === 'number' ? r(a)
        : Object.assign({}, a, { p: r(a.p), confidence: r(a.confidence) });
    }
    return out;
  }

  return Object.freeze({ KEYS: K, DEFAULT_CONFIG, MAX_VERDICTS, create });
})();
