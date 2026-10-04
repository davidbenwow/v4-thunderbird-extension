(function () {
  const DAY = 86400000;
  function make(startMs) {
    let t = startMs || Date.UTC(2026, 8, 21);
    const storage = FakeMailbox.create({ accounts: [] }).storage();
    const store = TriageStore.create(storage, () => t);
    return { storage, store, tick(ms) { t += ms; } };
  }

  test('store: defaults — all folders, classification on, live grouping; nothing runs until Today itself is on', async () => {
    const { store } = make();
    const c = await store.getConfig();
    eq([c.enabled, c.setupDone, c.folderMode, c.modelOff, c.shadow], [false, false, 'all', false, false]);
    eq(store.mayCallModel(c), false);
  });

  test('store: the model may be called only while Today is on and the editor has not switched classification off', async () => {
    const { store } = make();
    eq(store.mayCallModel(await store.setConfig({ enabled: true })), true);
    eq(store.mayCallModel(await store.setConfig({ modelOff: true })), false);
    eq(store.mayCallModel(await store.setConfig({ modelOff: false, enabled: false })), false);
    for (const junk of [null, undefined, {}, { enabled: 'yes' }, { enabled: true, modelOff: true }]) eq(store.mayCallModel(junk), false);
  });

  test('store: settings left by the test builds that kept a model key on the computer are dropped on read', async () => {
    const { store, storage } = make();
    await storage.set({ [TriageStore.KEYS.config]: { enabled: true, backend: 'jev-direct', consentAt: 123, shadow: true } });
    const c = await store.getConfig();
    eq(['backend' in c, 'consentAt' in c, c.shadow, c.modelOff], [false, false, true, false]);
  });

  test('store: user changes are recorded and a bulk change is one undo step', async () => {
    const { store } = make();
    await store.applyUserChanges([{ key: 'a|1', patch: { state: 'done' } }, { key: 'a|2', patch: { state: 'done' } }], 'Done (2)');
    eq(Object.keys(await store.getUserStates()).sort(), ['a|1', 'a|2']);
    eq(await store.undoLast(), { label: 'Done (2)', restored: 2 });
    eq(await store.getUserStates(), {});
    eq(await store.undoLast(), null);
  });

  test('store: undo restores the previous value, not just deletes', async () => {
    const { store } = make();
    await store.applyUserChanges([{ key: 'a|1', patch: { priorityOverride: 3 } }], 'Priority');
    await store.applyUserChanges([{ key: 'a|1', patch: { state: 'snoozed', until: 999 } }], 'Snooze');
    await store.undoLast();
    const s = (await store.getUserStates())['a|1'];
    eq([s.priorityOverride, s.state], [3, undefined]);
  });

  test('store: null removes a field, unknown fields are ignored, an emptied entry disappears', async () => {
    const { store } = make();
    await store.applyUserChanges([{ key: 'a|1', patch: { state: 'done', evil: 'x' } }], 'x');
    eq('evil' in (await store.getUserStates())['a|1'], false);
    await store.applyUserChanges([{ key: 'a|1', patch: { state: null } }], 'Reopen');
    eq(await store.getUserStates(), {});
  });

  test('store: quick successive changes do not overwrite each other', async () => {
    const { store } = make();
    await Promise.all(Array.from({ length: 12 }, (_, i) => store.applyUserChanges([{ key: 'a|' + i, patch: { state: 'done' } }], 'Done')));
    eq(Object.keys(await store.getUserStates()).length, 12);
  });

  test('store: the undo journal is capped', async () => {
    const { store, storage } = make();
    for (let i = 0; i < 30; i++) await store.applyUserChanges([{ key: 'a|' + i, patch: { state: 'done' } }], 'Done');
    eq(storage.data[TriageStore.KEYS.undo].length, 20);
  });

  test('store: a verdict is returned only for the same context hash and while fresh', async () => {
    const { store, tick } = make();
    await store.putVerdict('a|1', 'h1', 'jev-1.13.0', { needs_response: 0.91234, intent: { option: 'submission', p: 0.81234, confidence: 0.8, runnerUp: null } });
    eq((await store.getVerdict('a|1', 'h1')).answers.needs_response, 0.91);
    eq(await store.getVerdict('a|1', 'other-hash'), null);
    tick(91 * DAY);
    eq(await store.getVerdict('a|1', 'h1'), null);
    eq(await store.pruneVerdicts(), 1);
  });

  test('store: the verdict cache is capped, oldest dropped first', async () => {
    const { store, storage, tick } = make();
    for (let i = 0; i < TriageStore.MAX_VERDICTS + 5; i++) { await store.putVerdict('a|' + i, 'h', 'm', { x: 0.5 }); tick(1000); }
    const keys = Object.keys(storage.data[TriageStore.KEYS.verdicts]);
    eq(keys.length, TriageStore.MAX_VERDICTS);
    eq(keys.indexOf('a|0'), -1);
  });

  test('store: "Delete Today data" removes this feature\'s keys and nothing else', async () => {
    const { store, storage } = make();
    await storage.set({ v4pluginApiKey: 'keep-me', 'opened:v1:x': { a: 1 } });
    await store.setConfig({ enabled: true });
    await store.applyUserChanges([{ key: 'a|1', patch: { state: 'done' } }], 'Done');
    await store.putVerdict('a|1', 'h', 'm', { x: 0.5 });
    await store.setCoverage({ candidates: 1 });
    await store.deleteAll();
    eq(Object.keys(storage.data).sort(), ['opened:v1:x', 'v4pluginApiKey']);
  });

  // A scan a little larger than the cache used to evict its own upcoming hits:
  // every miss threw out the entry for a message still to come, so the second
  // scan of an unchanged mailbox asked about every single message again and
  // spent the shared quota twice.
  test('store: a scan does not evict the answers it is still about to read', async () => {
    const { store, storage, tick } = make();
    const N = TriageStore.MAX_VERDICTS + 5;
    const keys = Array.from({ length: N }, (_, i) => 'a|' + i);
    for (const k of keys) { await store.putVerdict(k, 'h', 'm', { x: 0.5 }, new Set(keys)); tick(1000); }
    // Whatever had to go, the cache is full and the newest survive.
    eq(Object.keys(storage.data[TriageStore.KEYS.verdicts]).length, TriageStore.MAX_VERDICTS);
    // Second pass over the same mailbox: the five that did not fit are asked
    // again; the rest are read from the cache and must survive those writes.
    const working = new Set(keys);
    let asked = 0;
    for (const k of keys) {
      const hit = await store.getVerdict(k, 'h');
      working.delete(k);
      if (!hit) { asked++; await store.putVerdict(k, 'h', 'm', { x: 0.5 }, working); tick(1000); }
    }
    assert.ok(asked <= 5, 'asked again about ' + asked + ' of ' + N);
  });

  test('store: a cache hit counts as a use, so the next scan does not throw it away first', async () => {
    const { store, storage, tick } = make();
    await store.putVerdict('a|old', 'h', 'm', { x: 0.5 });
    const was = storage.data[TriageStore.KEYS.verdicts]['a|old'].at;
    tick(60000);
    eq(await store.touchVerdicts(['a|old', 'a|never-seen']), 1);
    assert.ok(storage.data[TriageStore.KEYS.verdicts]['a|old'].at > was);
    eq(await store.touchVerdicts([]), 0);
  });

  // The mailbox Undo attached to one archive must reverse that archive's own
  // mark, not whatever the editor did afterwards in another tab.
  test('store: a change can be undone by name, wherever it has ended up in the stack', async () => {
    const { store } = make();
    const first = await store.applyUserChanges([{ key: 'a|1', patch: { state: 'done' } }], 'Archived');
    assert.ok(first.undoId, 'the change is named');
    await store.applyUserChanges([{ key: 'a|2', patch: { state: 'done' } }], 'Done in another tab');
    eq((await store.undoById(first.undoId)).label, 'Archived');
    const after = await store.getUserStates();
    eq([after['a|1'], after['a|2'].state], [undefined, 'done'], 'only its own change came back');
    // Undoing it twice, or undoing something unknown, changes nothing.
    eq(await store.undoById(first.undoId), null);
    for (const bad of [null, '', 'nope', 7]) eq(await store.undoById(bad), null, String(bad));
    // The page's own Undo button still takes the most recent change.
    eq((await store.undoLast()).label, 'Done in another tab');
    eq(Object.keys(await store.getUserStates()), []);
  });

  test('store: old "done" marks are cleared away; anything still outstanding is kept', async () => {
    const { store, storage, tick } = make();
    await store.applyUserChanges([
      { key: 'a|done', patch: { state: 'done' } },
      { key: 'a|snoozed', patch: { state: 'snoozed', until: Date.UTC(2027, 0, 1) } },
      { key: 'a|pinned', patch: { pinned: true } },
      { key: 'a|graded', patch: { priorityOverride: 3 } },
      { key: 'a|corrected', patch: { corrected: 'manuscript' } }
    ], 'Set up');
    tick(179 * DAY);
    eq(await store.pruneUserStates(), 0, 'nothing goes before its time');
    tick(2 * DAY);
    eq(await store.pruneUserStates(), 1);
    eq(Object.keys(storage.data[TriageStore.KEYS.user]).sort(), ['a|corrected', 'a|graded', 'a|pinned', 'a|snoozed']);
  });

  test('store: nothing but triage:v1:* keys is ever written', async () => {
    const { store, storage } = make();
    await store.setConfig({ enabled: true });
    await store.applyUserChanges([{ key: 'a|1', patch: { pinned: true } }], 'Pin');
    await store.putVerdict('a|1', 'h', 'm', { x: 0.5 });
    assert.ok(Object.keys(storage.data).every((k) => k.indexOf('triage:v1:') === 0));
  });
})();
