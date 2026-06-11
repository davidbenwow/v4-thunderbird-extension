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
      markBtn.appendChild(el('span', 'mark-label', 'Mark Lead in V4'));
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
    markBtn.appendChild(el('span', 'mark-label', 'Mark as Manuscript received'));
    markBtn.classList.remove('opened');
    markBtn.classList.add('manuscript');
    markBtn.title = 'Open this lead in V4 and mark their status as Manuscript received.';
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
    markBtn.appendChild(el('span', 'mark-label', 'Mark as Response'));
    markBtn.classList.remove('opened');
    markBtn.title = 'Open this lead in V4 and mark their status as Response.';
  }

  // Informational "Open in V4" — shown when no marking action is needed
  // (status already 'response', no manuscript). Muted styling.
  function setOpenOnlyButtonState(markBtn) {
    while (markBtn.firstChild) markBtn.removeChild(markBtn.firstChild);
    markBtn.appendChild(el('span', 'mark-label', 'Open in V4'));
    markBtn.classList.remove('opened');
    markBtn.classList.add('secondary');
    markBtn.title = 'Open this lead in V4 (no action needed right now).';
  }

  // V4 lead-status metadata: the status is now the ROW HEADLINE (status mode),
  // shown as bold colored text with a matching dot + left border. 'updating'
  // is the transient state shown while a Mark click is propagating to V4.
  const STATUS_META = {
    no_response:         { label: 'No response yet',     cls: 'st-gray',  border: '#8592a6' },
    response:            { label: 'Responded',           cls: 'st-blue',  border: '#2563eb' },
    manuscript_received: { label: 'Manuscript received', cls: 'st-green', border: '#16a34a' },
    rejected:            { label: 'Rejected',            cls: 'st-red',   border: '#dc2626' },
    locked:              { label: 'Locked',              cls: 'st-gray',  border: '#8592a6' },
    invalid_email:       { label: 'Invalid email',       cls: 'st-red',   border: '#dc2626' },
    updating:            { label: 'Updating…',           cls: 'st-brand', border: '#e7741b' }
  };

  function makeStatusTitle(statusKey) {
    const meta = STATUS_META[statusKey] || STATUS_META.no_response;
    const title = el('div', `lead-status-title ${meta.cls}`);
    title.appendChild(el('span', 'dot'));
    title.appendChild(document.createTextNode(meta.label));
    return title;
  }

  // Builds the optional 📄 indicator span. Returns null if no signal.
  function makeManuscriptIcon(signal) {
    if (!signal || !signal.has) return null;
    const docIcon = document.createElement('span');
    docIcon.className = 'manuscript-icon';
    docIcon.textContent = '📄 ';
    docIcon.title = signal.type === 'attachment'
      ? 'Possible manuscript attached: ' + signal.detail
      : 'Possible manuscript transfer link: ' + signal.detail;
    return docIcon;
  }

  function makeCopyBtn(address) {
    const copyBtn = el('button', 'icon-btn copy-btn', '📋');
    copyBtn.dataset.email = address;
    copyBtn.title = 'Copy email';
    return copyBtn;
  }

  // leadStatus: normalized V4 status string or null (legacy mode).
  // isPending: a Mark click for this email is propagating to V4 — show the
  // "Updating…" headline until the live status confirms it.
  function makeLeadRow({ address, source, leadStatus }, statusCode, isOpened, currentManuscriptSignal, isPending) {
    const manuscriptHas = !!(currentManuscriptSignal && currentManuscriptSignal.has);

    // ---- STATUS MODE: the V4 status is the headline AND the source of truth.
    // The button is driven by the real status, not the local "opened" guess —
    // if the lead is still no_response, the action stays available even if we
    // optimistically flipped it last time; the API confirms what actually
    // happened. Email is demoted to a quiet subtitle.
    if (leadStatus !== null) {
      const row = el('div', 'lead-row');
      const shownKey = isPending ? 'updating' : leadStatus;
      const meta = STATUS_META[shownKey] || STATUS_META.no_response;
      row.style.borderLeft = `3px solid ${meta.border}`;

      const main = el('div', 'lead-row-main');
      const text = el('div', 'lead-text');
      text.appendChild(makeStatusTitle(shownKey));

      const sub = el('div', 'lead-subtitle');
      const docIcon = makeManuscriptIcon(currentManuscriptSignal);
      if (docIcon) sub.appendChild(docIcon);
      sub.appendChild(el('span', 'sub-email', address));
      // 'sender' is the default/obvious case — annotating it is just noise.
      // Other sources (recipient, Cc, found in thread) ARE worth flagging.
      if (source && source !== 'sender') {
        sub.appendChild(el('span', 'sub-sep', '·'));
        sub.appendChild(el('span', 'sub-source', SOURCE_LABELS[source] || source));
      }
      sub.title = address;
      text.appendChild(sub);
      main.appendChild(text);
      row.appendChild(main);

      const actions = el('div', 'lead-row-actions');
      const markBtn = el('button', 'mark-btn');
      markBtn.dataset.email = address;
      markBtn.dataset.statusMode = '1';

      const terminalStatus = leadStatus === 'manuscript_received' || leadStatus === 'rejected' ||
                             leadStatus === 'locked' || leadStatus === 'invalid_email';
      if (isPending) {
        // Just acted; the click is propagating — offer only "Open in V4" so
        // the user doesn't re-fire the same mark before V4 catches up.
        setOpenOnlyButtonState(markBtn);
      } else if (terminalStatus) {
        setOpenOnlyButtonState(markBtn);
      } else if (manuscriptHas) {
        markBtn.dataset.terminal = '1';
        markBtn.dataset.marks = '1';          // an actual mark action
        setManuscriptButtonState(markBtn);   // "Mark as Manuscript received"
      } else if (leadStatus === 'no_response') {
        markBtn.dataset.marks = '1';          // an actual mark action
        setResponseButtonState(markBtn);      // "Mark as Response"
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

    const emailDiv = el('div', 'lead-email');
    const docIcon = makeManuscriptIcon(currentManuscriptSignal);
    if (docIcon) emailDiv.appendChild(docIcon);
    emailDiv.appendChild(document.createTextNode(address));
    emailDiv.title = address;
    text.appendChild(emailDiv);

    if (source && source !== 'sender') {
      const metaDiv = el('div', 'lead-meta');
      metaDiv.appendChild(el('span', 'source-hint', SOURCE_LABELS[source] || source));
      text.appendChild(metaDiv);
    }

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
          terminal
        });
      } catch (err) {
        markBtn.classList.remove('dispatching');
        ui.errorDetail.textContent = `Could not open V4: ${err && err.message ? err.message : err}`;
        show('error');
        return;
      }
      markBtn.classList.remove('dispatching');
      if (markBtn.dataset.statusMode === '1') {
        // Only an actual mark action (Mark as Response / Manuscript received)
        // changes the lead's status — a passive "Open in V4" click does not,
        // so it must NOT flip the headline to "Updating…". Gate on dataset.marks.
        if (markBtn.dataset.marks === '1') {
          // Don't claim "done" — the live status is the source of truth and
          // will confirm on the next scan/reopen. Show a transient "Updating…"
          // headline and demote the button so the mark isn't re-fired.
          try {
            const rowEl = markBtn.closest('.lead-row');
            const titleEl = rowEl && rowEl.querySelector('.lead-status-title');
            if (titleEl) titleEl.replaceWith(makeStatusTitle('updating'));
            if (rowEl) rowEl.style.borderLeft = `3px solid ${STATUS_META.updating.border}`;
          } catch (e) { /* cosmetic only */ }
          setOpenOnlyButtonState(markBtn);
        }
        // Passive "Open in V4": leave the row exactly as it is.
      } else {
        // Legacy mode: the local "opened" guess is the only signal we have.
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
    // The response also carries the opened/pending flags rows render with.
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

    const title = leads.length === 1 ? '1 lead found' : `${leads.length} leads found`;
    ui.leadsSection.appendChild(makeSectionHeader(title));
    for (const l of leads) {
      const ev = evaluation[l.address.toLowerCase()] || {};
      const isOpened = !!ev.opened;
      // pendingMark is a status-mode concept: the "Updating…" chip replaces a
      // stale API status. In legacy mode (leadStatus null) there is no chip
      // at all, so pending must not surface — openInV4 writes pendingMark on
      // every Mark click regardless of mode.
      const isPending = !isOpened && !!ev.pending && l.leadStatus !== null;
      ui.leadsSection.appendChild(makeLeadRow(l, l.statusCode, isOpened, currentManuscriptSignal, isPending));
    }
    show('results');
  }

  document.addEventListener('DOMContentLoaded', run);
})();
