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
    markBtn.appendChild(el('span', 'mark-label', 'Manuscript received'));
    markBtn.classList.remove('opened');
    markBtn.classList.add('manuscript');
    markBtn.title = 'Mark this lead as Manuscript received in V4 — stops further reminders.';
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

  // V4 status chip — rendered in the lead-meta line when the API returns a
  // lead status. 'updating' is the local variant shown while a pendingMark
  // bridge is live (the user just clicked Mark; the API hasn't caught up).
  const STATUS_CHIPS = {
    no_response:         { label: 'No response yet',     cls: 'chip-gray'     },
    response:            { label: 'Responded',           cls: 'chip-blue'     },
    manuscript_received: { label: 'Manuscript received', cls: 'chip-green'    },
    rejected:            { label: 'Rejected',            cls: 'chip-red'      },
    locked:              { label: 'Locked',              cls: 'chip-gray'     },
    invalid_email:       { label: 'Invalid email',       cls: 'chip-red'      },
    updating:            { label: 'Updating…',           cls: 'chip-updating' }
  };

  function makeStatusChip(statusKey) {
    const def = STATUS_CHIPS[statusKey];
    if (!def) return null;
    return el('span', `status-chip ${def.cls}`, def.label);
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

  // leadStatus: normalized V4 status string or null (legacy mode).
  // isPending: a Mark click for this email is in the bridge window — show
  // "Updating…" instead of the (stale) API status.
  function makeLeadRow({ address, source, leadStatus }, statusCode, isOpened, currentManuscriptSignal, isPending) {
    const s = STATUS[statusCode];
    const row = el('div', `lead-row ${s.className}`);

    const main = el('div', 'lead-row-main');
    const text = el('div', 'lead-text');

    const emailDiv = el('div', 'lead-email');
    const docIcon = makeManuscriptIcon(currentManuscriptSignal);
    if (docIcon) emailDiv.appendChild(docIcon);
    emailDiv.appendChild(document.createTextNode(address));
    emailDiv.title = address;
    text.appendChild(emailDiv);

    const metaDiv = el('div', 'lead-meta');
    if (source) {
      metaDiv.appendChild(el('span', 'source-hint', SOURCE_LABELS[source] || source));
    }
    // Status chip (status mode only). pendingMark overrides the API status —
    // the user just acted; showing the stale status would contradict them.
    // Guard on leadStatus so legacy rows never get a chip, even if a caller
    // passes isPending for a legacy lead.
    const chip = leadStatus === null ? null : makeStatusChip(isPending ? 'updating' : leadStatus);
    if (chip) metaDiv.appendChild(chip);
    if (metaDiv.childNodes.length) text.appendChild(metaDiv);

    main.appendChild(text);
    row.appendChild(main);

    const actions = el('div', 'lead-row-actions');
    // Non-actionable statuses (lifecycle ended, lead locked, invalid address)
    // still get a button — the muted "Open in V4" — so the user can always
    // jump to the lead's CRM page even when there's nothing to mark.
    const terminalStatus = leadStatus === 'manuscript_received' || leadStatus === 'rejected' ||
                           leadStatus === 'locked' || leadStatus === 'invalid_email';

    const markBtn = el('button', 'mark-btn');
    markBtn.dataset.email = address;
    if (terminalStatus) {
      setOpenOnlyButtonState(markBtn);
    } else if (currentManuscriptSignal && currentManuscriptSignal.has && !isOpened) {
      // Manuscript signal → terminal mark, both modes.
      markBtn.dataset.terminal = '1';
      setManuscriptButtonState(markBtn);
    } else if (isOpened) {
      setButtonState(markBtn, true);
    } else if (leadStatus === 'no_response') {
      setResponseButtonState(markBtn);
    } else if (leadStatus === 'response') {
      setOpenOnlyButtonState(markBtn);
    } else {
      setButtonState(markBtn, false);  // legacy
    }
    actions.appendChild(markBtn);

    const copyBtn = el('button', 'icon-btn copy-btn', '📋');
    copyBtn.dataset.email = address;
    copyBtn.title = 'Copy email';
    actions.appendChild(copyBtn);

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
      // Flip this button to the persisted "opened" state. The background has
      // already saved it to storage, so reopening the popup keeps the state.
      setButtonState(markBtn, true);
      markBtn.classList.remove('dispatching');
      // Status mode: the API status is now stale for this lead (the user is
      // about to change it in V4). Swap the chip to "Updating…" so the UI
      // doesn't contradict the user's own action.
      try {
        const rowEl = markBtn.closest('.lead-row');
        const chipEl = rowEl && rowEl.querySelector('.status-chip');
        if (chipEl) {
          const updated = makeStatusChip('updating');
          if (updated) chipEl.replaceWith(updated);
        }
      } catch (e) { /* cosmetic only */ }
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
