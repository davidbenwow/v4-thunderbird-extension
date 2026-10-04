// The Jev key is shared by every editor's add-on: these tests pin down how one
// add-on behaves as a polite client among many. Virtual clock, no real waiting.
(function () {
  const T = TriageThrottle;

  function rig(script, limits, randomValue) {
    let t = 1000000;
    const sendTimes = [];
    let inFlight = 0, peak = 0;
    const th = T.create({
      limits,
      now: () => t,
      sleep: (ms) => { const wake = t + ms; return Promise.resolve().then(() => { if (t < wake) t = wake; }); },
      random: () => (randomValue === undefined ? 0.5 : randomValue),
      send: async (payload) => {
        sendTimes.push(t);
        inFlight++; peak = Math.max(peak, inFlight);
        await Promise.resolve(); await Promise.resolve();
        inFlight--;
        const r = typeof script === 'function' ? script(payload, sendTimes.length) : script.shift();
        if (r && r.throwCode) { const e = new Error(r.throwCode); e.code = r.throwCode; throw e; }
        return r;
      }
    });
    return { th, sendTimes, clock: () => t, peak: () => peak };
  }
  const OK = { status: 200, body: { answers: {} } };
  const codeOf = async (p) => { try { await p; return 'resolved'; } catch (e) { return e.code; } };

  test('throttle: never more than four requests in flight from one add-on', async () => {
    const r = rig(() => OK);
    await Promise.all(Array.from({ length: 25 }, (_, i) => r.th.request({ i })));
    eq([r.peak() <= 4, r.sendTimes.length, r.th.snapshot().stats.ok], [true, 25, 25]);
  });

  test('throttle: a "busy" answer is retried and the body of the later success is returned', async () => {
    const r = rig([{ status: 429 }, { status: 529 }, { status: 200, body: { hello: 1 } }]);
    eq(await r.th.request({}), { hello: 1 });
    eq(r.th.snapshot().stats, { sent: 3, ok: 1, busy: 2, retries: 2, gaveUp: 0, peak: 1 });
  });

  test('throttle: waits grow and are never zero — half fixed, half random', async () => {
    const low = rig([{ status: 429 }, { status: 429 }, OK], null, 0);
    await low.th.request({});
    eq([low.sendTimes[1] - low.sendTimes[0], low.sendTimes[2] - low.sendTimes[1]], [500, 1000]);
    const high = rig([{ status: 429 }, { status: 429 }, OK], null, 0.999);
    await high.th.request({});
    assert.ok(high.sendTimes[1] - high.sendTimes[0] > 990 && high.sendTimes[2] - high.sendTimes[1] > 1990);
  });

  test('throttle: two add-ons refused at the same moment do not come back at the same moment', async () => {
    const a = rig([{ status: 429, retryAfterMs: 5000 }, OK], null, 0.1);
    const b = rig([{ status: 429, retryAfterMs: 5000 }, OK], null, 0.9);
    await Promise.all([a.th.request({}), b.th.request({})]);
    const waitA = a.sendTimes[1] - a.sendTimes[0], waitB = b.sendTimes[1] - b.sendTimes[0];
    assert.ok(waitA >= 5000 && waitB >= 5000, 'Retry-After is a minimum');
    assert.notStrictEqual(waitA, waitB);
  });

  test('throttle: a Retry-After longer than a request may wait is kept in full — never cut short to come back early', async () => {
    let n = 0;
    const r = rig(() => (++n === 1 ? { status: 429, retryAfterMs: 300000 } : OK), null, 0);
    eq(await codeOf(r.th.request({})), 'RATE_LIMITED');
    eq(r.sendTimes.length, 1, 'no second try inside the five minutes');
    assert.ok(r.th.snapshot().pausedForMs >= 299000, 'the scheduler can see how long to stay away');
    // Others do not sleep through it either, and nothing is sent meanwhile.
    eq(await codeOf(r.th.request({})), 'RATE_LIMITED');
    eq(r.sendTimes.length, 1);
  });

  test('throttle: a Retry-After that fits the time a request may wait is waited out in full', async () => {
    const r = rig([{ status: 429, retryAfterMs: 90000 }, OK], null, 0);
    eq(await codeOf(r.th.request({})), 'resolved');
    eq(r.sendTimes[1] - r.sendTimes[0], 90000);
  });

  test('throttle: a two-hour Retry-After is recorded as two hours — never shortened', async () => {
    const r = rig(() => ({ status: 429, retryAfterMs: 7200000 }), null, 0);
    eq(await codeOf(r.th.request({})), 'RATE_LIMITED');
    const snap = r.th.snapshot();
    assert.ok(snap.pausedForMs >= 7200000, String(snap.pausedForMs));
    eq(snap.pausedUntil, r.clock() + snap.pausedForMs);
    eq(r.sendTimes.length, 1);
    // A new scan inside those two hours does not reach the service either.
    r.th.reset();
    eq([await codeOf(r.th.request({})), r.sendTimes.length], ['RATE_LIMITED', 1]);
  });

  test('throttle: a 48-hour Retry-After is kept in full and nothing is sent again — it is never read as "no header"', async () => {
    const r = rig(() => ({ status: 429, retryAfterMs: 172800000 }), null, 0);
    eq(await codeOf(r.th.request({})), 'RATE_LIMITED');
    eq([r.sendTimes.length, r.th.snapshot().pausedForMs >= 172800000], [1, true]);
    eq(r.th.autoRetryDelay(120000), null, 'automatic re-asks are suspended');
    r.th.reset();
    eq([await codeOf(r.th.request({})), r.sendTimes.length], ['RATE_LIMITED', 1]);
  });

  test('throttle: only a missing or malformed Retry-After falls back to our own backoff', async () => {
    for (const bad of [undefined, null, NaN, Infinity, -5, 0, '120']) {
      const r = rig([{ status: 429, retryAfterMs: bad }, OK], null, 0);
      eq(await codeOf(r.th.request({})), 'resolved', String(bad));
      eq(r.sendTimes[1] - r.sendTimes[0], 500, String(bad));
    }
  });

  test('throttle: around the one-hour horizon — below it the background waits the pause out, above it it stands down', async () => {
    const NOWMS = 1000000;                              // the rig's clock starts here
    const http = (ms) => new Date(Date.UTC(2026, 8, 21, 10, 0, 0) + ms).toUTCString();
    const base = Date.UTC(2026, 8, 21, 10, 0, 0);
    const forms = (ms) => [ms, T.parseRetryAfter(String(ms / 1000), base), T.parseRetryAfter(http(ms), base)];
    for (const [ms, expectAuto] of [[59 * 60000, true], [60 * 60000, true], [61 * 60000, false], [24 * 3600000, false], [48 * 3600000, false]]) {
      for (const value of forms(ms)) {
        eq(value, ms, 'seconds and HTTP-date parse to the same duration');
        const r = rig(() => ({ status: 429, retryAfterMs: value }), null, 0);
        await codeOf(r.th.request({}));
        eq(r.sendTimes.length, 1, String(ms));
        eq(r.th.snapshot().pausedUntil >= NOWMS + ms, true, String(ms));
        const d = r.th.autoRetryDelay(120000);
        if (expectAuto) assert.ok(d !== null && d >= ms, 'waits the pause out: ' + ms);
        else eq(d, null, 'stands down: ' + ms);
      }
    }
  });

  test('throttle: with no pause in force the background uses its own schedule', async () => {
    const r = rig(() => OK);
    await r.th.request({});
    eq(r.th.autoRetryDelay(120000), 120000);
  });

  test('throttle: "not retryable" outranks the status — a 503 that says so is not asked again', async () => {
    const r = rig(() => ({ status: 503, code: 'MODEL_NOT_CONFIGURED', retryable: false, stopRun: true }));
    eq([await codeOf(r.th.request({})), r.sendTimes.length], ['MODEL_NOT_CONFIGURED', 1]);
    eq(await codeOf(r.th.request({})), 'MODEL_NOT_CONFIGURED');
    eq(r.sendTimes.length, 1, 'the run stopped: the answer would be the same for every message');
  });

  test('throttle: a run-stopping answer ends the run even when it is marked retryable — and stays worth asking about later', async () => {
    const r = rig(() => ({ status: 503, code: 'v4_unreachable', retryable: true, stopRun: true }));
    eq([await codeOf(r.th.request({})), r.sendTimes.length], ['v4_unreachable', 1]);
    eq([await codeOf(r.th.request({})), r.sendTimes.length, T.isTransient('v4_unreachable')], ['v4_unreachable', 1, true]);
    r.th.reset();
    eq(r.th.snapshot().tripped, null);
  });

  test('throttle: a refusal that concerns one message only does not stop the run', async () => {
    let n = 0;
    const r = rig(() => (++n === 1 ? { status: 422, code: 'UPSTREAM_REJECTED', retryable: false } : OK));
    eq(await codeOf(r.th.request({})), 'UPSTREAM_REJECTED');
    eq(await codeOf(r.th.request({})), 'resolved');
  });

  test('throttle: a retryable gateway failure keeps its code when the tries run out', async () => {
    const r = rig(() => ({ status: 504, code: 'UPSTREAM_TIMEOUT', retryable: true }));
    eq([await codeOf(r.th.request({})), r.sendTimes.length, T.isTransient('UPSTREAM_TIMEOUT')], ['UPSTREAM_TIMEOUT', 3, true]);
    eq(['MODEL_KEY_REFUSED', 'MODEL_NOT_CONFIGURED', 'TRIAGE_SCHEMA_UNSUPPORTED', 'ACCESS_REVOKED', 'invalid_key'].map(T.isTransient), [false, false, false, false, false]);
  });

  test('throttle: one "busy" answer pauses every pending request and drops to one at a time', async () => {
    let n = 0;
    const r = rig(() => (++n === 1 ? { status: 429, retryAfterMs: 8000 } : OK), null, 0);
    const first = r.th.request({ id: 'a' });
    await first;
    const start = r.sendTimes[0];
    assert.ok(r.sendTimes.slice(1).every((t) => t - start >= 8000));
    eq(r.th.snapshot().allowed, 1);
    // …and it opens up again only after a run of successes.
    for (let i = 0; i < T.DEFAULTS.raiseAfter; i++) await r.th.request({ i });
    eq(r.th.snapshot().allowed, 2);
  });

  test('throttle: while paused, requests that arrive later wait too', async () => {
    let n = 0;
    const r = rig(() => (++n === 1 ? { status: 503, retryAfterMs: 4000 } : OK), null, 0);
    const a = r.th.request({ id: 'a' });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const b = r.th.request({ id: 'b' });
    await Promise.all([a, b]);
    assert.ok(r.sendTimes.slice(1).every((t) => t - r.sendTimes[0] >= 4000));
  });

  test('throttle: a request gives up as RATE_LIMITED after six "busy" answers', async () => {
    const r = rig(() => ({ status: 429 }), { budgetMs: 10000000 });
    eq(await codeOf(r.th.request({})), 'RATE_LIMITED');
    eq(r.sendTimes.length, 6);
  });

  test('throttle: a request never waits longer than its time budget', async () => {
    const r = rig(() => ({ status: 429, retryAfterMs: 50000 }), null, 0);
    eq(await codeOf(r.th.request({})), 'RATE_LIMITED');
    assert.ok(r.sendTimes.length <= 3, 'sent ' + r.sendTimes.length);
  });

  test('throttle: after three requests given up in a row the run stops asking — until reset', async () => {
    const r = rig(() => ({ status: 429 }), { budgetMs: 10000000 });
    for (let i = 0; i < 3; i++) eq(await codeOf(r.th.request({ i })), 'RATE_LIMITED');
    const sentSoFar = r.sendTimes.length;
    for (let i = 0; i < 40; i++) eq(await codeOf(r.th.request({ i })), 'RATE_LIMITED');
    eq(r.sendTimes.length, sentSoFar, 'the shared quota is not spent on a service that stays busy');
    r.th.reset();
    eq(r.th.snapshot().tripped, null);
  });

  test('throttle: a refused key stops the whole run after ONE request', async () => {
    const r = rig(() => ({ status: 401 }));
    const codes = await Promise.all(Array.from({ length: 30 }, () => codeOf(r.th.request({}))));
    eq([Array.from(new Set(codes)), r.sendTimes.length <= 4], [['HTTP_401'], true]);
    eq(await codeOf(r.th.request({})), 'HTTP_401');
    r.th.reset();
    eq(r.th.snapshot().tripped, null);
  });

  test('throttle: a malformed request (422) is not asked again', async () => {
    const r = rig(() => ({ status: 422 }));
    eq([await codeOf(r.th.request({})), r.sendTimes.length], ['HTTP_422', 1]);
  });

  test('throttle: a server error, a timeout and a dropped connection get two more tries, no more', async () => {
    for (const [reply, code] of [[{ status: 500 }, 'HTTP_500'], [{ throwCode: 'TIMEOUT' }, 'TIMEOUT'], [{ throwCode: 'ECONNRESET' }, 'NETWORK']]) {
      const r = rig(() => reply);
      eq([await codeOf(r.th.request({})), r.sendTimes.length], [code, 3], code);
    }
    const r = rig([{ throwCode: 'TIMEOUT' }, OK]);
    eq(await codeOf(r.th.request({})), 'resolved');
  });

  test('throttle: a cancelled scan sends nothing more', async () => {
    let cancelled = false;
    const r = rig(() => OK);
    await r.th.request({}, { cancelled: () => cancelled });
    cancelled = true;
    eq([await codeOf(r.th.request({}, { cancelled: () => cancelled })), r.sendTimes.length], ['CANCELLED', 1]);
  });

  test('throttle: a cancel during a pause is noticed before anything is sent', async () => {
    let cancelled = false, n = 0;
    const r = rig(() => { n++; if (n === 1) { cancelled = true; return { status: 429, retryAfterMs: 3000 }; } return OK; });
    eq([await codeOf(r.th.request({}, { cancelled: () => cancelled })), r.sendTimes.length], ['CANCELLED', 1]);
  });

  test('throttle: which failures are worth asking about again later', () => {
    eq(['RATE_LIMITED', 'TIMEOUT', 'NETWORK', 'HTTP_429', 'HTTP_529', 'HTTP_503', 'HTTP_500'].map(T.isTransient), [true, true, true, true, true, true, true]);
    eq(['HTTP_401', 'HTTP_403', 'HTTP_422', 'NO_JEV_KEY', 'intent:option', '', null].map(T.isTransient), [false, false, false, false, false, false, false]);
  });

  test('throttle: Retry-After as seconds, as a date, or as rubbish', () => {
    const now = Date.UTC(2026, 8, 21, 10, 0, 0);
    eq(T.parseRetryAfter('7', now), 7000);
    eq(T.parseRetryAfter('1.5', now), 1500);
    eq(T.parseRetryAfter('Mon, 21 Sep 2026 10:00:30 GMT', now), 30000);
    eq(T.parseRetryAfter('Mon, 21 Sep 2026 09:00:00 GMT', now), 0);
    eq([T.parseRetryAfter(null, now), T.parseRetryAfter('', now), T.parseRetryAfter('soon', now)], [null, null, null]);
    eq(['-5', '1e9', '0x10', 'Infinity', 'NaN', '12 34', '9'.repeat(40)].map((v) => T.parseRetryAfter(v, now)), [null, null, null, null, null, null, null]);
    eq(T.parseRetryAfter('7200', now), 7200000);
  });
})();
