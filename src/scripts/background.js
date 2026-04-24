// V4 Contacts Checker — background script
// API URL is hardcoded; only the API key is user-configurable.

const STORAGE_KEYS = {
  API_KEY: 'v4pluginApiKey',
  ENABLED: 'v4pluginEnabled'
};

// Persistent per-message "opened" state. Keyed by headerMessageId (the
// RFC Message-ID, stable across TB restarts and folder moves) so that a
// future message from the same sender is treated as a fresh interaction.
// Schema: `opened:v1:<headerMessageId>` -> { "email@x.com": unixMs, ... }
const OPENED_KEY_PREFIX = 'opened:v1:';

function openedKey(headerMessageId) {
  return OPENED_KEY_PREFIX + headerMessageId;
}

async function getOpened(headerMessageId) {
  if (!headerMessageId) return {};
  const key = openedKey(headerMessageId);
  const result = await browser.storage.local.get(key);
  return result[key] || {};
}

// Per-message write serialization. Because markOpened does a
// read-modify-write, two simultaneous calls on the same message could both
// read the old value and the later write would clobber the earlier one.
// We serialize writes per message via a promise chain.
const openedWriteLocks = new Map(); // headerMessageId -> Promise

async function markOpened(headerMessageId, email) {
  if (!headerMessageId || !email) return;
  const prev = openedWriteLocks.get(headerMessageId) || Promise.resolve();
  // .catch(() => {}) so a previous failure doesn't break the chain.
  const next = prev.catch(() => {}).then(async () => {
    const key = openedKey(headerMessageId);
    const result = await browser.storage.local.get(key);
    const current = result[key] || {};
    current[email.toLowerCase()] = Date.now();
    await browser.storage.local.set({ [key]: current });
  });
  openedWriteLocks.set(headerMessageId, next);
  // Drop the lock entry after this write completes, but only if it's still
  // the latest write in flight (otherwise a newer write is relying on it).
  next.finally(() => {
    if (openedWriteLocks.get(headerMessageId) === next) {
      openedWriteLocks.delete(headerMessageId);
    }
  }).catch(() => {});
  return next;
}

// Startup pruning: drop opened-state entries older than 6 months. Bounded
// by browser.storage.local quota; not urgent but worth doing to keep things
// tidy. Runs once per background-script load.
async function pruneStaleOpenedEntries() {
  const CUTOFF_MS = 180 * 24 * 60 * 60 * 1000; // ~6 months
  const cutoff = Date.now() - CUTOFF_MS;
  try {
    const all = await browser.storage.local.get(null);
    const keysToDelete = [];
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(OPENED_KEY_PREFIX)) continue;
      if (!value || typeof value !== 'object') { keysToDelete.push(key); continue; }
      const timestamps = Object.values(value);
      if (timestamps.length === 0 ||
          timestamps.every(t => typeof t !== 'number' || t < cutoff)) {
        keysToDelete.push(key);
      }
    }
    if (keysToDelete.length) {
      await browser.storage.local.remove(keysToDelete);
      console.debug(`V4 Contacts: pruned ${keysToDelete.length} stale opened entries`);
    }
  } catch (err) {
    console.debug('V4 Contacts: prune failed', err);
  }
}
pruneStaleOpenedEntries();

// Persistent per-message "dismissed" state — mirrors opened:v1 in shape and
// semantics. Populated by the Dismiss (✕) button on queue rows. Suppresses
// re-enqueue on future scans so a dismissed match doesn't reappear after the
// 5-min badge cache expires and the message is re-viewed. Kept separate from
// opened:v1 because dismissal is NOT "user opened V4" — the popup's per-email
// Mark button must not falsely read "Opened in browser" just because the user
// dismissed a reminder.
// Schema: `dismissed:v1:<headerMessageId>` -> { "email@x.com": unixMs, ... }
const DISMISSED_KEY_PREFIX = 'dismissed:v1:';

function dismissedKey(headerMessageId) {
  return DISMISSED_KEY_PREFIX + headerMessageId;
}

async function getDismissed(headerMessageId) {
  if (!headerMessageId) return {};
  const key = dismissedKey(headerMessageId);
  const result = await browser.storage.local.get(key);
  return result[key] || {};
}

const dismissedWriteLocks = new Map();

async function markDismissed(headerMessageId, email) {
  if (!headerMessageId || !email) return;
  const prev = dismissedWriteLocks.get(headerMessageId) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const key = dismissedKey(headerMessageId);
    const result = await browser.storage.local.get(key);
    const current = result[key] || {};
    current[email.toLowerCase()] = Date.now();
    await browser.storage.local.set({ [key]: current });
  });
  dismissedWriteLocks.set(headerMessageId, next);
  next.finally(() => {
    if (dismissedWriteLocks.get(headerMessageId) === next) {
      dismissedWriteLocks.delete(headerMessageId);
    }
  }).catch(() => {});
  return next;
}

