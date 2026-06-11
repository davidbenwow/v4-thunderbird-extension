#!/usr/bin/env node
// run-tests.js — zero-dependency test suite for the V4 Contacts Checker.
//
// Loads internal-domains.js and background.js into a Node `vm` context with a
// stubbed `browser` API, then exercises the pure decision/parsing functions
// that carry the extension's correctness: the API adapter, the suppression
// matrix, manuscript-signal detection, and email/URL extraction.
//
// Run directly:        node tests/run-tests.js
// Run automatically:   scripts/build.sh refuses to build if this fails.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// --- Stub browser API --------------------------------------------------------
// Just enough surface for background.js top-level code (startup prunes, the
// v1.21 cleanup IIFE, listener registration). messageDisplayAction is left
// undefined so hasBadgeAPI is false and all badge paths self-disable.
const noop = () => {};
const stubBrowser = {
  storage: {
    local: {
      get: async () => ({}),
      set: async () => {},
      remove: async () => {}
    },
    onChanged: { addListener: noop }
  },
  tabs: {
    onActivated: { addListener: noop },
    onRemoved: { addListener: noop },
    query: async () => []
  },
  runtime: { onMessage: { addListener: noop } }
};

const ctx = vm.createContext({
  browser: stubBrowser,
  console: { ...console, debug: noop, warn: noop },  // silence expected noise
  setTimeout, clearTimeout,
  fetch: async () => { throw new Error('network disabled in tests'); }
});

function loadIntoContext(relPath) {
  const file = path.join(__dirname, '..', relPath);
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: relPath });
}

loadIntoContext('src/scripts/internal-domains.js');
loadIntoContext('src/scripts/background.js');

// Top-level function declarations become globals of the vm context; they
// close over their own script scope, so the const tables they use still work.
const {
  parseCheckResponse, normalizeLeadStatus, decideActionable,
  hasManuscriptExtension, extractTransferLinkHost, extractAnchorURLs,
  collectBodyText, stripHtmlTags, extractEmailsFromText,
  extractEmailsFromVCard, isInternalEmail
} = ctx;

// --- Tiny runner --------------------------------------------------------------
let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { failures.push({ name, err }); }
}
const S = (o = {}) => Object.assign(
  { opened: {}, dismissed: {}, marked: {}, terminal: {}, pending: {} }, o);
// vm-created objects have a different realm's Object prototype, which
// assert.deepStrictEqual rejects — JSON round-trip to plain host objects.
const plain = (v) => JSON.parse(JSON.stringify(v));
const eq = (actual, expected, msg) => assert.deepStrictEqual(plain(actual), expected, msg);

// === API adapter ==============================================================

test('adapter: legacy numerics map to legacy mode', () => {
  const p = parseCheckResponse({ 'a@x.com': 1, 'b@x.com': 2, 'c@x.com': 3 }, false);
  eq(p['a@x.com'], { exists: false, status: null, legacyCode: 3 });
  eq(p['b@x.com'], { exists: true,  status: null, legacyCode: 2 });
  eq(p['c@x.com'], { exists: true,  status: null, legacyCode: 3 });
});

test('adapter: real wire shape {status, response_status}', () => {
  const p = parseCheckResponse({
    'a@x.com': { status: 2, response_status: 'manuscript_received' },
    'b@x.com': { status: 3, response_status: 'no_response' },
    'c@x.com': { status: 1 },
    'd@x.com': { status: 4 }
  }, false);
  eq(p['a@x.com'], { exists: true, status: 'manuscript_received', legacyCode: 2 });
  eq(p['b@x.com'], { exists: true, status: 'no_response', legacyCode: 3 });
  assert.strictEqual(p['c@x.com'].exists, false);  // NOT_IN_USE
  assert.strictEqual(p['d@x.com'].exists, false);  // DOMAIN_BLOCKED
});

test('adapter: all six canonical statuses normalize', () => {
  for (const s of ['no_response', 'response', 'manuscript_received', 'rejected', 'locked', 'invalid_email']) {
    assert.strictEqual(normalizeLeadStatus(s), s, s);
  }
});

