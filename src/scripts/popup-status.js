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
    leadsSection:  document.getElementById('leads-section'),
    queueSection:  document.getElementById('queue-section')
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

  function makeLeadRow({ address, source }, statusCode, isOpened) {
    const s = STATUS[statusCode];
    const row = el('div', `lead-row ${s.className}`);

    const main = el('div', 'lead-row-main');
    const text = el('div', 'lead-text');

    const emailDiv = el('div', 'lead-email', address);
    emailDiv.title = address;
    text.appendChild(emailDiv);

    if (source) {
      const metaDiv = el('div', 'lead-meta');
      metaDiv.appendChild(el('span', 'source-hint', SOURCE_LABELS[source] || source));
      text.appendChild(metaDiv);
    }

    main.appendChild(text);
    row.appendChild(main);

    const actions = el('div', 'lead-row-actions');

    const markBtn = el('button', 'mark-btn');
    markBtn.dataset.email = address;
    setButtonState(markBtn, isOpened);
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

  // --- Recent matches queue ------------------------------------------------
  // A queue row renders the subject prominently (it's how users recognize
  // messages) with the email shown below as the identifying detail. The Mark
  // button is the same as the per-email one, but it carries its own
  // headerMessageId via dataset so the handler routes to the right message.
  // The Dismiss (✕) button removes the entry without marking.
  function makeQueueRow(entry) {
    const s = STATUS[entry.status] || STATUS[3];
    const row = el('div', `lead-row ${s.className}`);

    const main = el('div', 'lead-row-main');
    const text = el('div', 'lead-text');

    const titleText = entry.subject && entry.subject.length ? entry.subject : entry.email;
    const titleDiv = el('div', 'lead-email', titleText);
    titleDiv.title = titleText;
    text.appendChild(titleDiv);

    const metaDiv = el('div', 'lead-meta');
    metaDiv.appendChild(el('span', 'source-hint', entry.email));
    text.appendChild(metaDiv);

    main.appendChild(text);
    row.appendChild(main);

    const actions = el('div', 'lead-row-actions');

    const markBtn = el('button', 'mark-btn');
    markBtn.dataset.email = entry.email;
    markBtn.dataset.headerMessageId = entry.headerMessageId;
    markBtn.dataset.fromQueue = '1';
    setButtonState(markBtn, false);
    actions.appendChild(markBtn);

    const dismissBtn = el('button', 'icon-btn dismiss-btn', '✕');
    dismissBtn.dataset.email = entry.email;
    dismissBtn.dataset.headerMessageId = entry.headerMessageId;
    dismissBtn.title = 'Dismiss from recent matches';
    actions.appendChild(dismissBtn);

    row.appendChild(actions);
    return row;
  }

  async function renderQueue() {
    let queue = [];
    try {
      const r = await browser.runtime.sendMessage({ method: 'getQueue' });
      queue = (r && Array.isArray(r.queue)) ? r.queue : [];
    } catch (e) { /* best effort — leave queue hidden if IPC fails */ }

    while (ui.queueSection.firstChild) {
      ui.queueSection.removeChild(ui.queueSection.firstChild);
    }

    if (queue.length === 0) {
      ui.queueSection.classList.add('hidden');
      return;
    }

    ui.queueSection.classList.remove('hidden');
    ui.queueSection.appendChild(makeSectionHeader('Still to mark in V4 👇'));
    for (const entry of queue) {
      ui.queueSection.appendChild(makeQueueRow(entry));
    }
  }

  // --- Event handlers ------------------------------------------------------
  document.addEventListener('click', async (e) => {
    const markBtn = e.target.closest('.mark-btn');
    if (markBtn) {
      if (markBtn.classList.contains('dispatching')) return;
      markBtn.classList.add('dispatching');
      const email = markBtn.dataset.email;
      // A Mark click from a queue row carries its own headerMessageId in
      // the dataset; fall back to the currently displayed message otherwise.
      const rowHeaderMessageId = markBtn.dataset.headerMessageId || currentHeaderMessageId;
      const fromQueue = markBtn.dataset.fromQueue === '1';
      try {
        await browser.runtime.sendMessage({
          method: 'openInV4',
          email,
          headerMessageId: rowHeaderMessageId
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
      // A queue-row Mark removed the entry from the queue server-side; refresh
      // the UI so the row disappears.
      if (fromQueue) {
        renderQueue().catch(() => {});
      }
      return;
    }

    const dismissBtn = e.target.closest('.dismiss-btn');
    if (dismissBtn) {
      if (dismissBtn.classList.contains('dispatching')) return;
      dismissBtn.classList.add('dispatching');
      const email = dismissBtn.dataset.email;
      const headerMessageId = dismissBtn.dataset.headerMessageId;
      try {
        // dismissFromQueue (vs. removeFromQueue) also writes dismissed:v1
        // state so the same match doesn't re-enter the queue after the
        // 5-min scan cache expires and the user re-views the message.
        await browser.runtime.sendMessage({
          method: 'dismissFromQueue',
          email,
          headerMessageId
        });
      } catch (err) {
        console.error('Dismiss failed:', err);
        dismissBtn.classList.remove('dispatching');
        return;
      }
      await renderQueue();
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

    // Kick off the recent-matches queue render in parallel — independent of
    // the per-message scan. Self-hides when empty.
    renderQueue().catch(() => {});

    const tab = await getCurrentTab();
    if (!tab) { show('empty'); return; }

    const gathered = await gatherEmails(tab);
    const { emails, error, headerMessageId } = gathered || {};
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

    const results = response.results || {};
    const leads = [];
    for (const item of emails) {
      const statusCode = results[item.address] ?? results[item.address.toLowerCase()];
      if (statusCode === 2 || statusCode === 3) {
        leads.push({ ...item, statusCode });
      }
    }

    // Fetch opened-state for this message so we render each button correctly.
    let opened = {};
    if (currentHeaderMessageId) {
      try {
        const r = await browser.runtime.sendMessage({
          method: 'getOpened',
          headerMessageId: currentHeaderMessageId
        });
        opened = (r && r.opened) || {};
      } catch (e) { /* best effort */ }
    }

    // Unopened leads drive the toolbar ring. Sync it — the background will
    // verify the tab still shows this exact message before applying.
    const unopenedCount = leads.filter(l => !opened[l.address.toLowerCase()]).length;
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
      const isOpened = !!opened[l.address.toLowerCase()];
      ui.leadsSection.appendChild(makeLeadRow(l, l.statusCode, isOpened));
    }
    show('results');
  }

  document.addEventListener('DOMContentLoaded', run);
})();