// Startup prune of stale dismissed entries (same 6-month cutoff as opened).
async function pruneStaleDismissedEntries() {
  const CUTOFF_MS = 180 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - CUTOFF_MS;
  try {
    const all = await browser.storage.local.get(null);
    const keysToDelete = [];
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(DISMISSED_KEY_PREFIX)) continue;
      if (!value || typeof value !== 'object') { keysToDelete.push(key); continue; }
      const timestamps = Object.values(value);
      if (timestamps.length === 0 ||
          timestamps.every(t => typeof t !== 'number' || t < cutoff)) {
        keysToDelete.push(key);
      }
    }
    if (keysToDelete.length) {
      await browser.storage.local.remove(keysToDelete);
      console.debug(`V4 Contacts: pruned ${keysToDelete.length} stale dismissed entries`);
    }
  } catch (err) {
    console.debug('V4 Contacts: dismissed prune failed', err);
  }
}
pruneStaleDismissedEntries();

// --- Recent-matches queue ---------------------------------------------------
// Persistent user-global queue of V4 matches the user has viewed but not
// acted on. Drives the count badge on the toolbar icon AND the "Recent
// matches" list in the popup. Cap + TTL keep it from growing unbounded;
// user-driven removal (Mark / Dismiss) + out-of-band markOpened clear entries.
//
// Schema: `queue:v1` -> Array<{
//   headerMessageId: string,   // RFC Message-ID of the email the match was seen in
//   email: string,             // lowercased lead email
//   status: 2 | 3,             // V4 status code at last sighting (used/pending)
//   subject: string,           // email subject, truncated to 200 chars
//   firstSeen: number,         // Date.now() of first enqueue — drives TTL
//   lastSeen: number           // Date.now() of most recent sighting
// }> — newest first, de-duped by (headerMessageId, email), capped at QUEUE_CAP.
const QUEUE_KEY    = 'queue:v1';
const QUEUE_CAP    = 10;
const QUEUE_TTL_MS = 24 * 60 * 60 * 1000;

// Single-key serialization (only one key, so one chained promise is enough).
let queueWriteLock = Promise.resolve();
function runUnderQueueLock(fn) {
  const prev = queueWriteLock.catch(() => {});
  const next = prev.then(fn);
  // Swallow errors on the lock chain so one failure doesn't wedge later writes.
  queueWriteLock = next.catch(() => {});
  return next;
}

function pruneQueue(list) {
  if (!Array.isArray(list)) return [];
  const cutoff = Date.now() - QUEUE_TTL_MS;
  return list.filter(e =>
    e && typeof e === 'object' &&
    typeof e.firstSeen === 'number' &&
    e.firstSeen >= cutoff
  );
}

async function readQueueRaw() {
  const r = await browser.storage.local.get(QUEUE_KEY);
  const raw = r[QUEUE_KEY];
  return Array.isArray(raw) ? raw : [];
}

// Read, prune, opportunistically write back if pruning changed anything.
async function getQueue() {
  return runUnderQueueLock(async () => {
    const raw = await readQueueRaw();
    const pruned = pruneQueue(raw);
    if (pruned.length !== raw.length) {
      await browser.storage.local.set({ [QUEUE_KEY]: pruned });
    }
    return pruned;
  });
}

// Merge a batch of match entries into the queue under a single lock+write.
// Called once per scan so N matches in one message = 1 storage write.
async function enqueueMatchBatch(entries, msgHeader) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  const now = Date.now();
  const subject = (msgHeader && typeof msgHeader.subject === 'string')
    ? msgHeader.subject.slice(0, 200)
    : '';
  return runUnderQueueLock(async () => {
    const list = pruneQueue(await readQueueRaw());
    let changed = false;
    for (const entry of entries) {
      if (!entry || !entry.headerMessageId || !entry.email) continue;
      const email = String(entry.email).toLowerCase();
      const status = entry.status;
      const existingIdx = list.findIndex(e =>
        e && e.headerMessageId === entry.headerMessageId && e.email === email
      );
      if (existingIdx !== -1) {
        list[existingIdx].lastSeen = now;
        list[existingIdx].status = status;
        // Preserve firstSeen / ordering — "newest first" means newest discovery,
        // not newest sighting. Re-seeing doesn't bump you to the top.
        changed = true;
      } else {
        list.unshift({
          headerMessageId: entry.headerMessageId,
          email,
          status,
          subject,
          firstSeen: now,
          lastSeen: now
        });
        changed = true;
      }
    }
    if (list.length > QUEUE_CAP) {
      list.length = QUEUE_CAP;
      changed = true;
    }
    if (changed) {
      await browser.storage.local.set({ [QUEUE_KEY]: list });
    }
  });
}

async function removeFromQueue({ headerMessageId, email }) {
  if (!headerMessageId || !email) return;
  const needle = String(email).toLowerCase();
  return runUnderQueueLock(async () => {
    const raw = await readQueueRaw();
    const filtered = raw.filter(e =>
      !(e && e.headerMessageId === headerMessageId && e.email === needle)
    );
    if (filtered.length !== raw.length) {
      await browser.storage.local.set({ [QUEUE_KEY]: filtered });
    }
  });
}

