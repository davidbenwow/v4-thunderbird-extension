// popup-status.js — safe DOM construction, no innerHTML with user data

(function () {
  'use strict';

  const STATUS = {
    2: { className: 'status-used' },
    3: { className: 'status-pending' }
  };

  const SOURCE_LABELS = {
    sender:    'sender',
    recipient: 'recipient',
    cc:        'Cc',
    bcc:       'Bcc',
    body:      'found in thread'
  };

  const ui = {
    loading:       document.getElementById('state-loading'),
    notConfigured: document.getElementById('state-not-configured'),
    disabled:      document.getElementById('state-disabled'),
    error:         document.getElementById('state-error'),
    errorDetail:   document.getElementById('error-detail'),
    empty:         document.getElementById('state-empty'),
    noLeads:       document.getElementById('state-no-leads'),
    results:       document.getElementById('state-results'),
    leadsSection:  document.getElementById('leads-section')
  };

  // Kept at module scope so click handlers can reference the current message
  // without threading it through every call.
  let currentHeaderMessageId = null;

  function show(stateKey) {
    const keys = ['loading', 'notConfigured', 'disabled', 'error', 'empty', 'noLeads', 'results'];
    if (!keys.includes(stateKey)) {
      console.error('V4 Contacts: unknown state', stateKey);
      return;
    }
    for (const key of keys) {
      ui[key].classList.toggle('hidden', key !== stateKey);
    }
  }

  // Every button in this popup NAVIGATES (opens V4 in the browser) — none
  // completes an action in place. The arrow makes that honest at a glance.
  function extArrow() {
    const a = el('span', 'ext-arrow', '\u2197');
    a.setAttribute('aria-hidden', 'true');  // decorative; the title carries it
    return a;
  }

  // Vector pencil for the mark buttons. Inline SVG in currentColor: inherits
  // the button's orange and stays sharp at any DPI — unlike the old 32px
  // raster logo, which blurred when downscaled into a 14px slot.
  function makePencilGlyph() {
    return makeStrokeGlyph('mark-glyph',
      ['M4 20h4L18.5 9.5a2.828 2.828 0 1 0-4-4L4 16v4', 'M13.5 6.5l4 4']);
  }

  function el(tag, className, textContent) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (textContent !== undefined) e.textContent = textContent;
    return e;
  }

  // Render a button in "ready to mark" or "already opened" state. The opened
  // variant still accepts clicks — users can re-open V4 if they want.
  function setButtonState(markBtn, opened) {
    while (markBtn.firstChild) markBtn.removeChild(markBtn.firstChild);

    if (opened) {
      markBtn.appendChild(el('span', 'mark-check', '✓'));
      markBtn.appendChild(el('span', 'mark-label', 'Opened in browser'));
      markBtn.classList.add('opened');
      markBtn.title = 'Open again in V4';
    } else {
      markBtn.appendChild(makePencilGlyph());
      markBtn.appendChild(el('span', 'mark-label', 'Mark lead in V4'));
      markBtn.appendChild(extArrow());
      markBtn.classList.remove('opened');
      markBtn.title = 'Open this lead in V4 to mark its status';
    }
  }

  // Manuscript variant of the Mark button. Used when a message contains a
  // manuscript signal (.docx/.doc/.pdf attachment or known transfer-link host).
  // Clicking writes markedTerminal:v1 in the background — the lead will not
  // resurface from any future message.
  function setManuscriptButtonState(markBtn) {
    while (markBtn.firstChild) markBtn.removeChild(markBtn.firstChild);
    markBtn.appendChild(makePencilGlyph());
    markBtn.appendChild(el('span', 'mark-label', 'Mark as manuscript received'));
    markBtn.appendChild(extArrow());
    markBtn.classList.remove('opened');
    markBtn.classList.add('act-manuscript');  // blue — matches V4's manuscript button
    markBtn.title = 'Open this lead in V4 and mark their status as manuscript received.';
  }

  // Status-mode variants. "Mark as Response" is the call-to-action when the
  // V4 status is still no_response and the lead just emailed — exactly the
  // moment the team's workflow says to mark "Response" in the CRM.
  function setResponseButtonState(markBtn) {
    while (markBtn.firstChild) markBtn.removeChild(markBtn.firstChild);
    markBtn.appendChild(makePencilGlyph());
    markBtn.appendChild(el('span', 'mark-label', 'Mark as response'));
    markBtn.appendChild(extArrow());
    markBtn.classList.remove('opened');
    markBtn.classList.add('act-response');  // green — matches V4's response button
    markBtn.title = 'Open this lead in V4 and mark their status as response.';
  }

  // Informational "Open in V4" — shown when no marking action is needed
  // (status already 'response', no manuscript). Muted styling.
  function setOpenOnlyButtonState(markBtn) {
    while (markBtn.firstChild) markBtn.removeChild(markBtn.firstChild);
    markBtn.appendChild(el('span', 'mark-label', 'Open in V4'));
    markBtn.appendChild(extArrow());
    markBtn.classList.remove('opened');
    markBtn.classList.add('secondary');
    markBtn.title = 'Open this lead in V4 (no action needed right now).';
  }

  // Status labels/colors come from LEAD_STATUS_DEFS in lead-statuses.js —
  // the single source of truth shared with the background script.
  function makeStatusTitle(statusKey) {
    const meta = LEAD_STATUS_DEFS[statusKey] || LEAD_STATUS_DEFS.no_response;
    // Soft pill (tinted bg + colored text), NOT V4's filled style: filled
    // pills read as buttons, and the status is state, not action. The tint
    // still echoes the V4 button that set this status (green/blue/red).
    const wrap = el('div', 'status-pill-wrap');
    const pill = el('span', `status-pill ${meta.cls}`);
    pill.appendChild(el('span', 'dot'));
    pill.appendChild(document.createTextNode(meta.label));
    wrap.appendChild(pill);
    return wrap;
  }

  // Stroke-style inline SVG glyphs in currentColor — no emoji/raster in
  // chrome (inconsistent rendering, untintable, blurry when downscaled).
  function makeStrokeGlyph(className, paths) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    for (const d of paths) {
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '2');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(p);
    }
    return svg;
  }

  function makeDocGlyph() {
    return makeStrokeGlyph('ms-glyph',
      ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6']);
  }

  // Manuscript badge: shows WHAT was detected (the filename or transfer host)
  // in a neutral capsule — it informs without competing with the status for
  // color. The tooltip keeps the honest hedge: detection is a guess.
  function makeManuscriptBadge(signal) {
    if (!signal || !signal.has) return null;
    const badge = el('span', 'ms-badge');
    badge.appendChild(makeDocGlyph());
    const detail = String(signal.detail || 'document');
    badge.appendChild(el('span', 'ms-name', detail.length > 34 ? detail.slice(0, 31) + '…' : detail));
    badge.title = signal.type === 'attachment'
      ? 'Possible manuscript attached: ' + detail
      : 'Possible manuscript transfer link: ' + detail;
    return badge;
  }

  function makeCopyBtn(address) {
    const copyBtn = el('button', 'icon-btn copy-btn', '📋');
    copyBtn.dataset.email = address;
    copyBtn.title = 'Copy email';
    copyBtn.setAttribute('aria-label', 'Copy email address');
    return copyBtn;
  }

  // --- Single-lead progress-tracker card (the hero view) ------------------
  // Avatar + identity header, a 3-step tracker (Contacted → Responded →
  // Manuscript) showing where this lead sits in the acquisition pipeline, an
  // optional manuscript file pill, and one full-width action. Status mode only.

  function makeCheckGlyph() { return makeStrokeGlyph('node-glyph', ['M5 13l4 4L19 7']); }
  function makeCrossGlyph() { return makeStrokeGlyph('node-glyph', ['M6 6l12 12', 'M18 6L6 18']); }

  // Initials from the email local part: "mirela.rozmarin" → "MR".
  function initialsFor(address) {
    const local = String(address || '').split('@')[0] || '';
    const parts = local.split(/[._\-]+/).filter(Boolean);  // drop separator runs
    let ini;
    if (parts.length >= 2) ini = parts[0][0] + parts[1][0];
    else if (parts.length === 1) ini = parts[0].slice(0, 2);
    else ini = '?';
    return ini.toUpperCase();
  }

  function makeAvatar(address) {
    return el('div', 'lead-avatar', initialsFor(address));
  }

  // One tracker node: circle (done/current/rejected/future) + label below.
  // Label is emphasized (colored + bold) only for the lead's active position
  // — the current/next step, the settled status, or a rejection — so passed
  // and future steps stay quiet. highlight adds the soft pill behind the label.
  function makeNode(label, state, color, highlight) {
    const node = el('div', `track-node n-${state} c-${color}`);
    const circle = el('span', 'node-circle');
    if (state === 'done') circle.appendChild(makeCheckGlyph());
    else if (state === 'rejected') circle.appendChild(makeCrossGlyph());
    node.appendChild(circle);
    const emphasized = state === 'current' || state === 'rejected' || highlight;
    let cls = 'node-label';
    if (emphasized) cls += ' node-label-em';
    if (highlight) cls += ' node-label-hl';
    node.appendChild(el('span', cls, label));
    return node;
  }

  function makeConnector(color) { return el('span', `track-conn conn-${color}`); }

  // status → tracker. Mirrors the pipeline: Contacted (always done for an
  // existing lead) → Responded → Manuscript. Each node = [label, state, color,
  // highlight]; conn1/conn2 are the two connector colors.
  function makeTracker(leadStatus, manuscriptHas) {
    const C = ['Contacted', 'done', 'green', false];
    let R, M, c1, c2;
    switch (leadStatus) {
      case 'no_response':
        if (manuscriptHas) { R = ['Responded', 'future', 'gray', false]; M = ['Manuscript', 'current', 'blue', false]; c1 = 'gray';  c2 = 'gray'; }
        else               { R = ['Responded', 'current', 'green', false]; M = ['Manuscript', 'future', 'gray', false]; c1 = 'green'; c2 = 'gray'; }
        break;
      case 'response':
        R = ['Responded', 'done', 'green', true];
        M = manuscriptHas ? ['Manuscript', 'current', 'blue', false] : ['Manuscript', 'future', 'gray', false];
        c1 = 'green'; c2 = 'gray';
        break;
      case 'manuscript_received':
        R = ['Responded', 'done', 'green', false]; M = ['Manuscript received', 'done', 'blue', true]; c1 = 'green'; c2 = 'blue';
        break;
      case 'rejected':
        R = ['Rejected', 'rejected', 'red', true]; M = ['Manuscript', 'future', 'gray', false]; c1 = 'green'; c2 = 'gray';
        break;
      default: // locked, invalid_email — no known sub-position
        R = ['Responded', 'future', 'gray', false]; M = ['Manuscript', 'future', 'gray', false]; c1 = 'gray'; c2 = 'gray';
    }
    const track = el('div', 'tracker');
    track.appendChild(makeNode.apply(null, C));
    track.appendChild(makeConnector(c1));
    track.appendChild(makeNode.apply(null, R));
    track.appendChild(makeConnector(c2));
    track.appendChild(makeNode.apply(null, M));
    return track;
  }

  // Full-width action. Mark actions are FILLED (green/blue) and primary;
  // "Open in V4" is a muted outline. All carry ↗ — every button navigates to
  // V4, none commits in place.
  function makeCardButton(leadStatus, manuscriptHas, address) {
    const markBtn = el('button', 'mark-btn btn-block');
    markBtn.dataset.email = address;
    markBtn.dataset.statusMode = '1';
    if (isInfoOnlyStatus(leadStatus) || (leadStatus === 'response' && !manuscriptHas)) {
      setOpenOnlyButtonState(markBtn);
    } else if (manuscriptHas) {
      markBtn.dataset.terminal = '1';
      setManuscriptButtonState(markBtn);
      markBtn.classList.add('fill-blue');
    } else { // no_response, no manuscript
      setResponseButtonState(markBtn);
      markBtn.classList.add('fill-green');
    }
    return markBtn;
  }

  // Captions for statuses that have no tracker position.
  const STATUS_CAPTION = {
    locked: 'Locked — another user is handling this lead.',
    invalid_email: 'Invalid email address.'
  };

  function makeLeadCard(lead, signal) {
    const { address, leadStatus } = lead;
    const manuscriptHas = !!(signal && signal.has);
    const card = el('div', 'lead-card');

    const header = el('div', 'card-header');
    header.appendChild(makeAvatar(address));
    const ident = el('div', 'card-ident');
    ident.appendChild(el('div', 'card-ident-label', 'Lead'));
    const em = el('div', 'card-ident-email', address);
    em.title = address;
    ident.appendChild(em);
    header.appendChild(ident);
    header.appendChild(makeCopyBtn(address));
    card.appendChild(header);

    const body = el('div', 'card-body');
    body.appendChild(makeTracker(leadStatus, manuscriptHas));

    const badge = makeManuscriptBadge(signal);
    if (badge) { badge.classList.add('badge-block'); body.appendChild(badge); }

    const caption = STATUS_CAPTION[leadStatus];
    if (caption) body.appendChild(el('div', 'card-caption', caption));

    body.appendChild(makeCardButton(leadStatus, manuscriptHas, address));
    card.appendChild(body);
    return card;
  }

  // leadStatus: normalized V4 status string or null (legacy mode). Renders the
  // COMPACT row used in the multi-lead list and the legacy fallback row; the
  // single-lead hero uses makeLeadCard.
  function makeLeadRow({ address, source, leadStatus }, statusCode, isOpened, currentManuscriptSignal) {
    const manuscriptHas = !!(currentManuscriptSignal && currentManuscriptSignal.has);

    // ---- STATUS MODE: the live V4 status is the headline AND the sole source
    // of truth. The action stays available until the real status changes —
    // clicking the button only opens V4; nothing is hidden optimistically.
    // Email is demoted to a quiet subtitle.
    if (leadStatus !== null) {
      const row = el('div', 'lead-row');
      const main = el('div', 'lead-row-main');
      const text = el('div', 'lead-text');
      text.appendChild(makeStatusTitle(leadStatus));

      const sub = el('div', 'lead-subtitle');
      sub.appendChild(el('span', 'sub-email', address));
      // 'sender' is the default/obvious case — annotating it is just noise.
      // Other sources (recipient, Cc, found in thread) ARE worth flagging.
      if (source && source !== 'sender') {
        sub.appendChild(el('span', 'sub-sep', '·'));
        sub.appendChild(el('span', 'sub-source', SOURCE_LABELS[source] || source));
      }
      sub.title = address;
      text.appendChild(sub);

      const badge = makeManuscriptBadge(currentManuscriptSignal);
      if (badge) text.appendChild(badge);
      main.appendChild(text);
      row.appendChild(main);

      const actions = el('div', 'lead-row-actions');
      const markBtn = el('button', 'mark-btn');
      markBtn.dataset.email = address;
      markBtn.dataset.statusMode = '1';
      if (isInfoOnlyStatus(leadStatus)) {
        setOpenOnlyButtonState(markBtn);
      } else if (manuscriptHas) {
        markBtn.dataset.terminal = '1';
        setManuscriptButtonState(markBtn);
      } else if (leadStatus === 'no_response') {
        setResponseButtonState(markBtn);
      } else {                                 // response, no manuscript
        setOpenOnlyButtonState(markBtn);
      }
      actions.appendChild(markBtn);
      actions.appendChild(makeCopyBtn(address));
      row.appendChild(actions);
      return row;
    }

    // ---- LEGACY MODE (no status from the API): email headline + the local
    // "opened" guess, exactly as before. Only reached with the kill-switch on
    // or when the API omits a status for an address.
    const s = STATUS[statusCode] || STATUS[3];
    const row = el('div', `lead-row ${s.className}`);

    const main = el('div', 'lead-row-main');
    const text = el('div', 'lead-text');

    const emailDiv = el('div', 'lead-email', address);
    emailDiv.title = address;
    text.appendChild(emailDiv);

    if (source && source !== 'sender') {
      const metaDiv = el('div', 'lead-meta');
      metaDiv.appendChild(el('span', 'source-hint', SOURCE_LABELS[source] || source));
      text.appendChild(metaDiv);
    }
    const legacyBadge = makeManuscriptBadge(currentManuscriptSignal);
    if (legacyBadge) text.appendChild(legacyBadge);

    main.appendChild(text);
    row.appendChild(main);

    const actions = el('div', 'lead-row-actions');
    const markBtn = el('button', 'mark-btn');
    markBtn.dataset.email = address;
    if (manuscriptHas && !isOpened) {
      markBtn.dataset.terminal = '1';
      setManuscriptButtonState(markBtn);
    } else if (isOpened) {
      setButtonState(markBtn, true);
    } else {
      setButtonState(markBtn, false);
    }
    actions.appendChild(markBtn);
    actions.appendChild(makeCopyBtn(address));

    row.appendChild(actions);
    return row;
  }

  function makeSectionHeader(title) {
    const h = el('div', 'section-header');
    h.appendChild(el('span', 'section-title', title));
    return h;
  }

  // --- Event handlers ------------------------------------------------------
  document.addEventListener('click', async (e) => {
    const markBtn = e.target.closest('.mark-btn');
    if (markBtn) {
      if (markBtn.classList.contains('dispatching')) return;
      markBtn.classList.add('dispatching');
      const email = markBtn.dataset.email;
      const terminal = markBtn.dataset.terminal === '1';
      try {
        await browser.runtime.sendMessage({
          method: 'openInV4',
          email,
          headerMessageId: currentHeaderMessageId,
          terminal,
          // HINT only: the background decides the write policy from its
          // own authority cache (last real API answer for this email); this
          // dataset flag is just the fallback when that cache is cold.
          statusRow: markBtn.dataset.statusMode === '1'
        });
      } catch (err) {
        markBtn.classList.remove('dispatching');
        ui.errorDetail.textContent = `Could not open V4: ${err && err.message ? err.message : err}`;
        show('error');
        return;
      }
      markBtn.classList.remove('dispatching');
      // Status mode: don't change the row optimistically. The lead stays "to
      // mark" until the real V4 status changes — the background re-scans now
      // and again when Thunderbird regains focus, so reopening the popup (or
      // glancing at the ring) reflects the actual status, never a guess.
      // Legacy mode has no status to verify against, so keep the local
      // "opened" signal as the only available feedback.
      if (markBtn.dataset.statusMode !== '1') {
        setButtonState(markBtn, true);
      }
      return;
    }

    const copyBtn = e.target.closest('.copy-btn');
    if (copyBtn) {
      const email = copyBtn.dataset.email;
      try {
        await navigator.clipboard.writeText(email);
        const orig = copyBtn.textContent;
        copyBtn.textContent = '✓';
        copyBtn.setAttribute('aria-label', 'Copied');  // announced by AT
        setTimeout(() => {
          copyBtn.textContent = orig;
          copyBtn.setAttribute('aria-label', 'Copy email address');
        }, 1200);
      } catch (err) {
        console.error('Copy failed', err);
      }
    }
  });

  // --- Main run ------------------------------------------------------------
  async function getCurrentTab() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function gatherEmails(tab) {
    const type = tab.type || '';
    if (type.includes('Compose') || type === 'messageCompose') {
      return browser.runtime.sendMessage({ method: 'getComposeEmails', tabId: tab.id });
    }
    return browser.runtime.sendMessage({ method: 'getDisplayedMessageEmails', tabId: tab.id });
  }

  async function run() {
    show('loading');

    let config;
    try {
      config = await browser.runtime.sendMessage({ method: 'getConfig' });
    } catch (err) {
      ui.errorDetail.textContent = `Extension runtime error: ${err.message}`;
      show('error');
      return;
    }

    if (!config || !config.enabled) { show('disabled');      return; }
    if (!config.apiKey)             { show('notConfigured'); return; }

    const tab = await getCurrentTab();
    if (!tab) { show('empty'); return; }

    const gathered = await gatherEmails(tab);
    const { emails, error, headerMessageId, manuscriptSignal: currentManuscriptSignal } = gathered || {};
    currentHeaderMessageId = headerMessageId || null;

    if (error) {
      ui.errorDetail.textContent = error;
      show('error');
      return;
    }
    if (!emails || !emails.length) {
      show('empty');
      return;
    }

    const addresses = emails.map(e => e.address);
    const response = await browser.runtime.sendMessage({
      method: 'checkEmails',
      emails: addresses
    });

    if (response.error) {
      ui.errorDetail.textContent =
        response.error === 'network_error' ? `Network: ${response.message}` :
        response.error === 'api_error'     ? `API returned HTTP ${response.status}` :
        response.error;
      show('error');
      return;
    }

    // Dual-mode filtering: `parsed` is the normalized adapter output
    // (exists + optional lead status). Falls back to the raw numeric map for
    // robustness if parsed is ever missing.
    const parsed = response.parsed || {};
    const results = response.results || {};
    const leads = [];
    for (const item of emails) {
      const lower = item.address.toLowerCase();
      const p = parsed[lower];
      if (p) {
        if (!p.exists) continue;
        leads.push({ ...item, statusCode: p.legacyCode, leadStatus: p.status });
      } else {
        const statusCode = results[item.address] ?? results[lower];
        if (statusCode === 2 || statusCode === 3) {
          leads.push({ ...item, statusCode, leadStatus: null });
        }
      }
    }

    // Ask the background to evaluate every lead through the SAME central
    // suppression matrix the scan loop uses (decideActionable). The popup
    // deliberately does NOT reimplement the matrix — a popup-side copy is how
    // marked/terminal leads ended up re-lighting the ring after popup open.
    // The response also carries the per-message opened flag (legacy mode).
    let evaluation = null;
    try {
      const r = await browser.runtime.sendMessage({
        method: 'evaluateLeads',
        leads: leads.map(l => ({ email: l.address, leadStatus: l.leadStatus })),
        headerMessageId: currentHeaderMessageId,
        manuscriptHas: !!(currentManuscriptSignal && currentManuscriptSignal.has)
      });
      evaluation = (r && r.evaluation) || null;
    } catch (e) { /* evaluation stays null → fail OPEN below */ }

    // Actionable leads drive the toolbar ring — same matrix as the scan, so
    // the ring never glows for already-marked / terminal / dismissed leads.
    // FAIL OPEN on IPC failure (evaluation null): count every lead, exactly
    // like v1.19.1 did when its opened-state read failed. A falsely-lit ring
    // is an annoyance; a falsely-dark ring is a missed lead.
    const unopenedCount = evaluation === null
      ? leads.length
      : leads.filter(l => {
          const ev = evaluation[l.address.toLowerCase()];
          return !!(ev && ev.actionable);
        }).length;
    if (evaluation === null) evaluation = {};
    browser.runtime.sendMessage({
      method: 'syncBadge',
      tabId: tab.id,
      headerMessageId: currentHeaderMessageId,
      count: unopenedCount
    }).catch(() => { /* best effort */ });

    if (leads.length === 0) {
      show('noLeads');
      return;
    }

    while (ui.leadsSection.firstChild) {
      ui.leadsSection.removeChild(ui.leadsSection.firstChild);
    }

    const single = leads.length === 1 ? leads[0] : null;
    if (single && single.leadStatus !== null) {
      // One status-mode lead (the common case): the progress-tracker card.
      ui.leadsSection.appendChild(makeLeadCard(single, currentManuscriptSignal));
    } else {
      const title = leads.length === 1 ? '1 lead found' : `${leads.length} leads found`;
      ui.leadsSection.appendChild(makeSectionHeader(title));
      for (const l of leads) {
        const ev = evaluation[l.address.toLowerCase()] || {};
        const isOpened = !!ev.opened;  // legacy-mode only
        ui.leadsSection.appendChild(makeLeadRow(l, l.statusCode, isOpened, currentManuscriptSignal));
      }
    }
    show('results');
  }

  document.addEventListener('DOMContentLoaded', run);
})();
