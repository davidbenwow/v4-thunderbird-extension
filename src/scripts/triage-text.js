// Text handling for the Today triage page: subject keys, display sanitising,
// authored-text extraction, redaction before a model call, hashing. Pure — no
// browser APIs, no DOM.
//
// Every input is untrusted mail content, so every function is total and
// linear-time: input is capped before any work, regexes are anchored or
// length-bounded, and scans a regex would make quadratic (trailing runs,
// e-mail local parts) are plain loops. A previous ReDoS in this repo came from
// an unbounded quantifier over a hostile header.

var TriageText = (function () {
  'use strict';

  const MAX_CHARS = 200000;
  const MAX_LINES = 2000;
  const MAX_SUBJECT = 1000;
  // Reply markers are short. Longer lines are never tested against them, which
  // bounds every per-line regex below.
  const MARKER_LINE_MAX = 300;

  // cleanName's class (C0/C1 controls, bidi overrides/isolates) plus zero-width
  // and invisible bidi marks.
  const INVISIBLE_RE = /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
  const INVISIBLE_KEEP_LINES_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
  // Controls that are whitespace: they must become a space, not vanish.
  const CONTROL_WS_RE = /[\t\n\u000B\f\r\u0085]/g;

  function cap(s, max) { return s.length > max ? s.slice(0, max) : s; }

  function posInt(n, fallback) {
    return typeof n === 'number' && isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
  }

  function isHighSurrogate(c) { return c >= 0xD800 && c <= 0xDBFF; }

  function clean(str, max) {
    return cap(str, max)
      .replace(CONTROL_WS_RE, ' ')
      .replace(INVISIBLE_RE, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function clip(s, maxLen, fallback) {
    const max = posInt(maxLen, fallback);
    if (s.length <= max) return s;
    let end = max - 1;
    if (end > 0 && isHighSurrogate(s.charCodeAt(end - 1))) end--;
    return s.slice(0, end) + '…';
  }

  // ---- subject ---------------------------------------------------------------

  const PREFIX_RE = /(?:re|aw|antw|sv|vs|fw|fwd|wg|tr|rv|res|enc|odp|r|отв|ответ|пересл)\.?\s{0,3}(?:\[\d{1,4}\]|\(\d{1,4}\))?\s{0,3}:\s{0,3}/y;
  const TAG_RE = /\[[^\[\]#]{0,40}#\d{1,40}[^\[\]]{0,40}\]\s{0,3}/y;
  const TRAILING = ' .,;:!?…';

  function normalizeSubject(subject) {
    if (typeof subject !== 'string' || !subject) return '';
    const s = clean(subject, MAX_SUBJECT).toLowerCase();
    let pos = 0;
    // Sticky matching from an index: slicing per prefix would be quadratic on
    // "re: re: re: ...".
    for (let i = 0; i < MAX_SUBJECT; i++) {
      PREFIX_RE.lastIndex = pos;
      let m = PREFIX_RE.exec(s);
      if (!m) { TAG_RE.lastIndex = pos; m = TAG_RE.exec(s); }
      if (!m) break;
      pos += m[0].length;
    }
    let end = s.length;
    while (end > pos && TRAILING.indexOf(s[end - 1]) !== -1) end--;
    return s.slice(pos, end);
  }

  // ---- display ---------------------------------------------------------------

  function sanitizeDisplay(str, maxLen) {
    if (typeof str !== 'string') return '';
    return clip(clean(str, MAX_CHARS), maxLen, 160);
  }

  function excerpt(text, maxLen) {
    if (typeof text !== 'string') return '';
    const limit = (typeof TriageSchema !== 'undefined' && TriageSchema.LIMITS &&
      TriageSchema.LIMITS.excerptDisplay) || 1200;
    return clip(clean(text, MAX_CHARS), maxLen, limit);
  }

  // ---- authored text ---------------------------------------------------------

  // `start` is what the line must open with unless it names the mailbox owner;
  // rules without one are accepted on the ending alone.
  const ATTRIBUTION = [
    { start: /^on\s/, end: 'wrote' },
    { start: /^am\s/, mid: /(?:^|\s)schrieb(?:\s|$)/ },
    { start: /^le\s/, end: 'a écrit' },
    { start: /^el\s/, end: 'escribió' },
    { start: null, end: 'a scris' },
    { start: null, end: 'пишет' },
    { start: null, end: 'написал' },
    { start: null, end: 'написала' },
    { start: null, end: 'написал(а)' }
  ];

  const ORIGINAL_MARKERS = ['original message', 'ursprüngliche nachricht', 'исходное сообщение',
    "message d'origine", 'mensaje original', 'mesaj original'];
  const FORWARD_MARKERS = ['forwarded message', 'weitergeleitete nachricht', 'пересылаемое сообщение',
    'перенаправленное сообщение', 'message transféré', 'mensaje reenviado'];
  const FORWARD_PLAIN = ['begin forwarded message:', 'anfang der weitergeleiteten nachricht:'];

  const HEADER_FROM_RE = /^\*{0,2}(?:from|von|de la|de|от)\s?:/;
  const HEADER_NEXT_RE = /^\*{0,2}(?:sent|gesendet|envoyé|enviado el|enviado|trimis|отправлено|date|datum|дата|to|an|à|para|către|кому|subject|betreff|objet|asunto|subiect|тема)\s?:/;

  const LETTER_RE = /[\p{L}\p{N}]/u;

  function ownerNames(opts) {
    const raw = opts && Array.isArray(opts.names) ? opts.names : [];
    const out = [];
    for (let i = 0; i < raw.length && i < 50 && out.length < 20; i++) {
      if (typeof raw[i] !== 'string') continue;
      const n = clean(raw[i], 200).toLowerCase();
      if (n.length >= 3) out.push(n);
    }
    // The owner's own addresses count as names: "… <editor@…> wrote:" in a
    // language we have no rule for is still recognisably an attribution.
    const addrs = opts && Array.isArray(opts.addresses) ? opts.addresses : [];
    for (let i = 0; i < addrs.length && i < 20 && out.length < 40; i++) {
      if (typeof addrs[i] !== 'string') continue;
      const a = clean(addrs[i], 320).toLowerCase();
      if (a.length >= 5 && a.indexOf('@') > 0) out.push(a);
    }
    return out;
  }

  function hasName(low, names) {
    for (let i = 0; i < names.length; i++) if (low.indexOf(names[i]) !== -1) return true;
    return false;
  }

  function endsWithWord(base, word) {
    if (!base.endsWith(word)) return false;
    const before = base.length - word.length - 1;
    return before < 0 || !LETTER_RE.test(base[before]);
  }

  // Returns the matching rule for a line that ends like an attribution, else
  // null. `low` is a lowercased line of at most 2 * MARKER_LINE_MAX chars.
  function attributionRule(low, names) {
    if (low.charCodeAt(low.length - 1) !== 58) return null;          // ':'
    const base = low.slice(0, -1).trimEnd();
    for (let i = 0; i < ATTRIBUTION.length; i++) {
      const r = ATTRIBUTION[i];
      if (r.mid ? r.mid.test(base) : endsWithWord(base, r.end)) return r;
    }
    // "<date>, Name <addr>:" — Gmail and Yandex in Russian-language locales.
    if (base.endsWith('>') && base.indexOf('@') !== -1 && /\p{N}/u.test(base)) return { start: null };
    // Any language: "<date> Name <addr> <short verb>:" — an address in angle
    // brackets, at most four words after it, and either a date on the line or
    // the mailbox owner's own name/address (Vietnamese, Arabic, … have no rule).
    const gt = base.lastIndexOf('>');
    const lt = base.lastIndexOf('<', gt);
    if (gt !== -1 && lt !== -1 && base.indexOf('@', lt) !== -1 && base.indexOf('@', lt) < gt) {
      const tail = base.slice(gt + 1).trim();
      const words = tail ? tail.split(/\s+/).length : 0;
      if (words <= 4 && (/\p{N}/u.test(base) || hasName(low, names || []))) return { start: null };
    }
    return null;
  }

  function isAttribution(low, names) {
    const r = attributionRule(low, names);
    return !!r && (!r.start || r.start.test(low) || hasName(low, names));
  }

  // An attribution wrapped over two lines. The second half is a short fragment
  // and the first half must look like a date/address/owner line, not a sentence
  // — otherwise an authored line above "Name wrote:" would be cut with it.
  function isWrappedAttribution(a, b, names) {
    if (b.split(/\s+/).length > 4) return false;
    if (/[.!?]$/.test(a)) return false;
    if (!/[\d@<]/.test(a) && !hasName(a, names)) return false;
    return isAttribution(a + ' ' + b, names);
  }

  function isRuleLine(t) {
    if (t.length < 10) return false;
    const c = t.charCodeAt(0);
    if (c !== 45 && c !== 95) return false;                          // '-' or '_'
    for (let i = 1; i < t.length; i++) if (t.charCodeAt(i) !== c) return false;
    return true;
  }

  // "-----Original Message-----", "---------- Forwarded message ---------"
  function dashedMarker(low) {
    let a = 0;
    let b = low.length;
    while (a < b && low.charCodeAt(a) === 45) a++;
    while (b > a && low.charCodeAt(b - 1) === 45) b--;
    if (a < 2 || low.length - b < 2) return null;
    const inner = low.slice(a, b).trim();
    if (ORIGINAL_MARKERS.indexOf(inner) !== -1) return 'original';
    if (FORWARD_MARKERS.indexOf(inner) !== -1) return 'forward';
    return null;
  }

  function lineForm(line) {
    const t = line.trim();
    let low = null;
    if (t.length <= MARKER_LINE_MAX) {
      low = t.replace(INVISIBLE_RE, '').replace(/[\u00A0\u202F]/g, ' ').trim().toLowerCase().normalize('NFC');
    }
    return { t, low, quoted: t.charCodeAt(0) === 62 };               // '>'
  }

  function cutKindAt(lines, forms, i, names) {
    const f = forms[i];
    const next = i + 1 < forms.length ? forms[i + 1] : null;
    if (f.quoted) return next && next.quoted ? 'quote' : null;
    if (f.t === '') return null;
    if (lines[i].trimEnd() === '--') return 'signature';
    if (isRuleLine(f.t)) return 'rule';
    if (f.low === null || f.low === '') return null;

    const dashed = dashedMarker(f.low);
    if (dashed) return dashed;
    if (FORWARD_PLAIN.indexOf(f.low) !== -1) return 'forward';

    if (HEADER_FROM_RE.test(f.low)) {
      for (let j = i + 1; j <= i + 4 && j < forms.length; j++) {
        if (forms[j].low !== null && HEADER_NEXT_RE.test(forms[j].low)) return 'header';
      }
    }

    if (isAttribution(f.low, names)) return 'attribution';
    if (next && next.low && !next.quoted && isWrappedAttribution(f.low, next.low, names)) return 'attribution';
    return null;
  }

  // Text between ">" lines after the cut. A wrapped "wrote:" fragment inside a
  // quote is not an answer.
  function hasInlineReply(forms, from) {
    let seenQuote = false;
    let pending = false;
    for (let i = from; i < forms.length; i++) {
      const f = forms[i];
      if (f.t === '') continue;
      if (f.quoted) {
        if (pending) return true;
        seenQuote = true;
      } else if (seenQuote && !(f.low && attributionRule(f.low))) {
        pending = true;
      }
    }
    return false;
  }

  function hasNonSpace(s, min) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c > 32 && c !== 160 && ++n >= min) return true;
    }
    return false;
  }

  function authoredText(text, opts) {
    if (typeof text !== 'string' || !text) return { text: '', ambiguous: false, reason: null };
    const src = cap(text, MAX_CHARS);
    const lines = src.split(/\r\n|\r|\n/, MAX_LINES);
    const forms = lines.map(lineForm);
    const names = ownerNames(opts);

    let cut = lines.length;
    let kind = null;
    for (let i = 0; i < lines.length; i++) {
      kind = cutKindAt(lines, forms, i, names);
      if (kind) { cut = i; break; }
    }

    const authored = lines.slice(0, cut).join('\n').trim();
    let reason = null;
    if (kind && hasInlineReply(forms, cut)) reason = 'inline_reply';
    else if (kind === 'forward' && authored.length < 20) reason = 'forward_only';
    else if (!authored && hasNonSpace(src, 20)) reason = 'empty_after_strip';
    return { text: authored, ambiguous: reason !== null, reason };
  }

  // ---- redaction -------------------------------------------------------------

  // Runs to whitespace (or a character no URL may contain) on purpose: stopping
  // earlier would leave the tail of a transfer link — the secret — in the text.
  const URL_RE = /(?:((?:https?|s?ftps?):\/\/)|(?<![\w@.\-])www\.)[^\s<>"]+/gi;
  const HOST_RE = /^[a-z0-9\u00A1-\uFFFF][a-z0-9\u00A1-\uFFFF.\-]{0,252}$/;
  const URL_TRAILING = '.,;:!?)';

  // ISBN-13 and full dates are digit runs a phone pattern would swallow.
  const KEEP_RE = /(?<!\d)(?:97[89](?:[- ]?\d){10}|\d{1,2}[.\/\-]\d{1,2}[.\/\-](?:19|20)\d\d|(?:19|20)\d\d[.\/\-]\d{1,2}[.\/\-]\d{1,2})(?!\d)/g;
  // Not after a letter, digit or "#": that is an id, not a phone number.
  const PHONE_RE = /(?<![\w#])\+?\(?\d(?:[ \t\u00A0.\-()]{0,3}\d){8,}/g;

  function hostOf(url, start) {
    let auth = url.slice(start, start + 2048);
    const stop = auth.search(/[\/?#\\]/);
    if (stop !== -1) auth = auth.slice(0, stop);
    auth = auth.slice(auth.lastIndexOf('@') + 1);
    const colon = auth.indexOf(':');
    if (colon !== -1) auth = auth.slice(0, colon);
    let end = auth.length;
    while (end > 0 && auth.charCodeAt(end - 1) === 46) end--;
    auth = auth.slice(0, end).toLowerCase();
    return HOST_RE.test(auth) ? auth : '';
  }

  function isAsciiAlnum(c) {
    return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  }
  function isWordChar(s, i) {
    const c = s.charCodeAt(i);
    return isAsciiAlnum(c) || (c > 127 && LETTER_RE.test(s[i]));
  }
  function isLocalChar(s, i) {
    const c = s.charCodeAt(i);                                       // . _ % + -
    return c === 46 || c === 95 || c === 37 || c === 43 || c === 45 || isWordChar(s, i);
  }
  function isDomainChar(s, i) {
    const c = s.charCodeAt(i);
    return c === 46 || c === 45 || isWordChar(s, i);
  }

  function isDomain(d) {
    const dot = d.lastIndexOf('.');
    if (dot <= 0) return false;
    const tld = d.slice(dot + 1);
    return tld.length >= 2 && !/^\d+$/.test(tld);
  }

  // Walks outward from each "@" with bounded scans. The usual address regex is
  // quadratic on a long run of local-part characters with no "@".
  function maskEmails(s) {
    const parts = [];
    let last = 0;
    let at = s.indexOf('@');
    while (at !== -1) {
      let a = at;
      while (a > last && at - a < 64 && isLocalChar(s, a - 1)) a--;
      while (a < at && s.charCodeAt(a) === 46) a++;
      let b = at + 1;
      while (b < s.length && b - at <= 255 && isDomainChar(s, b)) b++;
      while (b > at + 1 && (s.charCodeAt(b - 1) === 46 || s.charCodeAt(b - 1) === 45)) b--;
      if (a < at && isDomain(s.slice(at + 1, b))) {
        parts.push(s.slice(last, a), '[email]');
        last = b;
      }
      at = s.indexOf('@', at + 1);
    }
    parts.push(s.slice(last));
    return parts.join('');
  }

  const MARK = ' [\u2026]';

  function redactForModel(text, maxChars) {
    if (typeof text !== 'string' || !text) return '';
    const max = posInt(maxChars, 4000);
    // Invisible characters go first: a zero-width space inside an address or a
    // link would otherwise carry it past the patterns below.
    let s = cap(text, MAX_CHARS).replace(INVISIBLE_KEEP_LINES_RE, '').replace(/\r\n?/g, '\n');

    // Links and kept digit runs sit behind placeholders (U+0000 / U+0001, both
    // stripped from the input above) so later passes cannot rewrite a host
    // such as 192.168.100.200 or an ISBN next to a phone number.
    const links = [];
    s = s.replace(URL_RE, (m, scheme) => {
      let end = m.length;
      while (end > 0 && URL_TRAILING.indexOf(m[end - 1]) !== -1) end--;
      const host = hostOf(m.slice(0, end), scheme ? scheme.length : 0);
      if (!scheme && host.indexOf('.') === -1) return m;
      links.push(host ? '[link: ' + host + ']' : '[link]');
      return '\u0000' + m.slice(end);
    });

    s = maskEmails(s);

    const kept = [];
    s = s.replace(KEEP_RE, (m) => { kept.push(m); return '\u0001'; });
    s = s.replace(PHONE_RE, '[phone]');

    let k = 0;
    let l = 0;
    s = s.replace(/\u0001/g, () => kept[k++]).replace(/\u0000/g, () => links[l++]);

    s = s.replace(/[ \t\u00A0]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

    if (s.length <= max) return s;
    // The cut mark counts towards the limit: `maxChars` is a promise to the
    // gateway, which refuses anything longer.
    const room = Math.max(1, max - MARK.length);
    let end = room;
    while (end > 0 && s.charCodeAt(end) !== 32 && s.charCodeAt(end) !== 10) end--;
    if (end === 0) {
      end = room;
      if (isHighSurrogate(s.charCodeAt(end - 1))) end--;
    }
    return s.slice(0, end).trimEnd() + MARK;
  }

  // ---- hash ------------------------------------------------------------------

  // cyrb53. Not capped: it is one pass, and capping would make long texts that
  // differ only in their tail collide.
  function hashString(str) {
    const s = typeof str === 'string' ? str : '';
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
  }

  // ---- message body -----------------------------------------------------------
  // The text a person wrote, with its line structure intact — authoredText cuts
  // quotes line by line. Plain-text parts win; HTML is only a fallback and is
  // never merged with the plain copy of the same message (that would double the
  // text and blur where the quote starts). Attachments are skipped.
  // Newsletters pad their layout with zero-width entities; left undecoded they
  // arrive at the model as literal "&zwnj;" runs. Invisible ones become nothing,
  // spacing ones a space.
  const ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', hairsp: ' ', numsp: ' ', puncsp: ' ',
    zwnj: '', zwj: '', shy: '', lrm: '', rlm: '', wj: '', feff: '',
    mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', bull: '\u2022', middot: '\u00b7',
    lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', laquo: '\u00ab', raquo: '\u00bb',
    euro: '\u20ac', pound: '\u00a3', copy: '\u00a9', reg: '\u00ae', trade: '\u2122', deg: '\u00b0'
  };

  const BREAK_TAGS = { br: 1, p: 1, div: 1, tr: 1, li: 1, table: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1 };
  const SKIP_TAGS = { script: 1, style: 1, head: 1 };

  // A <blockquote> is quoted history, and authoredText reads the flattened text
  // line by line: EVERY line the quote covers must carry the marker, not just
  // the first, or the tail of the quote arrives at the model as authored text.
  // Depth is capped so mail nesting thousands of blockquotes cannot make the
  // prefix — and with it the output — quadratic.
  const QUOTE_MAX = 8;
  const QUOTE_PREFIX = [''];
  for (let d = 1; d <= QUOTE_MAX; d++) QUOTE_PREFIX.push('>'.repeat(d) + ' ');
  function quoteMark(depth) { return QUOTE_PREFIX[depth < QUOTE_MAX ? depth : QUOTE_MAX]; }

  // One left-to-right pass. A regex per tag rescans from every "<" and goes
  // quadratic on hostile mail; here every character is looked at once, and the
  // position of the next ">" is remembered instead of searched for again.
  function htmlToText(html) {
    // Line endings are normalised first: a lone "\r" inside a blockquote would
    // otherwise open a line that authoredText counts but that carries no marker.
    const s = cap(String(html), MAX_CHARS).replace(/\r\n?/g, '\n');
    const lower = s.toLowerCase();
    let out = '', i = 0, gt = -1, depth = 0, mark = '';
    // Text between tags may hold source newlines; inside a quote they open a
    // line like any other, so they take the marker too.
    const put = (chunk) => { out += mark ? chunk.replace(/\n/g, '\n' + mark) : chunk; };
    while (i < s.length) {
      const lt = s.indexOf('<', i);
      if (lt === -1) { put(s.slice(i)); break; }
      put(s.slice(i, lt));
      if (gt !== -2 && gt <= lt) { gt = s.indexOf('>', lt + 1); if (gt === -1) gt = -2; }
      if (gt === -2 || gt - lt > 5000) { out += '<'; i = lt + 1; continue; }
      const m = /^<\s*(\/?)\s*([a-z][a-z0-9]{0,15})/.exec(lower.slice(lt, lt + 40));
      const closing = !!(m && m[1]);
      const name = m ? m[2] : '';
      i = gt + 1;
      if (SKIP_TAGS[name] && !closing) {
        const close = lower.indexOf('</' + name, i);
        if (close === -1) break;
        const after = s.indexOf('>', close);
        i = after === -1 ? s.length : after + 1;
        gt = -1;
      } else if (name === 'blockquote') {
        if (closing) { if (depth > 0) depth--; mark = quoteMark(depth); out += '\n' + mark; }
        // An opening quote emits a marker-only line before its first line of
        // text. authoredText only trusts a run of two quoted lines — plain-text
        // ">" alone has false positives — so a one-line blockquote would
        // otherwise still read as authored text. Here the boundary is known, and
        // this is what states it, without loosening the plain-text rule.
        else { depth++; mark = quoteMark(depth); out += '\n' + mark + '\n' + mark; }
      } else if (BREAK_TAGS[name] && (closing || name === 'br')) out += '\n' + mark;
    }
    out = out.replace(/&#(\d{1,7});/g, (x, d) => { const n = +d; return n > 31 && n < 0x110000 ? String.fromCodePoint(n) : ' '; });
    out = out.replace(/&([a-z]{2,8});/gi, (x, name) => (Object.prototype.hasOwnProperty.call(ENTITIES, name.toLowerCase()) ? ENTITIES[name.toLowerCase()] : x));
    return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  }

  function isAttachment(part) {
    const cd = part && part.headers && part.headers['content-disposition'];
    const v = Array.isArray(cd) ? cd[0] : cd;
    return !!(part && part.name) || (typeof v === 'string' && /^\s*attachment/i.test(v));
  }

  function bodyFromParts(full) {
    const plain = [], html = [];
    let budget = 400;
    (function walk(part) {
      if (!part || typeof part !== 'object' || budget-- <= 0 || isAttachment(part)) return;
      const type = typeof part.contentType === 'string' ? part.contentType.toLowerCase() : '';
      if (typeof part.body === 'string' && part.body) {
        if (type.indexOf('text/plain') === 0) plain.push(part.body);
        else if (type.indexOf('text/html') === 0) html.push(part.body);
      }
      if (Array.isArray(part.parts)) for (const p of part.parts) walk(p);
    })(full);
    const text = plain.length ? plain.join('\n') : html.map(htmlToText).join('\n');
    return cap(text, MAX_CHARS);
  }

  return Object.freeze({ normalizeSubject, sanitizeDisplay, authoredText, redactForModel, excerpt, hashString, htmlToText, bodyFromParts });
})();