// Updates the *global* (no-tabId) badge text to the queue length, or empty
// when the extension is disabled / the queue is empty. Called after every
// queue mutation (via storage.onChanged), after scans, and on startup.
// Green (#16a34a) is deliberate — the orange ring on the active icon already
// carries the "attention" signal, so using the same orange on the count
// badge creates orange-on-orange visual noise. Green contrasts cleanly and
// matches the popup's success palette (status-ok / "Opened in browser").
async function refreshBadgeCount() {
  if (typeof browser.messageDisplayAction === 'undefined' ||
      typeof browser.messageDisplayAction.setBadgeText !== 'function') return;
  try {
    const { enabled } = await getConfig();
    const count = enabled ? (await getQueue()).length : 0;
    await browser.messageDisplayAction.setBadgeText({
      text: count > 0 ? String(count) : ''
    });
    if (typeof browser.messageDisplayAction.setBadgeBackgroundColor === 'function') {
      await browser.messageDisplayAction.setBadgeBackgroundColor({ color: '#16a34a' });
    }
  } catch (err) {
    console.debug('refreshBadgeCount failed:', err && err.message);
  }
}

// Coalesces bursts of badge refreshes into a single call. Fast arrow-keying
// through 10 matching messages fires onMessageDisplayed → enqueue →
// storage.onChanged → refreshBadgeCount per message — that's 20+ refresh
// calls per second, each doing a storage read for config + queue. Debounced
// to 100ms so the user sees a single final count, not a thrash of writes.
let refreshBadgeTimer = null;
function scheduleBadgeRefresh() {
  if (refreshBadgeTimer) return;
  refreshBadgeTimer = setTimeout(() => {
    refreshBadgeTimer = null;
    refreshBadgeCount().catch(() => {});
    // Also re-sync the active tab's TITLE — queue mutations change the
    // tooltip wording ("Nothing to mark" → "N leads still to mark" and vice
    // versa) and must be reflected without waiting for the next scan.
    refreshActiveTabTitle().catch(() => {});
  }, 100);
}

// Hardcoded — this backend URL is constant for all users.
const API_URL = 'https://v4.vdm-vsg.de';

// --- Storage helpers --------------------------------------------------------
async function getConfig() {
  const result = await browser.storage.local.get([
    STORAGE_KEYS.API_KEY,
    STORAGE_KEYS.ENABLED
  ]);
  return {
    apiKey:  result[STORAGE_KEYS.API_KEY] || '',
    enabled: result[STORAGE_KEYS.ENABLED] !== false
  };
}

async function setConfig(partial) {
  const payload = {};
  if (partial.apiKey  !== undefined) payload[STORAGE_KEYS.API_KEY]  = partial.apiKey;
  if (partial.enabled !== undefined) payload[STORAGE_KEYS.ENABLED]  = partial.enabled;
  return browser.storage.local.set(payload);
}

// --- API call ---------------------------------------------------------------
async function checkEmails(emails) {
  const { apiKey, enabled } = await getConfig();

  if (!enabled)                  return { error: 'disabled' };
  if (!apiKey)                   return { error: 'not_configured' };
  if (!emails || !emails.length) return { results: {} };

  const url  = `${API_URL}/api/existence_check/${apiKey}`;
  const body = emails.map(e => `emails[]=${encodeURIComponent(e)}`).join('&');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    if (!response.ok) return { error: 'api_error', status: response.status };
    const data = await response.json();
    return { results: data };
  } catch (err) {
    console.error('V4 Contacts API error:', err);
    return { error: 'network_error', message: err.message };
  }
}

// --- Email extraction -------------------------------------------------------
// TLD {2,} to handle long TLDs like .museum, .international, .academy.
// Using lowercase normalization so we match across cases.
const EMAIL_REGEX = /([A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,24})/gi;

function extractEmailsFromText(text) {
  if (!text) return [];
  const found = [];
  let m;
  EMAIL_REGEX.lastIndex = 0;
  while ((m = EMAIL_REGEX.exec(text)) !== null) {
    found.push(m[1].toLowerCase());
  }
  return found;
}

// Defensive wrapper: if internal-domains.js failed to load, don't filter anything
// (better to show the email than throw).
function safeIsInternal(email) {
  try {
    if (typeof isInternalEmail === 'function') {
      return isInternalEmail(email);
    }
  } catch (e) { /* fall through */ }
  return false;
}

// Recursively walk the MIME tree and collect text from the *body* only.
// Skips attachments (filename, Content-Disposition: attachment, or nested
// message/rfc822) AND non-body inline text parts like text/calendar and
// text/vcard (which would otherwise leak invite attendee / contact emails
// into the V4 lookup even though the UI claims to scan the message/thread).
function isAttachmentPart(part) {
  if (!part) return false;
  if (part.name) return true;          // filename suggests attachment
  if (part.contentType === 'message/rfc822') return true;
  const dispo = part.headers && (part.headers['content-disposition'] || part.headers['Content-Disposition']);
  if (dispo) {
    const firstValue = Array.isArray(dispo) ? dispo[0] : dispo;
    if (typeof firstValue === 'string' && /attachment/i.test(firstValue)) return true;
  }
  return false;
}

