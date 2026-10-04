// Loads the add-on's real background scripts, in manifest order, into one fresh
// scope — the way Thunderbird does — and talks to the Today port.
(function () {
  function stubBrowser(over) {
    const listeners = { connect: [], message: [] };
    const data = {};
    const ev = () => ({ addListener() {} });
    const b = Object.assign({
      storage: { local: {
        async get(k) { if (k === null || k === undefined) return Object.assign({}, data); const o = {}; for (const x of [].concat(typeof k === 'string' ? [k] : Array.isArray(k) ? k : Object.keys(k))) if (x in data) o[x] = data[x]; return o; },
        async set(o) { Object.assign(data, JSON.parse(JSON.stringify(o))); }, async remove(k) { for (const x of [].concat(k)) delete data[x]; } }, onChanged: ev() },
      tabs: { onActivated: ev(), onRemoved: ev(), async query() { return []; } },
      windows: { onFocusChanged: ev(), WINDOW_ID_NONE: -1 },
      runtime: { onMessage: { addListener(fn) { listeners.message.push(fn); } }, onConnect: { addListener(fn) { listeners.connect.push(fn); } }, getURL: (p) => 'moz-extension://test/' + p, getManifest: () => ({ version: 'test' }), async getBrowserInfo() { return { name: 'Thunderbird', version: '155.0' }; } },
      permissions: { async contains() { return false; }, onAdded: ev(), onRemoved: ev() }
    }, over || {});
    return { b, listeners, data };
  }

  function openPort(listeners) {
    const got = [];
    let onMsg = null;
    const port = { name: 'triage:v1', postMessage(m) { got.push(m); }, onMessage: { addListener(fn) { onMsg = fn; } }, onDisconnect: { addListener() {} } };
    for (const fn of listeners.connect) fn(port);
    return { got, send: (m) => onMsg(m) };
  }
  const settle = () => new Promise((r) => setTimeout(r, 20));

  test('background: all scripts load into one scope without a collision or load-time error', async () => {
    const { b } = stubBrowser();
    const stack = backgroundStack(b);
    await settle();
    eq(stack.errors, []);
    assert.ok(stack.scripts.indexOf('scripts/background.js') < stack.scripts.indexOf('scripts/triage-background.js'), 'triage wiring loads after background.js');
    eq(stack.scripts.filter((s) => /triage-page/.test(s)), [], 'the page script is not a background script');
  });

  test('background: the shipped popup router still answers exactly as before', async () => {
    const { b, listeners } = stubBrowser();
    backgroundStack(b);
    await settle();
    eq(listeners.message.length, 1);
    eq(await listeners.message[0]({ method: 'nope' }), { error: 'unknown_method' });
    eq((await listeners.message[0]({ method: 'getConfig' })).enabled, true);
  });

  test('background: on an old Thunderbird, Today reports unsupported and stays dark', async () => {
    const { b, listeners } = stubBrowser();
    backgroundStack(b);
    await settle();
    const port = openPort(listeners);
    await port.send({ type: 'getState', id: 1 });
    await settle();
    const reply = port.got.find((m) => m.id === 1);
    eq([reply.ok, reply.result.supported, reply.result.config.enabled, reply.result.hasV4Key], [true, false, false, false]);
    await port.send({ type: 'enable', id: 2, accounts: ['a'], folders: ['f'] });
    await settle();
    eq(port.got.find((m) => m.id === 2), { type: 'reply', id: 2, ok: false, error: 'UNSUPPORTED', detail: '' });
  });

  test('background: unknown and prototype-named message types are refused', async () => {
    const { b, listeners } = stubBrowser();
    backgroundStack(b);
    await settle();
    const port = openPort(listeners);
    for (const [id, type] of [[1, 'nope'], [2, 'constructor'], [3, '__proto__'], [4, 42]]) await port.send({ type, id });
    await settle();
    eq(port.got.map((m) => m.error), ['UNKNOWN_TYPE', 'UNKNOWN_TYPE', 'UNKNOWN_TYPE', 'UNKNOWN_TYPE']);
  });

  function modernStub(accountsApi, foldersApi) {
    const ev = () => ({ addListener() {} });
    return stubBrowser({
      accounts: accountsApi, folders: foldersApi,
      spaces: { async query() { return []; }, async create() { return { id: 1 }; }, async update() {}, async remove() {} },
      messages: { async query() { return { id: null, messages: [] }; }, async continueList() { return { id: null, messages: [] }; }, onNewMailReceived: ev() },
      permissions: { async contains() { return true; }, async getAll() { return { permissions: ['accountsRead'], origins: [] }; }, onAdded: ev(), onRemoved: ev() }
    });
  }
  const twoAccounts = [{ id: 'a1', name: 'One', type: 'imap', identities: [{ email: 'one@example.org' }] }, { id: 'a2', name: 'Two', type: 'imap', identities: [] },
    { id: 'a3', name: 'Local Folders', type: 'none' }, { id: 'a4', name: 'Feeds', type: 'rss' }, { id: 'a5', name: 'News', type: 'nntp' }];
  const folder = (id, accountId) => ({ id, accountId, path: '/' + id, name: id, specialUse: [] });

  test('background: folders are listed even when the flat query throws — the tree walk takes over', async () => {
    const { b, listeners } = modernStub(
      { async list() { return twoAccounts; }, async get(id) { return { id, rootFolder: { subFolders: [Object.assign(folder(id + '-inbox', id), { subFolders: [folder(id + '-sub', id)] })] } }; } },
      { query() { throw new Error('Type error for parameter queryInfo'); }, async get() {} });
    backgroundStack(b);
    await settle();
    const port = openPort(listeners);
    await port.send({ type: 'listAccounts', id: 1 });
    await settle();
    const r = port.got.find((m) => m.id === 1);
    eq(r.ok, true);
    // a3 is Local Folders (type "none"): mail, so it is offered like the others.
    eq(r.result.map((a) => [a.id, a.folders.map((f) => f.id)]), [['a1', ['a1-inbox', 'a1-sub']], ['a2', ['a2-inbox', 'a2-sub']], ['a3', ['a3-inbox', 'a3-sub']]]);
  });

  test('background: a failure reaches the page with Thunderbird\'s own message, not a bare "FAILED"', async () => {
    const { b, listeners } = modernStub({ async list() { throw new Error('An unexpected error occurred'); }, async get() {} }, { async query() { return []; }, async get() {} });
    backgroundStack(b);
    await settle();
    const port = openPort(listeners);
    await port.send({ type: 'listAccounts', id: 1 });
    await port.send({ type: 'diagnose', id: 2 });
    await settle();
    eq(port.got.find((m) => m.id === 1), { type: 'reply', id: 1, ok: false, error: 'ACCOUNTS_LIST_FAILED', detail: 'An unexpected error occurred' });
    const d = port.got.find((m) => m.id === 2).result;
    eq([d.has.accounts, d.has.foldersQuery, d.permissions.permissions], [true, true, ['accountsRead']]);
    assert.ok(d.trace.some((x) => x.step === 'accounts.list' && x.ok === false && /unexpected/.test(x.error)));
  });

  test('background: a missing API namespace is reported as such', async () => {
    const { b, listeners } = modernStub(undefined, { async query() { return []; }, async get() {} });
    backgroundStack(b);
    await settle();
    const port = openPort(listeners);
    await port.send({ type: 'listAccounts', id: 1 });
    await settle();
    eq(port.got.find((m) => m.id === 1).error, 'API_NOT_READY');
  });

  test('manifest: every permission is granted at install — nothing is requested from editors later', () => {
    const stack = backgroundStack(stubBrowser().b);
    const m = stack.manifest;
    eq('optional_permissions' in m, false);
    for (const p of ['accountsRead', 'messagesRead', 'compose', 'storage', 'https://omnireply-gateway.vercel.app/*', 'https://v4.vdm-vsg.de/*']) assert.ok(m.permissions.indexOf(p) !== -1, p);
    assert.ok(!m.permissions.some((p) => /typesafe/i.test(p)), 'the add-on never talks to the model provider directly');
  });

  test('background: first run switches Today on and adds the Spaces button; nobody has to activate anything', async () => {
    let created = 0;
    const { b, listeners, data } = modernStub({ async list() { return []; }, async get() {} }, { async query() { return []; }, async get() {} });
    b.spaces.create = async () => { created++; return { id: 7 }; };
    backgroundStack(b);
    await settle();
    eq([data['triage:v1:config'].enabled, data['triage:v1:config'].setupDone, data['triage:v1:config'].folderMode, created], [true, true, 'all', 1]);
    const port = openPort(listeners);
    await port.send({ type: 'getState', id: 1 });
    await settle();
    eq(port.got.find((m) => m.id === 1).result.config.enabled, true);
  });

  test('background: an editor who turned Today off stays off after a restart', async () => {
    let created = 0;
    const { b, data } = modernStub({ async list() { return []; }, async get() {} }, { async query() { return []; }, async get() {} });
    b.spaces.create = async () => { created++; return { id: 7 }; };
    data['triage:v1:config'] = { enabled: false, setupDone: true };
    backgroundStack(b);
    await settle();
    eq([data['triage:v1:config'].enabled, created], [false, 0]);
  });

  test('background: a port with another name is ignored', async () => {
    const { b, listeners } = stubBrowser();
    backgroundStack(b);
    await settle();
    let attached = false;
    for (const fn of listeners.connect) fn({ name: 'other', onMessage: { addListener() { attached = true; } }, onDisconnect: { addListener() {} }, postMessage() {} });
    eq(attached, false);
  });

  // ---- classification through the OmniReply gateway ----
  const V4 = '0123456789abcdef0123456789abcdef';          // shape of a V4 key; not a real one
  function gatewayRig(opts) {
    const NOW = Date.now();
    const box = FakeMailbox.create({ accounts: [{ id: 'a1', identities: [{ email: 'editor@example.org', name: 'Ed Itor' }], folders: [
      { id: 'in', path: '/INBOX', specialUse: ['inbox'], messages: [
        { hmid: 'q1@x', date: NOW - 3600000, author: 'Ana Pop <ana@example.net>', recipients: ['editor@example.org'], subject: 'Question', body: 'Could you tell me how publishing with you works?' }] },
      { id: 'sent', path: '/Sent', specialUse: ['sent'], messages: [] }] }] });
    const ev = () => ({ addListener() {} });
    const stub = stubBrowser({
      accounts: Object.assign({ async get() { return null; } }, box.api.accounts), folders: box.api.folders,
      messages: Object.assign({ onNewMailReceived: ev() }, box.api.messages),
      spaces: { async query() { return []; }, async create() { return { id: 1 }; }, async update() {}, async remove() {} },
      permissions: { async contains() { return true; }, async getAll() { return { permissions: [], origins: [] }; }, onAdded: ev(), onRemoved: ev() }
    });
    if (opts.v4Key !== null) stub.data.v4pluginApiKey = opts.v4Key || V4;
    if (opts.legacyJevKey) stub.data['triage:v1:jevKey'] = opts.legacyJevKey;
    const stack = backgroundStack(stub.b);
    const calls = { health: 0, decide: [], other: [] };
    const headers = (h) => ({ get: (n) => (h && h[n.toLowerCase()]) || null });
    stack.context.fetch = async (url, init) => {
      const u = String(url);
      if (u === 'https://omnireply-gateway.vercel.app/api/health') {
        calls.health++;
        if (opts.health === 'down') throw new Error('offline');
        return { ok: true, status: 200, headers: headers(), async json() { return opts.health === undefined ? { ok: true, triage: { configured: true, configurationAvailable: true } } : opts.health; } };
      }
      if (u === 'https://omnireply-gateway.vercel.app/api/extension/triage/decide') {
        calls.decide.push({ headers: init.headers, body: JSON.parse(init.body), redirect: init.redirect, credentials: init.credentials });
        return opts.decide(calls.decide.length, JSON.parse(init.body), headers);
      }
      calls.other.push(u);
      throw new Error('network disabled in tests');
    };
    return { stub, calls, headers };
  }
  function okAnswers(body, headers) {
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      const ks = Object.keys(q.criteria);
      answers[id] = q.type === 'noul' ? { type: 'noul', noul: 0.9 } : { type: 'choice', choice: ks[0], probabilities: Object.fromEntries(ks.map((k, i) => [k, i === 0 ? 1 : 0])), confidence: 0.9 };
    }
    return { ok: true, status: 200, headers: headers(), async json() { return { model: 'jev-1.13.0', answers, usage: { input_tokens: 1, output_tokens: 1 } }; } };
  }
  const envelope = (status, code, retryable, h, headers) => ({ ok: false, status, headers: headers(h), async json() { return { error: 'X', code, retryable }; } });
  async function scanOnce(rig) {
    await settle();
    const port = openPort(rig.stub.listeners);
    await port.send({ type: 'scan', id: 9 });
    return { port, snap: port.got.find((m) => m.id === 9).result };
  }

  // ---- archive / trash: capability, refusal, and the real thing ----
  test('mail actions: what Thunderbird actually provides decides whether the buttons exist, and a missing one is refused before the mailbox is touched', async () => {
    const ev = () => ({ addListener() {} });
    const cases = [
      ['no archive function', { archive: false, move: true, perms: true }, { archive: false, trash: true }],
      ['no move function', { archive: true, move: false, perms: true }, { archive: true, trash: false }],
      ['permission not granted', { archive: true, move: true, perms: false }, { archive: false, trash: false }],
      ['everything available', { archive: true, move: true, perms: true }, { archive: true, trash: true }]
    ];
    for (const [name, have, expected] of cases) {
      const messages = { async query() { return { id: null, messages: [] }; }, async continueList() { return { id: null, messages: [] }; }, onNewMailReceived: ev() };
      if (have.archive) messages.archive = async () => {};
      if (have.move) messages.move = async () => {};
      const { b, listeners } = stubBrowser({
        accounts: { async list() { return []; }, async get() {} }, folders: { async query() { return []; }, async get() {} },
        spaces: { async query() { return []; }, async create() { return { id: 1 }; }, async update() {}, async remove() {} },
        messages,
        permissions: { async contains() { return have.perms; }, async getAll() { return { permissions: [], origins: [] }; }, onAdded: ev(), onRemoved: ev() }
      });
      backgroundStack(b);
      await settle();
      const port = openPort(listeners);
      await port.send({ type: 'getState', id: 1 });
      await port.send({ type: 'archive', id: 2, key: 'a|x@y' });
      await port.send({ type: 'trash', id: 3, key: 'a|x@y' });
      await settle();
      eq(port.got.find((m) => m.id === 1).result.can, expected, name);
      for (const [id, what] of [[2, 'archive'], [3, 'trash']]) {
        const r = port.got.find((m) => m.id === id);
        eq(r.ok, false, name + ' ' + what);
        if (!expected[what]) eq(r.error, what === 'archive' ? 'ARCHIVE_UNAVAILABLE' : 'TRASH_UNAVAILABLE', name + ' ' + what);
        else eq(r.error, 'ROW_GONE', name + ' ' + what + ' (no such row in this stub)');
      }
    }
  });

  // A real message, really moved, really put back.
  function mailboxRig(over) {
    const NOW = Date.now();
    const folders = [
      { id: 'in', path: '/INBOX', specialUse: ['inbox'], messages: [
        { hmid: 'm1@x', date: NOW - 3600000, author: 'Ana Pop <ana@example.net>', recipients: ['editor@example.org'], subject: 'A question', body: 'Could you tell me how publishing with you works?' }] },
      { id: 'sent', path: '/Sent', specialUse: ['sent'], messages: [] },
      { id: 'arch', path: '/Archives', specialUse: ['archives'], messages: [] }
    ].concat(over && over.noTrash ? [] : [{ id: 'trash', path: '/Trash', specialUse: over && over.unflaggedTrash ? [] : ['trash'], messages: [] }]);
    const box = FakeMailbox.create({ archiveTo: 'arch', accounts: [{ id: 'a1', identities: [{ email: 'editor@example.org', name: 'Ed Itor' }], folders }] });
    const ev = () => ({ addListener() {} });
    const stub = stubBrowser({
      accounts: Object.assign({ async get() { return null; } }, box.api.accounts), folders: box.api.folders,
      messages: Object.assign({ onNewMailReceived: ev() }, box.api.messages),
      spaces: { async query() { return []; }, async create() { return { id: 1 }; }, async update() {}, async remove() {} },
      permissions: { async contains() { return true; }, async getAll() { return { permissions: [], origins: [] }; }, onAdded: ev(), onRemoved: ev() }
    });
    stub.data.v4pluginApiKey = '0123456789abcdef0123456789abcdef';
    const stack = backgroundStack(stub.b);
    stack.context.fetch = async () => { throw new Error('no network in this test'); };
    const where = (hmid) => { for (const f of folders) if (f.messages.some((m) => m.hmid === hmid)) return f.id; return null; };
    return { stub, box, where };
  }

  async function scanThen(rig, send) {
    await settle();
    const port = openPort(rig.stub.listeners);
    await port.send({ type: 'scan', id: 1 });
    const key = port.got.find((m) => m.id === 1).result.rows[0].key;
    return send(port, key);
  }

  test('mail actions: Archive really archives, Trash really lands in Trash, and Undo puts the message back in the folder it came from', async () => {
    for (const [what, dest, label] of [['archive', 'arch', 'Archived'], ['trash', 'trash', 'Moved to Trash']]) {
      const rig = mailboxRig();
      await scanThen(rig, async (port, key) => {
        eq(rig.where('m1@x'), 'in', what + ': starts in the inbox');
        await port.send({ type: what, id: 2, key });
        await settle();
        const done = port.got.find((m) => m.id === 2);
        eq([done.ok, rig.where('m1@x')], [true, dest], what + ' -> ' + label);
        eq(done.result.snapshot.rows[0].group, 'done', what + ': the row steps aside');
        await port.send({ type: 'undoMail', id: 3, undo: done.result.undo });
        await settle();
        const back = port.got.find((m) => m.id === 3);
        eq([back.ok, rig.where('m1@x')], [true, 'in'], what + ': undo puts it back');
        assert.notStrictEqual(back.result.snapshot.rows[0].group, 'done', what + ': and the row returns');
      });
    }
  });

  test('mail actions: a server that flags no special folders still finds Trash by name', async () => {
    const rig = mailboxRig({ unflaggedTrash: true });
    await scanThen(rig, async (port, key) => {
      await port.send({ type: 'trash', id: 2, key });
      await settle();
      eq([port.got.find((m) => m.id === 2).ok, rig.where('m1@x')], [true, 'trash']);
    });
  });

  test('mail actions: with no Trash folder at all, nothing is moved and the editor is told', async () => {
    const rig = mailboxRig({ noTrash: true });
    await scanThen(rig, async (port, key) => {
      await port.send({ type: 'trash', id: 2, key });
      await settle();
      const r = port.got.find((m) => m.id === 2);
      eq([r.ok, r.error, rig.where('m1@x')], [false, 'NO_TRASH_FOLDER', 'in'], 'the message stays where it was');
      await port.send({ type: 'getState', id: 3 });
      await settle();
      eq(port.got.find((m) => m.id === 3).result.snapshot.rows[0].group === 'done', false, 'and the row is not marked done');
    });
  });

  // A Message-ID names a message, not a copy of it. The same newsletter, or the
  // same message filed twice, exists in several mailboxes at once — and Undo
  // used to look the id up across the whole profile and move whichever copy it
  // found first, so undoing in one mailbox emptied another.
  function twoMailboxes() {
    const NOW = Date.now();
    const shared = () => ({ hmid: 'same@x', date: NOW - 3600000, author: 'Ana Pop <ana@example.net>', recipients: ['editor@example.org'], subject: 'A question', body: 'Could you tell me how publishing with you works?' });
    const mailbox = (id) => ({ id, identities: [{ email: 'editor@' + id + '.example' }], folders: [
      { id: id + '-in', path: '/INBOX', specialUse: ['inbox'], messages: [shared()] },
      { id: id + '-sent', path: '/Sent', specialUse: ['sent'], messages: [] },
      { id: id + '-trash', path: '/Trash', specialUse: ['trash'], messages: [] }] });
    const spec = { accounts: [mailbox('a1'), mailbox('a2')] };
    const box = FakeMailbox.create(spec);
    const ev = () => ({ addListener() {} });
    const stub = stubBrowser({
      accounts: Object.assign({ async get() { return null; } }, box.api.accounts), folders: box.api.folders,
      messages: Object.assign({ onNewMailReceived: ev() }, box.api.messages),
      spaces: { async query() { return []; }, async create() { return { id: 1 }; }, async update() {}, async remove() {} },
      permissions: { async contains() { return true; }, async getAll() { return { permissions: [], origins: [] }; }, onAdded: ev(), onRemoved: ev() }
    });
    stub.data.v4pluginApiKey = V4;
    backgroundStack(stub.b).context.fetch = async () => { throw new Error('no network in this test'); };
    const count = (folderId) => { for (const a of spec.accounts) for (const f of a.folders) if (f.id === folderId) return f.messages.length; return null; };
    return { stub, count };
  }

  test('mail actions: Undo puts back the copy that was moved, not another mailbox\'s copy of the same message', async () => {
    const rig = twoMailboxes();
    await settle();
    const port = openPort(rig.stub.listeners);
    await port.send({ type: 'scan', id: 1 });
    await port.send({ type: 'trash', id: 2, key: 'a2|same@x' });
    await settle();
    const done = port.got.find((m) => m.id === 2);
    eq([done.ok, rig.count('a2-trash'), rig.count('a1-in')], [true, 1, 1], 'only the second mailbox was touched');
    await port.send({ type: 'undoMail', id: 3, undo: done.result.undo });
    await settle();
    const back = port.got.find((m) => m.id === 3);
    eq([back.ok, rig.count('a2-in'), rig.count('a2-trash'), rig.count('a1-in')], [true, 1, 0, 1],
      'the copy came back to its own mailbox and the other was left alone');
  });

  // "Exactly one copy" has to mean exactly one copy, not one on the first page
  // of the answer. A second copy is the very thing this lookup exists to catch.
  test('mail actions: a second copy on a later page of the result still stops Undo', async () => {
    const NOW = Date.now();
    const copy = () => ({ hmid: 'twice@x', date: NOW - 3600000, author: 'Ana Pop <ana@example.net>', recipients: ['editor@example.org'], subject: 'A question', body: 'How does publishing with you work?' });
    const folders = [
      { id: 'in', path: '/INBOX', specialUse: ['inbox'], messages: [copy()] },
      { id: 'sent', path: '/Sent', specialUse: ['sent'], messages: [] },
      // A copy of the same message is already in Trash, where this one is going.
      { id: 'trash', path: '/Trash', specialUse: ['trash'], messages: [copy()] }
    ];
    const box = FakeMailbox.create({ pageSize: 1, accounts: [{ id: 'a1', identities: [{ email: 'editor@example.org' }], folders }] });
    const ev = () => ({ addListener() {} });
    const stub = stubBrowser({
      accounts: Object.assign({ async get() { return null; } }, box.api.accounts), folders: box.api.folders,
      messages: Object.assign({ onNewMailReceived: ev() }, box.api.messages),
      spaces: { async query() { return []; }, async create() { return { id: 1 }; }, async update() {}, async remove() {} },
      permissions: { async contains() { return true; }, async getAll() { return { permissions: [], origins: [] }; }, onAdded: ev(), onRemoved: ev() }
    });
    stub.data.v4pluginApiKey = V4;
    backgroundStack(stub.b).context.fetch = async () => { throw new Error('no network in this test'); };
    await settle();
    const port = openPort(stub.listeners);
    await port.send({ type: 'scan', id: 1 });
    await port.send({ type: 'trash', id: 2, key: 'a1|twice@x' });
    await settle();
    const moved = port.got.find((m) => m.id === 2);
    eq([moved.ok, folders[2].messages.length], [true, 2], 'both copies are now in Trash');
    await port.send({ type: 'undoMail', id: 3, undo: moved.result.undo });
    await settle();
    const back = port.got.find((m) => m.id === 3);
    eq([back.ok, back.error], [false, 'AMBIGUOUS_COPY'], 'it must refuse rather than pick one');
    eq([folders[0].messages.length, folders[2].messages.length], [0, 2], 'and nothing moved');
  });

  // A row is a conversation, so Delete takes all of it — deleting only the
  // latest would leave the rest in the Inbox and the row on the page — and one
  // Undo puts all of it back where each message came from.
  test('mail actions: Delete moves the whole conversation, and one Undo puts every message back', async () => {
    const NOW = Date.now();
    const folders = [
      { id: 'in', path: '/INBOX', specialUse: ['inbox'], messages: [
        { hmid: 'c1@x', date: NOW - 7200000, author: 'Ana Pop <ana@example.net>', recipients: ['editor@example.org'], subject: 'My book', body: 'A question about my book.' }] },
      { id: 'auth', path: '/Authors', specialUse: [], messages: [
        { hmid: 'c2@x', date: NOW - 3600000, author: 'Ana Pop <ana@example.net>', recipients: ['editor@example.org'], subject: 'Re: My book', irt: 'c1@x', refs: ['c1@x'], body: 'And one more question.' }] },
      { id: 'sent', path: '/Sent', specialUse: ['sent'], messages: [] },
      { id: 'trash', path: '/Trash', specialUse: ['trash'], messages: [] }
    ];
    const box = FakeMailbox.create({ pageSize: 50, accounts: [{ id: 'a1', identities: [{ email: 'editor@example.org' }], folders }] });
    const ev = () => ({ addListener() {} });
    const stub = stubBrowser({
      accounts: Object.assign({ async get() { return null; } }, box.api.accounts), folders: box.api.folders,
      messages: Object.assign({ onNewMailReceived: ev() }, box.api.messages),
      spaces: { async query() { return []; }, async create() { return { id: 1 }; }, async update() {}, async remove() {} },
      permissions: { async contains() { return true; }, async getAll() { return { permissions: [], origins: [] }; }, onAdded: ev(), onRemoved: ev() }
    });
    stub.data.v4pluginApiKey = V4;
    backgroundStack(stub.b).context.fetch = async () => { throw new Error('no network in this test'); };
    await settle();
    const port = openPort(stub.listeners);
    await port.send({ type: 'scan', id: 1 });
    const row = port.got.find((m) => m.id === 1).result.rows[0];
    eq([row.count, row.keys.length], [2, 2], 'one row for the two messages');
    await port.send({ type: 'trash', id: 2, keys: row.keys });
    await settle();
    const moved = port.got.find((m) => m.id === 2);
    eq([moved.ok, folders[0].messages.length, folders[1].messages.length, folders[3].messages.length], [true, 0, 0, 2]);
    await port.send({ type: 'undoMail', id: 3, undo: moved.result.undo });
    await settle();
    eq(port.got.find((m) => m.id === 3).ok, true);
    eq([folders[0].messages.map((m) => m.hmid), folders[1].messages.map((m) => m.hmid), folders[3].messages.length],
      [['c1@x'], ['c2@x'], 0], 'each back in its own folder');
  });

  // Settings has only the folders now. An editor who switched classification
  // off, or turned on comparison mode or newsletters, in an earlier build
  // would be stuck with it and no switch to undo it — so start-up puts Today
  // back to how it works for everyone, and clears the pilot counts nothing reads.
  test('start-up: settings the page no longer offers are reset, and old pilot counts are removed', async () => {
    const rig = mailboxRig();
    rig.stub.data['triage:v1:config'] = { enabled: true, setupDone: true, modelOff: true, shadow: true, showNewsletters: true, folderMode: 'all' };
    rig.stub.data['triage:v1:signals'] = { '2026-09-24': { open: { 3: 1 } } };
    await settle();
    await settle();
    const cfg = rig.stub.data['triage:v1:config'];
    eq([cfg.modelOff, cfg.shadow, cfg.showNewsletters, cfg.enabled], [false, false, false, true]);
    eq('triage:v1:signals' in rig.stub.data, false);
  });

  test('spaces: the Today button never shows a count, and an old one is cleared', async () => {
    const NOW = Date.now();
    const box = FakeMailbox.create({ accounts: [{ id: 'a1', identities: [{ email: 'editor@example.org' }], folders: [
      { id: 'in', path: '/INBOX', specialUse: ['inbox'], messages: [
        { hmid: 'b1@x', date: NOW - 3600000, author: 'Ana Pop <ana@example.net>', recipients: ['editor@example.org'], subject: 'A question', body: 'How does publishing with you work?' }] },
      { id: 'sent', path: '/Sent', specialUse: ['sent'], messages: [] },
      { id: 'trash', path: '/Trash', specialUse: ['trash'], messages: [] }] }] });
    const updates = [];
    const ev = () => ({ addListener() {} });
    const stub = stubBrowser({
      accounts: Object.assign({ async get() { return null; } }, box.api.accounts), folders: box.api.folders,
      messages: Object.assign({ onNewMailReceived: ev() }, box.api.messages),
      // An existing button, as an older build would have left it.
      spaces: { async query() { return [{ id: 7 }]; }, async create() { return { id: 7 }; }, async update(id, props) { updates.push(props); }, async remove() {} },
      permissions: { async contains() { return true; }, async getAll() { return { permissions: [], origins: [] }; }, onAdded: ev(), onRemoved: ev() }
    });
    stub.data.v4pluginApiKey = V4;
    stub.data['triage:v1:config'] = { enabled: true, setupDone: true };
    backgroundStack(stub.b).context.fetch = async () => { throw new Error('no network in this test'); };
    await settle();
    const port = openPort(stub.listeners);
    await port.send({ type: 'scan', id: 1 });
    const key = port.got.find((m) => m.id === 1).result.rows[0].key;
    await port.send({ type: 'userChange', id: 2, changes: [{ key, patch: { state: 'done' } }], label: 'Dismissed' });
    await port.send({ type: 'trash', id: 3, keys: [key] });
    await settle();
    assert.ok(updates.some((u) => u.badgeText === ''), 'the old count is cleared');
    eq(updates.filter((u) => u.badgeText), [], 'and no count is ever set');
  });

  test('mail actions: Undo reverses its own mark, not whatever the editor did next', async () => {
    const rig = mailboxRig();
    await scanThen(rig, async (port, key) => {
      await port.send({ type: 'trash', id: 2, key });
      await settle();
      const done = port.got.find((m) => m.id === 2);
      // Meanwhile, in another tab: something else is marked done.
      await port.send({ type: 'userChange', id: 3, changes: [{ key: 'a1|other@x', patch: { state: 'done' } }], label: 'Done' });
      await settle();
      await port.send({ type: 'undoMail', id: 4, undo: done.result.undo });
      await settle();
      eq(port.got.find((m) => m.id === 4).ok, true);
      const user = rig.stub.data['triage:v1:user'] || {};
      eq(user['a1|other@x'] && user['a1|other@x'].state, 'done', 'the other tab\'s change is untouched');
      assert.ok(!user[key] || user[key].state !== 'done', 'and this action\'s own mark is the one reversed');
    });
  });

  test('mail actions: the add-on never asks for permission to delete mail', () => {
    const m = readManifest();
    eq(m.permissions.indexOf('messagesDelete'), -1);
    assert.ok(m.permissions.indexOf('messagesMove') !== -1);
  });

  test('gateway: with nothing set up by the editor, a scan is classified through the service — recognised by the V4 key, never by a model key', async () => {
    const rig = gatewayRig({ decide: (n, body, headers) => okAnswers(body, headers) });
    const { port, snap } = await scanOnce(rig);
    eq([snap.modelState, snap.coverage.model.asked, snap.rows[0].modelUsed, rig.calls.health], ['on', 1, true, 1]);
    const sent = rig.calls.decide[0];
    eq([sent.headers['X-V4-Api-Key'], sent.headers['Content-Type'], sent.headers['X-Extension-Version'], 'Authorization' in sent.headers, sent.redirect, sent.credentials],
      [V4, 'application/json', 'test', false, 'error', 'omit']);
    eq(Object.keys(sent.body).sort(), ['model', 'questions', 'state']);
    assert.ok(!JSON.stringify(sent.body).includes('ana@example.net'), 'no address in what was sent');
    assert.ok(!JSON.stringify(port.got).includes(V4), 'the V4 key never travels to the page');
    // The only other host is V4 itself (the existing read-only lead lookup) — never the model provider.
    assert.ok(rig.calls.other.every((u) => u.indexOf('https://v4.vdm-vsg.de/api/existence_check/') === 0), JSON.stringify(rig.calls.other.map((u) => u.split('/')[2])));
    assert.ok(!rig.calls.other.some((u) => /typesafe/i.test(u)));
  });

  test('gateway: unless the service clearly says classification is switched on, no message text leaves the computer', async () => {
    const cases = [{ ok: true, triage: { configured: false, configurationAvailable: true } }, { ok: true, triage: { configured: null, configurationAvailable: false } },
      { ok: true }, { ok: true, triage: { configured: 'true' } }, null, 'down'];
    for (const health of cases) {
      const rig = gatewayRig({ health, decide: (n, body, headers) => okAnswers(body, headers) });
      const { snap } = await scanOnce(rig);
      eq([rig.calls.decide.length, snap.modelState, snap.rows.length], [0, 'unavailable', 1], JSON.stringify(health));
    }
  });

  test('gateway: without a V4 key nothing is contacted at all, and the row says what to do', async () => {
    const rig = gatewayRig({ v4Key: null, decide: (n, body, headers) => okAnswers(body, headers) });
    const { snap } = await scanOnce(rig);
    eq([rig.calls.health, rig.calls.decide.length, snap.modelState, snap.rows[0].reason.id], [0, 0, 'no_v4_key', 'unclassified_no_v4_key']);
  });

  test('gateway: a "busy" answer is waited out (Retry-After read from the response) and the scan still classifies', async () => {
    const rig = gatewayRig({ decide: (n, body, headers) => (n === 1 ? envelope(429, 'UPSTREAM_BUSY', true, { 'retry-after': '0.01' }, headers) : okAnswers(body, headers)) });
    const { snap } = await scanOnce(rig);
    eq([rig.calls.decide.length, snap.coverage.model.asked, snap.coverage.model.busy, snap.coverage.model.errors], [2, 1, 0, 0]);
  });

  test('gateway: what the service SAYS outranks the status — a 503 marked not retryable is asked once and ends the run', async () => {
    for (const [status, code, row] of [[503, 'MODEL_NOT_CONFIGURED', 'unclassified_error'], [502, 'MODEL_KEY_REFUSED', 'unclassified_error'], [401, 'invalid_key', 'unclassified_error'],
      [403, 'ACCESS_REVOKED', 'unclassified_error'], [422, 'TRIAGE_SCHEMA_UNSUPPORTED', 'unclassified_error']]) {
      const rig = gatewayRig({ decide: (n, body, headers) => envelope(status, code, false, null, headers) });
      const { snap } = await scanOnce(rig);
      eq([rig.calls.decide.length, snap.coverage.model.refused, snap.coverage.model.stopCode, snap.coverage.model.busy, snap.rows[0].reason.id], [1, true, code, 0, row], code);
    }
  });

  test('gateway: "V4 did not confirm your key" stops the scan after ONE request and is asked again later — it is not retried message by message', async () => {
    // Found on the live service: V4 answers a wrong (well-formed) key with a server error, so the
    // gateway cannot say "refused" and answers 503 v4_unreachable, retryable. Asking again at once changes nothing.
    const rig = gatewayRig({ decide: (n, body, headers) => envelope(503, 'v4_unreachable', true, null, headers) });
    const { snap } = await scanOnce(rig);
    const m = snap.coverage.model;
    eq([rig.calls.decide.length, m.refused, m.stopCode, m.busy, snap.rows[0].reason.id], [1, false, 'v4_unreachable', 1, 'unclassified_busy']);
  });

  test('gateway: a failure without the service\'s envelope (platform level) is judged by its status alone', async () => {
    const rig = gatewayRig({ decide: (n, body, headers) => ({ ok: false, status: 404, headers: headers(), async json() { throw new Error('<html>'); } }) });
    const { snap } = await scanOnce(rig);
    eq([rig.calls.decide.length, snap.coverage.model.errors, snap.coverage.model.busy, snap.rows[0].display.modelError], [1, 1, 0, 'HTTP_404']);
  });

  test('gateway: a 200 without readable JSON is a failure, not an empty answer', async () => {
    const rig = gatewayRig({ decide: (n, body, headers) => ({ ok: true, status: 200, headers: headers(), async json() { throw new Error('truncated'); } }) });
    const { snap } = await scanOnce(rig);
    eq([snap.coverage.model.asked, snap.coverage.model.errors > 0, snap.rows[0].modelUsed], [0, true, false]);
  });

  test('gateway: a model key left on the computer by a test build is deleted at start-up, and there is no way to store one', async () => {
    const rig = gatewayRig({ legacyJevKey: 'test-key-not-real', decide: (n, body, headers) => okAnswers(body, headers) });
    await settle();
    eq('triage:v1:jevKey' in rig.stub.data, false);
    const port = openPort(rig.stub.listeners);
    await port.send({ type: 'setJevKey', id: 1, key: 'test-key-not-real' });
    await settle();
    eq([port.got.find((m) => m.id === 1).error, 'triage:v1:jevKey' in rig.stub.data], ['UNKNOWN_TYPE', false]);
  });

  test('gateway: the editor\'s own switch — off sends nothing and forgets stored answers; "Delete Today data" leaves the V4 key alone', async () => {
    const rig = gatewayRig({ decide: (n, body, headers) => okAnswers(body, headers) });
    const { port } = await scanOnce(rig);
    assert.ok(Object.keys(rig.stub.data['triage:v1:verdicts'] || {}).length > 0);
    await port.send({ type: 'setConfig', id: 2, patch: { modelOff: true, backend: 'jev-direct', consentAt: true, evil: 1 } });
    await settle();
    const cfg = rig.stub.data['triage:v1:config'];
    eq([cfg.modelOff, 'backend' in cfg, 'consentAt' in cfg, 'evil' in cfg, 'triage:v1:verdicts' in rig.stub.data], [true, false, false, false, false]);
    const before = rig.calls.decide.length;
    await port.send({ type: 'scan', id: 3 });
    eq([rig.calls.decide.length, port.got.find((m) => m.id === 3).result.modelState], [before, 'off']);
    await port.send({ type: 'deleteData', id: 4 });
    await settle();
    eq(Object.keys(rig.stub.data), ['v4pluginApiKey']);
  });

  // The two switches an editor can reach mid-scan. "Off" and "delete" have to
  // mean off and deleted from that moment, not once the queue has drained:
  // otherwise the rest of the mailbox is sent after she has said stop, and the
  // store she just emptied fills up again behind her.
  function manyMessages(n) {
    const NOW = Date.now();
    return { accounts: [{ id: 'a1', identities: [{ email: 'editor@example.org', name: 'Ed Itor' }], folders: [
      { id: 'in', path: '/INBOX', specialUse: ['inbox'], messages: Array.from({ length: n }, (_, i) => ({
        hmid: 'q' + i + '@x', date: NOW - 3600000, author: 'Ana Pop <ana@example.net>', recipients: ['editor@example.org'],
        subject: 'Question ' + i, body: 'Could you tell me how publishing with you works? Message ' + i })) },
      { id: 'sent', path: '/Sent', specialUse: ['sent'], messages: [] }] }] };
  }

  // A gateway rig whose answers can be held open, so a switch can be flipped
  // while requests are in flight.
  function heldRig(spec) {
    const box = FakeMailbox.create(spec);
    const ev = () => ({ addListener() {} });
    const stub = stubBrowser({
      accounts: Object.assign({ async get() { return null; } }, box.api.accounts), folders: box.api.folders,
      messages: Object.assign({ onNewMailReceived: ev() }, box.api.messages),
      spaces: { async query() { return []; }, async create() { return { id: 1 }; }, async update() {}, async remove() {} },
      permissions: { async contains() { return true; }, async getAll() { return { permissions: [], origins: [] }; }, onAdded: ev(), onRemoved: ev() }
    });
    stub.data.v4pluginApiKey = V4;
    const stack = backgroundStack(stub.b);
    const gates = [];
    let sent = 0, hold = 0;
    const headers = () => ({ get: () => null });
    stack.context.fetch = async (url, init) => {
      const u = String(url);
      if (u.endsWith('/api/health')) return { ok: true, status: 200, headers: headers(), async json() { return { ok: true, triage: { configured: true } }; } };
      if (u.indexOf('/triage/decide') !== -1) {
        sent++;
        if (sent <= hold) await new Promise((r) => gates.push(r));
        return okAnswers(JSON.parse(init.body), headers);
      }
      throw new Error('network disabled in tests');
    };
    return { stub, gates, holdFirst(n) { hold = n; }, sentCount: () => sent, release: () => { for (const r of gates.splice(0)) r(); } };
  }

  const until = async (cond) => { for (let i = 0; i < 200 && !cond(); i++) await settle(); assert.ok(cond(), 'condition never came true'); };

  test('gateway: switching classification off stops the messages already queued, and they are not sent', async () => {
    const rig = heldRig(manyMessages(8));
    rig.holdFirst(4);
    await settle();
    const port = openPort(rig.stub.listeners);
    const scanning = port.send({ type: 'scan', id: 1 });
    await until(() => rig.sentCount() === 4);
    await port.send({ type: 'setConfig', id: 2, patch: { modelOff: true } });
    rig.release();
    await scanning;
    await settle();
    eq(rig.sentCount(), 4, 'the four still queued were sent after she said stop');
    eq(Object.keys(rig.stub.data['triage:v1:verdicts'] || {}).length, 0, 'and the answers she cleared came back');
  });

  test('gateway: an answer that arrives after "Delete Today data" is not written back', async () => {
    const rig = heldRig(manyMessages(1));
    rig.holdFirst(1);
    await settle();
    const port = openPort(rig.stub.listeners);
    const scanning = port.send({ type: 'scan', id: 1 });
    await until(() => rig.sentCount() === 1);
    await port.send({ type: 'deleteData', id: 2 });
    await settle();
    eq('triage:v1:verdicts' in rig.stub.data, false);
    rig.release();
    await scanning;
    await settle();
    eq(Object.keys(rig.stub.data['triage:v1:verdicts'] || {}).length, 0, 'the deleted store filled up again');
  });
})();
