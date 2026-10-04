#!/usr/bin/env node
// Test runner for the Today triage modules. Separate from run-tests.js on
// purpose: the shipped popup/background tests stay exactly as they are.
//
//   node tests/run-triage-tests.js
//
// Loads the real pure modules into one vm context — deliberately WITHOUT a
// `browser` global, so any module that touches a WebExtension API at load
// time fails here — then runs every tests/triage/*.test.js inside that context.
// Test files get: test(name, fn) (fn may be async), assert, eq(actual, expected).
// Fixtures must be synthetic: this repository is public.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const PURE_MODULES = [
  'src/scripts/triage-schema.js',
  'src/scripts/triage-text.js',
  'src/scripts/triage-rules.js',
  'src/scripts/triage-link.js',
  'src/scripts/triage-questions.js',
  'src/scripts/triage-state.js',
  'src/scripts/triage-throttle.js'
];

// Take every browser API through injected dependencies, so they load here too —
// but they are allowed to be handed a `browser` at runtime, unlike the pure ones.
const INJECTED_MODULES = [
  'src/scripts/triage-store.js',
  'src/scripts/triage-scan.js'
];

const tests = [];
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

const ctx = vm.createContext({
  console: { ...console, debug() {}, warn() {} },
  setTimeout, clearTimeout,
  assert,
  test(name, fn) { tests.push({ name, fn }); },
  backgroundStack,
  // A test that checks what is packaged needs to read the manifest.
  readManifest: () => JSON.parse(fs.readFileSync(path.join(ROOT, 'src/manifest.json'), 'utf8')),
  // vm objects have a different Object.prototype; round-trip before comparing.
  eq(actual, expected, msg) { assert.deepStrictEqual(plain(actual), plain(expected), msg); }
});

// A brand-new context with the add-on's REAL background script list from the
// manifest, in order — what Thunderbird's background page does at startup.
function backgroundStack(browserStub) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/manifest.json'), 'utf8'));
  const errors = [];
  const c = vm.createContext({
    browser: browserStub, console: { ...console, debug() {}, warn() {}, error(...a) { errors.push(a.map(String).join(' ')); } },
    // The background page arms timers of minutes (its "ask again later" schedule).
    // They must not keep the test process alive; short ones stay ordinary so an
    // awaited backoff still holds the event loop.
    setTimeout: (fn, ms, ...rest) => { const t = setTimeout(fn, ms, ...rest); if (ms > 10000 && t.unref) t.unref(); return t; },
    clearTimeout, AbortController, fetch: async () => { throw new Error('network disabled in tests'); }
  });
  for (const rel of manifest.background.scripts) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', rel), 'utf8'), c, { filename: rel });
  }
  return { context: c, errors, scripts: manifest.background.scripts, manifest };
}

function load(rel) {
  const file = path.join(ROOT, rel);
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: rel });
}

let loaded = 0;
for (const rel of PURE_MODULES) {
  if (!fs.existsSync(path.join(ROOT, rel))) continue;   // modules land incrementally
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  tests.push({
    name: `${rel} is pure (no browser.* reference)`,
    fn() { assert.ok(!/\bbrowser\s*\./.test(src), 'pure modules must not touch browser APIs'); }
  });
  load(rel);
  loaded++;
}

for (const rel of INJECTED_MODULES) {
  if (!fs.existsSync(path.join(ROOT, rel))) continue;
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  tests.push({
    name: `${rel} reaches the browser only through injected deps`,
    fn() { assert.ok(!/\bbrowser\s*\./.test(src), 'use deps.api / the storage argument, not the global'); }
  });
  load(rel);
  loaded++;
}

const fakeDir = path.join(__dirname, 'fakes');
if (fs.existsSync(fakeDir)) for (const f of fs.readdirSync(fakeDir).filter((x) => x.endsWith('.js')).sort()) load(path.join('tests/fakes', f));

// Escapes like \\u202E must stay escapes in source: a raw bidi or control character
// in a file is invisible in review and turns the file into "data" for tools.
{
  const RAW = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2069\\uFEFF]');
  const dirs = ['src/scripts', 'tests/triage', 'tests/fakes'];
  for (const d of dirs) for (const f of fs.readdirSync(path.join(ROOT, d))) {
    if (!/^triage-|\.test\.js$|^fake-/.test(f)) continue;
    const rel = path.join(d, f);
    tests.push({ name: `${rel} contains no raw control or bidi characters`, fn() {
      assert.ok(!RAW.test(fs.readFileSync(path.join(ROOT, rel), 'utf8')), 'write them as \\uXXXX escapes');
    } });
  }
}

const testDir = path.join(__dirname, 'triage');
const files = fs.existsSync(testDir)
  ? fs.readdirSync(testDir).filter((f) => f.endsWith('.test.js')).sort()
  : [];
for (const f of files) load(path.join('tests/triage', f));

(async () => {
  const failures = [];
  for (const t of tests) {
    try { await t.fn(); } catch (e) { failures.push({ name: t.name, e }); }
  }
  if (failures.length) {
    for (const f of failures) console.error(`✗ ${f.name}\n    ${(f.e && f.e.message) || f.e}`);
    console.error(`\n${failures.length} of ${tests.length} triage tests failed`);
    process.exit(1);
  }
  console.log(`✓ all ${tests.length} triage tests passed (${loaded} modules, ${files.length} test files)`);
})();