// Only the two MIME types that represent the actual readable thread body.
// text/calendar, text/vcard, text/x-patch, etc. are inline text but not body.
const BODY_CONTENT_TYPES = new Set(['text/plain', 'text/html']);

function collectBodyText(part) {
  if (!part) return '';
  if (isAttachmentPart(part)) return '';
  let text = '';
  if (part.contentType && BODY_CONTENT_TYPES.has(part.contentType) && part.body) {
    text += (part.contentType === 'text/html' ? stripHtmlTags(part.body) : part.body) + '\n';
  }
  if (part.parts && part.parts.length) {
    for (const p of part.parts) text += collectBodyText(p);
  }
  return text;
}

function stripHtmlTags(s) {
  // Replace tags with a space so adjacent text isn't merged, and collapse
  // consecutive whitespace. This is intentionally simple; the email regex
  // handles the rest.
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
}

// --- Displayed-message email gathering --------------------------------------
// Returns: { emails: [{address, source}], headerMessageId }
// source ∈ { 'sender', 'recipient', 'cc', 'bcc', 'body' }
// Each address appears at most once, with the highest-priority source it was
// found in (sender > recipient > cc > bcc > body).
//
// extractEmailsFromMessage takes a specific msgHeader so callers that already
// have one (e.g. scanAndBadgeMessage from an onMessageDisplayed event) can
// avoid re-querying the current displayed message — otherwise a fast
// arrow-key during an in-flight scan could return emails for a *different*
// message than the one whose cache key we're about to write.
async function extractEmailsFromMessage(msgHeader) {
  try {
    if (!msgHeader) return { emails: [] };

    const sender     = extractEmailsFromText(msgHeader.author);
    const recipients = extractEmailsFromText((msgHeader.recipients || []).join(', '));
    const ccList     = extractEmailsFromText((msgHeader.ccList     || []).join(', '));
    const bccList    = extractEmailsFromText((msgHeader.bccList    || []).join(', '));

    const byAddress = new Map();
    const addIfNew = (address, source) => {
      if (!byAddress.has(address)) byAddress.set(address, source);
    };
    for (const e of sender)     addIfNew(e, 'sender');
    for (const e of recipients) addIfNew(e, 'recipient');
    for (const e of ccList)     addIfNew(e, 'cc');
    for (const e of bccList)    addIfNew(e, 'bcc');

    try {
      const full = await browser.messages.getFull(msgHeader.id);
      const bodyText = collectBodyText(full);
      const bodyEmails = extractEmailsFromText(bodyText);
      for (const e of bodyEmails) addIfNew(e, 'body');
    } catch (bodyErr) {
      console.warn('Could not read message body:', bodyErr);
    }

    const filtered = [];
    for (const [address, source] of byAddress) {
      if (!safeIsInternal(address)) filtered.push({ address, source });
    }

    return {
      emails: filtered,
      headerMessageId: msgHeader.headerMessageId || null
    };
  } catch (err) {
    console.error('extractEmailsFromMessage error:', err);
    return { emails: [], error: err.message };
  }
}

async function getDisplayedMessageEmails(tabId) {
  const msgHeader = await browser.messageDisplay.getDisplayedMessage(tabId);
  if (!msgHeader) return { emails: [] };
  return extractEmailsFromMessage(msgHeader);
}

// --- Compose window recipients ----------------------------------------------
// Thunderbird's compose.getComposeDetails() returns recipient lists that can
// contain either plain strings like "Name <a@b.com>" OR objects referencing
// a contact/mailing list like { type: "contact", id: "..." } or
// { type: "mailingList", id: "..." }.
//
// Resolving a contact is harder than it looks:
//   - Legacy API `browser.contacts.get()` returns { id, type, properties, vCard }
//     where `properties` may contain PrimaryEmail/SecondEmail, but legacy
//     properties only expose the first entry of each type (TB 102+ behaviour).
//   - Newer API `browser.addressBooks.contacts.get()` returns { id, type, vCard }
//     without the `properties` field at all (on some builds).
//   - Some contacts have 3+ email addresses that only the vCard carries.
//
// Strategy: try every source we can find (legacy properties AND the vCard
// itself), collect everything, de-duplicate at the caller.

// Extract EMAIL values from a vCard string. Handles:
//   EMAIL:user@example.com
//   EMAIL;TYPE=WORK:user@example.com
//   EMAIL;TYPE=WORK;PREF=1:user@example.com
//   item1.EMAIL;TYPE=WORK:user@example.com   (grouped properties from some importers)
// Also handles vCard line folding (continuation lines start with space/tab).
function extractEmailsFromVCard(vcard) {
  if (typeof vcard !== 'string' || !vcard) return [];
  // Unfold continuation lines first
  const unfolded = vcard.replace(/\r?\n[ \t]/g, '');
  const out = [];
  // Optional group prefix (e.g. "item1.") before the EMAIL property name.
  const re = /^(?:[A-Za-z0-9-]+\.)?EMAIL(?:;[^:\r\n]*)?:([^\r\n]+)/gim;
  let m;
  while ((m = re.exec(unfolded)) !== null) {
    for (const e of extractEmailsFromText(m[1])) out.push(e);
  }
  return out;
}

