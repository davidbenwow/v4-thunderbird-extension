// Wires the Today triage page into the background page: feature gate, Spaces
// button, the `triage:v1` port the page talks through, the V4 lead lookup and
// the Jev call. Loaded AFTER background.js and reuses its globals (getConfig,
// API_URL, parseCheckResponse, collectBodyText, extractTransferLinkHost,
// safeIsInternal) without changing them — the shipped popup path stays as is.
//
// The page never gets mail text, keys or message ids it did not ask for by row
// key. No model key exists on this computer: classification goes through the
// OmniReply gateway, which holds it, and is authorised by the editor's V4 key.

var TriageBackground = (function () {
  'use strict';

  const SPACE_NAME = 'v4_today';
  const PORT_NAME = 'triage:v1';
  const GATEWAY = 'https://omnireply-gateway.vercel.app';
  const DECIDE_URL = GATEWAY + '/api/extension/triage/decide';
  const HEALTH_URL = GATEWAY + '/api/health';
  const LEGACY_JEV_KEY = 'triage:v1:jevKey';     // test builds kept a model key here; removed at start-up
  const ACTIVE_GROUPS = ['do_first', 'then', 'low', 'needs_review', 'system_tasks'];

  const store = TriageStore.create(browser.storage.local);
  const ports = new Set();
  let scan = null;
  let spaceId = null;
  let rescanTimer = null;
  let retryTimer = null;
  let retryRound = 0;

  // Everything Today needs appeared by Thunderbird 121 (folder ids, specialUse,
  // folders.query) and 115 (spaces). On anything older the feature stays dark
  // while the rest of the add-on works as before.
  function supported() {
    return !!(browser.spaces && browser.spaces.create && browser.folders && browser.folders.query &&
      browser.permissions && browser.messages && browser.messages.query && browser.messages.continueList);
  }

  function hasPermission(p) { return browser.permissions.contains(p).catch(() => false); }

  // ---- V4 lead status, batch form ---------------------------------------------------
  // Same endpoint and same wire adapter as the popup, but chunked and with a
  // timeout, and without touching the popup's caches or diagnostics.
  async function checkLeads(addresses) {
    const { apiKey, enabled, statusMode } = await getConfig();
    const out = {};
    if (!enabled || !apiKey || statusMode === 'off') return out;
    for (let i = 0; i < addresses.length; i += 50) {
      const chunk = addresses.slice(i, i + 50);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15000);
      try {
        const res = await fetch(`${API_URL}/api/existence_check/${apiKey}?include_response_status=1`, {
          method: 'POST', signal: ctl.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: chunk.map((e) => `emails[]=${encodeURIComponent(e)}`).join('&')
        });
        if (!res.ok) continue;
        const parsed = parseCheckResponse(await res.json(), false);
        for (const addr of Object.keys(parsed)) out[addr] = { exists: !!parsed[addr].exists, status: parsed[addr].status || null };
      } catch (e) { /* lead status is optional evidence */ } finally { clearTimeout(timer); }
    }
    return out;
  }

  // ---- Jev -------------------------------------------------------------------------------
  function codedError(code, cause) {
    const e = new Error(code);
    e.code = code;
    if (cause) e.detail = detailOf(cause);
    return e;
  }
  // Thunderbird's own error text (never mail content), trimmed for display.
  function detailOf(err) { return String(err && err.message || err || '').replace(/\s+/g, ' ').slice(0, 300); }

  // One request, no retries of its own: TriageThrottle decides when to ask
  // again. What the gateway SAYS ({ code, retryable }) is handed over as it is;
  // an answer without that envelope (a platform-level failure) has only a status.
  async function sendToGateway(payload) {
    const { apiKey } = await getConfig();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 35000);
    try {
      const res = await fetch(DECIDE_URL, {
        method: 'POST', signal: ctl.signal, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'X-V4-Api-Key': apiKey || '', 'X-Extension-Version': browser.runtime.getManifest().version },
        body: JSON.stringify(payload)
      });
      const out = { status: res.status, retryAfterMs: TriageThrottle.parseRetryAfter(res.headers.get('retry-after'), Date.now()), body: null };
      let json = null;
      try { json = await res.json(); } catch (e) { json = null; }
      if (res.ok) { out.body = json; if (!json) out.status = 502; return out; }
      if (json && typeof json.code === 'string' && typeof json.retryable === 'boolean') {
        out.code = json.code.slice(0, 40);
        out.retryable = json.retryable;
        out.stopRun = TriageThrottle.RUN_ENDING.indexOf(out.code) !== -1 || TriageThrottle.RUN_PAUSING.indexOf(out.code) !== -1;
      }
      return out;
    } catch (e) { throw codedError(e && e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK'); } finally { clearTimeout(timer); }
  }

  // Every add-on shares the service and, behind it, one model account, so all
  // calls go through one governor per add-on (see triage-throttle.js).
  const throttle = TriageThrottle.create({ send: sendToGateway });

  async function decide(payload, o) {
    const { apiKey } = await getConfig();
    if (!apiKey) throw codedError('NO_V4_KEY');
    return throttle.request(payload, o);
  }

  // Before a scan sends anything: is there a key to be recognised by, and does
  // the service say classification is switched on? Anything short of a clear
  // "yes" means no message text leaves this computer.
  async function modelReady() {
    const { apiKey } = await getConfig();
    if (!apiKey) return { ok: false, why: 'no_v4_key' };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch(HEALTH_URL, { method: 'GET', signal: ctl.signal, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
      const json = res.ok ? await res.json() : null;
      return json && json.triage && json.triage.configured === true ? { ok: true } : { ok: false, why: 'unavailable' };
    } catch (e) { return { ok: false, why: 'unavailable' }; } finally { clearTimeout(timer); }
  }

  // ---- scanner ---------------------------------------------------------------------------------
  function getScan() {
    if (!scan) {
      scan = TriageScan.create({
        api: browser, store, isInternal: safeIsInternal, listFolders: (accountId) => foldersOf(accountId),
        bodyText: (full) => TriageText.bodyFromParts(full),
        transferHost: (text, full) => extractTransferLinkHost(full ? collectBodyText(full) : text),
        checkLeads, decide, modelReady, beginModelRun: () => throttle.reset()
      });
    }
    return scan;
  }

  // What the page gets: the scanner's snapshot plus "asked to stay away until".
  function forPage(snap) { return Object.assign({}, snap, { modelPausedUntil: throttle.snapshot().pausedUntil }); }

  function broadcast(msg) { for (const p of ports) { try { p.postMessage(msg); } catch (e) { ports.delete(p); } } }

  function publicRows(rows) {
    // Row objects hold no mail text; the excerpt is fetched per row on demand.
    return rows;
  }

  async function runScan() {
    const snap = await getScan().run({
      onProgress: (p) => broadcast({ type: 'progress', progress: p }),
      onRows: (rows) => broadcast({ type: 'rows', rows: publicRows(rows) }),
      onError: (error) => broadcast({ type: 'error', error })
    });
    broadcast({ type: 'snapshot', snapshot: forPage(snap) });
    retryRound = 0;
    scheduleModelRetry(snap);
    return forPage(snap);
  }

  // Rows the service was too busy to answer are asked again on their own —
  // only those rows, without reading the mailbox again — a few minutes apart
  // and at a random moment, so add-ons refused together do not return together.
  const RETRY_MINUTES = [2, 5, 15];
  function scheduleModelRetry(snap) {
    clearTimeout(retryTimer);
    const m = snap && snap.coverage && snap.coverage.model;
    if (!m || !m.busy || retryRound >= RETRY_MINUTES.length) return;
    // Never earlier than the service asked us to stay away (Retry-After). A
    // pause longer than an hour is not something to sit out with a timer: the
    // page says until when, and the next scan after that moment asks again.
    const wait = throttle.autoRetryDelay(RETRY_MINUTES[retryRound] * 60000 * (0.75 + Math.random() * 0.5));
    if (wait === null) return;
    retryRound++;
    retryTimer = setTimeout(async () => {
      try {
        const next = await getScan().retryModel({ onRows: (rows) => broadcast({ type: 'rows', rows: publicRows(rows) }) });
        broadcast({ type: 'snapshot', snapshot: forPage(next) });
        scheduleModelRetry(next);
      } catch (e) { /* the next scan asks again anyway */ }
    }, wait);
  }

  function scheduleRescan() {
    if (!ports.size) return;                       // nobody is looking; the next open rescans
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => { runScan().catch(() => {}); }, 5000);
  }

  // ---- Spaces button ---------------------------------------------------------------------------------
  async function ensureSpace() {
    if (!supported()) return;
    const mine = await browser.spaces.query({ name: SPACE_NAME, isSelfOwned: true });
    // No count on the Today button: the page is where the work is weighed, and
    // a number in the sidebar would nag all day. A button left over from a build
    // that did show one is cleared here.
    if (mine.length) { spaceId = mine[0].id; browser.spaces.update(spaceId, { badgeText: '' }).catch(() => {}); return; }
    const space = await browser.spaces.create(SPACE_NAME, browser.runtime.getURL('triage.html'), {
      title: 'Today', defaultIcons: { 16: 'images/icon-16.png', 32: 'images/icon-32.png' }
    });
    spaceId = space.id;
  }

  async function removeSpace() {
    if (!browser.spaces) return;
    const mine = await browser.spaces.query({ name: SPACE_NAME, isSelfOwned: true }).catch(() => []);
    for (const s of mine) await browser.spaces.remove(s.id).catch(() => {});
    spaceId = null;
  }


  // ---- message actions --------------------------------------------------------------------------------------
  // Message ids are session-scoped and a message can move: confirm the id still
  // points at the same Message-ID before opening or replying, and look it up
  // again if not. Never act on a guess.
  async function resolveMessage(key, which) {
    const entry = which === 'parent' ? getScan().parentEntryOf(key) : getScan().entryOf(key);
    if (!entry) throw codedError('ROW_GONE');
    try {
      const h = await browser.messages.get(entry.mid);
      // The same Message-ID can sit in several folders and several accounts —
      // one copy in the Inbox, one filed, one in a colleague's shared mailbox.
      // An id that has been reused since the scan must not be taken for the
      // message the row is about, so the folder has to match as well.
      if (h && TriageLink.normalizeHmid(h.headerMessageId) === entry.hmid && folderIdOf(h) === entry.folderId) return h;
    } catch (e) { /* stale id: fall through to a lookup */ }
    return locateCopy(entry.hmid, entry.folderId);
  }

  function folderIdOf(h) {
    const f = h && h.folder;
    return f && typeof f.id === 'string' ? f.id : (typeof h.folderId === 'string' ? h.folderId : null);
  }

  // Every page of a query, not just the first. A second copy of a message is
  // exactly the thing these lookups exist to notice, and a paginated result can
  // put it on page two — so stopping at the first page would report "only one"
  // about a query that had not finished.
  async function allMatches(query, hmid) {
    const out = [];
    let page = await browser.messages.query(query);
    for (let guard = 0; guard < 200; guard++) {
      for (const m of page.messages || []) if (TriageLink.normalizeHmid(m.headerMessageId) === hmid) out.push(m);
      if (!page.id || typeof browser.messages.continueList !== 'function') break;
      const next = await browser.messages.continueList(page.id);
      if (!next || !(next.messages || []).length) break;
      page = next;
    }
    return out;
  }

  // Exactly one copy, in one named folder. Two copies of the same Message-ID in
  // the same folder is not something to guess at: the caller is about to move
  // mail, so it refuses instead.
  async function locateCopy(hmid, folderId) {
    const hits = (await allMatches({ headerMessageId: hmid, folderId }, hmid))
      .filter((m) => folderIdOf(m) === null || folderIdOf(m) === folderId);
    if (!hits.length) throw codedError('MESSAGE_NOT_FOUND');
    if (hits.length > 1) throw codedError('AMBIGUOUS_COPY');
    return hits[0];
  }

  // Two ways to read an account's folders: the flat query, and — if that throws
  // or comes back empty — walking the folder tree. One broken account must not
  // hide the others.
  async function foldersOf(accountId, trace) {
    try {
      const q = await browser.folders.query({ accountId });
      if (Array.isArray(q) && q.length) { if (trace) trace.push({ step: 'folders.query', ok: true, count: q.length }); return q; }
      if (trace) trace.push({ step: 'folders.query', ok: true, count: 0 });
    } catch (e) { if (trace) trace.push({ step: 'folders.query', ok: false, error: detailOf(e) }); }
    try {
      const full = await browser.accounts.get(accountId, true);
      const out = [];
      (function walk(f, depth) { if (!f || depth > 12) return; for (const s of f.subFolders || []) { out.push(s); walk(s, depth + 1); } })(
        full && (full.rootFolder || { subFolders: full.folders || [] }), 0);
      if (trace) trace.push({ step: 'accounts.get(tree)', ok: true, count: out.length });
      return out;
    } catch (e) { if (trace) trace.push({ step: 'accounts.get(tree)', ok: false, error: detailOf(e) }); return []; }
  }

  async function listAccounts(trace) {
    if (!browser.accounts || !browser.folders) throw codedError('API_NOT_READY');
    let accounts;
    try { accounts = await browser.accounts.list(false); }
    catch (e) { if (trace) trace.push({ step: 'accounts.list', ok: false, error: detailOf(e) }); throw codedError('ACCOUNTS_LIST_FAILED', e); }
    if (trace) trace.push({ step: 'accounts.list', ok: true, count: accounts.length, types: accounts.map((a) => a.type) });
    const out = [];
    for (const a of accounts) {
      if (a.type === 'rss' || a.type === 'nntp') continue;   // Local Folders ('none') holds mail; feeds and news do not
      try {
        const folders = await foldersOf(a.id, trace);
        out.push({
          id: a.id, name: a.name, identities: (a.identities || []).map((i) => i && i.email).filter(Boolean),
          folders: folders.filter((f) => f && f.id && !f.isVirtual && !f.isRoot).map((f) => ({ id: f.id, path: f.path, name: f.name, specialUse: f.specialUse || [] }))
        });
      } catch (e) { if (trace) trace.push({ step: 'account', ok: false, error: detailOf(e) }); }
    }
    return out;
  }

  // What the add-on can see of its own environment — shown to the user when
  // setup fails, so one screenshot says why. No mail, no names, no keys.
  async function diagnose() {
    const trace = [];
    let info = null, perms = null, listed = null;
    try { info = await browser.runtime.getBrowserInfo(); } catch (e) { info = { error: detailOf(e) }; }
    try { const p = await browser.permissions.getAll(); perms = { permissions: p.permissions, origins: p.origins }; } catch (e) { perms = { error: detailOf(e) }; }
    try { const l = await listAccounts(trace); listed = l.map((a) => ({ folders: a.folders.length, identities: a.identities.length })); }
    catch (e) { trace.push({ step: 'listAccounts', ok: false, code: e && e.code, error: e && e.detail || detailOf(e) }); }
    return {
      addon: browser.runtime.getManifest().version, thunderbird: info && (info.version || info),
      has: { accounts: !!browser.accounts, folders: !!browser.folders, foldersQuery: !!(browser.folders && browser.folders.query), foldersGet: !!(browser.folders && browser.folders.get),
        spaces: !!browser.spaces, messagesQuery: !!(browser.messages && browser.messages.query), onNewMail: !!(browser.messages && browser.messages.onNewMailReceived) },
      permissions: perms, mailActions: await mailAbilities(), accounts: listed, trace
    };
  }

  // messages.move takes a folder id since Thunderbird 121; older builds want the
  // whole MailFolder, so fall back rather than fail the editor's undo.
  async function moveTo(ids, folderId) {
    try { await browser.messages.move(ids, folderId); }
    catch (e) { await browser.messages.move(ids, await browser.folders.get(folderId)); }
  }

  // Thunderbird only exposes a function when its permission is granted, and an
  // update that asks for a new permission can sit unapproved. An older
  // Thunderbird may not have messages.archive at all. So the page is told what
  // is really there and hides what is not, instead of offering a button that
  // fails when pressed.
  async function mailAbilities() {
    const has = (fn) => !!(browser.messages && typeof browser.messages[fn] === 'function');
    let canMove = false;
    try { canMove = await browser.permissions.contains({ permissions: ['messagesMove'] }); } catch (e) { canMove = false; }
    return {
      archive: has('archive') && canMove,
      trash: has('move') && canMove
    };
  }

  // The row says "Move this message to Trash", so that is what has to happen.
  // messages.delete() would have followed the account's own deletion setting,
  // which on some accounts removes the message instead of putting it in Trash —
  // a promise the button must not make and cannot keep. So the Trash folder is
  // resolved and the message is moved there; if no Trash folder can be
  // identified for that account, nothing is touched and the editor is told.
  async function trashFolderFor(accountId) {
    try {
      const flagged = await browser.folders.query({ accountId, specialUse: ['trash'] });
      const usable = (flagged || []).filter((f) => f && f.id && !f.isVirtual);
      if (usable.length) return usable[0].id;
    } catch (e) { /* fall through to the name match */ }
    // Servers that flag nothing: fall back to the folder names the scanner
    // already recognises, in this account only.
    const list = await foldersOf(accountId);
    const named = (list || []).filter((f) => f && f.id && !f.isVirtual && TriageScan.folderKind(f) === 'trash');
    return named.length ? named[0].id : null;
  }

  // Where a copy of `hmid` is now, within one account and not where it started.
  // Null when that cannot be answered without guessing — Undo then says so
  // rather than moving whichever copy it happens to find first.
  async function landedIn(hmid, accountId, fromFolderId) {
    try {
      const ids = new Set();
      for (const m of await allMatches({ headerMessageId: hmid, accountId }, hmid)) {
        const fid = folderIdOf(m);
        if (fid && fid !== fromFolderId) ids.add(fid);
      }
      return ids.size === 1 ? Array.from(ids)[0] : null;
    } catch (e) { return null; }
  }

  // A row is a conversation, so Archive and Delete move every message of it
  // that Today listed — archiving the latest alone would leave the rest in the
  // Inbox and the row on the page. Every copy is found before any is touched:
  // the conversation moves whole or not at all.
  async function mailAction(keys, what) {
    const can = await mailAbilities();
    if (!can[what]) throw codedError(what === 'archive' ? 'ARCHIVE_UNAVAILABLE' : 'TRASH_UNAVAILABLE');
    const list = (Array.isArray(keys) ? keys : [keys]).filter((k) => typeof k === 'string');
    if (!list.length) throw codedError('ROW_GONE');
    const entries = list.map((key) => ({ key, entry: getScan().entryOf(key) }));
    if (entries.some((x) => !x.entry)) throw codedError('ROW_GONE');
    const acct = entries[0].entry.acct;
    if (entries.some((x) => x.entry.acct !== acct)) throw codedError('ROW_GONE');
    for (const x of entries) x.header = await resolveMessage(x.key);
    let items;
    if (what === 'archive') {
      await browser.messages.archive(entries.map((x) => x.header.id));
      // archive() picks the folder itself (usually Archives/<year>), so where
      // each copy landed is only knowable afterwards, and only within this
      // account.
      items = [];
      for (const x of entries) items.push({ hmid: x.entry.hmid, acct, folderId: x.entry.folderId, dest: await landedIn(x.entry.hmid, acct, x.entry.folderId) });
    } else {
      const dest = await trashFolderFor(acct);
      if (!dest) throw codedError('NO_TRASH_FOLDER');
      const moving = entries.filter((x) => x.entry.folderId !== dest);
      if (!moving.length) throw codedError('ALREADY_IN_TRASH');
      await moveTo(moving.map((x) => x.header.id), dest);
      items = moving.map((x) => ({ hmid: x.entry.hmid, acct, folderId: x.entry.folderId, dest }));
    }
    // The messages have left the folders Today scanned, so the row goes quiet
    // until the next scan confirms it. One undo entry for all of them, so one
    // Undo puts the whole conversation back.
    const change = await store.applyUserChanges(list.map((key) => ({ key, patch: { state: 'done' } })), what === 'archive' ? 'Archived' : 'Moved to Trash');
    const undo = { items, stateUndoId: change && change.undoId };
    const snap = await getScan().rederive();
    return { ok: true, undo, snapshot: forPage(snap) };
  }

  async function state() {
    const config = await store.getConfig();
    return {
      supported: supported(), config, hasV4Key: !!(await getConfig()).apiKey, can: await mailAbilities(),
      hasAccountsRead: await hasPermission({ permissions: ['accountsRead'] }),
      snapshot: forPage(getScan().snapshot()), modelId: TriageSchema.MODEL_ID
    };
  }

  async function disable() {
    clearTimeout(retryTimer);
    getScan().cancel();
    await store.setConfig({ enabled: false });
    await removeSpace();
  }

  const handlers = {
    getState: () => state(),
    listAccounts: () => listAccounts(),
    diagnose: () => diagnose(),
    scan: () => runScan(),
    cancel: () => { getScan().cancel(); return { ok: true }; },
    async enable(m) {
      if (!supported()) throw codedError('UNSUPPORTED');
      await store.setConfig({ enabled: true, setupDone: true });
      await ensureSpace();
      attachMailListeners();
      return state();
    },
    async disable() { await disable(); return state(); },
    async setConfig(m) {
      const allowed = ['candidateDays', 'lookbackDays', 'modelOff', 'shadow', 'showNewsletters', 'accounts', 'folders', 'folderMode'];
      const patch = {};
      for (const k of allowed) if (m.patch && k in m.patch) patch[k] = m.patch[k];
      if ('modelOff' in patch) patch.modelOff = patch.modelOff === true;
      // Off means off from this moment: the scan that is running is stopped
      // before the setting is written, so the messages still queued in it are
      // never sent. Without this, Refresh joined the old run and it carried on
      // sending under the old setting.
      if (patch.modelOff === true) getScan().cancel();
      await store.setConfig(patch);
      // A verdict belongs to one message and its context hash, so a different
      // folder choice keeps it — asking again would only spend the shared quota.
      // Switching classification off means off: the stored answers go too.
      if (patch.modelOff === true) await store.dropVerdicts();
      return state();
    },
    async userChange(m) {
      await store.applyUserChanges(m.changes, m.label);
      const snap = await getScan().rederive();
      return forPage(snap);
    },
    async undo() {
      const undone = await store.undoLast();
      const snap = await getScan().rederive();
      return { undone, snapshot: forPage(snap) };
    },
    excerpt: (m) => ({ key: m.key, excerpt: getScan().excerptOf(m.key) }),
    async parentExcerpt(m) { return { key: m.key, excerpt: await getScan().parentExcerpt(m.key) }; },
    async openParent(m) { const h = await resolveMessage(m.key, 'parent'); await browser.messageDisplay.open({ messageId: h.id, location: 'tab' }); return { ok: true }; },
    whatWasSent: (m) => ({ key: m.key, payload: getScan().whatWasSent(m.key) }),
    async open(m) { const h = await resolveMessage(m.key); await browser.messageDisplay.open({ messageId: h.id, location: 'tab' }); return { ok: true }; },
    async reply(m) { const h = await resolveMessage(m.key); await browser.compose.beginReply(h.id, 'replyToSender'); return { ok: true }; },
    // Archive and Trash are the only things Today ever changes in the mailbox,
    // they are always the editor's own click, and both are undone by putting the
    // message back where it came from. Nothing is ever deleted permanently.
    async archive(m) { return mailAction(m.keys || m.key, 'archive'); },
    async trash(m) { return mailAction(m.keys || m.key, 'trash'); },
    // Puts back the copy this action moved: the one now sitting in the folder it
    // was moved to. A Message-ID names a message, not a copy of it — looking it
    // up across the profile found a different mailbox's copy of the same
    // newsletter and moved that instead.
    async undoMail(m) {
      const u = m && m.undo;
      // A token from before conversations named one message; it still works.
      const items = u && Array.isArray(u.items) ? u.items : u ? [u] : [];
      if (!items.length || items.some((it) => !it || typeof it.hmid !== 'string' || typeof it.folderId !== 'string')) throw codedError('NOTHING_TO_UNDO');
      if (items.some((it) => typeof it.dest !== 'string' || !it.dest)) throw codedError('UNDO_UNRESOLVED');
      // Every copy is found before any is moved back, for the same reason as
      // going forward: half a conversation restored is worse than none. Then
      // each folder's copies are looked up again just before they move — a
      // message's id is not something to trust across a move, and the
      // messages go back to different folders in separate moves.
      for (const it of items) await locateCopy(it.hmid, it.dest);
      const back = new Map();
      for (const it of items) {
        if (!back.has(it.folderId)) back.set(it.folderId, []);
        back.get(it.folderId).push(it);
      }
      for (const [folderId, group] of back) {
        const ids = [];
        for (const it of group) ids.push((await locateCopy(it.hmid, it.dest)).id);
        await moveTo(ids, folderId);
      }
      // The mark this action wrote, not whatever the editor did afterwards.
      await store.undoById(u.stateUndoId);
      const snap = await getScan().rederive();
      return { snapshot: forPage(snap) };
    },
    async openInV4(m) {
      const entry = getScan().entryOf(m.key);
      if (!entry || !entry.from.address) throw codedError('ROW_GONE');
      await browser.windows.openDefaultBrowser(`${API_URL}/system/lead/find?search_query=${encodeURIComponent(entry.from.address)}`);
      return { ok: true };
    },
    async deleteData() {
      await disable();
      await store.deleteAll();
      await browser.storage.local.remove(LEGACY_JEV_KEY);
      scan = null;
      return state();
    }
  };

  function onConnect(port) {
    if (port.name !== PORT_NAME) return;
    ports.add(port);
    port.onDisconnect.addListener(() => ports.delete(port));
    port.onMessage.addListener(async (m) => {
      const h = m && typeof m.type === 'string' && Object.prototype.hasOwnProperty.call(handlers, m.type) ? handlers[m.type] : null;
      let reply;
      try { reply = h ? { ok: true, result: await h(m) } : { ok: false, error: 'UNKNOWN_TYPE' }; }
      catch (e) {
        console.error('V4 Today:', m && m.type, e);
        reply = { ok: false, error: String(e && e.code || 'FAILED'), detail: e && e.code ? (e.detail || '') : detailOf(e) };
      }
      try { port.postMessage(Object.assign({ type: 'reply', id: m && m.id }, reply)); } catch (e) { ports.delete(port); }
    });
  }

  // New mail and a sent message are only reasons to look again; what the page
  // shows always comes from messages the scan actually located. The new-mail
  // event needs accountsRead, so this runs only once that is granted.
  let listening = false;
  function attachMailListeners() {
    if (listening) return;
    listening = true;
    try { browser.messages.onNewMailReceived.addListener(scheduleRescan, true); }
    catch (e) { try { browser.messages.onNewMailReceived.addListener(scheduleRescan); } catch (e2) { /* event unavailable */ } }
    try { browser.compose.onAfterSend.addListener(scheduleRescan); } catch (e) { /* TB < 105 */ }
  }

  async function init() {
    browser.runtime.onConnect.addListener(onConnect);
    if (!supported()) return;
    let config = await store.getConfig();
    // First run: on, for every mail folder. After that, "off" is the editor's
    // own choice and is never undone behind their back.
    if (!config.setupDone) config = await store.setConfig({ enabled: true, setupDone: true });
    if (config.enabled) await ensureSpace();
    store.pruneVerdicts().catch(() => {});
    store.pruneUserStates().catch(() => {});
    // Settings the page no longer offers go back to how Today works for
    // everyone: classifying, grouping by the answers, newsletters hidden. An
    // editor who changed one in an earlier build would otherwise be stuck with
    // it and no way back.
    if (config.modelOff || config.shadow || config.showNewsletters) {
      config = await store.setConfig({ modelOff: false, shadow: false, showNewsletters: false });
    }
    // Counts a test build kept for the pilot; nothing reads them any more.
    browser.storage.local.remove('triage:v1:signals').catch(() => {});
    browser.storage.local.remove(LEGACY_JEV_KEY).catch(() => {});
    attachMailListeners();
    if (browser.permissions.onRemoved) {
      browser.permissions.onRemoved.addListener(async (p) => {
        if ((p.permissions || []).indexOf('accountsRead') !== -1) { await disable(); broadcast({ type: 'snapshot', snapshot: getScan().snapshot() }); }
      });
    }
  }

  init().catch((e) => console.error('V4 Today init failed:', e));

  return Object.freeze({ supported });
})();
