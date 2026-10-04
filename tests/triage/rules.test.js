// Synthetic fixtures only — this repository is public.
(function () {
  const R = TriageRules;
  const ME = new Set(['editor@imprint.example']);
  const ctx = { me: ME, isInternal: (a) => /@(imprint|platform)\.example$/.test(a) };
  const NOW = Date.UTC(2026, 8, 20);                       // 20 Sep 2026

  // ---- system notifications ----
  test('rules: real notification subjects map to their system type', () => {
    eq(R.systemTypeOfSubject('Manuscript Approved'), 'manuscript_submitted');
    eq(R.systemTypeOfSubject('Manuscripts Transferred'), 'manuscripts_transferred');
    eq(R.systemTypeOfSubject('Publication of Project 978-620-0-12345-6'), 'publication');
    eq(R.systemTypeOfSubject('Your book 978-620-0-12345-6 has been released'), 'book_notice');
    eq(R.systemTypeOfSubject("Jane Roe, get ready for your book's launch!"), 'book_launch_offer');
    eq(R.systemTypeOfSubject('Bundle offer Voucher 978-620-0-12345-6'), 'voucher');
  });

  test('rules: near-miss subjects are not system events', () => {
    eq(R.systemTypeOfSubject('Re: my manuscript was approved?'), null);
    eq(R.systemTypeOfSubject('Question about publication'), null);
    eq(R.systemTypeOfSubject(''), null);
    eq(R.systemTypeOfSubject(null), null);
  });

  test('rules: an OUTSIDE sender cannot fake a system event with the subject line', () => {
    const d = R.classifyDirection({ from: { address: 'author@example.org' }, subject: 'Manuscript Approved' }, ctx);
    eq(d, { dir: 'inbound', sysType: null, auto: null });
  });

  test('rules: internal sender + system subject is a system event', () => {
    const d = R.classifyDirection({ from: { address: 'noreply@platform.example' }, subject: 'Manuscript Approved' }, ctx);
    eq(d, { dir: 'system', sysType: 'manuscript_submitted', auto: true });
  });

  test('rules: internal sender without a system subject is internal, automation unknown', () => {
    const d = R.classifyDirection({ from: { address: 'Colleague@Imprint.example' }, subject: 'Re: [Ticket#2026091912345678] Failed GLE 978-620-0-12345-6' }, ctx);
    eq(d, { dir: 'internal', sysType: null, auto: null });
  });

  test('rules: parseSystemEvent reads labelled fields and the ISBN', () => {
    const ev = R.parseSystemEvent(
      { subject: 'Publication of Project 978-620-0-12345-6' },
      'Imprint: GlobeEdit\nISBN: 978-620-0-12345-6\nProject: Sample Title\nURL: https://platform.example/p/1\n');
    eq(ev.type, 'publication');
    eq(ev.isbn, '978-620-0-12345-6');
    eq(ev.fields.imprint, 'GlobeEdit');
    eq(ev.fields.project, 'Sample Title');
  });

  test('rules: labelled fields are cleaned and capped', () => {
    const ev = R.parseSystemEvent({ subject: 'Manuscript Approved' },
      'Author: Jane\u202E Roe\nTitle: ' + 'x'.repeat(400) + '\nLanguage: Uzbek\n');
    assert.ok(!/\u202E/.test(ev.fields.author));
    assert.ok(ev.fields.title.length <= 120);
    eq(ev.fields.language, 'Uzbek');
  });

  // ---- direction / automation ----
  test('rules: platform reminders sent under the editor address are automated outbound', () => {
    for (const s of ['Reviewing your manuscript, Jane Roe', 'Awaiting your manuscript, Jane Roe',
                     'Inquiry regarding Jane Roe work', 'Jane Roe - publish your research as a book',
                     "Jane Roe, get ready for your book's launch!"]) {
      eq(R.classifyDirection({ from: { address: 'EDITOR@imprint.example' }, subject: s }, ctx),
         { dir: 'outbound', sysType: null, auto: true }, s);
    }
  });

  test('rules: an outbound reply is human; any other outbound stays unknown, never assumed human', () => {
    eq(R.outboundAutomation('Re: Your cover'), false);
    eq(R.outboundAutomation('AW: Ihr Manuskript'), false);
    eq(R.outboundAutomation('Отв: Ваша рукопись'), false);
    eq(R.outboundAutomation('Your cover is ready for review'), null);
  });

  test('rules: classifyDirection is total on garbage', () => {
    eq(R.classifyDirection(null, null).dir, 'inbound');
    eq(R.classifyDirection({}, {}).dir, 'inbound');
    eq(R.classifyDirection({ from: { address: 42 } }, ctx).dir, 'inbound');
  });

  // ---- files ----
  test('rules: file kinds and hints', () => {
    const f = R.extractFileSignals(['Monografiya_final.docx', 'passport-scan.PDF', 'cover.jpg', 'data.xlsx', 'notes']);
    eq(f.map((x) => [x.ext, x.kind, x.hint]), [
      ['docx', 'document', 'manuscript'], ['pdf', 'document', 'form_or_payment'],
      ['jpg', 'image', 'image_or_cover'], ['xlsx', 'sheet', 'unknown'], ['', 'other', 'unknown']]);
  });

  // "book" is in the manuscript pattern and "receipt" in the paperwork one, so
  // a supplier's receipt was read as an arriving manuscript and went to the top
  // of the list. Paperwork wording is specific; "book" is not.
  test('rules: paperwork wording beats a generic "book" in the same filename', () => {
    for (const name of ['book-payment-receipt.pdf', 'Book invoice 2026.pdf', 'chapter-contract.docx', 'Book_transfer_confirmation.pdf']) {
      eq(R.extractFileSignals([name])[0].hint, 'form_or_payment', name);
    }
    // A manuscript is still a manuscript.
    for (const name of ['My book.docx', 'Monografiya_final.docx', 'chapter 3 revised.doc']) {
      eq(R.extractFileSignals([name])[0].hint, 'manuscript', name);
    }
  });

  test('rules: a size suffix after the extension does not hide it', () => {
    eq(R.extractFileSignals(['thesis.pdf (2.3 MB)'])[0].ext, 'pdf');
  });

  test('rules: Russian and Romanian filename hints', () => {
    eq(R.extractFileSignals(['Рукопись.docx'])[0].hint, 'manuscript');
    eq(R.extractFileSignals(['chitanta_plata.pdf'])[0].hint, 'form_or_payment');
  });

  test('rules: file list is capped and total', () => {
    eq(R.extractFileSignals(new Array(50).fill('a.pdf')).length, 20);
    eq(R.extractFileSignals(null), []);
    eq(R.extractFileSignals([null, 3, '']), []);
  });

  // ---- identifiers ----
  test('rules: ISBN-13, ticket and project mentions', () => {
    const r = R.extractRefsMentioned('Re: [Ticket#2026091912345678] Failed GLE 978-620-0-12345-6',
      'See also 978 620 0 54321 7 and project #48213. Project ID: 48213 again.');
    eq(r.isbns, ['978-620-0-12345-6', '978-620-0-54321-7']);
    eq(r.ticketIds, ['2026091912345678']);
    eq(r.projectIds, ['48213']);
  });

  test('rules: a phone number is not an ISBN', () => {
    eq(R.extractRefsMentioned('', 'call +373 69 123 456 or 979123').isbns, []);
  });

  test('rules: several books yield several candidates, capped at five', () => {
    const many = Array.from({ length: 9 }, (_, i) => `978-620-0-1234${i}-1`).join(' ');
    eq(R.extractRefsMentioned('', many).isbns.length, 5);
  });

  // ---- dates ----
  test('rules: numeric and ISO dates', () => {
    const c = R.extractDateCandidates('Deadline 05.10.2026, or 2026-11-01, or 7/12/26.', NOW);
    eq(c.map((x) => x.iso), ['2026-11-01', '2026-10-05', '2026-12-07']);
  });

  test('rules: day + month name in English, Russian, Romanian, Uzbek', () => {
    eq(R.extractDateCandidates('I will send it on 5 October.', NOW)[0].iso, '2026-10-05');
    eq(R.extractDateCandidates('October 5th, 2026 works for me', NOW)[0].iso, '2026-10-05');
    eq(R.extractDateCandidates('Отправлю 12 ноября', NOW)[0].iso, '2026-11-12');
    eq(R.extractDateCandidates('Trimit pe 3 octombrie', NOW)[0].iso, '2026-10-03');
    eq(R.extractDateCandidates('15 oktabrda yuboraman', NOW)[0].iso, '2026-10-15');
  });

  test('rules: a bare month becomes a month candidate', () => {
    eq(R.extractDateCandidates("I'll update you in October.", NOW), [{ raw: 'October', iso: '2026-10-01', kind: 'month' }]);
  });

  test('rules: "may" and "march" as ordinary words are not dates', () => {
    eq(R.extractDateCandidates('You may proceed. We march on.', NOW), []);
  });

  test('rules: a yearless date already past rolls to next year', () => {
    eq(R.extractDateCandidates('on 10 January', NOW)[0].iso, '2027-01-10');
  });

  test('rules: impossible dates are dropped', () => {
    eq(R.extractDateCandidates('31.02.2026 and 2026-13-40', NOW), []);
  });

  test('rules: candidates are capped at eight', () => {
    const t = Array.from({ length: 20 }, (_, i) => `${i + 1}.10.2026`).join(' ');
    eq(R.extractDateCandidates(t, NOW).length, 8);
  });

  test('rules: hostile input stays fast', () => {
    const hostile = '978-'.repeat(40000) + ' ' + '1.'.repeat(40000) + ' ' + 'project '.repeat(20000);
    const t0 = Date.now();
    R.extractRefsMentioned(hostile, hostile);
    R.extractDateCandidates(hostile, NOW);
    R.parseSystemEvent({ subject: 'Manuscript Approved' }, 'Author: ' + 'a '.repeat(100000));
    R.extractFileSignals(['x'.repeat(100000) + '.pdf']);
    assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
  });
  test('rules: declaresAutomation reads only explicit declarations, and never throws', () => {
    const D = TriageRules.declaresAutomation;
    eq([{ 'auto-submitted': ['auto-replied'] }, { 'auto-submitted': ['Auto-Generated; x=y'] }, { 'x-autoreply': ['yes'] }, { 'x-autorespond': [''] },
      { precedence: ['bulk'] }, { precedence: ['Auto_Reply'] }, { precedence: ['list'] }].map(D), [true, true, true, true, true, true, true]);
    eq([{}, { 'auto-submitted': ['no'] }, { 'auto-submitted': ['No'] }, { precedence: ['first-class'] }, { 'x-auto-response-suppress': ['All'] },
      { subject: ['Automatic reply'] }, null, undefined, 'x', 7, { 'auto-submitted': null }, { precedence: [] }].map(D),
    [false, false, false, false, false, false, false, false, false, false, false, false]);
  });
  test('rules: what counts as a mailing, and what must never be mistaken for one', () => {
    const B = TriageRules.declaresBulk;
    const bulk = [{ 'list-unsubscribe': ['<https://x/u>'] }, { 'list-unsubscribe-post': ['List-Unsubscribe=One-Click'] },
      { 'list-id': ['<news.x.com>'] }, { 'list-help': ['<mailto:h@x>'] }, { 'list-archive': ['<https://a>'] },
      { 'feedback-id': ['1:2:3:mc'] }, { 'x-mailchimp-campaign-id': ['abc'] }, { 'x-campaign-id': ['c'] },
      { 'x-report-abuse-to': ['abuse@x'] }, { precedence: ['bulk'] }, { precedence: ['LIST'] }];
    for (const h of bulk) eq(B(h), true, JSON.stringify(h));
    const ordinary = [{}, { from: ['a@b.c'] }, { 'x-mailer': ['Microsoft Outlook 16.0'] }, { 'x-mailer': ['Thunderbird'] },
      { precedence: ['first-class'] }, { 'auto-submitted': ['auto-generated'] }, { 'in-reply-to': ['<x@y>'] },
      null, undefined, 'x', 7];
    for (const h of ordinary) eq(B(h), false, JSON.stringify(h));
  });

  // The routing id a sending platform stamps on everything it carries says which
  // service delivered the message and nothing about what it is: the same
  // platform carries the newsletter, the invoice, the password reset and
  // sometimes a person's own reply. Treating that id as "sent to a list" hid
  // real work, so the two questions are asked separately.
  test('rules: a delivery service\'s routing id is not a mailing list', () => {
    const transport = [{ 'x-sg-eid': ['e'] }, { 'x-sendgrid-eid': ['e'] }, { 'x-klaviyo-message-id': ['k'] },
      { 'x-hubspot-msgid': ['h'] }, { 'x-ac-messageid': ['a'] }, { 'x-sib-id': ['s'] }, { 'x-mc-user': ['u'] },
      { 'x-mailer': ['Mailchimp Mailer 1.0'] }, { 'x-mailer': ['rapidmail'] }];
    for (const h of transport) {
      eq(TriageRules.declaresBulk(h), false, 'not a list: ' + JSON.stringify(h));
      eq(TriageRules.declaresEspTransport(h), true, 'but a platform: ' + JSON.stringify(h));
    }
    // A newsletter carries both, and is still a mailing.
    const news = { 'list-unsubscribe': ['<https://x/u>'], 'x-sg-eid': ['e'] };
    eq([TriageRules.declaresBulk(news), TriageRules.declaresEspTransport(news)], [true, true]);
    for (const h of [{}, { 'x-mailer': ['Thunderbird'] }, null, 7]) eq(TriageRules.declaresEspTransport(h), false, JSON.stringify(h));
  });
})();