async function getContactEmails(id) {
  const out = [];
  // Try legacy top-level contacts API first (present in TB 115+)
  let node = null;
  try {
    if (browser.contacts && browser.contacts.get) {
      node = await browser.contacts.get(id);
    }
  } catch (e) { /* fall through */ }
  // Fallback to the nested addressBooks.contacts API
  if (!node) {
    try {
      if (browser.addressBooks && browser.addressBooks.contacts && browser.addressBooks.contacts.get) {
        node = await browser.addressBooks.contacts.get(id);
      }
    } catch (e) { /* fall through */ }
  }
  if (!node) return out;

  // Pull from legacy flat properties (may not exist on newer API)
  const props = node.properties || {};
  for (const key of ['PrimaryEmail', 'SecondEmail']) {
    if (props[key]) for (const e of extractEmailsFromText(props[key])) out.push(e);
  }
  // Always parse the vCard too — it's the authoritative source and may contain
  // additional emails that the legacy properties can't represent.
  if (node.vCard) {
    for (const e of extractEmailsFromVCard(node.vCard)) out.push(e);
  }
  return out;
}

async function getMailingListMemberEmails(id) {
  const out = [];
  let members = null;
  // Legacy top-level API
  try {
    if (browser.mailingLists && browser.mailingLists.listMembers) {
      members = await browser.mailingLists.listMembers(id);
    }
  } catch (e) { /* fall through */ }
  // Nested API
  if (!members) {
    try {
      if (browser.addressBooks && browser.addressBooks.mailingLists && browser.addressBooks.mailingLists.listMembers) {
        members = await browser.addressBooks.mailingLists.listMembers(id);
      }
    } catch (e) { /* fall through */ }
  }
  if (!members) return out;

  for (const m of members) {
    const props = (m && m.properties) || {};
    for (const key of ['PrimaryEmail', 'SecondEmail']) {
      if (props[key]) for (const e of extractEmailsFromText(props[key])) out.push(e);
    }
    if (m && m.vCard) {
      for (const e of extractEmailsFromVCard(m.vCard)) out.push(e);
    }
  }
  return out;
}

async function resolveRecipientsToEmails(recipients) {
  if (!recipients || !recipients.length) return [];
  const resolved = [];

  for (const r of recipients) {
    if (typeof r === 'string') {
      for (const e of extractEmailsFromText(r)) resolved.push(e);
      continue;
    }

    if (r && typeof r === 'object') {
      const id = r.id || r.nodeId;
      if (!id) continue;
      try {
        if (r.type === 'contact') {
          for (const e of await getContactEmails(id)) resolved.push(e);
        } else if (r.type === 'mailingList') {
          for (const e of await getMailingListMemberEmails(id)) resolved.push(e);
        }
      } catch (resolveErr) {
        console.warn('Could not resolve recipient object:', r, resolveErr);
      }
    }
  }
  return resolved;
}

async function getComposeEmails(tabId) {
  try {
    const details = await browser.compose.getComposeDetails(tabId);

    const to  = await resolveRecipientsToEmails(details.to  || []);
    const cc  = await resolveRecipientsToEmails(details.cc  || []);
    const bcc = await resolveRecipientsToEmails(details.bcc || []);

    // Priority-aware dedupe: To beats Cc beats Bcc
    const byAddress = new Map();
    const addIfNew = (address, source) => {
      if (!byAddress.has(address)) byAddress.set(address, source);
    };
    for (const e of to)  addIfNew(e, 'recipient');
    for (const e of cc)  addIfNew(e, 'cc');
    for (const e of bcc) addIfNew(e, 'bcc');

    const filtered = [];
    for (const [address, source] of byAddress) {
      if (!safeIsInternal(address)) filtered.push({ address, source });
    }

    return { emails: filtered };
  } catch (err) {
    console.error('getComposeEmails error:', err);
    return { emails: [], error: err.message };
  }
}

