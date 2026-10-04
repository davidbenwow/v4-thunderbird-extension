// One Jev key serves every editor's mailbox, so this add-on is one client among
// many sharing a single rate limit, and no client can see the others. Each one
// therefore behaves so that the sum stays healthy:
//
//   - few requests in flight, and fewer after the service says "busy"
//     (additive increase, multiplicative decrease — the same rule TCP uses to
//     share a link fairly without coordination);
//   - a "busy" answer pauses EVERY pending request of this add-on, not only the
//     one that received it;
//   - waits carry random jitter, so add-ons that were refused at the same moment
//     do not come back at the same moment;
//   - a refused key or a service that stays busy stops the run early instead of
//     spending the shared quota on requests that cannot succeed.
//
// Pure: no WebExtension API, no timers of its own beyond the injected `sleep`.
//
//   send(payload) -> Promise<{ status, body?, retryAfterMs?, code?, retryable?, stopRun? }>,
//                    rejects with { code: 'TIMEOUT' | 'NETWORK' } when nothing came back.
//
// What the service SAYS outranks the status it says it with: an answer marked
// `retryable: false` is never asked again, even as a 503, and `stopRun` (wrong
// key, service not configured, question set not accepted) ends the run — the
// same answer would come back for every other message. A Retry-After is a
// promise kept in full: if it is longer than a request may wait, the request
// gives up and nothing is sent before that moment; it is never cut short.