test('adapter: tolerant aliases', () => {
  assert.strictEqual(normalizeLeadStatus('no response'), 'no_response');
  assert.strictEqual(normalizeLeadStatus('Manuscript Received'), 'manuscript_received');
  assert.strictEqual(normalizeLeadStatus('REJECTED'), 'rejected');
  assert.strictEqual(normalizeLeadStatus('invalid email'), 'invalid_email');
});

test('adapter: unknown status degrades to legacy (never guess)', () => {
  assert.strictEqual(normalizeLeadStatus('brand_new_status'), null);
  assert.strictEqual(normalizeLeadStatus(undefined), null);
  const p = parseCheckResponse({ 'a@x.com': { status: 2, response_status: 'weird' } }, false);
  eq(p['a@x.com'], { exists: true, status: null, legacyCode: 2 });
});

test('adapter: missing response_status on existing lead → legacy, no exists loss', () => {
  const p = parseCheckResponse({ 'a@x.com': { status: 2 } }, false);
  eq(p['a@x.com'], { exists: true, status: null, legacyCode: 2 });
});

test('adapter: ambiguous strings are NOT treated as not-found', () => {
  const p = parseCheckResponse({ 'a@x.com': 'unknown', 'b@x.com': 'none' }, false);
  assert.strictEqual(p['a@x.com'].exists, true);
  assert.strictEqual(p['b@x.com'].exists, true);
});

test('adapter: kill-switch forces legacy even on status payloads', () => {
  const p = parseCheckResponse({ 'a@x.com': { status: 2, response_status: 'no_response' } }, true);
  eq(p['a@x.com'], { exists: true, status: null, legacyCode: 2 });
});

test('adapter: email keys normalized to lowercase', () => {
  const p = parseCheckResponse({ 'A@X.COM': 2 }, false);
  assert.ok(p['a@x.com']);
});

// === Suppression matrix =======================================================

test('matrix legacy: plain lead is actionable', () => {
  assert.strictEqual(decideActionable('a', null, false, S()), true);
});

test('matrix legacy: marked suppresses unless manuscript', () => {
  assert.strictEqual(decideActionable('a', null, false, S({ marked: { a: {} } })), false);
  assert.strictEqual(decideActionable('a', null, true,  S({ marked: { a: {} } })), true);
});

test('matrix legacy: terminal always suppresses', () => {
  assert.strictEqual(decideActionable('a', null, true, S({ terminal: { a: {} } })), false);
});

test('matrix legacy: opened/dismissed suppress per message', () => {
  assert.strictEqual(decideActionable('a', null, false, S({ opened: { a: 1 } })), false);
  assert.strictEqual(decideActionable('a', null, false, S({ dismissed: { a: 1 } })), false);
});

test('matrix status: no_response is the call to action', () => {
  assert.strictEqual(decideActionable('a', 'no_response', false, S()), true);
});

test('matrix status: response only actionable with manuscript', () => {
  assert.strictEqual(decideActionable('a', 'response', false, S()), false);
  assert.strictEqual(decideActionable('a', 'response', true,  S()), true);
});

test('matrix status: terminal/locked/invalid never actionable, even with manuscript', () => {
  for (const st of ['manuscript_received', 'rejected', 'locked', 'invalid_email']) {
    assert.strictEqual(decideActionable('a', st, true, S()), false, st);
  }
});

test('matrix status: live status is the truth — local guesses do NOT suppress', () => {
  // The v1.21.4 regression fix: a Mark click must not hide a still-unchanged lead.
  assert.strictEqual(decideActionable('a', 'no_response', false, S({ opened: { a: 1 } })), true);
  assert.strictEqual(decideActionable('a', 'no_response', false, S({ marked: { a: {} } })), true);
  assert.strictEqual(decideActionable('a', 'no_response', false, S({ terminal: { a: {} } })), true);
  assert.strictEqual(decideActionable('a', 'no_response', false, S({ pending: { a: {} } })), true);
  assert.strictEqual(decideActionable('a', 'no_response', false, S({ dismissed: { a: 1 } })), true);
});

// === Manuscript signal ========================================================

test('manuscript: docx/doc/pdf extensions, case-insensitive', () => {
  assert.strictEqual(hasManuscriptExtension('book.docx'), true);
  assert.strictEqual(hasManuscriptExtension('Book.DOC'), true);
  assert.strictEqual(hasManuscriptExtension('final.PDF'), true);
  assert.strictEqual(hasManuscriptExtension('image.png'), false);
  assert.strictEqual(hasManuscriptExtension(''), false);
  assert.strictEqual(hasManuscriptExtension(null), false);
});