// --- Open lead search in V4 -------------------------------------------------
async function openInV4(email, headerMessageId) {
  const url = `${API_URL}/system/lead/find?search_query=${encodeURIComponent(email)}`;

  // Dispatch to browser FIRST. If this rejects, we don't persist opened state —
  // otherwise a failed browser launch would permanently mark the lead as
  // opened even though the user never reached V4.
  await browser.windows.openDefaultBrowser(url);

  // Only after successful dispatch: persist opened state so the UI reflects
  // the action across popup reopens and Thunderbird restarts.
  if (headerMessageId && email) {
    try {
      await markOpened(headerMessageId, email);
    } catch (e) {
      console.warn('markOpened failed:', e);
    }
    // Also drop this match from the recent-matches queue. The subsequent
    // storage.onChanged fires refreshBadgeCount so the badge decrements.
    try {
      await removeFromQueue({ headerMessageId, email });
    } catch (e) {
      console.debug('removeFromQueue failed:', e);
    }
  }

  // Kick off an icon refresh for the currently displayed message without
  // awaiting, so the return to the caller isn't delayed.
  (async () => {
    try {
      const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!activeTab) return;
      const msgHeader = await browser.messageDisplay.getDisplayedMessage(activeTab.id).catch(() => null);
      if (!msgHeader) return;
      badgeCache.delete(cacheKey(msgHeader));
      await scanAndBadgeMessage(activeTab, msgHeader);
    } catch (e) { /* best effort */ }
  })();
}

// --- Proactive badging on message display -----------------------------------
// Cache results per (accountId, messageId) tuple to minimize cross-folder clashes.
// Entries have a TTL so a lead marked in V4 is re-checked within a reasonable window.
const BADGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const badgeCache = new Map(); // key -> { count, expiresAt }
// Per-tab generation counter for race-condition-safe updates
const tabGen = new Map();
// Global generation, bumped whenever settings change. A scan that started
// under an older generation must NOT write results, because the API key or
// enabled state may have changed mid-flight.
let configGen = 0;

function cacheKey(msgHeader) {
  const folder = msgHeader.folder || {};
  const acc = folder.accountId || '';
  return `${acc}:${msgHeader.id}`;
}

function getCachedCount(key) {
  const entry = badgeCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    badgeCache.delete(key);
    return undefined;
  }
  return entry.count;
}

function setCachedCount(key, count) {
  badgeCache.set(key, { count, expiresAt: Date.now() + BADGE_TTL_MS });
  if (badgeCache.size > 200) {
    const firstKey = badgeCache.keys().next().value;
    badgeCache.delete(firstKey);
  }
}

function invalidateAllCache() {
  badgeCache.clear();
}

async function updateBadgeForTab(tabId, count, opts = {}) {
  try {
    // This function owns the ICON swap (active ring vs. default) for the
    // current message's per-message state. Badge TEXT is managed globally by
    // refreshBadgeCount() from the queue; setting per-tab badge text here
    // would create a per-tab override that masks the global queue count.

    const useActive = count > 0;

    if (useActive) {
      await browser.messageDisplayAction.setIcon({
        path: {
          16: 'images/icon-16-active.png',
          19: 'images/icon-19-active.png',
          32: 'images/icon-32-active.png',
          38: 'images/icon-38-active.png'
        },
        tabId
      });
    } else {
      await browser.messageDisplayAction.setIcon({
        path: {
          16: 'images/icon-16.png',
          19: 'images/icon-19.png',
          32: 'images/icon-32.png',
          38: 'images/icon-38.png'
        },
        tabId
      });
    }

    // Title composition — considers BOTH per-message match state AND global
    // queue state. Without this, the tooltip would say "Nothing to mark in
    // V4" while the badge counts queued matches, contradicting itself.
    let title;
    if (opts.showAlert) {
      title = 'V4 Contacts — not configured. Open preferences to set up.';
    } else if (useActive) {
      title = 'Mark Lead in V4';
    } else {
      let queueLen = 0;
      try {
        const { enabled } = await getConfig();
        queueLen = enabled ? (await getQueue()).length : 0;
      } catch (e) { /* fall through to 0 — idle title */ }
      if (queueLen === 1)      title = '1 lead still to mark in V4';
      else if (queueLen > 1)   title = `${queueLen} leads still to mark in V4`;
      else                     title = 'Nothing to mark in V4';
    }
    await browser.messageDisplayAction.setTitle({ title, tabId });
  } catch (err) {
    // Tab may have closed, or API may not exist on older Thunderbird builds
    console.debug('Badge update failed:', err && err.message);
  }
}

// Refresh the active tab's title after a queue mutation. The title depends
// on queue length AND current-message match state; we use the cached per-
// message count (populated by scanAndBadgeMessage) instead of re-scanning.
async function refreshActiveTabTitle() {
  if (typeof browser.messageDisplayAction === 'undefined') return;
  try {
    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) return;
    const msgHeader = await browser.messageDisplay.getDisplayedMessage(activeTab.id).catch(() => null);
    if (!msgHeader) return;
    const cachedCount = getCachedCount(cacheKey(msgHeader));
    await updateBadgeForTab(activeTab.id, cachedCount || 0);
  } catch (e) { /* best effort — title will self-correct on next scan */ }
}

