// Code-only facts for the Today triage page: who a message is from, whether it
// is a platform notification, what files and identifiers it mentions, and which
// dates appear in it. Pure functions — no browser APIs, no network.
//
// Everything here reads untrusted mail. Inputs are capped before any regex
// runs and every quantifier is bounded, so a hostile message cannot stall the
// background page.

var TriageRules = (function () {
  'use strict';

  const MAX_TEXT = 200000;
  const MAX_FIELD = 120;

  function str(v) { return typeof v === 'string' ? v : ''; }
  function capped(v) { const s = str(v); return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s; }
  function lower(v) { return str(v).trim().toLowerCase(); }

  function cleanField(v) {
    const s = str(v)
      .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    return s.length > MAX_FIELD ? s.slice(0, MAX_FIELD - 1) + '…' : s;
  }

  // ---- system notifications -------------------------------------------------
  // Subject shapes taken from the platform's real notifications. Matching is on
  // the subject only; classifyDirection additionally requires an INTERNAL
  // sender, so an outside author cannot fake a system event with a subject line.
  const SYSTEM_SUBJECTS = [
    ['manuscript_submitted', /^\s*manuscript approved\b/i],
    ['manuscripts_transferred', /^\s*manuscripts? transferred\b/i],
    ['publication', /^\s*publication of project\b/i],
    ['book_notice', /^\s*your book\b.{0,80}\bhas been released\b/i],
    ['book_launch_offer', /\bget ready for your book.{0,3}s launch\b/i],
    ['voucher', /\bvoucher\b/i]
  ];

  const SYSTEM_LABELS = ['author', 'title', 'imprint', 'language', 'isbn', 'project', 'comments'];

  function systemTypeOfSubject(subject) {
    const s = str(subject).slice(0, 300);
    for (const [type, re] of SYSTEM_SUBJECTS) if (re.test(s)) return type;
    return null;
  }

  function parseLabelledFields(text) {
    const out = {};
    const lines = capped(text).split('\n', 200);
    for (const raw of lines) {
      const line = raw.slice(0, 400);
      const m = /^\s*([A-Za-z][A-Za-z \-]{1,24}?)\s*:\s+(\S.*)$/.exec(line);
      if (!m) continue;
      const label = m[1].trim().toLowerCase();
      if (SYSTEM_LABELS.indexOf(label) === -1 || out[label] !== undefined) continue;
      out[label] = cleanField(m[2]);
    }
    return out;
  }

  function parseSystemEvent(header, text) {
    const type = systemTypeOfSubject(header && header.subject);
    if (!type) return null;
    const refs = extractRefsMentioned(header && header.subject, text);
    return { type, isbn: refs.isbns[0] || null, fields: parseLabelledFields(text) };
  }

  // ---- direction ------------------------------------------------------------
  // Platform mail sent under the editor's own address (reminders, offers). An
  // outbound message matching these is never counted as "the editor replied".
  const AUTOMATED_OUTBOUND = [
    /^\s*reviewing your manuscript\b/i,
    /^\s*awaiting your manuscript\b/i,
    /^\s*inquiry regarding\b.{0,120}\bwork\s*$/i,
    /\bpublish your research as a book\s*$/i,
    /\bget ready for your book.{0,3}s launch\b/i
  ];

  const REPLY_PREFIX = /^\s*(?:re|aw|antw|sv|vs|odp|отв|ответ)\s*(?:\[\d{1,3}\]|\(\d{1,3}\))?\s*:/i;

  function outboundAutomation(subject) {
    const s = str(subject).slice(0, 300);
    for (const re of AUTOMATED_OUTBOUND) if (re.test(s)) return true;
    // A reply prefix is the only header-level sign of a hand-written answer.
    // Everything else stays unknown rather than being assumed human.
    return REPLY_PREFIX.test(s) ? false : null;
  }

  // header: { from:{address}, subject }.  ctx: { me: Set<lowercased address>, isInternal(address) }
  function classifyDirection(header, ctx) {
    const from = lower(header && header.from && header.from.address);
    const subject = header && header.subject;
    const me = ctx && ctx.me;
    const isInternal = ctx && typeof ctx.isInternal === 'function' ? ctx.isInternal : () => false;

    if (from && me && typeof me.has === 'function' && me.has(from)) {
      return { dir: 'outbound', sysType: null, auto: outboundAutomation(subject) };
    }
    if (from && isInternal(from)) {
      const sysType = systemTypeOfSubject(subject);
      return sysType
        ? { dir: 'system', sysType, auto: true }
        : { dir: 'internal', sysType: null, auto: null };
    }
    return { dir: 'inbound', sysType: null, auto: null };
  }

  // ---- files ----------------------------------------------------------------
  const FILE_KINDS = {
    document: ['doc', 'docx', 'pdf', 'odt', 'rtf', 'tex'],
    image: ['png', 'jpg', 'jpeg', 'gif', 'tif', 'tiff', 'bmp', 'webp', 'heic'],
    archive: ['zip', 'rar', '7z'],
    sheet: ['xls', 'xlsx', 'csv']
  };

  // Filenames often carry the author's name, so the model never sees them. It
  // gets this code-made hint instead.
  const NAME_HINTS = [
    ['manuscript', /manuscript|monograph|thesis|dissertat|chapter|book|article|paper|рукопис|монограф|диссертац|статья|kitob|monografiya|maqola|qo.?llanma|carte|manuscris|lucrare|tez[aă]/i],
    ['form_or_payment', /passport|contract|agreement|invoice|receipt|payment|transfer|bank|authori[sz]|consent|permission|declarat|certificate|паспорт|договор|соглас|квитанц|оплат|shartnoma|to.?lov|chitanta|factura|acord/i],
    ['image_or_cover', /cover|photo|foto|portrait|picture|image|scan|обложк|фото|muqova|rasm|copert/i]
  ];

  function extOf(name) {
    const m = /\.([A-Za-z0-9]{1,8})\s*(?:\([^)]{0,30}\))?\s*$/.exec(str(name).slice(-60));
    return m ? m[1].toLowerCase() : '';
  }

  function extractFileSignals(names) {
    const out = [];
    const list = Array.isArray(names) ? names.slice(0, 20) : [];
    for (const n of list) {
      const name = cleanField(n);
      if (!name) continue;
      const ext = extOf(name);
      let kind = 'other';
      for (const k of Object.keys(FILE_KINDS)) if (FILE_KINDS[k].indexOf(ext) !== -1) { kind = k; break; }
      // A filename can match more than one hint, and "book" is in the manuscript
      // pattern while "receipt" and "invoice" are in the payment one — so
      // `book-payment-receipt.pdf` matched both and, first match winning, was
      // called a manuscript and put at the top of the list. Paperwork wording is
      // specific where "book" is generic, so it decides.
      let hint = 'unknown';
      const matched = NAME_HINTS.filter(([, re]) => re.test(name)).map(([h]) => h);
      if (matched.length) hint = matched.indexOf('form_or_payment') !== -1 ? 'form_or_payment' : matched[0];
      if (hint === 'unknown' && kind === 'image') hint = 'image_or_cover';
      out.push({ name, ext, kind, hint });
    }
    return out;
  }

  // ---- identifiers ----------------------------------------------------------
  const ISBN_RE = /\b97[89][- ]?\d{1,5}[- ]?\d{1,7}[- ]?\d{1,7}[- ]?\d\b/g;
  const TICKET_RE = /\[ticket#(\d{6,20})\]/gi;
  const PROJECT_RE = /\bproject\s*(?:id|no\.?|number|#)?\s*[:#]?\s*(\d{3,9})\b/gi;

  function pushUnique(list, value, max) {
    if (value && list.indexOf(value) === -1 && list.length < max) list.push(value);
  }

  // A mention is not an association: the page shows these as "mentioned", and a
  // message quoting three books yields three candidates, not one answer.
  function extractRefsMentioned(subject, text) {
    const hay = (str(subject).slice(0, 300) + '\n' + capped(text));
    const isbns = [], ticketIds = [], projectIds = [];
    let m;
    ISBN_RE.lastIndex = 0;
    while ((m = ISBN_RE.exec(hay)) && isbns.length < 5) {
      const digits = m[0].replace(/[- ]/g, '');
      if (digits.length === 13) pushUnique(isbns, m[0].replace(/ /g, '-'), 5);
    }
    TICKET_RE.lastIndex = 0;
    while ((m = TICKET_RE.exec(hay)) && ticketIds.length < 5) pushUnique(ticketIds, m[1], 5);
    PROJECT_RE.lastIndex = 0;
    while ((m = PROJECT_RE.exec(hay)) && projectIds.length < 5) pushUnique(projectIds, m[1], 5);
    return { isbns, ticketIds, projectIds };
  }

  // ---- dates ----------------------------------------------------------------
  // Jev reads dates as text and cannot order them, so code finds the candidates
  // and does the arithmetic; the model only picks which candidate is meant.
  const MONTHS = [
    ['jan', 'январ', 'ianuar', 'yanvar'], ['feb', 'феврал', 'februar', 'fevral'],
    ['mar', 'март', 'marti', 'mart'], ['apr', 'апрел', 'april', 'aprel'],
    ['may', 'мая', 'mai', 'may'], ['jun', 'июн', 'iuni', 'iyun'],
    ['jul', 'июл', 'iuli', 'iyul'], ['aug', 'август', 'august', 'avgust'],
    ['sep', 'сентябр', 'septembr', 'sentabr'], ['oct', 'октябр', 'octombr', 'oktabr'],
    ['nov', 'ноябр', 'noiembr', 'noyabr'], ['dec', 'декабр', 'decembr', 'dekabr']
  ];
  const MONTH_WORD = /[A-Za-zА-Яа-яЁёĂăÂâÎîȘșȚț]{3,12}/.source;

  function monthIndex(word) {
    const w = lower(word);
    if (w.length < 3) return -1;
    for (let i = 0; i < 12; i++) for (const stem of MONTHS[i]) if (w.indexOf(stem) === 0) return i;
    return -1;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function isoFor(year, month, day, nowMs) {
    const now = new Date(nowMs);
    let y = year;
    if (!y) {
      y = now.getFullYear();
      // Without a year, a date more than a month in the past means next year.
      if (Date.UTC(y, month, day) < nowMs - 30 * 86400000) y += 1;
    }
    if (month < 0 || month > 11 || day < 1 || day > 31 || y < 2000 || y > 2100) return null;
    const d = new Date(Date.UTC(y, month, day));
    if (d.getUTCMonth() !== month) return null;
    return `${y}-${pad(month + 1)}-${pad(day)}`;
  }

  function extractDateCandidates(text, nowMs) {
    const hay = capped(text).slice(0, 20000);
    const now = typeof nowMs === 'number' ? nowMs : Date.now();
    const out = [];
    const seen = new Set();
    function add(raw, iso, kind) {
      const key = lower(raw);
      if (!iso || seen.has(key) || seen.has(iso + kind) || out.length >= 8) return;
      seen.add(key); seen.add(iso + kind);
      out.push({ raw: cleanField(raw), iso, kind });
    }
    let m;
    const isoRe = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g;
    while ((m = isoRe.exec(hay))) add(m[0], isoFor(+m[1], +m[2] - 1, +m[3], now), 'date');
    const dmyRe = /\b(\d{1,2})[./](\d{1,2})[./](20\d{2}|\d{2})\b/g;
    while ((m = dmyRe.exec(hay))) add(m[0], isoFor(+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[2] - 1, +m[1], now), 'date');
    const dMonRe = new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(' + MONTH_WORD + ')(?:\\s+(20\\d{2}))?', 'g');
    while ((m = dMonRe.exec(hay))) {
      const mi = monthIndex(m[2]);
      if (mi !== -1) add(m[0], isoFor(m[3] ? +m[3] : 0, mi, +m[1], now), 'date');
    }
    const monDRe = new RegExp('\\b(' + MONTH_WORD + ')\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b', 'g');
    while ((m = monDRe.exec(hay))) {
      const mi = monthIndex(m[1]);
      if (mi !== -1) add(m[0], isoFor(m[3] ? +m[3] : 0, mi, +m[2], now), 'date');
    }
    const monRe = new RegExp('(?:^|[^A-Za-zА-Яа-яЁё])(' + MONTH_WORD + ')(?![A-Za-zА-Яа-яЁё])', 'g');
    while ((m = monRe.exec(hay))) {
      const mi = monthIndex(m[1]);
      // "may", "march" and "mart" are ordinary words; a bare month only counts
      // when nothing more precise was found for that month.
      if (mi === -1 || /^(may|mai|mar|march|mart|marti)$/i.test(m[1])) continue;
      const iso = isoFor(0, mi, 1, now);
      if (iso && !out.some((c) => c.iso.slice(0, 7) === iso.slice(0, 7))) add(m[1], iso, 'month');
    }
    return out;
  }

  // A message that SAYS it is automated (RFC 3834 and the usual vendor headers).
  // Not an attempt to detect every robot: only a refusal to take a message that
  // declares itself automatic for something the editor wrote. `headers` is the
  // lower-cased name -> [values] map of messages.getFull().
  // Headers that say the message went to a LIST rather than to this editor: the
  // unsubscribe and list machinery of RFC 2369/8058, the complaint-feedback
  // addresses, and the campaign identifiers a platform stamps on a send that had
  // many recipients. Nothing here reads the body, so marketing copy cannot argue
  // its way out and a colleague cannot fall in.
  const LIST_HEADERS = [
    'list-unsubscribe', 'list-unsubscribe-post', 'list-id', 'list-post', 'list-help', 'list-owner', 'list-archive',
    'feedback-id', 'x-feedback-id', 'x-csa-complaints', 'x-report-abuse', 'x-report-abuse-to',
    'x-campaign-id', 'x-campaignid', 'x-mailer-lid', 'x-marketing-campaign',
    'x-mailchimp-campaign-id', 'x-mailjet-campaign', 'x-rpcampaign', 'x-mailgun-campaign-id'
  ];
  // Headers that only say WHICH SERVICE carried the message. A company sends its
  // invoices, password resets, delivery notices — and sometimes a real person's
  // reply — through the same platform as its newsletter, and every one of those
  // messages gets a routing id. On its own that identifies the transport, never
  // the editor's obligation, so it must not move a row anywhere.
  const ESP_TRANSPORT_HEADERS = [
    'x-mc-user', 'x-sg-eid', 'x-sendgrid-eid', 'x-sib-id',
    'x-klaviyo-message-id', 'x-hubspot-msgid', 'x-ac-messageid'
  ];
  const BULK_MAILERS = /(mailchimp|sendgrid|sendinblue|brevo|mailjet|klaviyo|hubspot|activecampaign|rapidmail|cleverreach|mailerlite|constantcontact|campaignmonitor|salesforce|marketo|braze|iterable|customer\.io|omnisend|getresponse|newsletter2go|inxmail)/i;

  function declaresBulk(headers) {
    const h = headers && typeof headers === 'object' ? headers : {};
    for (const name of LIST_HEADERS) if (name in h) return true;
    const first = (name) => { const v = h[name]; return lower(Array.isArray(v) ? v[0] : v).trim(); };
    return /^(bulk|junk|list)\b/.test(first('precedence'));
  }

  // "Sent through a mass-mailing platform", which is not the same statement as
  // "sent to a mailing list" and carries none of its consequences.
  function declaresEspTransport(headers) {
    const h = headers && typeof headers === 'object' ? headers : {};
    for (const name of ESP_TRANSPORT_HEADERS) if (name in h) return true;
    const first = (name) => { const v = h[name]; return lower(Array.isArray(v) ? v[0] : v).trim(); };
    return BULK_MAILERS.test(first('x-mailer')) || BULK_MAILERS.test(first('x-sender')) || BULK_MAILERS.test(first('x-csa-complaints'));
  }

  function declaresAutomation(headers) {
    const h = headers && typeof headers === 'object' ? headers : {};
    const first = (name) => { const v = h[name]; return lower(Array.isArray(v) ? v[0] : v).trim(); };
    const auto = first('auto-submitted');
    if (auto && auto.indexOf('no') !== 0) return true;
    for (const name of ['x-autoreply', 'x-autorespond', 'x-autoresponder', 'x-auto-reply']) if (name in h && first(name) !== 'no') return true;
    return /^(bulk|junk|list|auto[_-]?reply)\b/.test(first('precedence'));
  }

  return Object.freeze({
    systemTypeOfSubject, parseSystemEvent, outboundAutomation, classifyDirection,
    extractFileSignals, extractRefsMentioned, extractDateCandidates,
    declaresAutomation, declaresBulk, declaresEspTransport });
})();
