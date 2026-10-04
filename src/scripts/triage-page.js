// The Today page. Talks to the background page over the `triage:v1` port and
// renders rows it is given; it never reads mail itself. All text from mail goes
// through textContent — nothing here builds HTML from strings, and nothing from
// a message is ever made clickable.

(function () {
  'use strict';

  const S = TriageSchema;
  const $ = (id) => document.getElementById(id);
  const main = $('t-main');

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function button(label, className, onClick) {
    const b = el('button', className || 'mark-btn', label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // ---- what the editor has not finished ------------------------------------------------
  // renderMain throws the page away and builds it again, and while a scan runs
  // the background sends fresh rows every few answers. Without help, everything
  // half-done goes out with the old page: a folder ticked but not saved, an
  // open fold, the control under her hands.
  // So a control that carries something of hers is given a name, and the name
  // is what its value and the focus travel back on. A name and not a position,
  // because rows come and go between renders and a position would quietly hand
  // her a different row's control.
  function named(node, name) { node.dataset.keep = name; return node; }
  function holds(node, name) { node.dataset.holds = ''; return named(node, name); }

  const heldValues = new Map();
  let heldFocus = null, heldRange = null;

  function valueOf(n) { return n.tagName === 'DETAILS' ? n.open : (n.type === 'checkbox' || n.type === 'radio') ? n.checked : n.value; }
  function setValue(n, v) { if (n.tagName === 'DETAILS') n.open = v; else if (n.type === 'checkbox' || n.type === 'radio') n.checked = v; else n.value = v; }

  // A control with no name of its own is recognised by the row it sits in and
  // by what it says. That is enough to put focus back, and a miss costs only
  // the focus — which is what every re-render costs today.
  function nameOf(node) {
    if (!node || node === main || !node.dataset || !main.contains(node)) return null;
    if (node.dataset.keep) return node.dataset.keep;
    const holder = node.closest('[data-key]');
    const says = node.getAttribute('aria-label') || (node.textContent || '').trim().slice(0, 40);
    return says ? '~' + (holder ? holder.dataset.key : '') + '|' + node.tagName + '|' + says : null;
  }

  // Only a text field has a caret, and only a text field minds losing one. The
  // page has none today; asking a checkbox where its caret is would be asking
  // for trouble, so nothing but a text field is ever asked.
  function texty(n) { return !!n && (n.tagName === 'TEXTAREA' || (n.tagName === 'INPUT' && (n.type === 'text' || n.type === 'search'))); }

  function hold() {
    const active = document.activeElement;
    heldFocus = nameOf(active);
    heldRange = heldFocus && texty(active) ? [active.selectionStart, active.selectionEnd] : null;
    for (const node of main.querySelectorAll('[data-holds]')) heldValues.set(node.dataset.keep, valueOf(node));
  }

  // The folder picker is fetched, so it is built long after the render that
  // asked for it: it reads its own kept value as it builds, instead of waiting
  // to be put back with the rest.
  function heldValue(name, fallback) { return heldValues.has(name) ? heldValues.get(name) : fallback; }

  function restore() {
    for (const node of main.querySelectorAll('[data-holds]')) if (heldValues.has(node.dataset.keep)) setValue(node, heldValues.get(node.dataset.keep));
    // An explicit key wins: after Done or Snooze she should land on the row she
    // acted on, not on whatever stood where it used to be.
    const target = view.focusKey ? main.querySelector('.t-row[data-key="' + CSS.escape(view.focusKey) + '"]')
      : !heldFocus ? null
        : heldFocus[0] !== '~' ? main.querySelector('[data-keep="' + CSS.escape(heldFocus) + '"]')
          : Array.from(main.querySelectorAll('a, button, input, select, textarea, summary, [tabindex]')).find((n) => nameOf(n) === heldFocus);
    view.focusKey = null;
    if (!target) return;
    target.focus();
    if (heldRange && texty(target)) target.setSelectionRange(heldRange[0], heldRange[1]);
  }

  // ---- port ---------------------------------------------------------------------------
  let port = null, nextId = 1;
  const pending = new Map();

  function connect() {
    port = browser.runtime.connect({ name: 'triage:v1' });
    port.onMessage.addListener(onPush);
    port.onDisconnect.addListener(() => {
      port = null;
      for (const p of pending.values()) p.reject(new Error('DISCONNECTED'));
      pending.clear();
    });
  }

  function ask(type, extra) {
    if (!port) connect();
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      port.postMessage(Object.assign({ type, id }, extra || {}));
    });
  }

  function onPush(m) {
    if (m.type === 'reply') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.result); else { const err = new Error(m.error || 'FAILED'); err.detail = m.detail || ''; p.reject(err); }
    } else if (m.type === 'rows') {
      // Until the first scan has finished, rows arriving mid-scan are not yet
      // ranked by Jev; the "getting ready" card stays up instead of a list that
      // would reshuffle under her as the answers come in.
      view.rows = m.rows;
      if (view.ready) renderMain();
    }
    else if (m.type === 'snapshot') { applySnapshot(m.snapshot); renderMain(); }
    else if (m.type === 'progress') showProgress(m.progress);
    else if (m.type === 'error') toast('The scan stopped: ' + m.error);
  }

  // ---- state ---------------------------------------------------------------------------------
  const view = { app: null, rows: [], coverage: null, status: 'idle', filter: null, mailbox: null, expanded: new Set(), selected: new Set(), collapsed: new Set(['low', 'no_reply_needed', 'closed', 'done']), showSettings: false, focusKey: null };

  function applySnapshot(snap) {
    if (!snap) return;
    view.rows = snap.rows || [];
    view.coverage = snap.coverage || null;
    view.pausedUntil = typeof snap.modelPausedUntil === 'number' ? snap.modelPausedUntil : null;
    view.status = snap.status;
    view.modelState = snap.modelState || null;
    // A scan has finished at least once (this one, or one the add-on ran
    // before the tab was opened): from now on there is a list to show.
    if (snap.status === 'ready' || snap.coverage) view.ready = true;
    if (snap.status !== 'scanning') { hideProgress(); view.prog = {}; }
  }

  const ERRORS = {
    ARCHIVE_UNAVAILABLE: 'This Thunderbird cannot archive from here. Open the message and archive it there.',
    TRASH_UNAVAILABLE: 'This Thunderbird cannot move mail from here. Open the message and delete it there.',
    NO_TRASH_FOLDER: 'No Trash folder could be identified for this account, so nothing was moved. Delete the message from the message window instead.',
    ALREADY_IN_TRASH: 'That message is already in Trash.',
    UNSUPPORTED: 'Today needs Thunderbird 128 or newer.',
    NO_ACCOUNTS_PERMISSION: 'Today needs permission to see your accounts and folders.',
    MESSAGE_NOT_FOUND: 'That message could not be found any more. Refresh and try again.',
    ROW_GONE: 'That row is out of date. Refresh and try again.',
    DISCONNECTED: 'Lost the connection to the add-on. Reload this tab.',
    API_NOT_READY: 'Thunderbird has not given the add-on access to your folder list yet. Restart Thunderbird once, then open Today again.',
    ACCOUNTS_LIST_FAILED: 'Thunderbird could not list your accounts.'
  };
  const say = (e) => {
    const known = ERRORS[e && e.message];
    const detail = e && e.detail ? ' — ' + e.detail : '';
    return known ? known + (e.message === 'ACCOUNTS_LIST_FAILED' ? detail : '') : 'That did not work (' + (e && e.message || 'unknown') + detail + ').';
  };

  // ---- toast / progress --------------------------------------------------------------------------------
  let toastTimer = null;
  function toast(text, actionLabel, action) {
    const t = $('t-toast');
    clear(t);
    t.appendChild(el('span', null, text));
    if (actionLabel) t.appendChild(button(actionLabel, 'mark-btn t-toast-btn', () => { t.hidden = true; action(); }));
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 8000);
  }
  // Two ways to show a scan going on. The first time — nothing to show yet —
  // the page is the "getting ready" card, which fills in as each stage reports.
  // Once there is a list, the list stays and a thin bar under the header moves.
  const STAGES = ['index', 'bodies', 'model'];
  let cardFrame = 0;
  function showProgress(p) {
    view.prog = Object.assign(view.prog || {}, { phase: p.phase, [p.phase]: { done: p.done, total: p.total } },
      p.messages !== undefined ? { messages: p.messages } : {}, p.oldest ? { oldest: p.oldest } : {},
      p.mailboxes ? { mailboxes: p.mailboxes } : {}, p.days ? { days: p.days } : {});
    if (!view.ready) {
      $('t-progress').hidden = true;
      // Hundreds of reports in a scan; one redraw per frame is plenty.
      if (!cardFrame) cardFrame = requestAnimationFrame(() => { cardFrame = 0; renderMain(); });
      return;
    }
    // Each phase counts a different set, so each says which one.
    const say = {
      index: (d, t) => 'Reading folders \u2014 ' + d + ' of ' + t,
      bodies: (d, t) => 'Reading the ' + t + ' messages that could need you \u2014 ' + d + ' done',
      model: (d, t) => 'Asking Jev about ' + t + ' messages \u2014 ' + d + ' done'
    };
    const bar = $('t-progress');
    clear(bar);
    bar.appendChild(el('span', null, (say[p.phase] || ((d, t) => 'Working \u2014 ' + d + ' of ' + t))(p.done, p.total)));
    // One bar across the whole scan: reading folders is quick, reading
    // messages takes longer, asking Jev takes longest.
    const span = { index: [0, 0.15], bodies: [0.15, 0.45], model: [0.45, 1] }[p.phase] || [0, 1];
    const fill = el('i', 't-progress-bar');
    fill.style.width = Math.round((span[0] + (span[1] - span[0]) * (p.total ? p.done / p.total : 0)) * 100) + '%';
    bar.appendChild(fill);
    bar.hidden = false;
  }
  function hideProgress() { $('t-progress').hidden = true; }

  // ---- formatting -----------------------------------------------------------------------------------------
  function initials(who) {
    const base = (who && (who.name || who.address) || '?').replace(/@.*/, '');
    const parts = base.split(/[\s._\-]+/).filter(Boolean);
    const ini = parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] || '?').slice(0, 2);
    return ini.toUpperCase();
  }
  function ago(ms) {
    const d = Math.floor((Date.now() - ms) / 86400000);
    if (d <= 0) return 'today';
    return d === 1 ? '1 day ago' : d + ' days ago';
  }
  // Same age, in the space of a row: "3 h", "2 d".
  function shortAge(ms) {
    const h = Math.max(0, Math.floor((Date.now() - ms) / 3600000));
    return h < 1 ? 'now' : h < 24 ? h + ' h' : Math.floor(h / 24) + ' d';
  }
  function pct(c) { return typeof c === 'number' ? Math.round(c * 100) + '%' : ''; }

  const FACTOR_TEXT = {
    deadline_close: 'The sender gives a deadline within three days',
    deadline: 'The sender gives a deadline',
    deadline_passed: 'The deadline the sender gave has passed',
    promised_date_passed: 'The date they promised has passed',
    production_waiting: 'Production is waiting on your next step',
    manuscript_waiting: 'A manuscript has arrived and is not dealt with yet',
    file_to_check: 'A file is attached and has not been looked at',
    material_supplied: 'They sent what you asked for',
    money_waiting: 'Money is involved: an order, a payment or royalties',
    needs_reply: 'The sender expects an answer',
    waiting: 'Message dated three or more working days ago'
  };

  const LOGO_H = 22, LOGO_W = 112;       // the box a mailbox logo is fitted into
  const PAGE = 15;                       // rows of one group shown before "show the rest"
  // Priority as a traffic light on each band heading: three dots, lit to the
  // band's level, red for high, amber for medium, green for low. The bands
  // that are not about urgency at all — waiting, no reply needed, closed, done
  // — get one grey dot: green there would read as "fine", which is a verdict
  // those rows have not earned.
  const BAND = { do_first: ['high', 3], then: ['medium', 2], low: ['low', 1], needs_review: ['medium', 2], system_tasks: ['medium', 2] };
  function dots(g) {
    const [tone, n] = BAND[g] || ['none', 1];
    const wrap = el('span', 't-dots t-dots-' + tone);
    wrap.setAttribute('aria-hidden', 'true');
    for (let i = 1; i <= 3; i++) wrap.appendChild(el('i', i <= n ? 'on' : ''));
    return wrap;
  }

  // One label per row: the one that says most about THIS message. The last chip
  // a row was given is the most specific — code facts are added first, the
  // judgment that follows from them last.
  function leadChip(chips) {
    if (!chips || !chips.length) return null;
    const strong = ['representative', 'authorization', 'manuscript', 'send_brochure', 'approval', 'changes', 'promise_passed', 'opt_out', 'not_now'];
    for (const id of strong) { const hit = chips.find((c) => c.id === id); if (hit) return hit; }
    return chips[chips.length - 1];
  }

  // Two small, exact icons. Anything bigger would compete with Open message.
  const ICONS = {
    archive: 'M3 4h14v3H3zM4.5 8h11l-.8 8.2H5.3zM8 11h4',
    trash: 'M4 6h12M8 6V4h4v2M6.5 6l.7 10h5.6l.7-10M9 9v5M11 9v5',
    dismiss: 'M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5zM8 10a2 2 0 1 0 4 0a2 2 0 1 0-4 0M4 4l12 12'
  };
  function iconButton(name, label, fn) {
    const b = button('', 'mark-btn t-icon', (ev) => { ev.stopPropagation(); fn(); });
    b.title = label;
    b.setAttribute('aria-label', label);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICONS[name]);
    svg.appendChild(path);
    b.appendChild(svg);
    return b;
  }

  function chipEl(c) {
    const e = el('span', 't-chip t-' + (c.tone || 'neutral'), c.label);
    e.title = (c.source === 'model' ? 'Model judgment' + (c.confidence !== null ? ' · ' + pct(c.confidence) : '') : 'Established by code');
    return e;
  }

  // ---- actions ----------------------------------------------------------------------------------------------
  // Every row opens the message, because that is where the editor's tools are:
  // OmniReply's "Draft compliant reply" is a reading-context action, offered
  // beside Reply when a message is open and NOT offered inside a compose
  // window. Opening a blank reply from here would take her to the one place
  // her drafting habit does not work. Today decides what to work on; the
  // message window is where the work happens.
  const STEP_ACTION = { open_in_v4: 'openInV4' };
  const STEP_LABEL = { open_in_v4: 'Open in V4' };

  async function act(type, key) {
    try { await ask(type, { key }); } catch (e) { toast(say(e)); }
  }

  async function change(keys, patch, label) {
    view.focusKey = keys[0];
    try {
      const snap = await ask('userChange', { changes: keys.map((key) => ({ key, patch })), label });
      applySnapshot(snap);
      view.selected.clear();
      renderMain();
      toast(label, 'Undo', async () => {
        try { const r = await ask('undo'); applySnapshot(r.snapshot); renderMain(); } catch (e) { toast(say(e)); }
      });
    } catch (e) { toast(say(e)); }
  }

  // What an action on a row means: every message of its conversation.
  const keysOf = (r) => (r && Array.isArray(r.keys) && r.keys.length ? r.keys : [r.key]);

  const snoozeUntil = (days) => { const d = new Date(); d.setHours(8, 0, 0, 0); d.setDate(d.getDate() + days); return d.getTime(); };

  // ---- row --------------------------------------------------------------------------------------------------------
  function rowEl(r) {
    const d = r.display;
    const row = el('div', 't-row' + (d.read ? '' : ' unread'));
    row.dataset.key = r.key;
    // The row says its own age, which changes under her, so it is named
    // outright rather than recognised by what it says.
    named(row, 'row:' + r.key);
    row.tabIndex = 0;

    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = view.selected.has(r.key);
    cb.setAttribute('aria-label', 'Select');
    cb.addEventListener('change', () => { if (cb.checked) view.selected.add(r.key); else view.selected.delete(r.key); renderBulk(); });
    row.appendChild(cb);

    const av = el('div', 'lead-avatar t-avatar' + (d.dir === 'system' ? ' sys' : ''), d.dir === 'system' ? '•' : initials(d.who));
    // A colleague gets their signature photo; anyone else, and any photo that is
    // not there, keeps the initials. Only colleagues are looked up, so no
    // author's name is ever sent to that server.
    if (d.dir === 'internal' && d.who && d.who.address) {
      const photo = S.employeePhoto(d.who.address);
      if (photo.photoUrl) {
        const img = el('img', 't-photo');
        img.src = photo.photoUrl;
        img.alt = '';
        img.addEventListener('load', () => { clear(av); av.appendChild(img); av.classList.add('has-photo'); });
      }
    }
    av.setAttribute('aria-hidden', 'true');
    row.appendChild(av);

    // Name, one sentence, one label. Everything else — subject, ISBNs, priority
    // reasons, the other labels — is one click away under Details, because a
    // list that says everything at once says nothing.
    const mid = el('div', 't-mid');
    // A conversation names everyone who wrote in it, the latest first, and
    // says how many messages it holds — the row stands for all of them.
    const whoLine = el('div', 't-who', d.dir === 'system' ? 'Platform notification'
      : (d.people && d.people.length > 1 ? d.people.join(', ') : (d.who.name || d.who.address || 'Unknown sender')));
    if (r.count > 1) {
      const n = el('span', 't-count', String(r.count));
      n.title = r.count + ' messages in this conversation';
      whoLine.appendChild(n);
    }
    mid.appendChild(whoLine);
    // The subject is what she recognises a message by; why the row is here is
    // one line down, under Details.
    // Sixteen platform notices share one subject; the book they are about is
    // the only thing that tells them apart.
    const sysTitle = d.system && d.system.fields && d.system.fields.title;
    mid.appendChild(el('div', 't-reason', sysTitle || d.subject || '(no subject)'));
    if (d.preview) mid.appendChild(el('div', 't-preview', d.preview));
    row.appendChild(mid);

    const right = el('div', 't-right');
    const lead = d.modelError ? { id: 'model', label: d.modelBusy ? 'Model busy' : 'Model unavailable', tone: 'warn', source: 'code', confidence: null } : leadChip(r.chips);
    if (lead) right.appendChild(chipEl(lead));
    const age = el('span', 't-age', shortAge(d.date));
    age.title = 'Message dated ' + ago(d.date);
    right.appendChild(age);
    // Only offered when Thunderbird really has them (see mailAbilities).
    const can = (view.app && view.app.can) || {};
    const many = r.count > 1;
    // Dismiss takes the row off Today and leaves the mail exactly where it is:
    // for the message she has decided to ignore without filing or deleting it.
    // It comes back only if something new arrives in the conversation.
    right.appendChild(iconButton('dismiss', many ? 'Dismiss this conversation from Today (the emails stay where they are)' : 'Dismiss from Today (the email stays where it is)',
      () => change(keysOf(r), { state: 'done' }, 'Dismissed')));
    if (can.archive) right.appendChild(iconButton('archive', many ? 'Archive all ' + r.count + ' messages' : 'Archive this message', () => mailAction('archive', keysOf(r), 'Archived')));
    if (can.trash) right.appendChild(iconButton('trash', many ? 'Move all ' + r.count + ' messages to Trash' : 'Move this message to Trash', () => mailAction('trash', keysOf(r), 'Moved to Trash')));
    const step = button(STEP_LABEL[r.nextStep] || 'Open message', 'mark-btn t-step', (ev) => { ev.stopPropagation(); act(STEP_ACTION[r.nextStep] || 'open', r.key); });
    right.appendChild(step);
    row.appendChild(right);

    // A row is a message, not a dossier: clicking it opens the message in
    // Thunderbird, which is what an editor wants from a list. Everything the
    // page knows about a row is said on the row itself.
    row.addEventListener('click', (ev) => { if (!ev.target.closest('input, button')) act('open', r.key); });

    row.addEventListener('keydown', (ev) => {
      if (ev.target !== row) return;
      if (ev.key === 'Enter') { ev.preventDefault(); act('open', r.key); }
      else if (ev.key === 'd') change(keysOf(r), { state: 'done' }, 'Marked done');
      else if (ev.key === 's') change(keysOf(r), { state: 'snoozed', until: snoozeUntil(3) }, 'Snoozed for 3 days');
      else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const all = Array.from(main.querySelectorAll('.t-row'));
        const next = all[all.indexOf(row) + (ev.key === 'ArrowDown' ? 1 : -1)];
        if (next) next.focus();
      }
    });

    const wrap = el('div', 't-rowwrap');
    wrap.dataset.key = r.key;
    wrap.appendChild(row);
    return wrap;
  }

  // The one thing Today changes in the mailbox. Always undoable, and the undo
  // puts the message back in the folder it came from.
  async function mailAction(what, keys, label) {
    try {
      const res = await ask(what, { keys });
      applySnapshot(res.snapshot);
      renderMain();
      toast(label, 'Undo', async () => {
        try { applySnapshot((await ask('undoMail', { undo: res.undo })).snapshot); renderMain(); toast('Put back'); }
        catch (e) { toast(say(e)); }
      });
    } catch (e) { toast(say(e)); }
  }

  // ---- getting ready ------------------------------------------------------------------------------------------------------------
  // The first time the page opens there is nothing to show until the scan has
  // been through three stages, so the page says which stage it is in and how
  // far through. Numbers appear as each stage finds them.
  function gettingReadyEl() {
    const pr = view.prog || {};
    const at = STAGES.indexOf(pr.phase);
    const n = (v) => Number(v || 0).toLocaleString();
    const card = el('div', 't-ready');
    card.setAttribute('role', 'status');
    card.appendChild(el('h2', 't-ready-title', 'Getting your Today ready'));
    const boxes = (pr.mailboxes || []).map((b) => S.mailboxLabel(b));
    if (boxes.length) {
      card.appendChild(el('p', 't-ready-sub', boxes.length === 1 ? boxes[0]
        : boxes.slice(0, 3).join(', ') + (boxes.length > 3 ? ' and ' + (boxes.length - 3) + ' more mailboxes' : '')));
    }
    const since = pr.oldest ? new Date(pr.oldest).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : null;
    const folders = pr.index || {};
    const steps = [
      { label: 'Reading your folders',
        done: folders.total ? n(folders.total) + ' folders \u00b7 ' + n(pr.messages) + ' messages' + (since ? ' since ' + since : '') : '',
        now: folders.total ? n(folders.done) + ' of ' + n(folders.total) + ' folders' : 'Starting\u2026', bar: false },
      { label: 'Finding what could need you',
        done: pr.bodies ? n(pr.bodies.total) + ' messages from the last ' + (pr.days || 30) + ' days' : '', bar: true },
      { label: 'Asking Jev about each one', bar: true }
    ];
    // With classification switched off there is no third stage to wait for.
    if (view.app && view.app.config && view.app.config.modelOff) steps.pop();
    const list = el('ol', 't-ready-steps');
    steps.forEach((st, i) => {
      const state = i < Math.max(at, 0) ? 'done' : i === Math.max(at, 0) ? 'now' : 'next';
      const li = el('li', 't-ready-step ' + state);
      const dot = el('span', 't-ready-dot', state === 'done' ? '' : String(i + 1));
      if (state === 'done') {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M4 10.5l4 4 8-9');
        svg.appendChild(path); dot.appendChild(svg);
      }
      li.appendChild(dot);
      const body = el('div');
      body.appendChild(el('div', 't-ready-label', st.label));
      const count = pr[STAGES[i]];
      if (state === 'now' && st.bar && count && count.total) {
        const bar = el('div', 't-ready-bar');
        const fill = el('i');
        fill.style.width = Math.round(100 * count.done / count.total) + '%';
        bar.appendChild(fill);
        body.appendChild(bar);
        body.appendChild(el('div', 't-ready-meta', n(count.done) + ' of ' + n(count.total)));
      } else if (state === 'now' && st.now) {
        body.appendChild(el('div', 't-ready-meta', st.now));
      } else if (state === 'done' && st.done) {
        body.appendChild(el('div', 't-ready-meta', st.done));
      }
      li.appendChild(body);
      list.appendChild(li);
    });
    card.appendChild(list);
    const wrap = el('div', 't-ready-wrap');
    wrap.appendChild(card);
    return wrap;
  }

  // ---- mailbox picker ---------------------------------------------------------------------------------------------------------------
  // One choice out of a few, so it is a segmented control: the imprints' own
  // logos on a shared track, and a white thumb that slides to the one being
  // worked on. No counts — the list below says what is there. An empty
  // mailbox is only dimmed, so it is still there to pick.
  //
  // The whole page is rebuilt on every render, the thumb included, so it would
  // simply appear in its new place. To move it, each render builds the thumb
  // where it was last time and then sends it to where it belongs.
  let mailboxAt = null;
  const logoScale = new Map();     // logo file -> the size factor it settled at
  function mailboxPicker(boxes) {
    const scroll = el('div', 't-seg-scroll');
    const track = el('div', 't-seg');
    track.setAttribute('role', 'radiogroup');
    track.setAttribute('aria-label', 'Mailbox');
    track.style.setProperty('--n', String(boxes.length));
    const index = Math.max(0, boxes.findIndex((b) => b.id === view.mailbox));
    const thumb = el('span', 't-seg-thumb');
    thumb.setAttribute('aria-hidden', 'true');
    thumb.style.setProperty('--i', String(mailboxAt === null || mailboxAt >= boxes.length ? index : mailboxAt));
    track.appendChild(thumb);

    const pick = (i, focus) => {
      const b = boxes[i];
      if (!b || b.id === view.mailbox) return;
      view.mailbox = b.id;
      view.filter = null;
      renderMain();
      window.scrollTo(0, 0);
      if (focus) { const next = main.querySelector('[data-keep="mailbox:' + CSS.escape(b.id) + '"]'); if (next) next.focus(); }
    };
    boxes.forEach((b, i) => {
      const on = i === index;
      const empty = !view.rows.some((r) => r.display.accountId === b.id);
      const label = S.mailboxLabel(b);
      const imprint = S.mailboxImprint(b);
      const opt = named(button('', 't-seg-opt' + (on ? ' on' : '') + (empty ? ' t-mailbox-empty' : ''), () => pick(i, false)), 'mailbox:' + b.id);
      opt.setAttribute('role', 'radio');
      opt.setAttribute('aria-checked', String(on));
      opt.setAttribute('aria-label', label + (empty ? ', nothing in it' : ''));
      // Arrow keys move within the group; Tab enters and leaves it once.
      opt.tabIndex = on ? 0 : -1;
      opt.title = label + ((b.identities || []).length ? ' \u00b7 ' + b.identities.join(', ') : '');
      opt.addEventListener('keydown', (ev) => {
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
        const to = step ? (i + step + boxes.length) % boxes.length : ev.key === 'Home' ? 0 : ev.key === 'End' ? boxes.length - 1 : null;
        if (to === null) return;
        ev.preventDefault();
        pick(to, true);
      });
      if (imprint && imprint.logo) {
        const img = el('img', 't-logo');
        img.alt = '';
        // A long single-line wordmark reads much heavier than a stacked logo
        // at the same height, so the wider it is the smaller its box gets. The
        // size is remembered once known: every render redraws the logos, and
        // one that started full size and shrank a moment later jolted as the
        // thumb slid under it.
        const size = (f) => { img.style.maxHeight = (LOGO_H * f).toFixed(1) + 'px'; img.style.maxWidth = (LOGO_W * f).toFixed(1) + 'px'; };
        if (logoScale.has(imprint.logo)) size(logoScale.get(imprint.logo));
        img.addEventListener('load', () => {
          const ratio = img.naturalWidth / (img.naturalHeight || 1);
          const f = ratio >= 10 ? 0.74 : ratio >= 6 ? 0.84 : ratio >= 4 ? 0.94 : 1;
          logoScale.set(imprint.logo, f);
          size(f);
        });
        img.src = imprint.logo;
        img.addEventListener('error', () => { img.replaceWith(el('span', 't-mailbox-name', label)); });
        opt.appendChild(img);
      } else {
        opt.appendChild(el('span', 't-mailbox-name', label));
      }
      track.appendChild(opt);
    });
    scroll.appendChild(track);

    // Built where it was; now, once it is on the page, sent where it belongs.
    if (mailboxAt !== null && mailboxAt !== index) {
      requestAnimationFrame(() => { void thumb.offsetWidth; thumb.style.setProperty('--i', String(index)); });
    }
    mailboxAt = index;
    return scroll;
  }

  // ---- main view ----------------------------------------------------------------------------------------------------------------
  // A number you cannot act on is decoration. The three batch tiles are
  // buttons: pressing one shows that queue alone, pressing it again shows
  // everything. The first tile is the whole list, so it clears the filter.
  function tile(n, label, id) {
    const on = view.filter === id;
    const t = named(button('', 't-tile' + (on ? ' on' : ''), () => { view.filter = on ? null : id; renderMain(); window.scrollTo(0, 0); }), 'tile:' + id);
    t.setAttribute('aria-pressed', String(on));
    if (!n) t.disabled = true;
    t.appendChild(el('div', 't-tile-n', String(n)));
    t.appendChild(el('div', 't-tile-l', label));
    return t;
  }

  // The six agreed cards. A card stands for the rows placed in it by
  // TriageState.cardOf — the same rule for every view, so a count and its list
  // can never disagree.
  const QUEUES = {};
  for (const id of S.CARDS) QUEUES[id] = ((c) => (r) => r.card === c)(id);

  function renderBulk() {
    const bar = $('t-bulk');
    if (!bar) return;
    clear(bar);
    const picked = Array.from(view.selected);
    bar.hidden = !picked.length;
    if (!picked.length) return;
    // A tick is on a conversation; the marks go on every message in it.
    const byKey = new Map(view.rows.map((r) => [r.key, r]));
    const keys = [].concat(...picked.map((k) => keysOf(byKey.get(k) || { key: k })));
    bar.appendChild(el('span', null, picked.length + ' selected'));
    bar.appendChild(button('Done', 'mark-btn', () => change(keys, { state: 'done' }, 'Marked ' + picked.length + ' done')));
    bar.appendChild(button('Snooze 3 days', 'mark-btn', () => change(keys, { state: 'snoozed', until: snoozeUntil(3) }, 'Snoozed ' + picked.length)));
    bar.appendChild(button('Clear', 'mark-btn', () => { view.selected.clear(); renderMain(); }));
  }

  // paint() has several ways out — a pressed card returns early, so does an
  // unsupported Thunderbird — and every one of them must give the editor back
  // what she had. Holding and restoring around it is the only place that is true.
  function renderMain() {
    hold();
    try { paint(); } finally { restore(); }
  }

  function paint() {
    const app = view.app;
    $('t-refresh').hidden = $('t-settings-btn').hidden = !(app && app.config.enabled);
    clear(main);
    if (!app) return;
    if (!app.supported) return void main.appendChild(notice('Today needs a newer Thunderbird', 'This page uses folder features that arrived in Thunderbird 128. The rest of V4 Contacts Checker keeps working as before.'));
    if (!app.config.enabled) return void main.appendChild(setupEl());
    if (view.showSettings) main.appendChild(settingsEl());
    if (!view.ready && view.status !== 'error' && view.status !== 'disabled') return void main.appendChild(gettingReadyEl());

    // With several mailboxes open, one list mixes imprints together. Pick one
    // first; the choice is remembered, and the cards and groups below follow it.
    const boxes = (view.coverage && view.coverage.mailboxes) || [];
    // Every scanned mailbox stays in the picker, including the empty ones: a
    // missing mailbox reads as a bug, and "0" is an answer.
    const withRows = boxes.slice();
    if (withRows.length > 1) {
      if (!view.mailbox || !withRows.some((b) => b.id === view.mailbox)) view.mailbox = withRows[0].id;
      main.appendChild(el('div', 't-mailbox-l', 'Mailbox'));
      main.appendChild(mailboxPicker(withRows));
    } else if (view.mailbox && !withRows.some((b) => b.id === view.mailbox)) {
      view.mailbox = null;
    }

    const all = withRows.length > 1 ? view.rows.filter((r) => r.display.accountId === view.mailbox) : view.rows;
    // The way back out of a card filter is the card itself: pressing the one
    // that is lit turns it off. It is blue, it is the thing that was just
    // clicked, and a second control saying the same thing only added a line.

    // Only the cards with something in them, so the row is short and the ones
    // that remain are wide enough to read. If every card is empty they all
    // stay: that state usually means something is wrong, and the banner above
    // says what.
    const counts = S.CARDS.map((id) => ({ id, n: all.filter(QUEUES[id]).length }));
    const filled = counts.filter((c) => c.n > 0);
    const shown = filled.length ? filled : counts;
    const tiles = el('div', 't-tiles');
    tiles.style.gridTemplateColumns = 'repeat(' + Math.min(shown.length, 6) + ', minmax(0, 1fr))';
    for (const c of shown) tiles.appendChild(tile(c.n, S.CARD_LABELS[c.id], c.id));
    main.appendChild(tiles);

    // Rows below follow the tile that is pressed.
    const rows = view.filter && QUEUES[view.filter] ? all.filter(QUEUES[view.filter]) : all;
    const inGroup = (g) => rows.filter((r) => r.group === g);

    // A tick belongs to a row she can see. Switching mailbox, pressing a card
    // or a scan that drops a row used to leave the tick behind, so "3 selected"
    // could mark messages that were not on the page — in another mailbox, or
    // gone altogether.
    if (view.selected.size) {
      const here = new Set(rows.map((r) => r.key));
      for (const key of Array.from(view.selected)) if (!here.has(key)) view.selected.delete(key);
    }

    // Why rows are not classified, in the editor's terms — and whose move it is.
    const openSettings = () => { view.showSettings = true; renderMain(); window.scrollTo(0, 0); };
    const actionBanner = (text, label, fn) => { const b = el('div', 't-banner t-banner-action'); b.appendChild(el('span', null, text)); if (label) b.appendChild(button(label, 'mark-btn', fn)); main.appendChild(b); };
    const STOPPED = {
      invalid_key: 'Your V4 API key was refused by the classification service, so messages are not classified. Check the key in the add-on\u2019s Preferences.',
      ACCESS_REVOKED: 'Classification has been withdrawn for this V4 key, so messages are not classified. Ask your administrator.',
      MODEL_KEY_REFUSED: 'Classification is not available: the service\u2019s own model key needs your administrator\u2019s attention. Nothing is wrong on your side.',
      TRIAGE_SCHEMA_UNSUPPORTED: 'This version of the add-on is not accepted by the classification service. Update the add-on \u2014 nothing is wrong on your side.'
    };
    STOPPED.missing_key = STOPPED.NO_V4_KEY = STOPPED.HTTP_401 = STOPPED.invalid_key;
    STOPPED.HTTP_403 = STOPPED.ACCESS_REVOKED;
    STOPPED.MODEL_NOT_CONFIGURED = STOPPED.MODEL_KEY_REFUSED;
    STOPPED.MODEL_NOT_ALLOWED = STOPPED.METHOD_NOT_ALLOWED = STOPPED.UNSUPPORTED_MEDIA_TYPE = STOPPED.TRIAGE_SCHEMA_UNSUPPORTED;

    const ms = view.modelState;
    if (view.showSettings) { /* the Settings card says it all */ }
    else if (app.config.modelOff) actionBanner('Classification is switched off, so rows show only what the add-on can see for itself.', 'Open Settings', openSettings);
    else if (ms === 'no_v4_key' || (!app.hasV4Key && ms !== 'on')) actionBanner('Add your V4 API key in the add-on\u2019s Preferences: classification uses it to recognise you. Until then rows show only what the add-on can see for itself.', null);
    else if (ms === 'unavailable') main.appendChild(el('p', 't-banner', 'The classification service is not available right now, so messages are not classified \u2014 nothing was sent. Press Refresh to try again.'));
    else if (c0(view) && c0(view).model) {
      const m = c0(view).model;
      if (m.refused) {
        main.appendChild(el('p', 't-banner', STOPPED[m.stopCode] || STOPPED.MODEL_KEY_REFUSED));
      } else if (m.busy) {
        const n = m.busy + (m.busy === 1 ? ' message is' : ' messages are') + ' not classified yet: ';
        if (m.stopCode === 'v4_unreachable' || m.stopCode === 'GATEWAY_UNAVAILABLE') {
          main.appendChild(el('p', 't-banner', n + (m.stopCode === 'v4_unreachable'
            ? 'the classification service could not confirm your V4 API key with V4 just now. Today asks again by itself in a few minutes. If this message stays, check the key in the add-on\u2019s Preferences.'
            : 'the classification service is having trouble right now. Today asks again by itself in a few minutes \u2014 nothing to do.')));
        } else {
        const until = view.pausedUntil && view.pausedUntil > Date.now() ? view.pausedUntil : null;
        // A long pause is said as it is, with its end; Today does not pretend to retry sooner.
        main.appendChild(el('p', 't-banner', until && until - Date.now() > 3600000
          ? n + 'the classification service asked to be left alone until ' + new Date(until).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + '. Press Refresh after that time.'
          : n + 'the model is shared by all editors and is busy right now. Today asks again by itself' + (until ? ' after ' + new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ' in a few minutes') + ' \u2014 nothing to do.'));
        }
      } else if (m.errors && !m.asked && !m.cached) {
        main.appendChild(el('p', 't-banner', 'The model could not be reached for any message (' + m.errors + ' failed). Check your connection, then Refresh.'));
      }
    }

    const c = view.coverage;
    if (c && (c.folders.some((f) => !f.complete) || !c.sentLikeScanned)) {
      const unread = c.folders.filter((f) => !f.complete).map((f) => (f.path || f.id) + ' could not be read').join('; ');
      // Name the mailbox: with several accounts, "no Sent folder" is useless
      // unless the editor knows which one is meant.
      const missing = (c.sentLikeMissing || []).map((a) => a.name);
      const sent = c.sentLikeScanned ? '' : missing.length
        ? 'no Sent folder could be read in ' + missing.join(' and ') + ', so rows from ' + (missing.length > 1 ? 'those mailboxes' : 'that mailbox') + ' cannot say whether you have replied'
        : 'no Sent folder could be identified or read, so no row says whether you have replied';
      main.appendChild(el('p', 't-banner', 'The scan is incomplete: ' + [sent, unread].filter(Boolean).join('; ') + '.'));
    }

    // Snoozed messages and rows waiting for a promised date are looked up one
    // at a time, and one scan will not do an unbounded number of them. When
    // some were left for next time the editor is told, because a reminder she
    // is expecting and that quietly did not come back is the worst way for this
    // page to be wrong.
    const rq = c && c.rescue;
    if (rq && (rq.omitted || rq.waiting || rq.notFound)) {
      const bits = [];
      if (rq.omitted) bits.push(rq.omitted + ' will be checked on the next refresh');
      if (rq.waiting) bits.push(rq.waiting + ' will be tried again later');
      if (rq.notFound) bits.push(rq.notFound + ' could not be found in your mail');
      main.appendChild(el('p', 't-banner', 'Of the messages you snoozed or that are waiting for a date, ' + bits.join(', ') + '.'));
    }

    // No setup step any more, so a scan that could read nothing must explain itself.
    if (view.status === 'error' || (c && !c.folders.some((f) => f.complete))) {
      const box = notice('Today could not read your mail folders', 'Nothing below is reliable until this is fixed. Try again first \u2014 Thunderbird sometimes has not finished opening your accounts.');
      const area = el('div');
      const fix = el('div', 't-controls');
      fix.appendChild(button('Try again', 'mark-btn act-manuscript', () => refresh()));
      fix.appendChild(button('Choose folders myself', 'mark-btn', () => { view.showSettings = true; renderMain(); window.scrollTo(0, 0); }));
      // Settings has a button saying the same thing, and both can be on screen
      // at once, so each says which one it is.
      fix.appendChild(named(button('Show technical details', 'mark-btn', () => showDiagnostics(area)), 'diagnostics:scan'));
      box.appendChild(fix);
      box.appendChild(area);
      main.appendChild(box);
    }

    const bulk = el('div', 't-bulk'); bulk.id = 't-bulk'; bulk.hidden = true;
    main.appendChild(bulk);

    if (!rows.length && view.status === 'ready') main.appendChild(notice('Nothing found in the folders and dates scanned', 'That is not the same as "nothing to do": check the coverage line above, or add folders in Settings.'));

    // Low, No reply needed and Closed start folded, which is right while there
    // is work above them to read first. A mailbox whose every message happens
    // to be in one of those bands would otherwise open on nothing at all — a
    // page that says "3" at the top and shows an empty list. So when nothing
    // else is on screen, the folded bands open — really open, not just for this
    // render, or the heading would say "show" on a band that is already showing.
    const bandsWithRows = S.GROUPS.filter((g) => inGroup(g).length);
    if (bandsWithRows.length && bandsWithRows.every((g) => view.collapsed.has(g))) {
      for (const g of bandsWithRows) view.collapsed.delete(g);
    }

    for (const g of S.GROUPS) {
      const list = inGroup(g);
      // A band with nothing in it is not an answer, it is a line to read and
      // dismiss. Needs review used to stay at zero to promise that nothing was
      // being hidden there — but at zero there is nothing to hide, and it says
      // so loudly enough the moment it has a row.
      if (!list.length) continue;
      const sec = el('section', 't-group');
      // A pressed card is a short list she asked for by name, so all of it is
      // on screen: the bands still label it, but none of them is shut and
      // nothing waits behind "show the remaining".
      const collapsed = !view.filter && view.collapsed.has(g);
      // The priority marks sit on the group, not on every row: the group already
      // says how urgent the rows in it are. While a card is pressed the heading
      // is a label and not a control — everything is open, so a control to open
      // it would be one that does nothing.
      const head = view.filter ? el('div', 't-group-head t-group-label')
        : named(button('', 't-group-head', () => { if (collapsed) view.collapsed.delete(g); else view.collapsed.add(g); renderMain(); }), 'group:' + g);
      head.appendChild(dots(g));
      head.appendChild(el('span', 't-group-name', S.GROUP_LABELS[g]));
      head.appendChild(el('span', 't-group-count', String(list.length)));
      // Read out once, in words, rather than as a name followed by a stray number.
      head.setAttribute('aria-label', S.GROUP_LABELS[g] + ', ' + list.length + (list.length === 1 ? ' conversation' : ' conversations'));
      if (!view.filter) head.setAttribute('aria-expanded', String(!collapsed));
      sec.appendChild(head);
      if (!collapsed) {
        const card = el('div', 't-card');
        list.sort((a, b) => b.priority.bars - a.priority.bars || a.display.date - b.display.date);
        const limit = view.filter || view.expanded.has(g) ? list.length : PAGE;
        list.slice(0, limit).forEach((r) => card.appendChild(rowEl(r)));
        sec.appendChild(card);
        if (list.length > limit) {
          sec.appendChild(named(button('Show the remaining ' + (list.length - limit) + ' \u2014 they are ordered, not hidden', 'mark-btn t-more-rows',
            () => { view.expanded.add(g); renderMain(); }), 'more-rows:' + g));
        }
      }
      main.appendChild(sec);
    }
    renderBulk();
  }

  function c0(v) { return v.coverage; }

  function notice(title, text) {
    const n = el('div', 't-notice');
    n.appendChild(el('h2', null, title));
    n.appendChild(el('p', null, text));
    return n;
  }

  // ---- setup & settings --------------------------------------------------------------------------------------------------------------
  function folderPicker(accounts, chosenAccounts, chosenFolders) {
    const wrap = el('div', 't-picker');
    for (const a of accounts) {
      const box = el('fieldset', 't-account');
      const lg = el('legend');
      // Ticks are only saved when she presses Save folders, so a tick made
      // while a scan is running has to outlive the re-render that scan causes.
      const acb = holds(el('input'), 'account:' + a.id); acb.type = 'checkbox'; acb.dataset.account = a.id;
      acb.checked = heldValue('account:' + a.id, chosenAccounts ? chosenAccounts.indexOf(a.id) !== -1 : true);
      const al = el('label'); al.appendChild(acb); al.appendChild(document.createTextNode(' ' + a.name + (a.identities.length ? ' — ' + a.identities.join(', ') : '')));
      lg.appendChild(al); box.appendChild(lg);
      for (const f of a.folders) {
        if (f.specialUse.some((s) => ['junk', 'trash', 'drafts', 'templates', 'outbox', 'sent'].indexOf(s) !== -1)) continue;
        const cb = holds(el('input'), 'folder:' + f.id); cb.type = 'checkbox'; cb.dataset.folder = f.id; cb.dataset.owner = a.id;
        cb.checked = heldValue('folder:' + f.id, chosenFolders ? chosenFolders.indexOf(f.id) !== -1 : f.specialUse.indexOf('inbox') !== -1);
        const l = el('label', 't-folder'); l.appendChild(cb); l.appendChild(document.createTextNode(' ' + f.path));
        box.appendChild(l);
      }
      wrap.appendChild(box);
    }
    wrap.read = () => {
      const accounts = Array.from(wrap.querySelectorAll('input[data-account]')).filter((c) => c.checked).map((c) => c.dataset.account);
      const folders = Array.from(wrap.querySelectorAll('input[data-folder]')).filter((c) => c.checked && accounts.indexOf(c.dataset.owner) !== -1).map((c) => c.dataset.folder);
      return { accounts, folders };
    };
    return wrap;
  }

  // After a failed setup: what the add-on can see of Thunderbird (versions, which
  // APIs exist, which step failed). No mail, names or keys — safe to screenshot.
  function showDiagnostics(area) {
    clear(area);
    area.appendChild(el('p', 't-note', 'Technical details (no mail, names or keys in here — a screenshot of this helps):'));
    const pre = el('pre', 't-pre', 'Collecting…');
    area.appendChild(pre);
    ask('diagnose').then((d) => { pre.textContent = JSON.stringify(d, null, 2); }).catch((e) => { pre.textContent = 'Diagnostics failed too: ' + (e && e.message) + (e && e.detail ? ' — ' + e.detail : ''); });
  }

  // Today is on by default. This card only appears after the editor turned it off.
  function setupEl() {
    const card = el('div', 't-notice t-setup');
    card.appendChild(el('h2', null, 'Today is turned off'));
    card.appendChild(el('p', null, 'Today lists the mail that needs you and reads your Sent folder to see whether a later message from you was located. It changes nothing in your mailbox and nothing in V4.'));
    const area = el('div');
    card.appendChild(button('Turn Today on', 'mark-btn act-manuscript', async () => {
      try { view.app = await ask('enable'); renderMain(); refresh(); } catch (e) { toast(say(e)); showDiagnostics(area); }
    }));
    card.appendChild(area);
    return card;
  }

  function settingsEl() {
    const app = view.app, cfg = app.config;
    const card = el('div', 't-notice t-settings');
    card.appendChild(el('h2', null, 'Settings'));

    card.appendChild(el('h3', null, 'Folders'));
    const modeAll = cfg.folderMode !== 'chosen';
    const modeRow = el('div', null);
    // The boxes and radios in Settings say nothing themselves — the words beside
    // them are the label's — so each is named, or focus could not tell them apart.
    for (const [val, label] of [['all', 'All mail folders (recommended) — new folders are covered automatically'], ['chosen', 'Only the folders I pick']]) {
      const l = el('label', 't-check');
      const r = named(el('input'), 'foldermode:' + val); r.type = 'radio'; r.name = 't-foldermode'; r.value = val; r.checked = (val === 'all') === modeAll;
      r.addEventListener('change', async () => { try { view.app = await ask('setConfig', { patch: { folderMode: val } }); renderMain(); refresh(); } catch (e) { toast(say(e)); } });
      l.appendChild(r); l.appendChild(document.createTextNode(' ' + label));
      modeRow.appendChild(l);
    }
    card.appendChild(modeRow);
    card.appendChild(el('p', 't-note', 'Sent, Drafts, Trash, Junk, Templates and Archives are never listed as mail that needs you. Sent is always read, to see whether you wrote back.'));
    const area = el('div', null);
    card.appendChild(area);
    if (!modeAll) {
      ask('listAccounts').then((accounts) => {
        const picker = folderPicker(accounts, cfg.accounts.length ? cfg.accounts : null, cfg.folders);
        area.appendChild(picker);
        area.appendChild(button('Save folders', 'mark-btn', async () => {
          const sel = picker.read();
          if (!sel.folders.length) return toast('Choose at least one folder.');
          try { view.app = await ask('setConfig', { patch: sel }); toast('Folders saved'); refresh(); } catch (e) { toast(say(e)); }
        }));
      }).catch((e) => { area.appendChild(el('p', 't-note', say(e))); showDiagnostics(area); });
    }

    return card;
  }

  // ---- boot ---------------------------------------------------------------------------------------------------------------------------------
  let refreshing = false;
  async function refresh() {
    if (!view.app || !view.app.config.enabled || refreshing) return;
    refreshing = true;
    view.status = 'scanning';
    showProgress({ phase: 'index', done: 0, total: 0 });
    try { applySnapshot(await ask('scan')); view.app = await ask('getState'); } catch (e) { toast(say(e)); }
    finally { refreshing = false; }
    hideProgress();
    renderMain();
  }

  $('t-refresh').addEventListener('click', refresh);
  $('t-settings-btn').addEventListener('click', () => { view.showSettings = !view.showSettings; renderMain(); });

  (async () => {
    try {
      connect();
      view.app = await ask('getState');
      applySnapshot(view.app.snapshot);
      renderMain();
      refresh();
    } catch (e) {
      clear(main);
      main.appendChild(notice('Today could not start', say(e)));
    }
  })();
})();