// Validated entry point for the popup to update a tab's icon. Rejects writes
// that are clearly stale: wrong current message, disabled extension, or a
// newer scan already in progress (via configGen).
async function syncBadgeFromPopup(tabId, headerMessageId, count) {
  if (!hasBadgeAPI) return;
  try {
    const current = await browser.messageDisplay.getDisplayedMessage(tabId).catch(() => null);
    if (!current) return; // tab no longer shows a message
    // If the popup computed against a specific message, make sure the tab
    // still shows that message. (The popup might have been computed for one
    // message, then the user arrow-keyed to another before the popup's API
    // call resolved.)
    if (headerMessageId && current.headerMessageId && current.headerMessageId !== headerMessageId) {
      return;
    }
    const { enabled } = await getConfig();
    if (!enabled) return;
    await updateBadgeForTab(tabId, count);
  } catch (err) {
    console.debug('syncBadgeFromPopup failed:', err && err.message);
  }
}

async function scanAndBadgeMessage(tab, msgHeader) {
  if (!tab || !msgHeader) return;

  // Advance the per-tab generation and capture the current config generation.
  // We check BOTH on every await boundary: per-tab guards against the user
  // arrow-keying to a new message; config guards against the settings changing
  // during the scan.
  const myGen = (tabGen.get(tab.id) || 0) + 1;
  tabGen.set(tab.id, myGen);
  const myConfigGen = configGen;
  const stillValid = () =>
    tabGen.get(tab.id) === myGen && configGen === myConfigGen;

  const { apiKey, enabled } = await getConfig();
  if (!stillValid()) return;

  if (!enabled) {
    await updateBadgeForTab(tab.id, 0);
    return;
  }
  if (!apiKey) {
    await updateBadgeForTab(tab.id, 0, { showAlert: true });
    return;
  }

  const key = cacheKey(msgHeader);

  const cached = getCachedCount(key);
  if (cached !== undefined) {
    await updateBadgeForTab(tab.id, cached);
    return;
  }

  try {
    // Use the msgHeader we were handed, not a fresh getDisplayedMessage lookup.
    // If the user arrow-keys to another message mid-scan, the tabGen check
    // catches it — but *only* if onMessageDisplayed has fired by then. Until
    // then, re-querying by tab could return the new message's data under the
    // old message's cache key. Binding directly to msgHeader prevents that.
    const { emails, headerMessageId } = await extractEmailsFromMessage(msgHeader);
    if (!stillValid()) return;

    if (!emails || !emails.length) {
      setCachedCount(key, 0);
      await updateBadgeForTab(tab.id, 0);
      return;
    }

    const addresses = emails.map(e => e.address);
    const result = await checkEmails(addresses);
    if (!stillValid()) return;

    if (result.error) {
      // Don't cache transient errors
      await updateBadgeForTab(tab.id, 0);
      return;
    }

    // Load per-message opened + dismissed state so already-actioned / already-
    // dismissed leads don't count toward the orange ring or re-enter the queue
    // after cache expiry. If there's no headerMessageId (shouldn't happen for
    // real messages), treat both as empty.
    const [opened, dismissed] = await Promise.all([
      getOpened(headerMessageId),
      getDismissed(headerMessageId)
    ]);
    if (!stillValid()) return;

    const results = result.results || {};
    let leadCount = 0;
    const toEnqueue = [];
    for (const addr of addresses) {
      const status = results[addr] ?? results[addr.toLowerCase()];
      if (status === 2 || status === 3) {
        const lower = addr.toLowerCase();
        if (!opened[lower] && !dismissed[lower]) {
          leadCount++;
          if (headerMessageId) {
            toEnqueue.push({ headerMessageId, email: lower, status });
          }
        }
      }
    }

    setCachedCount(key, leadCount);

    if (stillValid()) {
      await updateBadgeForTab(tab.id, leadCount);
      if (toEnqueue.length > 0) {
        try { await enqueueMatchBatch(toEnqueue, msgHeader); }
        catch (e) { console.debug('enqueueMatchBatch failed:', e); }
      }
    }
  } catch (err) {
    console.error('scanAndBadgeMessage error:', err);
    if (stillValid()) {
      await updateBadgeForTab(tab.id, 0);
    }
  }
}

// Guard against older Thunderbird builds missing messageDisplayAction
const hasBadgeAPI = typeof browser.messageDisplayAction !== 'undefined'
                 && typeof browser.messageDisplayAction.setBadgeText === 'function';

if (hasBadgeAPI && browser.messageDisplay && browser.messageDisplay.onMessageDisplayed) {
  browser.messageDisplay.onMessageDisplayed.addListener(async (tab, msgHeader) => {
    await scanAndBadgeMessage(tab, msgHeader);
    // Reassert queue-count badge in case scan was a cache hit, disabled, or
    // short-circuited. Debounced so fast arrow-key navigation doesn't thrash.
    scheduleBadgeRefresh();
  });
}

// Re-check when the user changes tabs
browser.tabs.onActivated.addListener(async ({ tabId }) => {
  if (!hasBadgeAPI) return;
  try {
    const msgHeader = await browser.messageDisplay.getDisplayedMessage(tabId);
    if (msgHeader) {
      const tab = await browser.tabs.get(tabId);
      await scanAndBadgeMessage(tab, msgHeader);
    } else {
      await updateBadgeForTab(tabId, 0);
    }
  } catch (err) { /* not a message tab — ignore */ }
  scheduleBadgeRefresh();
});

