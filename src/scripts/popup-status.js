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
    return el('span', 'ext-arrow', '\u2197');
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
      const markIcon = document.createElement('img');
      markIcon.className = 'mark-icon';
      markIcon.src = 'images/icon-32.png';
      markIcon.alt = '';
      markBtn.appendChild(markIcon);
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
    const markIcon = document.createElement('img');
    markIcon.className = 'mark-icon';
    markIcon.src = 'images/icon-32.png';
    markIcon.alt = '';
    markBtn.appendChild(markIcon);
    markBtn.appendChild(el('span', 'mark-label', 'Mark as manuscript received'));
    markBtn.appendChild(extArrow());
    markBtn.classList.remove('opened');
    markBtn.classList.add('manuscript');
    markBtn.title = 'Open this lead in V4 and mark their status as manuscript received.';
  }

  // Status-mode variants. "Mark as Response" is the call-to-action when the
  // V4 status is still no_response and the lead just emailed — exactly the
  // moment the team's workflow says to mark "Response" in the CRM.
  function setResponseButtonState(markBtn) {
    while (markBtn.firstChild) markBtn.removeChild(markBtn.firstChild);
    const markIcon = document.createElement('img');
    markIcon.className = 'mark-icon';
    markIcon.src = 'images/icon-32.png';
    markIcon.alt = '';
    markBtn.appendChild(markIcon);
    markBtn.appendChild(el('span', 'mark-label', 'Mark as response'));
    markBtn.appendChild(extArrow());
    markBtn.classList.remove('opened');
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

  // V4 lead-status metadata: the status is the ROW HEADLINE (status mode),
  // shown as bold colored text with a matching dot + left border.
  const STATUS_META = {
    no_response:         { label: 'No response yet',     cls: 'st-gray',  border: '#8592a6' },
    response:            { label: 'Responded',           cls: 'st-blue',  border: '#2563eb' },
    manuscript_received: { label: 'Manuscript received', cls: 'st-green', border: '#16a34a' },
    rejected:            { label: 'Rejected',            cls: 'st-red',   border: '#dc2626' },
    locked:              { label: 'Locked',              cls: 'st-gray',  border: '#8592a6' },
    invalid_email:       { label: 'Invalid email',       cls: 'st-red',   border: '#dc2626' }
  };

  function makeStatusTitle(statusKey) {
    const meta = STATUS_META[statusKey] || STATUS_META.no_response;
    const title = el('div', `lead-status-title ${meta.cls}`);
    title.appendChild(el('span', 'dot'));
    title.appendChild(document.createTextNode(meta.label));
    return title;
  }

  // Small document glyph (inline SVG, currentColor) — no emoji in chrome:
  // emoji render inconsistently across platforms and can't be tinted.
  function makeDocGlyph() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'ms-glyph');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6']) {
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '2');
      p.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(p);
    }
    return svg;
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
    return copyBtn;
  }

  // leadStatus: normalized V4 status string or null (legacy mode).
  // opts.overline    — render a small "Current status" label above the status
  // opts.hideSubtitle — identity lives in the section header (single-lead view)
  // opts.hideCopy     — the copy button lives next to the email in the header
  function makeLeadRow({ address, source, leadStatus }, statusCode, isOpened, currentManuscriptSignal, opts = {}) {
    const manuscriptHas = !!(currentManuscriptSignal && currentManuscriptSignal.has);

    // ---- STATUS MODE: the live V4 status is the headline AND the sole source
    // of truth. The action stays available until the real status changes —
    // clicking the button only opens V4; nothing is hidden optimistically.
    // Email is demoted to a quiet subtitle.
    if (leadStatus !== null) {
      // No colored stripe: the colored status text + dot already carry the
      // state; one signal, not three.
      const row = el('div', 'lead-row');

      const main = el('div', 'lead-row-main');
      const text = el('div', 'lead-text');
      if (opts.overline) {
        text.appendChild(el('div', 'status-overline', 'Current status'));
      }
      text.appendChild(makeStatusTitle(leadStatus));

      if (!opts.hideSubtitle) {
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
      }
      // Manuscript badge as its own quiet line — message-level evidence for
      // why the action button says what it says.
      const badge = makeManuscriptBadge(currentManuscriptSignal);
      if (badge) text.appendChild(badge);
      main.appendChild(text);
      row.appendChild(main);

      const actions = el('div', 'lead-row-actions');
      const markBtn = el('button', 'mark-btn');
      markBtn.dataset.email = address;
      markBtn.dataset.statusMode = '1';

      const terminalStatus = leadStatus === 'manuscript_received' || leadStatus === 'rejected' ||
                             leadStatus === 'locked' || leadStatus === 'invalid_email';
      if (terminalStatus) {
        setOpenOnlyButtonState(markBtn);
      } else if (manuscriptHas) {
        markBtn.dataset.terminal = '1';
        setManuscriptButtonState(markBtn);   // "Mark as Manuscript received"
      } else if (leadStatus === 'no_response') {
        setResponseButtonState(markBtn);      // "Mark as Response"
      } else {                                 // response, no manuscript
        setOpenOnlyButtonState(markBtn);
      }
      actions.appendChild(markBtn);
      if (!opts.hideCopy) actions.appendChild(makeCopyBtn(address));
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

  // Identity header for the single-lead view: LEAD <email> [source] [copy].
  // The email is WHO this popup is about — it belongs in the header line, not
  // buried in the row competing with the status. The copy button sits next to
  // the email it copies.
  function makeLeadHeader({ address, source }) {
    const h = el('div', 'section-header');
    h.appendChild(el('span', 'section-label', 'Lead'));
    const emailSpan = el('span', 'section-lead-email', address);
    emailSpan.title = address;
    h.appendChild(emailSpan);
    if (source && source !== 'sender') {
      h.appendChild(el('span', 'section-lead-source', SOURCE_LABELS[source] || source));
    }
    h.appendChild(el('span', 'section-spacer'));
    h.appendChild(makeCopyBtn(address));
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
          // Status rows: the live V4 status is the only truth — the click
          // must not write local legacy guess-flags (opened/marked/terminal),
          // which could wrongly suppress the lead if it ever falls back to
          // legacy handling.
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
        setTimeout(() => { copyBtn.textContent = orig; }, 1200);
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
      // One status-mode lead (the overwhelmingly common case): identity in
      // the header, labeled status + action in the row.
      ui.leadsSection.appendChild(makeLeadHeader(single));
      const ev = evaluation[single.address.toLowerCase()] || {};
      ui.leadsSection.appendChild(makeLeadRow(
        single, single.statusCode, !!ev.opened, currentManuscriptSignal,
        { overline: true, hideSubtitle: true, hideCopy: true }
      ));
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
