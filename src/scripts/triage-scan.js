// The Today scan: headers index -> candidates -> bodies (candidates only) ->
// explicit links -> V4 leads -> model -> rows. Every browser call goes through
// `deps.api`, so the whole pipeline runs against a fake mailbox in tests.
//
// Invariants:
//  - single-flight, cancellable: a newer run or cancel() invalidates the old
//    one at the next await (generation counter, as in background.js);
//  - bodies are fetched only for candidates and for an explicit parent written
//    by the editor, never above LIMITS.maxBodyBytes, two at a time;
//  - message text lives in memory for the length of the session and is never
//    written to storage;
//  - nothing is sent to the model unless store.mayCallModel(config) is true,
//    the body loaded, and the authored text could be separated unambiguously.

var TriageScan = (function () {
  'use strict';

  const S = TriageSchema;
  const DAY = 86400000;
  const ROW_SYSTEM_TYPES = ['manuscript_submitted', 'manuscripts_transferred'];
  // Thunderbird calls the Local Folders account type "none". It holds real mail
  // — archives an editor dragged out of the server, and anything imported — so
  // it is scanned like any other account. News and feeds are not mail.
  const NON_MAIL_TYPES = ['rss', 'nntp'];
  // Snoozed or pinned messages older than the header window are looked up one by
  // one; the ceiling keeps a profile full of old marks from turning a scan into
  // an unbounded number of single-message searches. What it leaves out is
  // counted in the coverage, never dropped quietly.
  const MAX_RESCUE_LOOKUPS = 200;
  // How long a mark waits after its message could not be found, by miss count.
  // A server that is offline today costs an hour; a message that really has
  // been deleted is asked about once a week and no longer crowds out the marks
  // whose messages are still there.
  const MISS_BACKOFF = [3600000, 6 * 3600000, DAY, 7 * DAY];
  // How long a parked follow-up is still worth chasing after its date. Beyond
  // this the message is far outside the window anyway and the record is dropped
  // rather than kept for ever.
  const FOLLOWUP_GRACE = 60 * DAY;
  // Never a place where mail that needs the editor arrives.
  const NOT_CANDIDATE = ['sent', 'drafts', 'trash', 'junk', 'templates', 'outbox', 'archives'];
  // Many IMAP servers do not mark their special folders, so Thunderbird reports
  // no specialUse for them (they show as plain folders). Names are the fallback.
  const NAMES = {
    sent: ['sent', 'sent items', 'sent mail', 'sent messages', 'sent-mail', 'gesendet', 'gesendete elemente', 'gesendete objekte', 'envoy\u00E9s', '\u00E9l\u00E9ments envoy\u00E9s', 'messages envoy\u00E9s', 'enviados', 'elementos enviados', 'inviata', 'posta inviata', '\u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043D\u044B\u0435', 'trimise', 'elemente trimise'],
    drafts: ['drafts', 'draft', 'entw\u00FCrfe', 'brouillons', 'borradores', 'bozze', '\u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u0438', 'ciorne'],
    trash: ['trash', 'deleted items', 'deleted messages', 'bin', 'papierkorb', 'corbeille', 'papelera', 'cestino', '\u043A\u043E\u0440\u0437\u0438\u043D\u0430', '\u0443\u0434\u0430\u043B\u0435\u043D\u043D\u044B\u0435'],
    junk: ['junk', 'spam', 'junk e-mail', 'junk email', 'bulk mail', 'junk-e-mail', 'spamverdacht',
      'unerw\u00FCnscht', 'unerw\u00FCnschte e-mails', 'courrier ind\u00E9sirable', 'ind\u00E9sirables', 'pourriel', 'pourriels',
      'correo no deseado', 'no deseado', 'posta indesiderata', 'indesiderata',
      'mesaje nedorite', 'nedorite', 'lixo eletr\u00F4nico',
      '\u0441\u043F\u0430\u043C', '\u043D\u0435\u0436\u0435\u043B\u0430\u0442\u0435\u043B\u044C\u043D\u0430\u044F \u043F\u043E\u0447\u0442\u0430'],
    templates: ['templates', 'vorlagen', 'mod\u00E8les'],
    outbox: ['outbox', 'unsent messages'],
    archives: ['archive', 'archives', 'archiv', 'all mail']
  };

  // What a folder is for: Thunderbird's own mark first, then its name. Archive
  // subfolders ("Archives/2026") count as archives through any path segment.
  function folderKind(f) {
    const su = f.specialUse || [];
    for (const k of NOT_CANDIDATE) if (su.indexOf(k) !== -1) return k;
    if (su.indexOf('inbox') !== -1) return 'inbox';
    const segs = String(f.path || f.name || '').toLowerCase().split('/').map((x) => x.trim()).filter(Boolean);
    const last = lower(f.name).split('/').filter(Boolean).pop() || segs[segs.length - 1] || '';
    for (const k of Object.keys(NAMES)) if (k !== 'archives' && NAMES[k].indexOf(last) !== -1) return k;
    if (segs.some((x) => NAMES.archives.indexOf(x) !== -1)) return 'archives';
    return null;
  }

  function lower(v) { return typeof v === 'string' ? v.trim().toLowerCase() : ''; }

  // "Jane Roe <jane@example.org>" -> { name, address }. Bounded, first match only.
  function parseMailbox(raw) {
    const s = typeof raw === 'string' ? raw.slice(0, 1000) : '';
    const m = /<\s*([^<>\s]{1,320}@[^<>\s]{1,255})\s*>/.exec(s) || /([A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,255})/.exec(s);
    const address = m ? m[1].toLowerCase() : '';
    const lt = s.indexOf('<');
    const name = TriageText.sanitizeDisplay((lt > 0 ? s.slice(0, lt) : '').replace(/^["'\s]+|["'\s]+$/g, ''), S.LIMITS.nameDisplay);
    return { name: name && name.toLowerCase() !== address ? name : '', address };
  }

  function headerList(full, name) {
    const h = full && full.headers && full.headers[name];
    return Array.isArray(h) ? h : typeof h === 'string' ? [h] : [];
  }

  function messageIdsIn(values) {
    const out = [];
    for (const v of values) {
      const re = /<([^<>\s]{1,400})>/g;
      let m, n = 0;
      const s = String(v).slice(0, 20000);
      while ((m = re.exec(s)) && n++ < 60) out.push(m[1]);
      if (!n && s.trim()) out.push(s.trim());
    }
    return out;
  }

  // When the editor asked to see this again: a snooze that has run out is more
  // overdue than one still running, and a pin or a priority she set is due from
  // the moment she set it.
  function dueAt(us, followUp) {
    if (us && us.state === 'snoozed' && typeof us.until === 'number') return us.until;
    if (followUp && followUp.untilIso) { const t = Date.parse(followUp.untilIso + 'T00:00:00Z'); if (!isNaN(t)) return t; }
    return (us && typeof us.at === 'number') ? us.at : (followUp && followUp.at) || 0;
  }

  async function pool(items, size, worker) {
    let i = 0;
    const runners = [];
    for (let k = 0; k < size; k++) {
      runners.push((async () => { while (i < items.length) { const item = items[i++]; await worker(item); } })());
    }
    await Promise.all(runners);
  }

  function create(deps) {
    const api = deps.api;
    const store = deps.store;
    const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
    const isInternal = typeof deps.isInternal === 'function' ? deps.isInternal : () => false;
    const bodyText = deps.bodyText;
    const transferHost = typeof deps.transferHost === 'function' ? deps.transferHost : () => null;
    const checkLeads = deps.checkLeads;
    const decide = deps.decide;
    const beginModelRun = typeof deps.beginModelRun === 'function' ? deps.beginModelRun : () => {};
    // Asked once per scan, BEFORE any text is prepared for sending: is there a
    // service to send to? -> { ok } or { ok: false, why: 'no_v4_key' | 'unavailable' }.
    const modelReady = typeof deps.modelReady === 'function' ? deps.modelReady : async () => ({ ok: true });
    const listFolders = typeof deps.listFolders === 'function' ? deps.listFolders : (accountId) => api.folders.query({ accountId });

    let generation = 0;
    let running = null;
    let retrying = false;
    const session = { rows: [], coverage: null, status: 'idle', texts: new Map(), sent: new Map(), facts: new Map(), answers: new Map(), replyLinks: new Map(), parents: new Map(), userStates: {}, newslettersHidden: 0 };

    class Cancelled extends Error {}

    function cancel() { generation++; }
    function snapshot() { return { rows: session.rows, coverage: session.coverage, status: session.status, modelState: session.modelState || 'off' }; }
    function whatWasSent(key) { return session.sent.get(key) || null; }
    function excerptOf(key) { const t = session.texts.get(key); return t ? t.excerpt : ''; }
    function entryOf(key) { const f = session.facts.get(key); return f ? f.entry : null; }
    function parentEntryOf(key) { const f = session.facts.get(key); return f && f.parent ? f.parent : null; }

    // Every page of a one-message lookup. A result that fits on page one is the
    // normal case, but "not found" must mean not found, not "not on page one".
    async function queryAll(query) {
      const out = [];
      let page = await api.messages.query(query);
      for (let guard = 0; guard < 200; guard++) {
        for (const h of page.messages || []) out.push(h);
        if (!page.id || typeof api.messages.continueList !== 'function') break;
        const next = await api.messages.continueList(page.id);
        if (!next || !(next.messages || []).length) break;
        page = next;
      }
      return out;
    }

    // The earlier message is read only when the editor opens the row (or when the
    // model needs it), never for every candidate.
    async function parentExcerpt(key) {
      const p = parentEntryOf(key);
      if (!p) return '';
      const cached = session.texts.get(key + '#parent');
      if (cached) return cached.excerpt;
      const text = await parentText(p);
      const excerpt = text === null ? '' : TriageText.excerpt(TriageText.authoredText(text, {}).text);
      session.texts.set(key + '#parent', { excerpt });
      return excerpt;
    }

    // The earlier message the editor wrote, read at most once however many rows
    // point at it — and never read at all when it is over the size limit, which
    // the candidate messages have always respected and this one did not.
    function parentText(p) {
      if (!p || (p.size || 0) > S.LIMITS.maxBodyBytes) return Promise.resolve(null);
      const cacheKey = p.folderId + '|' + p.hmid;
      if (!session.parents.has(cacheKey)) {
        session.parents.set(cacheKey, api.messages.getFull(p.mid)
          .then((full) => String(bodyText(full) || '')).catch(() => null));
      }
      return session.parents.get(cacheKey);
    }

    function run(hooks) {
      if (running && !retrying) return running;
      // A full scan outranks a retry of a few rows: bumping the generation stops it.
      const gen = ++generation;
      retrying = false;
      const mine = doRun(gen, hooks || {}).catch((e) => {
        if (!(e instanceof Cancelled)) { session.status = 'error'; if (hooks && hooks.onError) hooks.onError(String(e && e.message || e)); }
        return snapshot();
      }).finally(() => { if (running === mine) running = null; });
      running = mine;
      return mine;
    }

    async function doRun(gen, hooks) {
      const alive = () => { if (gen !== generation) throw new Cancelled(); };
      // What the page's "getting ready" card shows while nothing else can be:
      // which stage, how far into it, and the few numbers that stage has found.
      const progress = (phase, done, total, extra) => { if (hooks.onProgress) hooks.onProgress(Object.assign({ phase, done, total }, extra || {})); };
      const config = await store.getConfig();
      if (!config.enabled) { session.status = 'disabled'; session.rows = []; return snapshot(); }
      session.status = 'scanning';
      // A fresh run starts from nothing: no text or payload from an earlier scan
      // may outlive the messages it came from.
      session.texts = new Map(); session.sent = new Map(); session.facts = new Map(); session.answers = new Map(); session.replyLinks = new Map(); session.parents = new Map();
      const startedAt = now();

      // ---- who is "me", which folders -------------------------------------------
      const allMode = config.folderMode !== 'chosen';
      const usableAccounts = (await api.accounts.list(false)).filter((a) => NON_MAIL_TYPES.indexOf(a.type) === -1);
      // Local Folders (Thunderbird calls the type "none", and names it in the
      // editor's own language) is a filing cabinet, not an imprint mailbox. It
      // is skipped whenever there is a real mail account — and still scanned
      // when it is all there is, so a Local-Folders-only profile still works.
      const realMail = usableAccounts.filter((a) => a.type !== 'none');
      const accounts = (realMail.length ? realMail : usableAccounts)
        .filter((a) => allMode || !config.accounts.length || config.accounts.indexOf(a.id) !== -1);
      alive();
      const me = new Set(), names = [];
      for (const a of accounts) for (const id of a.identities || []) {
        if (lower(id.email)) me.add(lower(id.email));
        if (id.name) names.push(String(id.name));
      }
      const folders = new Map();
      const coverageFolders = [];
      let sentLikeScanned = accounts.length > 0;
      // One folder listing per account serves everything: Sent (to see later
      // messages from the editor) and the candidate folders. In 'all' mode the
      // list is re-read on every scan, so a folder created tomorrow is covered.
      const wanted = new Set(config.folders || []);
      for (const a of accounts) {
        let list = [];
        try { list = await listFolders(a.id); } catch (e) { coverageFolders.push({ id: a.id, path: null, seen: 0, complete: false, error: 'folders_unavailable' }); }
        const usable = list.filter((f) => f && f.id && !f.isVirtual && !f.isUnified && !f.isTag && !f.isRoot);
        for (const f of usable) {
          const kind = folderKind(f);
          // Sent is always read (never as a place for candidates); the other
          // special folders are not read at all.
          if (kind === 'sent') folders.set(f.id, { folder: f, candidate: false, kind });
          else if (NOT_CANDIDATE.indexOf(kind) !== -1) continue;
          else if (allMode || wanted.has(f.id)) folders.set(f.id, { folder: f, candidate: true, kind });
        }
      }
      alive();

      // ---- headers index ------------------------------------------------------------
      const entries = [];
      const since = new Date(startedAt - config.lookbackDays * DAY);
      let fi = 0;
      const mailboxes = accounts.map((a) => ({ id: a.id, name: a.name || a.id, identities: (a.identities || []).map((i) => i && i.email).filter(Boolean) }));
      for (const { folder: f, candidate, kind } of folders.values()) {
        progress('index', fi++, folders.size, { messages: entries.length, mailboxes });
        const cov = { id: f.id, accountId: f.accountId, path: f.path, kind: kind || null, seen: 0, outbound: 0, outboundAuto: 0, oldest: null, newest: null, complete: false, error: null, candidate, sentLike: false };
        coverageFolders.push(cov);
        try {
          let page = await api.messages.query({ folderId: f.id, fromDate: since, messagesPerPage: 200 });
          for (;;) {
            alive();
            for (const h of page.messages || []) {
              const e = indexEntry(h, f, candidate, me);
              if (!e) continue;
              entries.push(e);
              cov.seen++;
              if (e.dir === 'outbound') { cov.outbound++; if (e.auto === true) cov.outboundAuto++; }
              if (cov.oldest === null || e.date < cov.oldest) cov.oldest = e.date;
              if (cov.newest === null || e.date > cov.newest) cov.newest = e.date;
            }
            if (!page.id) break;
            page = await api.messages.continueList(page.id);
          }
          cov.complete = true;
        } catch (e) {
          if (e instanceof Cancelled) throw e;
          cov.error = 'query_failed';
        }
      }
      // "Did we read where the editor's own replies live?" A folder counts when it
      // is marked or named Sent, or when it is mostly hand-written mail from the
      // editor — platform copies sent under their address (all automated) do not.
      for (const c of coverageFolders) {
        const human = c.outbound - c.outboundAuto;
        c.sentLike = !!c.complete && (c.kind === 'sent' || (c.seen >= 5 && human / c.seen >= 0.5));
      }
      // Whether we can see the editor's replies is a question per account, not
      // one answer for the whole profile: Local Folders holds archives and has
      // no Sent folder of its own, and one mailbox without Sent must not make
      // every other mailbox's rows say "unable to check".
      const sentLikeByAccount = new Map();
      for (const a of accounts) {
        const mine = coverageFolders.filter((c) => c.accountId === a.id);
        sentLikeByAccount.set(a.id, mine.some((c) => c.sentLike) && !mine.some((c) => c.kind === 'sent' && !c.complete));
      }
      const index = TriageLink.buildIndex(entries);
      progress('index', folders.size, folders.size, { messages: entries.length, oldest: index.oldest, mailboxes, days: config.candidateDays });
      alive();

      // ---- candidates ----------------------------------------------------------------
      const userStates = await store.getUserStates();
      session.userStates = userStates;
      const cutoff = startedAt - config.candidateDays * DAY;
      // What the editor asked to see again, and what Today itself promised to
      // bring back: a row parked until a date is an obligation the page has
      // already displayed, so it must survive the candidate window exactly as a
      // snooze does — otherwise the message ages out while it waits and the
      // follow-up never arrives.
      const followUps = await store.getFollowUps();
      const outstanding = (us) => !!(us && (us.pinned || us.state === 'snoozed' || us.priorityOverride));
      const retained = (key) => outstanding(userStates[key]) || !!followUps[key];
      const byKey = new Map();
      for (const e of entries) {
        const wanted = retained(e.key) ||
          (e.inCandidateFolder && e.date >= cutoff && (e.dir === 'inbound' || e.dir === 'internal' ||
            (e.dir === 'system' && ROW_SYSTEM_TYPES.indexOf(e.sysType) !== -1)));
        if (!wanted || e.dir === 'outbound') continue;
        const prev = byKey.get(e.key);
        if (!prev || rank(e) < rank(prev)) byKey.set(e.key, e);
      }
      // A message snoozed for three months, or parked until a promised date,
      // ages out of the header window long before it is due, so it cannot be
      // rescued by the loop above: it was never indexed. These are looked up by
      // name instead.
      //
      // Two things decide who gets a turn, because one scan will not look up an
      // unbounded number. A mark whose message has been deleted costs a query
      // and recovers nothing, so after a miss it waits, longer each time; and
      // what is left goes least-recently-tried first, so the same few cannot
      // hold the budget for ever while a live reminder behind them is never
      // reached. Whatever still does not fit is counted and said out loud.
      const rescueLog = await store.getRescueLog();
      const nextTryAt = (k) => {
        const r = rescueLog[k];
        if (!r || !r.misses) return 0;
        return (r.at || 0) + MISS_BACKOFF[Math.min(r.misses, MISS_BACKOFF.length) - 1];
      };
      const marked = Object.keys(userStates).concat(Object.keys(followUps))
        .filter((k, i, a) => a.indexOf(k) === i)
        .filter((k) => retained(k) && !byKey.has(k) && k.indexOf('|') > 0
          && accounts.some((a) => a.id === k.slice(0, k.indexOf('|'))));
      const due = marked.filter((k) => nextTryAt(k) <= startedAt)
        .sort((a, b) => ((rescueLog[a] && rescueLog[a].at) || 0) - ((rescueLog[b] && rescueLog[b].at) || 0)
          || dueAt(userStates[a], followUps[a]) - dueAt(userStates[b], followUps[b]));
      const lookedUp = due.slice(0, MAX_RESCUE_LOOKUPS);
      const rescue = { marked: marked.length, lookedUp: lookedUp.length, found: 0, notFound: 0,
        waiting: marked.length - due.length, omitted: due.length - lookedUp.length };
      const results = [];
      await pool(lookedUp, 4, async (key) => {
        alive();
        const cut = key.indexOf('|');
        const acct = key.slice(0, cut), hmid = key.slice(cut + 1);
        try {
          for (const h of await queryAll({ headerMessageId: hmid, accountId: acct })) {
            const f = h && h.folder;
            if (!f || !f.id || f.accountId !== acct) continue;
            const e = indexEntry(h, f, true, me);
            if (!e || e.key !== key || e.dir === 'outbound') continue;
            const prev = byKey.get(key);
            if (!prev || rank(e) < rank(prev)) byKey.set(key, e);
          }
        } catch (err) { if (err instanceof Cancelled) throw err; }
        const found = byKey.has(key);
        results.push({ key, found });
        if (found) rescue.found++; else rescue.notFound++;
      });
      alive();
      // The message may simply be on a server that is offline today, so a mark
      // is never thrown away for not being found — only asked about less often.
      if (results.length) { try { await store.noteRescue(results, marked); } catch (e) { /* bookkeeping only */ } }
      alive();
      const candidates = Array.from(byKey.values()).sort((a, b) => b.date - a.date);

      // ---- bodies and code facts (candidates only) --------------------------------------
      const bodies = { ok: 0, unavailable: 0, tooLarge: 0, empty: 0 };
      const factsList = [];
      let done = 0;
      await pool(candidates, 2, async (e) => {
        alive();
        const facts = await codeFacts(e, index, { names, addresses: Array.from(me) }, !!sentLikeByAccount.get(e.acct), bodies, startedAt);
        factsList.push(facts);
        session.facts.set(e.key, facts);
        progress('bodies', ++done, candidates.length);
      });
      alive();

      // ---- V4 lead status -------------------------------------------------------------------
      if (typeof checkLeads === 'function') {
        const addrs = Array.from(new Set(factsList.filter((f) => f.entry.dir === 'inbound').map((f) => f.correspondent.address).filter(Boolean)));
        try {
          const leads = addrs.length ? await checkLeads(addrs) : {};
          for (const f of factsList) if (leads && leads[f.correspondent.address]) f.lead = leads[f.correspondent.address];
        } catch (e) { /* lead status is optional evidence; the scan goes on without it */ }
      }
      alive();

      let useModel = store.mayCallModel(config) && typeof decide === 'function';
      session.modelState = !useModel ? 'off' : config.shadow ? 'shadow' : 'on';
      if (useModel) {
        let ready = null;
        try { ready = await modelReady(); } catch (e) { ready = null; }
        alive();
        if (!ready || ready.ok !== true) {
          // Not ready, or no clear answer: nothing leaves this computer.
          useModel = false;
          session.modelState = ready && ready.why === 'no_v4_key' ? 'no_v4_key' : 'unavailable';
        }
      }
      // The editor's own marks are read fresh every time rows are built: a scan
      // publishes partial rows for minutes, and a message marked Done in that
      // time must not come back as active when the next answers arrive.
      const build = (answersByKey) => buildRows(factsList, answersByKey, useModel && !config.shadow, config);

      // Code-only rows first, so the page fills before any model call returns.
      session.rows = build(new Map());
      if (hooks.onRows) hooks.onRows(session.rows);

      // ---- model ----------------------------------------------------------------------------------
      let model = null;
      session.owner = { names, addresses: Array.from(me) };
      if (useModel) {
        model = await askModel(factsList, gen, alive, progress, () => {
          session.rows = build(session.answers);
          if (hooks.onRows) hooks.onRows(session.rows);
        });
        session.rows = build(session.answers);
      }

      // A row the model parked until a date is a promise the page has made:
      // "this comes back on the 5th". Remembering it here is what keeps that
      // promise when the message itself ages out of the candidate window in the
      // meantime. Only the model's own parking — the editor's snooze is already
      // her mark — and only while the date is worth waiting for.
      const keptFollowUps = {};
      for (const r of session.messageRows || []) {
        if (r.group === 'waiting_until' && r.demotedBy === 'model' && r.untilIso) {
          const prev = followUps[r.key];
          keptFollowUps[r.key] = { untilIso: r.untilIso, at: (prev && prev.at) || now() };
        }
      }
      // What this scan did not look at keeps its record, so nothing is lost by
      // a scan that simply did not reach it; what is long past its date goes.
      for (const key of Object.keys(followUps)) {
        if (keptFollowUps[key] || byKey.has(key)) continue;
        const due = dueAt(null, followUps[key]);
        if (now() - due < FOLLOWUP_GRACE) keptFollowUps[key] = followUps[key];
      }
      try { await store.setFollowUps(keptFollowUps); } catch (e) { /* bookkeeping only */ }
      alive();

      // Named in the banner: only the mailboxes that have rows AND no Sent
      // folder we could read. An account with nothing in the list has nothing
      // to warn about.
      const withRows = new Set(candidates.map((e) => e.acct));
      const sentLikeMissing = accounts.filter((a) => withRows.has(a.id) && !sentLikeByAccount.get(a.id))
        .map((a) => ({ id: a.id, name: a.name || a.id }));
      sentLikeScanned = sentLikeMissing.length === 0;

      session.coverage = {
        startedAt, finishedAt: now(), folders: coverageFolders, candidates: candidates.length,
        indexed: index.count, oldest: index.oldest, newest: index.newest,
        bodies, sentLikeScanned, sentLikeMissing, model, shadow: !!config.shadow, newslettersHidden: session.newslettersHidden, rescue,
        mailboxes: accounts.map((a) => ({ id: a.id, name: a.name || a.id, identities: (a.identities || []).map((i) => i && i.email).filter(Boolean) })),
        replyHeaderReads: session.replyLinks.size   // Sent messages opened to check whose reply they are
      };
      await store.setCoverage(session.coverage);
      session.status = 'ready';
      if (hooks.onRows) hooks.onRows(session.rows);
      return snapshot();
    }

    // Asks the model about every message in `list` that has no cached answer.
    // The key is shared by many mailboxes: nothing is asked twice, a cancelled
    // scan stops asking at once, and what the service was too busy for is
    // counted apart (`busy`) so it can be asked again later.
    async function askModel(list, gen, alive, progress, onPartial) {
      const model = { asked: 0, cached: 0, errors: 0, busy: 0, refused: false, stopCode: null, skipped: 0 };
      const askable = list.filter((f) => f.bodyState === 'ok' && !f.authoredAmbiguous && !f.system);
      model.skipped = list.length - askable.length;
      const cancelled = () => gen !== generation;
      // The keys this run still has to look up. Telling the cache which ones
      // they are stops it evicting the answers this same scan is about to read.
      const working = new Set(askable.map((f) => f.key));
      const hits = [];
      let done = 0, fresh = 0;
      beginModelRun();
      await pool(askable, 4, async (f) => {
        alive();
        f.modelError = null;
        try {
          const req = await buildModelRequest(f, session.owner);
          if (!req) { model.skipped++; return; }
          const hash = TriageQuestions.contextHash(req);
          const wire = TriageQuestions.wirePayload(req);
          const cached = await store.getVerdict(f.key, hash);
          alive();
          working.delete(f.key);
          if (cached) { session.sent.set(f.key, wire); session.answers.set(f.key, cached.answers); hits.push(f.key); model.cached++; }
          else {
            // Asked again here, not only at the start of the run: switching
            // classification off must stop the text of the messages still in
            // the queue from being sent, not just the ones not yet reached.
            if (!store.mayCallModel(await store.getConfig())) { model.skipped++; return; }
            alive();
            session.sent.set(f.key, wire);
            const parsed = TriageQuestions.parseAnswers(req, await decide(wire, { cancelled }));
            // Between the request and the answer the editor may have cancelled
            // the scan or deleted Today's data. Nothing of a run that is over
            // may be published or written back.
            alive();
            if (Object.keys(parsed.answers).length) {
              session.answers.set(f.key, parsed.answers);
              await store.putVerdict(f.key, hash, parsed.model, parsed.answers, working);
              alive();
              model.asked++;
              if (++fresh % 8 === 0 && onPartial) onPartial();
            } else { f.modelError = parsed.errors[0] || 'no_answers'; model.errors++; }
          }
        } catch (e) {
          if (e instanceof Cancelled) throw e;
          alive();
          f.modelError = String(e && e.code || e && e.message || 'request_failed').slice(0, 60);
          model.errors++;
          if (TriageThrottle.isTransient(f.modelError)) model.busy++;
          if (TriageThrottle.RUN_ENDING.indexOf(f.modelError) !== -1) { model.refused = true; if (!model.stopCode) model.stopCode = f.modelError; }
          else if (TriageThrottle.RUN_PAUSING.indexOf(f.modelError) !== -1 && !model.stopCode) model.stopCode = f.modelError;
        }
        progress('model', ++done, askable.length);
      });
      alive();
      // A cache hit is a use of that answer: one write at the end keeps the
      // entries this scan relied on from being the first thrown away next time.
      if (hits.length) { try { await store.touchVerdicts(hits); } catch (e) { /* the cache is an optimisation */ } }
      return model;
    }

    // Second chance for the rows the service was too busy to answer — from what
    // is already in memory, without reading the mailbox again.
    function retryModel(hooks) {
      if (running) return running;
      const gen = generation;
      retrying = true;
      const mine = (async () => {
        const alive = () => { if (gen !== generation) throw new Cancelled(); };
        const config = await store.getConfig();
        const pending = Array.from(session.facts.values()).filter((f) => f.modelError && TriageThrottle.isTransient(f.modelError));
        if (session.status !== 'ready' || !pending.length || !store.mayCallModel(config) || typeof decide !== 'function') return snapshot();
        let ready = null;
        try { ready = await modelReady(); } catch (e) { ready = null; }
        if (!ready || ready.ok !== true) return snapshot();
        const model = await askModel(pending, gen, alive, () => {}, null);
        const before = (session.coverage && session.coverage.model) || { asked: 0, cached: 0, errors: 0, skipped: 0 };
        session.coverage = Object.assign({}, session.coverage, { model: {
          asked: before.asked + model.asked, cached: before.cached + model.cached, skipped: before.skipped,
          errors: Math.max(0, before.errors - model.asked - model.cached), busy: model.busy, refused: model.refused, stopCode: model.stopCode
        } });
        await store.setCoverage(session.coverage);
        const snap = await rederive();
        if (hooks && hooks.onRows) hooks.onRows(snap.rows);
        return snap;
      })().catch(() => snapshot()).finally(() => { if (running === mine) { running = null; retrying = false; } });
      running = mine;
      return mine;
    }

    function rank(e) {
      if ((e.specialUse || []).indexOf('inbox') !== -1) return 0;
      return e.inCandidateFolder ? 1 : 2;
    }

    function indexEntry(h, folder, candidate, me) {
      const hmid = TriageLink.normalizeHmid(h && h.headerMessageId);
      if (!hmid) return null;
      const from = parseMailbox(h.author);
      const cls = TriageRules.classifyDirection({ from, subject: h.subject }, { me, isInternal });
      const date = h.date instanceof Date ? h.date.getTime() : Number(h.date);
      return {
        key: folder.accountId + '|' + hmid, acct: folder.accountId, hmid, mid: h.id,
        folderId: folder.id, folderPath: folder.path, specialUse: folder.specialUse || [],
        date: isFinite(date) ? date : 0, from,
        to: (h.recipients || []).map((r) => parseMailbox(r).address).filter(Boolean),
        cc: (h.ccList || []).map((r) => parseMailbox(r).address).filter(Boolean),
        subject: TriageText.sanitizeDisplay(h.subject, S.LIMITS.subjectDisplay),
        subjN: TriageText.normalizeSubject(h.subject),
        size: h.size || 0, read: !!h.read, flagged: !!h.flagged,
        dir: cls.dir, sysType: cls.sysType, auto: cls.auto, inCandidateFolder: candidate
      };
    }

    async function codeFacts(e, index, owner, sentLikeScanned, bodies, nowMs) {
      const facts = {
        key: e.key, entry: e, date: e.date, correspondent: e.from, subject: e.subject,
        bodyState: 'ok', authoredAmbiguous: false, files: [], transferHost: null,
        refsMentioned: { isbns: [], ticketIds: [], projectIds: [] }, dateCandidates: [],
        parent: null, system: null, lead: null, modelError: null, broadcast: null,
        inInbox: (e.specialUse || []).indexOf('inbox') !== -1,
        laterOutbound: TriageLink.laterOutbound(e, index, { sentLikeScanned }),
        introduction: TriageLink.earlierOutbound(e, index, { sentLikeScanned }),
        replied: { state: S.TRISTATE.UNKNOWN, hmid: null }
      };
      facts.replied = await directReply(e, index, sentLikeScanned);
      let text = '';
      let full = null;
      let link = { irt: null, refs: [] };
      if (e.size > S.LIMITS.maxBodyBytes) { facts.bodyState = 'too_large'; bodies.tooLarge++; }
      else {
        try {
          full = await api.messages.getFull(e.mid);
          link = { irt: messageIdsIn(headerList(full, 'in-reply-to'))[0] || null, refs: messageIdsIn(headerList(full, 'references')) };
          const hs = full && full.headers;
          facts.broadcast = TriageRules.declaresBulk(hs) ? 'bulk' : TriageRules.declaresAutomation(hs) ? 'automated' : null;
          text = String(bodyText(full) || '');
          if (!text.trim()) { facts.bodyState = 'empty'; bodies.empty++; } else bodies.ok++;
        } catch (err) { facts.bodyState = 'unavailable'; bodies.unavailable++; }
      }
      if (facts.bodyState !== 'too_large') {
        try { facts.files = TriageRules.extractFileSignals((await api.messages.listAttachments(e.mid)).map((a) => a.name)); } catch (err) { /* drafts and some IMAP states throw */ }
      }
      const authored = TriageText.authoredText(text, owner);
      facts.authoredAmbiguous = facts.bodyState === 'ok' && authored.ambiguous;
      facts.authoredChars = (authored.text || '').trim().length;
      facts.transferHost = text ? transferHost(text, full) : null;
      facts.refsMentioned = TriageRules.extractRefsMentioned(e.subject, authored.text);
      // "By 5 October" means the October after the message was WRITTEN, whenever
      // it is scanned: anchored to the message date, the same message always
      // yields the same dates (and so the same question and the same cache key).
      facts.dateCandidates = TriageRules.extractDateCandidates(authored.text, e.date || nowMs);
      if (e.dir === 'system') facts.system = TriageRules.parseSystemEvent({ subject: e.subject }, text) || { type: e.sysType, isbn: null, fields: {} };

      // What makes two messages one conversation: the reply headers they carry,
      // and a person they share other than the editor (see
      // TriageState.conversations for why both are needed).
      facts.threadRefs = [link.irt].concat(link.refs || []).map((id) => TriageLink.normalizeHmid(id)).filter(Boolean).slice(0, 60);
      const mine = new Set((owner.addresses || []).map((a) => lower(a)));
      facts.people = Array.from(new Set([e.from && e.from.address].concat(e.to || [], e.cc || []).map((a) => lower(a))
        .filter((a) => a && !mine.has(a))));
      // The people outside the company: a colleague copied on every
      // introduction is shared by all the authors who answer, so a shared
      // colleague alone must not make their replies one conversation.
      facts.peopleOutside = facts.people.filter((a) => !isInternal(a));

      const parent = TriageLink.findExplicitParent(link, index, e.acct);
      if (parent) facts.parent = { role: parent.role, via: parent.via, hmid: parent.entry.hmid, mid: parent.entry.mid, folderId: parent.entry.folderId, subject: parent.entry.subject, date: parent.entry.date, size: parent.entry.size || 0 };
      // Two lines for the row, the fuller excerpt for the details panel.
      const shown = authored.text || text;
      session.texts.set(e.key, { authored: authored.text, excerpt: TriageText.excerpt(shown),
        preview: TriageText.sanitizeDisplay(String(shown || '').replace(/\s+/g, ' '), 180) });
      return facts;
    }

    // "You answered THIS message" — a later message of yours whose reply headers
    // name it AND that is yours by every sign we have: a reply-style subject that
    // is not one of the platform's automatic mails, and no header declaring it
    // automated. A reply header alone only shows that two messages belong to one
    // conversation; an automatic acknowledgement has one too. A later mail about
    // something else is not that either. Whatever is short of proof stays
    // "unable to check" and never takes a task off the list. Headers are not in
    // the index, so the few candidate messages are read here, once per scan each.
    async function directReply(e, index, sentLikeScanned) {
      const T = S.TRISTATE;
      const cands = TriageLink.laterOutboundCandidates(e, index, 5);
      let unreadable = cands.more, automatedOnly = false, unconfirmed = false;
      for (const c of cands.list) {
        // The promise is what is cached: two rows about the same sender are
        // worked on at once and must not both fetch the same Sent message.
        if (!session.replyLinks.has(c.key)) {
          session.replyLinks.set(c.key, c.size > S.LIMITS.maxBodyBytes ? Promise.resolve(null)
            : api.messages.getFull(c.mid).then((full) => ({
              ids: messageIdsIn(headerList(full, 'in-reply-to')).concat(messageIdsIn(headerList(full, 'references')))
                .map((id) => TriageLink.normalizeHmid(id)).filter(Boolean),
              automated: TriageRules.declaresAutomation(full && full.headers)
            }), () => null));
        }
        const link = await session.replyLinks.get(c.key);
        if (link === null) { unreadable = true; continue; }
        if (link.ids.indexOf(e.hmid) === -1) continue;
        if (link.automated) { automatedOnly = true; continue; }
        if (c.auto !== false) { unconfirmed = true; continue; }
        return { state: T.FOUND, hmid: c.hmid, note: null };
      }
      if (unconfirmed) return { state: T.UNKNOWN, hmid: null, note: 'unconfirmed' };
      return { state: sentLikeScanned && !unreadable ? T.NOT_FOUND : T.UNKNOWN, hmid: null, note: automatedOnly ? 'automated_only' : null };
    }

    async function buildModelRequest(f, owner) {
      const t = session.texts.get(f.key);
      if (!t || !t.authored) return null;
      let preceding = null;
      // Only a message the editor wrote, reached through a real reply header,
      // may stand in as "the request this reply answers".
      if (f.parent && f.parent.role === 'editor' && f.parent.mid !== undefined) {
        // Without the earlier text the approval question is simply not asked.
        const text = await parentText(f.parent);
        const authored = text === null ? null : TriageText.authoredText(text, owner);
        if (authored && authored.text && !authored.ambiguous) {
          preceding = { subject: TriageText.redactForModel(f.parent.subject, 200), text: TriageText.redactForModel(authored.text, S.LIMITS.precedingChars) };
        }
      }
      return TriageQuestions.buildRequest({
        subject: TriageText.redactForModel(f.subject, 200),
        text: TriageText.redactForModel(t.authored, S.LIMITS.incomingChars),
        files: f.files, transferHost: f.transferHost, preceding, dateCandidates: f.dateCandidates
      });
    }

    function toRow(f, answers, userState, useModel, nowMs) {
      const row = TriageState.deriveRow(f, answers, userState, nowMs, { useModel, modelState: !f.modelError ? session.modelState : TriageThrottle.isTransient(f.modelError) ? 'busy' : 'error' });
      row.display = {
        who: f.correspondent, subject: f.subject, date: f.date, folderPath: f.entry.folderPath, accountId: f.entry.acct,
        dir: f.entry.dir, read: f.entry.read, inInbox: f.inInbox,
        system: f.system, refsMentioned: f.refsMentioned, transferHost: f.transferHost,
        parent: f.parent ? { role: f.parent.role, via: f.parent.via, subject: f.parent.subject, date: f.parent.date } : null,
        preview: (session.texts.get(f.key) || {}).preview || '',
        modelError: f.modelError, modelBusy: !!f.modelError && TriageThrottle.isTransient(f.modelError), sentToModel: session.sent.has(f.key)
      };
      row.thread = { acct: f.entry.acct, hmid: f.entry.hmid, refs: f.threadRefs || [], people: f.people || [], outside: f.peopleOutside || [] };
      return row;
    }

    // One way to turn facts into the rows the page shows, used by the scan and
    // by every re-derive. Newsletters were once filtered here and not there, so
    // pressing Done anywhere brought every hidden newsletter back.
    function buildRows(list, answersByKey, useModel, config) {
      const all = list.map((f) => toRow(f, answersByKey.get(f.key) || null, session.userStates[f.key], useModel, now()));
      const keep = config.showNewsletters ? all : all.filter((r) => r.reason.id !== 'bulk_mail');
      session.newslettersHidden = all.length - keep.length;
      // One row per message is what the judgments are made on; one row per
      // conversation is what the editor works through.
      session.messageRows = keep;
      return TriageState.conversations(keep).sort((a, b) => b.display.date - a.display.date);
    }

    // After Done / Snooze / priority change: re-derive rows from what is in
    // memory, without touching the mailbox or the model again.
    async function rederive() {
      const config = await store.getConfig();
      session.userStates = await store.getUserStates();
      // Re-deriving never contacts anything: a scan that found the service
      // unavailable stays that way until the next scan asks again.
      const held = session.modelState === 'no_v4_key' || session.modelState === 'unavailable';
      const useModel = store.mayCallModel(config) && !config.shadow && !held;
      if (!held || !store.mayCallModel(config)) session.modelState = !store.mayCallModel(config) ? 'off' : config.shadow ? 'shadow' : 'on';
      session.rows = buildRows(Array.from(session.facts.values()), session.answers, useModel, config);
      if (session.coverage) session.coverage = Object.assign({}, session.coverage, { newslettersHidden: session.newslettersHidden });
      return snapshot();
    }

    return Object.freeze({ run, retryModel, cancel, snapshot, rederive, whatWasSent, excerptOf, entryOf, parentEntryOf, parentExcerpt });
  }

  return Object.freeze({ create, parseMailbox, folderKind });
})();