// Refresh badge once at startup so restart-persisted queue is reflected
// on the toolbar before the user touches anything. Immediate (not debounced)
// because this is a one-shot on script load.
if (hasBadgeAPI) refreshBadgeCount().catch(() => {});

// Clean up tab-generation tracking when tabs close
browser.tabs.onRemoved.addListener((tabId) => {
  tabGen.delete(tabId);
});

// Rescan the currently displayed message when Thunderbird regains focus.
// This catches the critical flow: user clicks Mark Lead in V4 → marks the
// lead in their browser → returns to Thunderbird. Without this, the icon
// would stay stale until the message is re-displayed. Debounced so rapid
// alt-tab sequences don't thrash the API.
let focusRescanTimer = null;
if (browser.windows && browser.windows.onFocusChanged) {
  browser.windows.onFocusChanged.addListener((windowId) => {
    // windowId === -1 means "no window focused" (focus left all TB windows)
    if (windowId === browser.windows.WINDOW_ID_NONE) return;
    if (!hasBadgeAPI) return;
    if (focusRescanTimer) clearTimeout(focusRescanTimer);
    focusRescanTimer = setTimeout(async () => {
      focusRescanTimer = null;
      try {
        const [activeTab] = await browser.tabs.query({ active: true, windowId });
        if (!activeTab) return;
        const msgHeader = await browser.messageDisplay.getDisplayedMessage(activeTab.id);
        if (!msgHeader) return;
        // Drop the cached count for this message so we fetch fresh status
        // (the user may have just marked a lead in V4).
        badgeCache.delete(cacheKey(msgHeader));
        await scanAndBadgeMessage(activeTab, msgHeader);
      } catch (e) { /* not a message tab — ignore */ }
    }, 400);
  });
}

// React to settings changes only — ignore opened-state writes that happen
// on every Mark click (otherwise we'd trigger a full rescan + cache wipe
// every time the user presses the button). Queue changes are additive:
// they refresh the badge count but do NOT bump configGen or invalidate
// the per-message scan cache.
browser.storage.onChanged.addListener(async (changes) => {
  if (QUEUE_KEY in changes) {
    scheduleBadgeRefresh();
  }

  const settingsKeys = [STORAGE_KEYS.API_KEY, STORAGE_KEYS.ENABLED];
  const settingsChanged = settingsKeys.some(k => k in changes);
  if (!settingsChanged) return;

  configGen++;
  invalidateAllCache();
  if (!hasBadgeAPI) return;
  try {
    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) return;
    const msgHeader = await browser.messageDisplay.getDisplayedMessage(activeTab.id);
    if (msgHeader) {
      await scanAndBadgeMessage(activeTab, msgHeader);
    } else {
      await updateBadgeForTab(activeTab.id, 0);
    }
  } catch (e) { /* no active message tab — ignore */ }
  // Enabled/disabled flip must reflect on the queue badge too.
  scheduleBadgeRefresh();
});

// --- Message router ---------------------------------------------------------
browser.runtime.onMessage.addListener((message) => {
  switch (message.method) {
    case 'getConfig':                 return getConfig();
    case 'setConfig':                 return setConfig(message.payload);
    case 'checkEmails':               return checkEmails(message.emails);
    case 'getDisplayedMessageEmails': return getDisplayedMessageEmails(message.tabId);
    case 'getComposeEmails':          return getComposeEmails(message.tabId);
    case 'openInV4':                  return openInV4(message.email, message.headerMessageId);
    case 'getOpened':                 return getOpened(message.headerMessageId).then(o => ({ opened: o }));
    // Called by the popup after it has its own fresh result. We verify that
    // the tab still shows the message the popup computed against, and that
    // the extension is still enabled, so a stale/background popup can't set
    // the icon for the wrong message.
    case 'syncBadge':
      if (typeof message.tabId !== 'number' || typeof message.count !== 'number') {
        return Promise.resolve({ error: 'bad_args' });
      }
      return syncBadgeFromPopup(message.tabId, message.headerMessageId, message.count);
    // Recent-matches queue: read and user-dismiss. The badge updates
    // automatically via storage.onChanged after any mutation.
    case 'getQueue':
      return getQueue().then(queue => ({ queue }));
    // Legacy / internal-style: just remove an entry without marking dismissed.
    // The popup uses 'dismissFromQueue' for user-initiated dismissal so the
    // same row doesn't re-enter after the 5-min badge cache expires.
    case 'removeFromQueue':
      return removeFromQueue({
        headerMessageId: message.headerMessageId,
        email: message.email
      }).then(() => getQueue()).then(queue => ({ queue }));
    case 'dismissFromQueue':
      return markDismissed(message.headerMessageId, message.email)
        .then(() => removeFromQueue({
          headerMessageId: message.headerMessageId,
          email: message.email
        }))
        .then(() => getQueue())
        .then(queue => ({ queue }));
    default:                          return Promise.resolve({ error: 'unknown_method' });
  }
});