var TriageThrottle = (function () {
  'use strict';

  const DEFAULTS = Object.freeze({
    maxConcurrent: 4,        // ceiling for requests in flight from this add-on
    raiseAfter: 8,           // successes in a row before one more is allowed
    maxBusyAttempts: 6,      // tries for one request while the service says "busy"
    maxTransientRetries: 2,  // retries after a timeout, network error or 5xx
    baseMs: 1000,
    capMs: 30000,
    autoRetryHorizonMs: 3600000, // a pause longer than this is not sat out with a timer: automatic re-asks are suspended
    budgetMs: 120000,        // longest one request may wait in total
    giveUpsToTrip: 3         // requests given up in a row before the run stops asking
  });

  // Answers that would be the same for every other message of a scan.
  const RUN_ENDING = Object.freeze(['missing_key', 'invalid_key', 'ACCESS_REVOKED', 'MODEL_NOT_CONFIGURED', 'MODEL_KEY_REFUSED',
    'MODEL_NOT_ALLOWED', 'TRIAGE_SCHEMA_UNSUPPORTED', 'METHOD_NOT_ALLOWED', 'UNSUPPORTED_MEDIA_TYPE', 'NO_V4_KEY', 'HTTP_401', 'HTTP_403']);
  // Also the same for every message of a scan, but possibly over in a few
  // minutes: the run stops at once (no point asking 300 times), and the rows are
  // asked about again later. `v4_unreachable` is what the service answers when V4
  // does not confirm the editor's key — V4 being down, or (V4 answers a wrong key
  // with a server error, not a refusal) a key that is simply wrong.
  const RUN_PAUSING = Object.freeze(['v4_unreachable', 'GATEWAY_UNAVAILABLE']);
  const BUSY = [429, 503, 529];
  const REFUSED = [401, 403];

  function coded(code) { const e = new Error(code); e.code = code; return e; }

  const TRANSIENT_CODES = ['RATE_LIMITED', 'TIMEOUT', 'NETWORK', 'UPSTREAM_BUSY', 'EDITOR_RATE_LIMIT', 'UPSTREAM_UNAVAILABLE',
    'UPSTREAM_INVALID_RESPONSE', 'UPSTREAM_TIMEOUT', 'GATEWAY_TIMEOUT', 'GATEWAY_UNAVAILABLE', 'v4_unreachable'];

  // Worth another try later, as opposed to wrong key / malformed request.
  function isTransient(code) {
    const c = String(code || '');
    if (TRANSIENT_CODES.indexOf(c) !== -1) return true;
    const m = /^HTTP_(\d+)$/.exec(c);
    return !!m && (BUSY.indexOf(+m[1]) !== -1 || +m[1] >= 500);
  }

  function create(opts) {
    const cfg = Object.assign({}, DEFAULTS, opts && opts.limits);
    const send = opts.send;
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    const sleep = typeof opts.sleep === 'function' ? opts.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
    const random = typeof opts.random === 'function' ? opts.random : Math.random;

    let allowed = cfg.maxConcurrent;
    let inFlight = 0;
    let streak = 0;
    let pausedUntil = 0;
    let giveUps = 0;
    let tripped = null;      // error code every further request fails with, until reset()
    const waiting = [];
    const stats = { sent: 0, ok: 0, busy: 0, retries: 0, gaveUp: 0, peak: 0 };

    function release() {
      inFlight--;
      while (waiting.length && inFlight < allowed) { inFlight++; waiting.shift()(); }
    }
    function acquire() {
      if (inFlight < allowed) { inFlight++; return Promise.resolve(); }
      return new Promise((r) => waiting.push(r));
    }

    // Half fixed, half random: never a zero wait, never everyone at once.
    function backoff(attempt) {
      const d = Math.min(cfg.capMs, cfg.baseMs * Math.pow(2, attempt));
      return d / 2 + random() * d / 2;
    }

    // Holds until this request owns a slot and no pause is in force. A pause
    // longer than the request may wait is not slept through: it gives up, and
    // the rows are asked about again once the pause is over.
    async function turn(cancelled, deadline) {
      for (;;) {
        if (tripped) throw coded(tripped);
        if (cancelled && cancelled()) throw coded('CANCELLED');
        const gap = pausedUntil - now();
        if (gap > 0 && now() + gap > deadline) throw giveUp('RATE_LIMITED');
        if (gap > 0) { await sleep(gap); continue; }
        await acquire();
        if (!tripped && pausedUntil <= now() && !(cancelled && cancelled())) return;
        release();
      }
    }

    function giveUp(code) {
      stats.gaveUp++;
      if (++giveUps >= cfg.giveUpsToTrip) tripped = code;
      return coded(code);
    }

    async function request(payload, o) {
      const cancelled = o && typeof o.cancelled === 'function' ? o.cancelled : null;
      const started = now();
      let busyTries = 0, transientTries = 0;
      for (;;) {
        await turn(cancelled, started + cfg.budgetMs);
        let res = null, failure = null;
        stats.sent++;
        if (inFlight > stats.peak) stats.peak = inFlight;
        try { res = await send(payload); } catch (e) { failure = e && e.code === 'TIMEOUT' ? 'TIMEOUT' : 'NETWORK'; } finally { release(); }

        if (res && res.status >= 200 && res.status < 300) {
          stats.ok++; giveUps = 0;
          if (++streak >= cfg.raiseAfter && allowed < cfg.maxConcurrent) { allowed++; streak = 0; }
          return res.body;
        }

        if (res && (res.retryable === false || res.stopRun)) {
          const code = res.code || 'HTTP_' + res.status;
          if (res.stopRun || REFUSED.indexOf(res.status) !== -1) tripped = code;
          throw coded(code);
        }

        if (res && BUSY.indexOf(res.status) !== -1) {
          stats.busy++;
          allowed = 1; streak = 0;
          // Three outcomes, never a fourth:
          //   no usable value (missing, malformed)  -> our own jittered backoff;
          //   a positive duration, however long     -> kept in full as "not before";
          //   ... and if that is further away than a request may wait, the request
          //   gives up and automatic re-asks are suspended (see autoRetryDelay).
          // How long a request may WAIT (budgetMs) and when the service may next be
          // asked (pausedUntil) are different things; a long value is never read as
          // "no value", which would mean coming back within a second.
          const ra = res.retryAfterMs;
          const asked = typeof ra === 'number' && isFinite(ra) && ra > 0 ? ra : 0;
          // Everyone refused together was told the same Retry-After: the jitter
          // on top is what keeps them from returning together.
          const wait = asked ? asked + random() * Math.min(cfg.capMs, cfg.baseMs * Math.pow(2, busyTries)) : backoff(busyTries);
          pausedUntil = Math.max(pausedUntil, now() + wait);
          busyTries++;
          if (busyTries >= cfg.maxBusyAttempts || now() - started + wait > cfg.budgetMs) throw giveUp('RATE_LIMITED');
          stats.retries++;
          continue;
        }

        if (res && REFUSED.indexOf(res.status) !== -1) {
          // The same key would be refused for every other message too.
          tripped = 'HTTP_' + res.status;
          throw coded(tripped);
        }

        const code = failure || (res && res.code) || 'HTTP_' + (res ? res.status : 0);
        if (res && res.status < 500) throw coded(code);          // 4xx: asking again changes nothing
        if (transientTries >= cfg.maxTransientRetries || now() - started > cfg.budgetMs) throw giveUp(code);
        await sleep(backoff(transientTries++));
        stats.retries++;
      }
    }

    // A new scan, or a new key, starts with a clean slate — but keeps the pause:
    // a service that said "busy" a second ago is still busy.
    function reset() { tripped = null; giveUps = 0; allowed = cfg.maxConcurrent; streak = 0; }

    // When the background may ask again by itself: not before the announced
    // pause is over, and not at all (null) when that is beyond the horizon — then
    // the page says until when, and a person decides.
    function autoRetryDelay(baseMs) {
      const paused = Math.max(0, pausedUntil - now());
      if (paused > cfg.autoRetryHorizonMs) return null;
      return Math.max(baseMs, paused + 5000 + random() * 30000);
    }

    function snapshot() { return { allowed, inFlight, waiting: waiting.length, pausedUntil: pausedUntil > now() ? pausedUntil : null, pausedForMs: Math.max(0, pausedUntil - now()), tripped, stats: Object.assign({}, stats) }; }

    return Object.freeze({ request, reset, snapshot, autoRetryDelay });
  }

  // Seconds or an HTTP date, as the Retry-After header allows. Anything that is
  // not a finite, non-negative duration is "no header" (null), never a guess.
  function parseRetryAfter(value, nowMs) {
    if (value === null || value === undefined || value === '') return null;
    const s = String(value).trim();
    let ms = null;
    if (/^\d{1,12}(\.\d{1,6})?$/.test(s)) ms = Math.round(parseFloat(s) * 1000);
    else if (/[a-z]/i.test(s)) { const t = Date.parse(s); if (isFinite(t)) ms = Math.max(0, t - nowMs); }
    return typeof ms === 'number' && isFinite(ms) && ms >= 0 ? ms : null;
  }

  return Object.freeze({ DEFAULTS, RUN_ENDING, RUN_PAUSING, create, isTransient, parseRetryAfter });
})();
