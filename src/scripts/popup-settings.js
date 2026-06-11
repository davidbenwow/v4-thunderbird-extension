// popup-settings.js
(function () {
  'use strict';

  const apiKeyInput   = document.getElementById('api-key');
  const saveBtn       = document.getElementById('save-btn');
  const saveStatus    = document.getElementById('save-status');
  const toggleBtn     = document.getElementById('toggle-btn');
  const statusModeBtn = document.getElementById('status-mode-btn');

  async function load() {
    const config = await browser.runtime.sendMessage({ method: 'getConfig' });
    apiKeyInput.value = config.apiKey || '';
    setToggleUI(config.enabled);
    setStatusModeUI(config.statusMode !== 'off');

    // Populate the ignored-domains list (INTERNAL_DOMAINS comes from internal-domains.js)
    try {
      const listEl = document.getElementById('domain-list');
      const summaryEl = document.querySelector('.domain-details summary');
      if (listEl && typeof INTERNAL_DOMAINS !== 'undefined') {
        const sorted = [...INTERNAL_DOMAINS].sort();
        for (const domain of sorted) {
          const li = document.createElement('li');
          li.textContent = domain;
          listEl.appendChild(li);
        }
        if (summaryEl) summaryEl.textContent = `Ignored internal domains (${sorted.length})`;
      }
    } catch (err) {
      console.warn('Could not render domain list:', err);
    }
  }

  function setToggleUI(enabled) {
    toggleBtn.textContent = enabled ? 'ON' : 'OFF';
    toggleBtn.className   = enabled ? 'toggle-on' : 'toggle-off';
  }

  function setStatusModeUI(auto) {
    if (!statusModeBtn) return;
    statusModeBtn.textContent = auto ? 'ON' : 'OFF';
    statusModeBtn.className   = auto ? 'toggle-on' : 'toggle-off';
  }

  saveBtn.addEventListener('click', async () => {
    const rawKey = apiKeyInput.value.trim();

    if (!rawKey) {
      saveStatus.textContent = 'Please enter a key';
      saveStatus.style.color = '#dc2626';
      setTimeout(() => {
        saveStatus.textContent = '';
        saveStatus.style.color = '';
      }, 3000);
      return;
    }

    try {
      await browser.runtime.sendMessage({
        method: 'setConfig',
        payload: { apiKey: rawKey }
      });
    } catch (err) {
      // Without this catch a storage/IPC failure exits the handler silently —
      // the user assumes the key was saved when it wasn't.
      saveStatus.textContent = 'Save failed — please try again';
      saveStatus.style.color = '#dc2626';
      setTimeout(() => {
        saveStatus.textContent = '';
        saveStatus.style.color = '';
      }, 4000);
      return;
    }
    saveStatus.textContent = 'Saved ✓';
    saveStatus.style.color = '';
    setTimeout(() => { saveStatus.textContent = ''; }, 2000);
  });

  toggleBtn.addEventListener('click', async () => {
    const config = await browser.runtime.sendMessage({ method: 'getConfig' });
    const next = !config.enabled;
    await browser.runtime.sendMessage({
      method: 'setConfig',
      payload: { enabled: next }
    });
    setToggleUI(next);
  });

  if (statusModeBtn) {
    statusModeBtn.addEventListener('click', async () => {
      const config = await browser.runtime.sendMessage({ method: 'getConfig' });
      const nextAuto = config.statusMode === 'off';  // flip
      await browser.runtime.sendMessage({
        method: 'setConfig',
        payload: { statusMode: nextAuto ? 'auto' : 'off' }
      });
      setStatusModeUI(nextAuto);
    });
  }

  document.addEventListener('DOMContentLoaded', load);
})();