test('manuscript: transfer hosts match exactly and by subdomain', () => {
  assert.strictEqual(extractTransferLinkHost('see https://wetransfer.com/dl/abc'), 'wetransfer.com');
  assert.strictEqual(extractTransferLinkHost('https://share.dropbox.com/x'), 'dropbox.com');
  assert.strictEqual(extractTransferLinkHost('https://drive.google.com/file/d/1'), 'drive.google.com');
});

test('manuscript: suffix-spoof hosts do NOT match', () => {
  assert.strictEqual(extractTransferLinkHost('https://evil-dropbox.com.attacker.io/x'), null);
  assert.strictEqual(extractTransferLinkHost('https://notwetransfer.com/x'), null);
});

test('manuscript: plain text without transfer links yields null', () => {
  assert.strictEqual(extractTransferLinkHost('hello, see https://example.com/a'), null);
  assert.strictEqual(extractTransferLinkHost(''), null);
});

test('manuscript: href URLs survive HTML stripping via extractAnchorURLs', () => {
  const html = '<p>Hi</p><a href="https://wetransfer.com/downloads/x">Download</a>';
  assert.ok(extractAnchorURLs(html).includes('https://wetransfer.com/downloads/x'));
  const body = collectBodyText({ contentType: 'text/html', body: html });
  assert.strictEqual(extractTransferLinkHost(body), 'wetransfer.com');
});

// === MIME / extraction ========================================================

test('body: attachment and non-body parts are skipped', () => {
  const tree = {
    contentType: 'multipart/mixed',
    parts: [
      { contentType: 'text/plain', body: 'contact me at lead@example.com' },
      { contentType: 'text/plain', body: 'attached@example.com', name: 'file.txt' },
      { contentType: 'text/calendar', body: 'attendee@example.com' }
    ]
  };
  const text = collectBodyText(tree);
  assert.ok(text.includes('lead@example.com'));
  assert.ok(!text.includes('attached@example.com'));
  assert.ok(!text.includes('attendee@example.com'));
});

test('emails: extraction lowercases and handles long TLDs', () => {
  eq(extractEmailsFromText('Reach Me@Example.COM today'), ['me@example.com']);
  eq(extractEmailsFromText('a@books.international'), ['a@books.international']);
  eq(extractEmailsFromText(''), []);
});

test('emails: vCard extraction with folding and group prefixes', () => {
  const vcard = 'BEGIN:VCARD\r\nEMAIL;TYPE=WORK:a@x.com\r\nitem1.EMAIL:b@y.com\r\nEMAIL:c@\r\n zfold.com\r\nEND:VCARD';
  const out = extractEmailsFromVCard(vcard);
  assert.ok(out.includes('a@x.com'));
  assert.ok(out.includes('b@y.com'));
  assert.ok(out.includes('c@zfold.com'));  // folded line
});

test('html: stripHtmlTags separates adjacent text', () => {
  assert.strictEqual(stripHtmlTags('<b>a</b><i>b</i>').trim(), 'a b');
});

// === Internal domains =========================================================

test('internal: exact and subdomain matches are filtered', () => {
  assert.strictEqual(isInternalEmail('someone@omniscriptum.com'), true);
  assert.strictEqual(isInternalEmail('x@mail.omniscriptum.com'), true);
  assert.strictEqual(isInternalEmail('a@lap-publishing.com'), true);
});

test('internal: lookalike domains are NOT filtered', () => {
  assert.strictEqual(isInternalEmail('a@evilomniscriptum.com'), false);
  assert.strictEqual(isInternalEmail('lead@gmail.com'), false);
  assert.strictEqual(isInternalEmail(''), false);
  assert.strictEqual(isInternalEmail(null), false);
});

// --- Report -------------------------------------------------------------------
if (failures.length) {
  console.error(`\n✗ ${failures.length} test(s) FAILED (${passed} passed):\n`);
  for (const { name, err } of failures) {
    console.error(`  ✗ ${name}\n    ${err.message.split('\n')[0]}`);
  }
  process.exit(1);
}
console.log(`✓ all ${passed} tests passed`);
