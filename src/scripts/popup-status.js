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

  // --- Event handlers ------------------------------------------------------
  document.addEventListener('click', async (e) => {
    const markBtn = e.target.closest('.mark-btn');
    if (markBtn) {
      if (markBtn.classList.contains('dispatching')) return;
      markBtn.classList.add('dispatching');
      const email = markBtn.dataset.email;
      try {
        await browser.runtime.sendMessage({
          method: 'openInV4',
          email,
          headerMessageId: currentHeaderMessageId
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
