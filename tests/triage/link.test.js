// Tests for src/scripts/triage-link.js. Synthetic fixtures only.
// Wrapped in an IIFE: every test file shares one vm context, so a top-level
// `const` here could collide with another test file.
(function () {
  'use strict';

  const L = TriageLink;
  const T = TriageSchema.TRISTATE;
  const DAY = 86400000;
  const HOUR = 3600000;
  const T0 = Date.UTC(2026, 0, 15, 9, 0, 0);

  const ADA = { name: 'Ada Quill', address: 'ada.quill@example.org' };
  const BRAM = { name: 'Bram Folio', address: 'bram.folio@example.org' };
  const EDITOR = { name: 'Press Editor', address: 'editor@press.example.com' };
  const COLLEAGUE = { name: 'Cleo Margin', address: 'cleo.margin@press.example.com' };

  let seq = 0;
  function make(over) {
    seq++;
    return Object.assign({
      key: 'k' + seq, acct: 'acct1', hmid: '<m' + seq + '@mail.example.org>',
      folderPath: '/INBOX', specialUse: [], date: T0,
      from: ADA, to: [EDITOR.address], cc: [],
      subject: 'Cover proof for The Glass Orchard', subjN: 'cover proof for the glass orchard',
      size: 1200, read: false, flagged: false, dir: 'inbound', sysType: null, auto: null
    }, over);
  }
  function inbound(over) { return make(Object.assign({ dir: 'inbound', from: ADA, to: [EDITOR.address] }, over)); }
  function outbound(over) {
    return make(Object.assign({
      dir: 'outbound', from: EDITOR, to: [ADA.address], folderPath: '/Sent', specialUse: ['sent'], auto: false
    }, over));
  }
  const keys = (list) => list.map((e) => e.key);

  // ---- normalizeHmid ----

  test('link: normalizeHmid strips one pair of angle brackets and lowercases', () => {
    assert.strictEqual(L.normalizeHmid('<ABC.123@Mail.Example.ORG>'), 'abc.123@mail.example.org');
    assert.strictEqual(L.normalizeHmid('abc.123@mail.example.org'), 'abc.123@mail.example.org');
  });

  test('link: normalizeHmid trims whitespace around and inside the brackets', () => {
    assert.strictEqual(L.normalizeHmid('  <id-1@example.org>\r\n'), 'id-1@example.org');
    assert.strictEqual(L.normalizeHmid('< id-1@example.org >'), 'id-1@example.org');
  });

  test('link: normalizeHmid removes only one bracket pair and leaves an unpaired bracket', () => {
    assert.strictEqual(L.normalizeHmid('<<id-2@example.org>>'), '<id-2@example.org>');
    assert.strictEqual(L.normalizeHmid('<id-2@example.org'), '<id-2@example.org');
  });

  test('link: normalizeHmid returns an empty string for non-strings and blanks', () => {
    for (const v of [undefined, null, 42, {}, [], true, '', '   ', '<>']) {
      assert.strictEqual(L.normalizeHmid(v), '');
    }
  });

  // ---- buildIndex ----

  test('link: buildIndex keeps both copies of a duplicated message', () => {
    const a = outbound({ hmid: '<Dup-1@mail.example.org>', folderPath: '/Sent', acct: 'acct1' });
    const b = outbound({ hmid: '<dup-1@MAIL.example.org>', folderPath: '/Archive/2026', acct: 'acct2' });
    const index = L.buildIndex([a, b]);
    assert.ok(index.byHmid instanceof Map);
    eq(keys(index.byHmid.get('dup-1@mail.example.org')), [a.key, b.key]);
    assert.strictEqual(index.byHmid.size, 1);
    assert.strictEqual(index.count, 2);
  });

  test('link: buildIndex skips entries without an hmid and reports count, oldest, newest', () => {
    const a = inbound({ date: T0 + DAY });
    const b = outbound({ date: T0 - DAY });
    const noId = outbound({ hmid: '', date: T0 - 30 * DAY });
    const undated = inbound({ date: undefined });
    const index = L.buildIndex([a, noId, b, undated, null, 'junk']);
    assert.strictEqual(index.count, 3);
    assert.strictEqual(index.oldest, T0 - DAY);
    assert.strictEqual(index.newest, T0 + DAY);
    eq(keys(index.outboundTo.get(ADA.address)), [b.key]);
  });

  test('link: buildIndex of nothing has null oldest and newest', () => {
    const index = L.buildIndex([]);
    eq([index.count, index.oldest, index.newest], [0, null, null]);
    assert.strictEqual(index.byHmid.size, 0);
    assert.strictEqual(index.outboundTo.size, 0);
  });

  test('link: outboundTo is keyed by cc as well as to, lowercased and trimmed', () => {
    const o = outbound({ to: ['  Ada.Quill@Example.ORG '], cc: [BRAM.address] });
    const notOutbound = inbound({ to: [BRAM.address] });
    const index = L.buildIndex([o, notOutbound]);
    eq(keys(index.outboundTo.get(ADA.address)), [o.key]);
    eq(keys(index.outboundTo.get(BRAM.address)), [o.key]);
    assert.strictEqual(index.outboundTo.has(EDITOR.address), false);
  });

  test('link: outboundTo lists are sorted by date ascending whatever the input order', () => {
    const late = outbound({ date: T0 + 5 * DAY });
    const early = outbound({ date: T0 - 5 * DAY });
    const mid = outbound({ date: T0 });
    const input = [late, early, mid];
    const index = L.buildIndex(input);
    eq(keys(index.outboundTo.get(ADA.address)), [early.key, mid.key, late.key]);
    eq(keys(input), [late.key, early.key, mid.key]);
  });

  test('link: an address in both to and cc is listed once', () => {
    const o = outbound({ to: [ADA.address], cc: [ADA.address.toUpperCase()] });
    const index = L.buildIndex([o]);
    eq(keys(index.outboundTo.get(ADA.address)), [o.key]);
  });

  // ---- findExplicitParent ----

  test('link: In-Reply-To wins over References', () => {
    const viaIrt = outbound({ hmid: '<irt-1@mail.example.org>' });
    const viaRef = outbound({ hmid: '<ref-1@mail.example.org>' });
    const index = L.buildIndex([viaIrt, viaRef]);
    const r = L.findExplicitParent({ irt: '<irt-1@mail.example.org>', refs: ['<ref-1@mail.example.org>'] }, index, 'acct1');
    assert.strictEqual(r.entry, viaIrt);
    assert.strictEqual(r.via, 'in_reply_to');
  });

  test('link: References are walked from the last id to the first', () => {
    const oldest = outbound({ hmid: '<thread-a@mail.example.org>', date: T0 - 9 * DAY });
    const newer = outbound({ hmid: '<thread-b@mail.example.org>', date: T0 - 3 * DAY });
    const index = L.buildIndex([oldest, newer]);
    const facts = {
      irt: '<not-indexed@mail.example.org>',
      refs: ['<thread-a@mail.example.org>', '<thread-b@mail.example.org>', '<not-indexed@mail.example.org>']
    };
    const r = L.findExplicitParent(facts, index, 'acct1');
    assert.strictEqual(r.entry, newer);
    assert.strictEqual(r.via, 'references');
  });

  test('link: header ids match regardless of brackets and case', () => {
    const parent = outbound({ hmid: '<Mixed.Case-7@Mail.Example.org>' });
    const index = L.buildIndex([parent]);
    const r = L.findExplicitParent({ irt: 'mixed.case-7@mail.example.ORG', refs: [] }, index, 'acct1');
    assert.strictEqual(r.entry, parent);
  });

  test('link: the copy in the requested account is preferred, else the first copy', () => {
    const first = outbound({ hmid: '<copy-1@mail.example.org>', acct: 'acct1' });
    const second = outbound({ hmid: '<copy-1@mail.example.org>', acct: 'acct2' });
    const index = L.buildIndex([first, second]);
    const facts = { irt: '<copy-1@mail.example.org>', refs: [] };
    assert.strictEqual(L.findExplicitParent(facts, index, 'acct2').entry, second);
    assert.strictEqual(L.findExplicitParent(facts, index, 'acct9').entry, first);
    assert.strictEqual(L.findExplicitParent(facts, index).entry, first);
  });

  test('link: an outbound parent is "editor" unless it is known to be automated', () => {
    const human = outbound({ hmid: '<role-h@mail.example.org>', auto: false });
    const unknown = outbound({ hmid: '<role-u@mail.example.org>', auto: null });
    const robot = outbound({ hmid: '<role-a@mail.example.org>', auto: true });
    const index = L.buildIndex([human, unknown, robot]);
    assert.strictEqual(L.findExplicitParent({ irt: human.hmid }, index, 'acct1').role, 'editor');
    assert.strictEqual(L.findExplicitParent({ irt: unknown.hmid }, index, 'acct1').role, 'editor');
    assert.strictEqual(L.findExplicitParent({ irt: robot.hmid }, index, 'acct1').role, 'editor_automated');
  });

  test('link: a parent written by a colleague, the author or a system is "other"', () => {
    const colleague = make({ hmid: '<other-c@mail.example.org>', dir: 'internal', from: COLLEAGUE, to: [ADA.address], auto: false });
    const authorOwn = inbound({ hmid: '<other-a@mail.example.org>', date: T0 - DAY });
    const system = make({ hmid: '<other-s@mail.example.org>', dir: 'system', sysType: 'publication', auto: true });
    const noDir = make({ hmid: '<other-n@mail.example.org>', dir: undefined });
    const index = L.buildIndex([colleague, authorOwn, system, noDir]);
    for (const p of [colleague, authorOwn, system, noDir]) {
      const r = L.findExplicitParent({ irt: p.hmid, refs: [] }, index, 'acct1');
      assert.strictEqual(r.entry, p);
      assert.strictEqual(r.role, 'other');
    }
  });

  test('link: no fallback — null when no header resolves even though a same-subject message exists', () => {
    const sameSubject = outbound({ date: T0 - DAY });
    const reply = inbound({ date: T0 });
    const index = L.buildIndex([sameSubject, reply]);
    assert.strictEqual(L.findSuggestions(reply, index).length, 1);
    assert.strictEqual(L.findExplicitParent({ irt: '<gone@mail.example.org>', refs: ['<also-gone@mail.example.org>'] }, index, 'acct1'), null);
    assert.strictEqual(L.findExplicitParent({ irt: null, refs: [] }, index, 'acct1'), null);
  });

  // ---- findSuggestions ----

  test('link: suggestions require an equal normalised subject', () => {
    const same = outbound({ date: T0 - DAY });
    const different = outbound({ date: T0 - 2 * DAY, subjN: 'royalty statement' });
    const reply = inbound({ date: T0 });
    eq(keys(L.findSuggestions(reply, L.buildIndex([same, different, reply]))), [same.key]);
  });

  test('link: suggestions only come from outbound mail to this correspondent', () => {
    const toOther = outbound({ date: T0 - DAY, to: [BRAM.address] });
    const authorEarlier = inbound({ date: T0 - 2 * DAY });
    const viaCc = outbound({ date: T0 - 3 * DAY, to: [BRAM.address], cc: [ADA.address] });
    const reply = inbound({ date: T0 });
    eq(keys(L.findSuggestions(reply, L.buildIndex([toOther, authorEarlier, viaCc, reply]))), [viaCc.key]);
  });

  test('link: suggestions respect the 90-day default window and opts.days', () => {
    const edge = outbound({ date: T0 - 90 * DAY });
    const tooOld = outbound({ date: T0 - 90 * DAY - 1 });
    const recent = outbound({ date: T0 - 5 * DAY });
    const reply = inbound({ date: T0 });
    const index = L.buildIndex([edge, tooOld, recent, reply]);
    eq(keys(L.findSuggestions(reply, index)), [recent.key, edge.key]);
    eq(keys(L.findSuggestions(reply, index, { days: 10 })), [recent.key]);
    eq(keys(L.findSuggestions(reply, index, { days: 'ten' })), [recent.key, edge.key]);
  });

  test('link: suggestions are strictly before the message', () => {
    const before = outbound({ date: T0 - 1 });
    const sameInstant = outbound({ date: T0 });
    const after = outbound({ date: T0 + HOUR });
    const reply = inbound({ date: T0 });
    eq(keys(L.findSuggestions(reply, L.buildIndex([after, sameInstant, before, reply]))), [before.key]);
  });

  test('link: suggestions are newest first and capped at 3 by default, or opts.max', () => {
    const sent = [1, 2, 3, 4, 5].map((n) => outbound({ date: T0 - n * DAY }));
    const reply = inbound({ date: T0 });
    const index = L.buildIndex([sent[3], sent[0], sent[4], sent[2], sent[1], reply]);
    eq(keys(L.findSuggestions(reply, index)), [sent[0].key, sent[1].key, sent[2].key]);
    eq(keys(L.findSuggestions(reply, index, { max: 1 })), [sent[0].key]);
    eq(keys(L.findSuggestions(reply, index, { max: 5 })), keys(sent));
    eq(L.findSuggestions(reply, index, { max: 0 }), []);
  });

  test('link: suggestions reject empty and too-short subjects', () => {
    const o1 = outbound({ date: T0 - DAY, subjN: 'fwd' });
    const o2 = outbound({ date: T0 - DAY, subjN: '' });
    const o3 = outbound({ date: T0 - DAY, subjN: 'isbn' });
    const index = L.buildIndex([o1, o2, o3]);
    eq(L.findSuggestions(inbound({ subjN: 'fwd' }), index), []);
    eq(L.findSuggestions(inbound({ subjN: '' }), index), []);
    eq(L.findSuggestions(inbound({ subjN: undefined }), index), []);
    eq(keys(L.findSuggestions(inbound({ subjN: 'isbn' }), index)), [o3.key]);
  });

  test('link: suggestions leave out opts.excludeHmid, compared normalised', () => {
    const parent = outbound({ hmid: '<Parent-1@mail.example.org>', date: T0 - DAY });
    const sibling = outbound({ date: T0 - 2 * DAY });
    const reply = inbound({ date: T0 });
    const index = L.buildIndex([parent, sibling, reply]);
    eq(keys(L.findSuggestions(reply, index)), [parent.key, sibling.key]);
    eq(keys(L.findSuggestions(reply, index, { excludeHmid: 'parent-1@MAIL.example.org' })), [sibling.key]);
  });

  test('link: two copies of one sent message take a single suggestion slot', () => {
    const copyElsewhere = outbound({ hmid: '<twice-1@mail.example.org>', acct: 'acct2', date: T0 - DAY, folderPath: '/Archive' });
    const copyHere = outbound({ hmid: '<twice-1@mail.example.org>', acct: 'acct1', date: T0 - DAY });
    const older = [2, 3, 4].map((n) => outbound({ date: T0 - n * DAY }));
    const reply = inbound({ date: T0, acct: 'acct1' });
    const index = L.buildIndex([copyElsewhere, copyHere].concat(older, [reply]));
    eq(keys(L.findSuggestions(reply, index)), [copyHere.key, older[0].key, older[1].key]);
  });

  test('link: suggestions are empty without a sender address or a date', () => {
    const o = outbound({ date: T0 - DAY });
    const index = L.buildIndex([o]);
    eq(L.findSuggestions(inbound({ from: { name: 'No Address' } }), index), []);
    eq(L.findSuggestions(inbound({ from: null }), index), []);
    eq(L.findSuggestions(inbound({ date: null }), index), []);
    eq(L.findSuggestions(inbound({ date: NaN }), index), []);
  });

  // ---- laterOutbound ----

  test('link: laterOutbound prefers a human reply over unknown over automated', () => {
    const reply = inbound({ date: T0 });
    const robot = outbound({ date: T0 + HOUR, auto: true });
    const unknown = outbound({ date: T0 + 2 * HOUR, auto: null });
    const human = outbound({ date: T0 + 3 * HOUR, auto: false });
    eq(L.laterOutbound(reply, L.buildIndex([reply, robot, unknown, human])), { state: T.FOUND, hmid: human.hmid, auto: false });
    eq(L.laterOutbound(reply, L.buildIndex([reply, robot, unknown])), { state: T.FOUND, hmid: unknown.hmid, auto: null });
    eq(L.laterOutbound(reply, L.buildIndex([reply, robot])), { state: T.FOUND, hmid: robot.hmid, auto: true });
  });

  test('link: laterOutbound takes the earliest message within the winning class', () => {
    const reply = inbound({ date: T0 });
    const h2 = outbound({ date: T0 + 4 * DAY, auto: false });
    const h1 = outbound({ date: T0 + 2 * DAY, auto: false });
    const a1 = outbound({ date: T0 + HOUR, auto: true });
    const a2 = outbound({ date: T0 + 2 * HOUR, auto: true });
    assert.strictEqual(L.laterOutbound(reply, L.buildIndex([h2, a2, h1, a1, reply])).hmid, h1.hmid);
    assert.strictEqual(L.laterOutbound(reply, L.buildIndex([a2, a1, reply])).hmid, a1.hmid);
  });

  test('link: laterOutbound ignores outbound mail to a different correspondent', () => {
    const reply = inbound({ date: T0 });
    const toBram = outbound({ date: T0 + HOUR, to: [BRAM.address] });
    const r = L.laterOutbound(reply, L.buildIndex([reply, toBram]), { sentLikeScanned: true });
    eq(r, { state: T.NOT_FOUND, hmid: null, auto: null });
  });

  test('link: laterOutbound ignores outbound mail dated before or at the inbound message', () => {
    const reply = inbound({ date: T0 });
    const before = outbound({ date: T0 - HOUR });
    const sameInstant = outbound({ date: T0 });
    const undated = outbound({ date: undefined });
    const index = L.buildIndex([before, sameInstant, undated, reply]);
    eq(L.laterOutbound(reply, index, { sentLikeScanned: true }), { state: T.NOT_FOUND, hmid: null, auto: null });
    const after = outbound({ date: T0 + 1 });
    assert.strictEqual(L.laterOutbound(reply, L.buildIndex([before, sameInstant, undated, after, reply])).hmid, after.hmid);
  });

  test('link: laterOutbound counts a later message that only cc\'d the correspondent', () => {
    const reply = inbound({ date: T0, from: { name: 'Ada Quill', address: ' ADA.Quill@example.org ' } });
    const viaCc = outbound({ date: T0 + HOUR, to: [BRAM.address], cc: [ADA.address] });
    eq(L.laterOutbound(reply, L.buildIndex([reply, viaCc])), { state: T.FOUND, hmid: viaCc.hmid, auto: false });
  });

  test('link: absence is NOT_FOUND only when the sent-like folders were scanned', () => {
    const reply = inbound({ date: T0 });
    const index = L.buildIndex([reply]);
    assert.strictEqual(L.laterOutbound(reply, index, { sentLikeScanned: true }).state, T.NOT_FOUND);
    for (const scope of [undefined, null, {}, { sentLikeScanned: false }, { sentLikeScanned: 'yes' }, { sentLikeScanned: 1 }]) {
      eq(L.laterOutbound(reply, index, scope), { state: T.UNKNOWN, hmid: null, auto: null });
    }
  });

  test('link: a located later message is FOUND whatever the scope says', () => {
    const reply = inbound({ date: T0 });
    const later = outbound({ date: T0 + DAY });
    const index = L.buildIndex([reply, later]);
    assert.strictEqual(L.laterOutbound(reply, index).state, T.FOUND);
    assert.strictEqual(L.laterOutbound(reply, index, { sentLikeScanned: false }).state, T.FOUND);
  });

  test('link: laterOutbound is UNKNOWN without a sender address or a date, even when scanned', () => {
    const later = outbound({ date: T0 + DAY });
    const index = L.buildIndex([later]);
    const scanned = { sentLikeScanned: true };
    const unknown = { state: T.UNKNOWN, hmid: null, auto: null };
    eq(L.laterOutbound(inbound({ from: {} }), index, scanned), unknown);
    eq(L.laterOutbound(inbound({ from: undefined }), index, scanned), unknown);
    eq(L.laterOutbound(inbound({ date: undefined }), index, scanned), unknown);
    eq(L.laterOutbound(inbound({ date: '2026-01-15' }), index, scanned), unknown);
  });

  // ---- totality ----

  test('link: every function tolerates missing and garbage input', () => {
    const unknown = { state: T.UNKNOWN, hmid: null, auto: null };
    for (const junk of [undefined, null, 0, 'text', {}, [], { byHmid: 1, outboundTo: 'x' }]) {
      const index = L.buildIndex(junk);
      eq([index.count, index.oldest, index.newest], [0, null, null]);
      assert.strictEqual(L.findExplicitParent(junk, junk, junk), null);
      assert.strictEqual(L.findExplicitParent({ irt: '<x@example.org>', refs: ['<y@example.org>'] }, junk, 'acct1'), null);
      eq(L.findSuggestions(junk, junk, junk), []);
      eq(L.findSuggestions(inbound({}), junk, junk), []);
      eq(L.laterOutbound(junk, junk, junk), unknown);
      eq(L.laterOutbound(inbound({}), junk, junk), unknown);
    }
  });

  test('link: malformed entries and header lists do not throw', () => {
    const odd = [
      { hmid: '<odd-1@example.org>', dir: 'outbound', to: 'not-an-array', cc: null, date: 'yesterday' },
      { hmid: '<odd-2@example.org>', dir: 'outbound', to: [null, 7, {}, ''], cc: [ADA.address], date: T0 + HOUR, auto: 'maybe' },
      { hmid: 12345, dir: 'outbound', to: [ADA.address] },
      { hmid: '<odd-3@example.org>', from: 'ada.quill@example.org', date: Infinity }
    ];
    const index = L.buildIndex(odd);
    assert.strictEqual(index.count, 3);
    eq([index.oldest, index.newest], [T0 + HOUR, T0 + HOUR]);
    eq(L.laterOutbound(inbound({ date: T0 }), index), { state: T.FOUND, hmid: '<odd-2@example.org>', auto: null });
    assert.strictEqual(L.findExplicitParent({ irt: 99, refs: [null, {}, '<odd-1@example.org>', 5] }, index, 'acct1').entry, odd[0]);
    assert.strictEqual(L.findExplicitParent({ irt: '<odd-1@example.org>', refs: 'not-a-list' }, index).via, 'in_reply_to');
    assert.strictEqual(L.findExplicitParent({ refs: 'not-a-list' }, index), null);
  });

  test('link: the module is frozen and exports exactly the contract', () => {
    assert.ok(Object.isFrozen(L));
    eq(Object.keys(L).sort(), ['buildIndex', 'earlierOutbound', 'findExplicitParent', 'findSuggestions', 'laterOutbound', 'laterOutboundCandidates', 'normalizeHmid']);
  });

  // ---- performance ----

  test('link: 10,000-entry index plus 1,000 laterOutbound lookups run in under a second', () => {
    const N = 10000;
    const PEOPLE = 199;   // odd, so each correspondent alternates inbound / outbound
    const autos = [false, null, true];
    const entries = [];
    for (let i = 0; i < N; i++) {
      const address = 'author' + (i % PEOPLE) + '@example.org';
      const isOut = i % 2 === 1;
      entries.push({
        key: 'p' + i, acct: 'acct1', hmid: '<perf-' + i + '@mail.example.org>',
        date: T0 + ((i * 7919) % N) * 60000,   // a permutation: every date is unique
        from: isOut ? EDITOR : { name: 'Author ' + (i % PEOPLE), address },
        to: isOut ? [address] : [EDITOR.address], cc: [],
        subjN: 'synthetic thread ' + (i % 40), dir: isOut ? 'outbound' : 'inbound',
        auto: isOut ? autos[i % 3] : null
      });
    }
    const probes = entries.filter((e) => e.dir === 'inbound').slice(0, 1000);
    assert.strictEqual(probes.length, 1000);

    const started = Date.now();
    const index = L.buildIndex(entries);
    const results = probes.map((e) => L.laterOutbound(e, index, { sentLikeScanned: true }));
    const elapsed = Date.now() - started;

    assert.strictEqual(index.count, N);
    assert.ok(elapsed < 1000, 'took ' + elapsed + ' ms');
    assert.ok(results.some((r) => r.state === T.FOUND));

    // Cross-check a sample against a brute-force scan.
    const rank = (e) => (e.auto === false ? 0 : e.auto === true ? 2 : 1);
    for (let i = 0; i < probes.length; i += 10) {
      const p = probes[i];
      const later = entries
        .filter((e) => e.dir === 'outbound' && e.to[0] === p.from.address && e.date > p.date)
        .sort((a, b) => rank(a) - rank(b) || a.date - b.date);
      const expected = later.length
        ? { state: T.FOUND, hmid: later[0].hmid, auto: later[0].auto }
        : { state: T.NOT_FOUND, hmid: null, auto: null };
      eq(results[i], expected);
    }
  });
})();
