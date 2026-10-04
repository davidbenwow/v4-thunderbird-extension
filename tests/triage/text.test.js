// Synthetic fixtures only — this repository is public.
(function () {
  const T = TriageText;
  const NONE = { text: '', ambiguous: false, reason: null };
  const NOT_STRINGS = [null, undefined, 42, NaN, true, {}, [], () => 'x'];
  const ATTR_EN = 'On Sat, Sep 19, 2026 at 10:00 AM Editor Example <editor@imprint.example> wrote:';
  const authored = (body, opts) => T.authoredText(body, opts).text;
  const clear = (body, expected, opts) => eq(T.authoredText(body, opts), { text: expected, ambiguous: false, reason: null });

  // ---- normalizeSubject ----
  test('text: normalizeSubject contract examples', () => {
    eq(T.normalizeSubject('Re: RE: Fwd: Your cover'), 'your cover');
    eq(T.normalizeSubject('AW: [Ticket#2026091912345678] Failed GLE 978-620-0-12345-6'), 'failed gle 978-620-0-12345-6');
    eq(T.normalizeSubject('Отв: Ваша рукопись'), 'ваша рукопись');
  });

  test('text: normalizeSubject strips every reply/forward prefix, any case', () => {
    const prefixes = ['re', 'aw', 'antw', 'sv', 'vs', 'fw', 'fwd', 'wg', 'tr', 'rv', 'res', 'enc', 'odp', 'r',
      'отв', 'ответ', 'пересл'];
    for (const p of prefixes) {
      eq(T.normalizeSubject(p + ': Sample title'), 'sample title', p);
      eq(T.normalizeSubject(p.toUpperCase() + ': Sample title'), 'sample title', p.toUpperCase());
    }
    eq(T.normalizeSubject('Ответ: Пересл: ОТВ: Обложка книги'), 'обложка книги');
    eq(T.normalizeSubject('WG: AW: Antw: SV: VS: TR: RV: RES: ENC: Odp: R: Fwd:Re: Sample title'), 'sample title');
  });

  test('text: normalizeSubject strips prefix counters and spaced colons', () => {
    eq(T.normalizeSubject('Re[2]: Sample title'), 'sample title');
    eq(T.normalizeSubject('RE (3): Sample title'), 'sample title');
    eq(T.normalizeSubject('Re [12] : Sample title'), 'sample title');
    eq(T.normalizeSubject('Re : Sample title'), 'sample title');
  });

  test('text: normalizeSubject strips leading ticket tags, keeps inner ones', () => {
    eq(T.normalizeSubject('[Ticket#123] Re: [Ticket#123] Sample title'), 'sample title');
    eq(T.normalizeSubject('Fwd: [Case #998877 open] Re: Sample title'), 'sample title');
    eq(T.normalizeSubject('Invoice [Ticket#123] attached'), 'invoice [ticket#123] attached');
    eq(T.normalizeSubject('[Draft] Sample title'), '[draft] sample title');
  });

  test('text: normalizeSubject leaves words that merely start like a prefix', () => {
    eq(T.normalizeSubject('Report: annual figures'), 'report: annual figures');
    eq(T.normalizeSubject('Reply needed'), 'reply needed');
    eq(T.normalizeSubject('Transfer: files'), 'transfer: files');
  });

  test('text: normalizeSubject collapses whitespace and trailing punctuation', () => {
    eq(T.normalizeSubject('  Re:   Hello \t  world !!! '), 'hello world');
    eq(T.normalizeSubject('Sample title...'), 'sample title');
    eq(T.normalizeSubject('Sample\u200B title\u202E?'), 'sample title');
    eq(T.normalizeSubject('Re:'), '');
    eq(T.normalizeSubject(''), '');
  });

  // ---- sanitizeDisplay / excerpt ----
  test('text: sanitizeDisplay removes controls, bidi overrides/isolates and zero-width chars', () => {
    eq(T.sanitizeDisplay('Jane\u202E Roe\u202C'), 'Jane Roe');
    eq(T.sanitizeDisplay('\u2066evil\u2069 \u202Atext\u202B'), 'evil text');
    eq(T.sanitizeDisplay('a\u200Bb\u200Cc\u200Dd\u200Ee\u200Ff\uFEFFg'), 'abcdefg');
    eq(T.sanitizeDisplay('x\u0000y\u0007z\u001B[0m\u007F\u009F'), 'xyz[0m');
  });

  test('text: sanitizeDisplay collapses all whitespace, line breaks included', () => {
    eq(T.sanitizeDisplay('  a\n\tb\r\nc \u00A0 d\u0085e  '), 'a b c d e');
    eq(T.sanitizeDisplay(' \n\t '), '');
  });

  test('text: sanitizeDisplay truncation boundary', () => {
    eq(T.sanitizeDisplay('a'.repeat(160)), 'a'.repeat(160));
    eq(T.sanitizeDisplay('a'.repeat(161)), 'a'.repeat(159) + '…');
    eq(T.sanitizeDisplay('abcde', 5), 'abcde');
    eq(T.sanitizeDisplay('abcdef', 5), 'abcd…');
    eq(T.sanitizeDisplay('abcdef', 1), '…');
    for (const bad of [0, -3, NaN, Infinity, '5', null]) eq(T.sanitizeDisplay('a'.repeat(200), bad).length, 160);
  });

  test('text: truncation never splits a surrogate pair', () => {
    eq(T.sanitizeDisplay('ab\uD83D\uDE00cd', 4), 'ab…');
  });

  test('text: excerpt cleans like sanitizeDisplay with the schema default length', () => {
    eq(TriageSchema.LIMITS.excerptDisplay, 1200);
    eq(T.excerpt('b'.repeat(1200)).length, 1200);
    eq(T.excerpt('b'.repeat(1201)), 'b'.repeat(1199) + '…');
    eq(T.excerpt('line one\n\nline\u202E two', 100), 'line one line two');
    eq(T.excerpt('x'.repeat(50), 10), 'x'.repeat(9) + '…');
  });

  // ---- authoredText: attribution lines ----
  test('text: authoredText cuts at an English attribution', () => {
    clear('Thank you, the cover looks fine.\n\n' + ATTR_EN + '\n> Please check the cover.\n> Regards',
      'Thank you, the cover looks fine.');
  });

  test('text: authoredText keeps an Uzbek body above an English attribution', () => {
    const body = "Assalomu alaykum! Qo'lyozmani ilova qildim, iltimos ko'rib chiqing.";
    clear(body + '\n\n' + ATTR_EN + '\n> Please send the manuscript.', body);
  });

  test('text: authoredText cuts at a German attribution', () => {
    clear('Guten Tag, anbei das korrigierte Manuskript.\n\nAm 19.09.2026 um 10:00 schrieb Editor Example:\n> Bitte senden Sie das Manuskript.',
      'Guten Tag, anbei das korrigierte Manuskript.');
  });

  test('text: authoredText cuts at a French attribution (space or NBSP before the colon)', () => {
    const top = 'Bonjour, voici le manuscrit corrigé.';
    clear(top + "\n\nLe 19/09/2026 à 10:00, Editor Example a écrit :\n> Merci d'envoyer le manuscrit.", top);
    clear(top + "\n\nLe 19/09/2026 à 10:00, Editor Example a écrit\u00A0:\n> Merci d'envoyer le manuscrit.", top);
  });

  test('text: authoredText cuts at a Spanish attribution', () => {
    clear('Hola, adjunto el manuscrito corregido.\n\nEl 19 sept 2026, a las 10:00, Editor Example escribió:\n> Por favor envíe el manuscrito.',
      'Hola, adjunto el manuscrito corregido.');
  });

  test('text: authoredText cuts at a Romanian attribution', () => {
    clear('Bună ziua! Am atașat manuscrisul corectat.\n\nÎn sâm., 19 sept. 2026 la 10:00, Editor Example <editor@imprint.example> a scris:\n> Vă rugăm să trimiteți manuscrisul.',
      'Bună ziua! Am atașat manuscrisul corectat.');
  });

  test('text: authoredText cuts at Russian attributions', () => {
    const top = 'Здравствуйте! Отправляю исправленную рукопись.';
    const quote = '\n> Пришлите, пожалуйста, рукопись.';
    clear(top + '\n\n19.09.2026 10:00, Редактор Примеров пишет:' + quote, top);
    clear(top + '\n\nсуббота, 19 сентября 2026 г. Редактор Примеров написал:' + quote, top);
    clear(top + '\n\n19 сент. 2026 г., в 10:00, Редактор Примеров <editor@imprint.example> написал(а):' + quote, top);
    clear(top + '\n\nсб, 19 сент. 2026 г. в 10:00, Editor Example <editor@imprint.example>:' + quote, top);
  });

  test('text: authoredText handles an attribution wrapped over two lines', () => {
    clear('Thanks, all good.\n\nOn Sat, Sep 19, 2026 at 10:00 AM Editor Example <editor@imprint.example>\nwrote:\n> old text',
      'Thanks, all good.');
    clear('Mulțumesc!\n\nÎn sâm., 19 sept. 2026 la 10:00, Editor Example <editor@imprint.example> a\nscris:\n> text vechi',
      'Mulțumesc!');
    // A sentence above a one-line attribution is not the first half of a wrap.
    clear('Позвоните мне в 5.\nИван Примеров пишет:\n> цитата', 'Позвоните мне в 5.');
  });

  test('text: authoredText uses owner names for attributions without the usual opening', () => {
    const body = 'Thanks!\n\nEditor Example <editor@imprint.example> wrote:\n> old text\n> more old text';
    eq(authored(body), 'Thanks!\n\nEditor Example <editor@imprint.example> wrote:');
    eq(authored(body, { names: [] }), 'Thanks!\n\nEditor Example <editor@imprint.example> wrote:');
    eq(authored(body, { names: ['Editor Example'] }), 'Thanks!');
    eq(authored(body, { names: [null, 7, '', 'ab', 'EDITOR example'] }), 'Thanks!');
    eq(authored(body, { names: 'Editor Example' }), 'Thanks!\n\nEditor Example <editor@imprint.example> wrote:');
  });

  test('text: authoredText does not cut prose that only resembles an attribution', () => {
    const prose = 'As my colleague wrote:\nthe cover is fine.\nOn Monday I wrote to you about it.';
    clear(prose, prose);
    const long = 'On ' + 'x'.repeat(400) + ' wrote:\nstill my text';
    clear(long, long);
  });

  // ---- authoredText: other cut markers ----
  test('text: authoredText cuts at Original Message markers', () => {
    for (const marker of ['-----Original Message-----', '----- Original Message -----',
      '-----Ursprüngliche Nachricht-----', '-----Исходное сообщение-----']) {
      clear('My reply is here.\n\n' + marker + '\nFrom: Editor Example\nOld body', 'My reply is here.');
    }
  });

  test('text: authoredText cuts at forwarded-message markers', () => {
    const note = 'Please see the manuscript from my co-author below.';
    for (const marker of ['---------- Forwarded message ---------', '-------- Forwarded Message --------',
      'Begin forwarded message:']) {
      clear(note + '\n\n' + marker + '\nFrom: Jane Roe <jane.roe@example.org>\nSubject: Manuscript\n\nForwarded body', note);
    }
  });

  test('text: authoredText cuts at an Outlook header block in each language', () => {
    const blocks = [
      'From: Editor Example <editor@imprint.example>\nSent: Saturday, September 19, 2026 10:00 AM\nTo: Jane Roe\nSubject: Your cover',
      'Von: Editor Example <editor@imprint.example>\nGesendet: Samstag, 19. September 2026 10:00\nAn: Jane Roe\nBetreff: Ihr Cover',
      'De : Editor Example <editor@imprint.example>\nEnvoyé : samedi 19 septembre 2026 10:00\nÀ : Jane Roe\nObjet : Votre couverture',
      'От: Editor Example <editor@imprint.example>\nОтправлено: 19 сентября 2026 г. 10:00\nКому: Jane Roe\nТема: Ваша обложка',
      'From: Editor Example <editor@imprint.example>\nDate: Sat, 19 Sep 2026 10:00:00 +0300',
      'From: Editor Example\n\n\n\nSubject: Your cover'
    ];
    for (const block of blocks) clear('Sounds good.\n\n' + block + '\n\nOld body text', 'Sounds good.');
  });

  test('text: a From: line without a header line in the next 4 lines is not a cut', () => {
    const prose = 'From: Chisinau with love\nthis is just prose\nnothing else here';
    clear(prose, prose);
    const far = 'From: Editor Example\n1\n2\n3\n4\nSubject: too far away';
    clear(far, far);
  });

  test('text: authoredText cuts at a run of 2+ quoted lines, not at a single one', () => {
    clear('Reply text\n> quoted one\n> quoted two', 'Reply text');
    const single = 'Reply text\n> just one quoted line\nmore of my text';
    clear(single, single);
  });

  test('text: authoredText cuts at the signature delimiter', () => {
    clear('Best regards\n-- \nJane Roe\nExample Press', 'Best regards');
    clear('Best regards\n--\nJane Roe\nExample Press', 'Best regards');
    clear('Best regards\r\n-- \r\nJane Roe', 'Best regards');
    clear('a -- b\n--- \nstill text', 'a -- b\n--- \nstill text');
  });

  test('text: authoredText cuts at a line of 10+ underscores or dashes', () => {
    clear('Hello\n__________\nFrom the old message', 'Hello');
    clear('Hello\n' + '-'.repeat(32) + '\nFrom the old message', 'Hello');
    clear('Hello\n_________\nnine is not enough', 'Hello\n_________\nnine is not enough');
    clear('Hello\n---------\nnine is not enough', 'Hello\n---------\nnine is not enough');
  });

  test('text: authoredText cuts at the first marker and returns uncut text trimmed', () => {
    clear('Hi\n-- \nJane\n> quoted one\n> quoted two', 'Hi');
    clear('\n\n  Just a plain message.  \n\n', 'Just a plain message.');
  });

  // ---- authoredText: ambiguity ----
  test('text: inline replies are flagged ambiguous', () => {
    const body = ['Hello, my answers are below.', '', ATTR_EN,
      '> Did you approve the cover?', 'Yes, the cover is approved.',
      '> Do you need printed copies?', 'Ten copies please.'].join('\n');
    eq(T.authoredText(body), { text: 'Hello, my answers are below.', ambiguous: true, reason: 'inline_reply' });
    const quotedFirst = '> Did you approve the cover?\n> Please answer.\nYes, approved.\n> Copies?\nTen.';
    eq(T.authoredText(quotedFirst), { text: '', ambiguous: true, reason: 'inline_reply' });
  });

  test('text: a wrapped attribution fragment between quoted lines is not an inline reply', () => {
    const body = 'Fine by me.\n\n' + ATTR_EN + '\n> On Fri, Sep 18, 2026 Jane Roe <jane.roe@example.org>\nwrote:\n>> older text\n> newer text';
    clear(body, 'Fine by me.');
  });

  test('text: a bare forward is flagged forward_only', () => {
    const fwd = '\n\n---------- Forwarded message ---------\nFrom: Jane Roe <jane.roe@example.org>\nSubject: Manuscript\n\nHere is the manuscript for the book.';
    eq(T.authoredText('FYI' + fwd), { text: 'FYI', ambiguous: true, reason: 'forward_only' });
    eq(T.authoredText(fwd), { text: '', ambiguous: true, reason: 'forward_only' });
    eq(T.authoredText('Begin forwarded message:\n\nFrom: Jane Roe\nSubject: Manuscript\n\nBody text here.').reason, 'forward_only');
  });

  test('text: text lost entirely to the cut is flagged empty_after_strip', () => {
    const bottomPosted = 'On 19/09/2026 10:00, Editor Example wrote:\n> Please confirm the cover.\n>\nI confirm the cover, thank you very much.';
    eq(T.authoredText(bottomPosted), { text: '', ambiguous: true, reason: 'empty_after_strip' });
    eq(T.authoredText('-- \nJR'), NONE);
    eq(T.authoredText('   \n\n  '), NONE);
  });

  test('text: authoredText looks at no more than 2000 lines', () => {
    const lines = [];
    for (let i = 0; i < 2500; i++) lines.push('line ' + i);
    const r = T.authoredText(lines.join('\n'));
    eq(r.text.split('\n').length, 2000);
    eq(r.ambiguous, false);
  });

  // ---- redactForModel ----
  test('text: redactForModel contract examples', () => {
    eq(T.redactForModel('see https://we.tl/t-AbC123?x=1 and mail me at jane.doe@example.org'),
      'see [link: we.tl] and mail me at [email]');
    eq(T.redactForModel('ISBN 978-620-0-12345-6, call +373 69 123 456'), 'ISBN 978-620-0-12345-6, call [phone]');
  });

  test('text: redactForModel reduces links to the lowercased host', () => {
    eq(T.redactForModel('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456/view?usp=sharing#frag'),
      '[link: drive.google.com]');
    eq(T.redactForModel('files at www.example.org/some/long/path?id=5 today'), 'files at [link: www.example.org] today');
    eq(T.redactForModel('https://user:hunter2@files.example.com:8443/dl/abc?token=XYZ'), '[link: files.example.com]');
    eq(T.redactForModel('HTTPS://WE.TL/t-XyZ987 and http://Example.ORG'), '[link: we.tl] and [link: example.org]');
    eq(T.redactForModel('download herehttps://we.tl/t-glued123'), 'download here[link: we.tl]');
    eq(T.redactForModel('<https://example.org/a/b>'), '<[link: example.org]>');
    eq(T.redactForModel('http://192.168.100.200:8080/private/path'), '[link: 192.168.100.200]');
    eq(T.redactForModel('http://[2001:db8::1]:8080/private/path'), '[link]');
    eq(T.redactForModel('upload to ftp://author:hunter2@ftp.example.org/incoming/'), 'upload to [link: ftp.example.org]');
    eq(T.redactForModel('see www... and https://'), 'see www... and https://');
  });

  test('text: redactForModel keeps sentence punctuation after a link and leaks no path', () => {
    eq(T.redactForModel('Look at https://example.org/a/b?c=d, then (or https://example.com/x).'),
      'Look at [link: example.org], then (or [link: example.com]).');
    const out = T.redactForModel('get it: https://transfer.example.com/d/SECRETTOKEN123/key=PRIVATEKEY456&x=(y)\'z');
    eq(out, 'get it: [link: transfer.example.com]');
    assert.ok(!/SECRET|PRIVATE/.test(out));
  });

  test('text: redactForModel masks e-mail addresses', () => {
    eq(T.redactForModel('Jane <jane.doe+books@mail.example.org>, cc JOHN_ROE@EXAMPLE.COM.'), 'Jane <[email]>, cc [email].');
    eq(T.redactForModel('mailto:jane@example.org or info@www.example.org'), 'mailto:[email] or [email]');
    eq(T.redactForModel('пишите на иван@пример.рф'), 'пишите на [email]');
    eq(T.redactForModel('jane\u200B.doe@exam\u200Bple.org'), '[email]');
    eq(T.redactForModel('3 copies @ 12.50 each, user@localhost, a@b'), '3 copies @ 12.50 each, user@localhost, a@b');
  });

  test('text: redactForModel masks phone-like sequences', () => {
    eq(T.redactForModel('Tel: +7 (495) 123-45-67.'), 'Tel: [phone].');
    eq(T.redactForModel('mobile 069.123.456 or 0049 30 1234567'), 'mobile [phone] or [phone]');
    eq(T.redactForModel('office (022) 123-456-78'), 'office [phone]');
    eq(T.redactForModel('only 12345678 here'), 'only 12345678 here');
  });

  test('text: redactForModel never touches ISBNs, ids or dates', () => {
    eq(T.redactForModel('ISBN 978 620 0 54321 7 and 9791234567896'), 'ISBN 978 620 0 54321 7 and 9791234567896');
    eq(T.redactForModel('978-620-0-12345-6 069 123 456'), '978-620-0-12345-6 [phone]');
    eq(T.redactForModel('2026 978-620-0-12345-6'), '2026 978-620-0-12345-6');
    eq(T.redactForModel('project #48213, Project ID: 48213, [Ticket#2026091912345678]'),
      'project #48213, Project ID: 48213, [Ticket#2026091912345678]');
    eq(T.redactForModel('meet on 19.09.2026 14:00 or 2026-09-21 09:30, from 01/09/2026 - 15/09/2026'),
      'meet on 19.09.2026 14:00 or 2026-09-21 09:30, from 01/09/2026 - 15/09/2026');
  });

  test('text: redactForModel collapses whitespace', () => {
    eq(T.redactForModel('  a  \t b\r\n\r\n\r\n\r\nc   \n   d\u00A0\u00A0e  '), 'a b\n\nc\nd e');
    eq(T.redactForModel('x\u0000y\u0001z\u202E'), 'xyz');
  });

  test('text: redactForModel truncates at the last whitespace and marks the cut', () => {
    // The cut mark is part of the limit: the result never exceeds `maxChars`.
    eq(T.redactForModel('aaaa bbbb cccc', 13), 'aaaa bbbb […]');
    eq(T.redactForModel('aaaa bbbb cccc', 12), 'aaaa […]');
    eq(T.redactForModel('aaaa bbbb cccc', 14), 'aaaa bbbb cccc');
    eq(T.redactForModel('x'.repeat(50), 10), 'x'.repeat(6) + ' […]');
    const long = T.redactForModel('word '.repeat(2000));
    assert.ok(long.endsWith('word […]'));
    assert.ok(long.length <= 4000 && long.length > 3990);
    for (const n of [5, 10, 200, 2000, 4000]) assert.ok(T.redactForModel('Уважаемый редактор '.repeat(900), n).length <= n, String(n));
    eq(T.redactForModel('word '.repeat(700)).length, 3499);
  });

  // ---- hashString ----
  test('text: hashString is deterministic lowercase hex', () => {
    eq(T.hashString('Ваша рукопись'), T.hashString('Ваша рукопись'));
    eq(T.hashString('a'), '1c2ba782c97901');                         // cyrb53('a') = 7929297801672961
    assert.ok(/^[0-9a-f]{14}$/.test(T.hashString('anything at all')));
    assert.ok(/^[0-9a-f]{14}$/.test(T.hashString('')));
    assert.notStrictEqual(T.hashString('abc'), T.hashString('abd'));
    assert.notStrictEqual(T.hashString('x'.repeat(200001)), T.hashString('x'.repeat(200002)));
  });

  // ---- totality ----
  test('text: every function is total on non-string input', () => {
    for (const v of NOT_STRINGS) {
      eq(T.normalizeSubject(v), '');
      eq(T.sanitizeDisplay(v), '');
      eq(T.sanitizeDisplay(v, 10), '');
      eq(T.excerpt(v), '');
      eq(T.authoredText(v), NONE);
      eq(T.authoredText(v, { names: ['Editor Example'] }), NONE);
      eq(T.redactForModel(v), '');
      eq(T.hashString(v), T.hashString(''));
    }
    for (const opts of [null, 42, 'names', { names: null }, { names: {} }, []]) {
      eq(authored('Hello there.', opts), 'Hello there.');
    }
    eq(T.redactForModel('short text', 'not a number'), 'short text');
  });

  test('text: the module is frozen and exports exactly the contract', () => {
    assert.ok(Object.isFrozen(T));
    eq(Object.keys(T).sort(), ['authoredText', 'bodyFromParts', 'excerpt', 'hashString', 'htmlToText', 'normalizeSubject', 'redactForModel', 'sanitizeDisplay']);
  });

  // ---- hostile input ----
  const N = 200000;
  const fill = (unit) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
  const HOSTILE = {
    'a@': fill('a@'),
    '@a.': fill('@a.'),
    'local run then @': fill('a.') + '@',
    '>': fill('>'),
    '> lines': fill('>\n'),
    'newlines': fill('\n'),
    'spaces': fill(' '),
    'digit then spaces': '1' + fill(' ') + '1',
    'digits': fill('1'),
    'spaced digits': fill('1 '),
    '8-digit groups': fill('12345678x'),
    'wide-spaced digits': fill('1    '),
    'parens': fill('1('),
    'isbn-like': fill('978-'),
    'date-like': fill('19.09.'),
    'dashes': fill('-'),
    'underscores': fill('_'),
    'schemes': fill('http://'),
    'www': fill(' www.'),
    'prefixes': fill('re: '),
    'tags': fill('[#1'),
    'attribution starts': fill('On x\n'),
    'long attribution': 'On ' + fill('x ') + ' wrote:',
    'header starts': fill('From: x\n'),
    'punctuation': fill('!') + 'a',
    'bidi': fill('\u202E\u200B'),
    'over the cap': fill('a@1 ').repeat(3)
  };

  function under500ms(label, fn) {
    for (const key of Object.keys(HOSTILE)) {
      const t0 = Date.now();
      fn(HOSTILE[key]);
      const ms = Date.now() - t0;
      assert.ok(ms < 500, label + ' took ' + ms + ' ms on "' + key + '"');
    }
  }

  test('text: authoredText stays under 500 ms on 200,000-char hostile input', () => {
    under500ms('authoredText', (s) => T.authoredText(s, { names: ['Editor Example', 'x'.repeat(5000)] }));
  });

  test('text: redactForModel stays under 500 ms on 200,000-char hostile input', () => {
    under500ms('redactForModel', (s) => T.redactForModel(s));
    under500ms('redactForModel uncut', (s) => T.redactForModel(s, N * 2));
  });

  test('text: subject, display and hash helpers stay under 500 ms on hostile input', () => {
    under500ms('normalizeSubject', (s) => T.normalizeSubject(s));
    under500ms('sanitizeDisplay', (s) => T.sanitizeDisplay(s, N * 2));
    under500ms('excerpt', (s) => T.excerpt(s));
    under500ms('hashString', (s) => T.hashString(s));
  });

  test('text: input beyond 200,000 chars is ignored, not processed', () => {
    const tail = ' tail@example.org';
    const out = T.redactForModel('a'.repeat(N) + tail, N * 2);
    eq(out, 'a'.repeat(N));
    eq(T.sanitizeDisplay('a'.repeat(N) + 'TAIL', N * 2).length, N);
    eq(T.authoredText('a'.repeat(N) + '\n-- \nsig').text.length, N);
  });
  test('text: invisible layout entities never reach the model as literal text', () => {
    const padded = T.htmlToText('<p>Your plan renews&zwnj;&zwnj;&zwnj; on 1 October&shy;.</p><p>Price&nbsp;&mdash;&nbsp;12&euro;</p>');
    assert.ok(!/&[a-z]+;/i.test(padded), padded);
    eq(padded.replace(/\s+/g, ' ').trim(), 'Your plan renews on 1 October. Price \u2014 12\u20ac');
    // An entity we do not know is left alone rather than mangled.
    assert.ok(T.htmlToText('<p>AT&unknownthing; T</p>').includes('&unknownthing;'));
  });
})();
