(function () {
  const T = TriageText;
  const part = (contentType, body, extra) => Object.assign({ contentType, body }, extra || {});
  const htmlBody = (html) => T.bodyFromParts({ parts: [part('text/html', html)] });
  // Exactly what the caller hands the model: nothing at all when the split is
  // ambiguous, the redacted authored text otherwise.
  const sent = (html, opts) => {
    const a = T.authoredText(htmlBody(html), opts);
    return a.ambiguous ? '' : T.redactForModel(a.text);
  };

  test('body: the plain-text copy wins and the HTML copy is not merged in', () => {
    const full = { contentType: 'multipart/alternative', parts: [part('text/plain', 'Please proceed.'), part('text/html', '<p>Please proceed.</p>')] };
    eq(T.bodyFromParts(full), 'Please proceed.');
  });

  test('body: HTML-only mail keeps its line structure, so quote cutting still works', () => {
    const html = '<div>Yes, go ahead.</div><div><br></div><div>On Mon, Eva Editor wrote:</div><blockquote type="cite"><div>Please review the cover.</div></blockquote>';
    const text = T.bodyFromParts({ parts: [part('text/html', html)] });
    const authored = T.authoredText(text, { names: ['Eva Editor'] });
    eq([authored.text, authored.ambiguous], ['Yes, go ahead.', false]);
    assert.ok(/\n> Please review the cover\./.test(text));
  });

  // ---- an HTML quote is quoted history on EVERY line, attribution or not ----
  test('body: an HTML quote without an attribution line never reaches the model', () => {
    const html = '<p>Thanks.</p><blockquote type="cite"><p>PRIVATE QUOTED HISTORY</p><p>OLDER PRIVATE HISTORY</p></blockquote>';
    eq(T.authoredText(htmlBody(html)), { text: 'Thanks.', ambiguous: false, reason: null });
    eq(sent(html), 'Thanks.');
    assert.ok(!/PRIVATE/.test(sent(html)), sent(html));
    // The marker is on every line of the quote, not only on the first.
    const text = htmlBody(html);
    for (const line of ['> PRIVATE QUOTED HISTORY', '> OLDER PRIVATE HISTORY']) {
      assert.ok(text.includes('\n' + line + '\n'), line + ' in ' + JSON.stringify(text));
    }
  });

  test('body: every level of a nested HTML quote carries its own marker', () => {
    const html = '<p>Top.</p><blockquote><p>L1 SECRET</p><blockquote><p>L2 SECRET</p>' +
      '<blockquote><p>L3 SECRET</p></blockquote><p>L2 MORE</p></blockquote><p>L1 MORE</p></blockquote>';
    eq(sent(html), 'Top.');
    assert.ok(!/SECRET|MORE/.test(sent(html)), sent(html));
    const text = htmlBody(html);
    for (const line of ['> L1 SECRET', '>> L2 SECRET', '>>> L3 SECRET', '>> L2 MORE', '> L1 MORE']) {
      assert.ok(text.includes('\n' + line + '\n'), line + ' in ' + JSON.stringify(text));
    }
  });

  test('body: a one-line blockquote is a quote, not authored text', () => {
    eq(sent('<p>Noted.</p><blockquote type="cite"><p>ONLY PRIVATE LINE</p></blockquote>'), 'Noted.');
    eq(sent('<p>Noted.</p><blockquote>ONLY PRIVATE LINE</blockquote>'), 'Noted.');
    // It is the HTML side that makes this unambiguous, by opening the quote with
    // a marker-only line. The plain-text rule is untouched: one ">" line on its
    // own there is still ordinary text, because plain ">" has false positives.
    const single = 'Reply text\n> just one quoted line\nmore of my text';
    eq(T.authoredText(single), { text: single, ambiguous: false, reason: null });
  });

  test('body: a blockquote split by <br> is marked on every line', () => {
    const html = '<p>Ok.</p><blockquote type="cite">BR ONE<br>BR TWO<br>BR THREE</blockquote>';
    eq(sent(html), 'Ok.');
    const text = htmlBody(html);
    for (const line of ['> BR ONE', '> BR TWO', '> BR THREE']) {
      assert.ok(text.includes('\n' + line + '\n'), line + ' in ' + JSON.stringify(text));
    }
  });

  test('body: a blockquote keeps its marker across the source own line breaks', () => {
    const html = '<p>Fine.</p><blockquote type="cite">\n  <p>SRC ONE</p>\r\n  <p>SRC TWO</p>\r  <p>SRC THREE</p>\n</blockquote>';
    eq(sent(html), 'Fine.');
    assert.ok(!/SRC/.test(sent(html)), sent(html));
    for (const line of htmlBody(html).split('\n')) {
      assert.ok(line === '' || line === 'Fine.' || line.charCodeAt(0) === 62, JSON.stringify(line));
    }
  });

  test('body: lists and tables inside a blockquote are quoted line by line', () => {
    const html = '<p>Hi.</p><blockquote><ul><li>ITEM ONE</li><li>ITEM TWO</li></ul>' +
      '<table><tr><td>CELL A</td></tr><tr><td>CELL B</td></tr></table></blockquote>';
    eq(sent(html), 'Hi.');
    assert.ok(!/ITEM|CELL/.test(sent(html)), sent(html));
  });

  test('body: bottom posting under an HTML quote sends nothing rather than the quote', () => {
    const below = '<blockquote type="cite"><p>QUOTED A</p><p>QUOTED B</p></blockquote><p>My answer below.</p>';
    eq(T.authoredText(htmlBody(below)), { text: '', ambiguous: true, reason: 'empty_after_strip' });
    eq(sent(below), '');
    // Above the quote the author's own text is sent, and only that.
    const above = '<p>Before.</p><blockquote><p>QUOTED MIDDLE</p></blockquote><p>After.</p>';
    eq(sent(above), 'Before.');
    assert.ok(!/QUOTED/.test(sent(above)), sent(above));
  });

  test('body: an answer interleaved with HTML quotes stays ambiguous', () => {
    const html = '<blockquote type="cite"><p>Q1 PRIVATE?</p></blockquote><p>Answer one.</p>' +
      '<blockquote type="cite"><p>Q2 PRIVATE?</p></blockquote><p>Answer two.</p>';
    eq(T.authoredText(htmlBody(html)), { text: '', ambiguous: true, reason: 'inline_reply' });
    eq(sent(html), '');
  });

  test('body: deeply nested blockquotes stay fast and leave no line unquoted', () => {
    const deep = '<blockquote><p>X</p>'.repeat(5000) + 'TAIL' + '</blockquote>'.repeat(5000);
    const t0 = Date.now();
    const text = htmlBody(deep);
    assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
    for (const line of text.split('\n')) assert.ok(line === '' || line.charCodeAt(0) === 62, JSON.stringify(line.slice(0, 40)));
  });

  test('body: attachments and non-text parts are skipped', () => {
    const full = { parts: [part('text/plain', 'Hello'), part('text/plain', 'SECRET FILE CONTENT', { name: 'notes.txt' }),
      part('text/plain', 'also secret', { headers: { 'content-disposition': ['attachment; filename="a.txt"'] } }), part('application/pdf', '%PDF')] };
    eq(T.bodyFromParts(full), 'Hello');
  });

  test('body: scripts, styles and tags are removed; entities decoded', () => {
    const t = T.htmlToText('<style>p{color:red}</style><script>alert(1)</script><p>Tom &amp; Ann &lt;3&nbsp;books &#1055;&#1088;&#1080;</p>');
    eq(t.trim(), 'Tom & Ann <3 books При');
  });

  test('body: nested multipart is walked; garbage never throws', () => {
    eq(T.bodyFromParts({ parts: [{ contentType: 'multipart/mixed', parts: [{ contentType: 'multipart/alternative', parts: [part('text/plain', 'Deep')] }] }] }), 'Deep');
    for (const bad of [null, undefined, 'x', 3, {}, { parts: 'x' }, { parts: [null, 5] }]) eq(T.bodyFromParts(bad), '');
  });

  test('authored: an attribution in a language with no rule is cut when it names the owner address', () => {
    const owner = { names: ['Eva Editor'], addresses: ['editor@imprint.example'] };
    const vi = 'Cam on.\n\nVao Th 3, 2 thg 6, 2026 luc 10:23 Eva Editor <editor@imprint.example> da viet:\n\nPlease review the cover.';
    eq(T.authoredText(vi, owner).text, 'Cam on.');
    const noDate = 'Shukran.\n\n<editor@imprint.example> kataba:\nPlease review the cover.';
    eq(T.authoredText(noDate, owner).text, 'Shukran.');
    const wrapped = 'Ok.\n\n2 June 2026, 10:23 Eva Editor <editor@imprint.example>\nda viet:\nPlease review.';
    eq(T.authoredText(wrapped, owner).text, 'Ok.');
  });

  test('authored: an ordinary sentence that mentions an address and ends in a colon is NOT cut', () => {
    const owner = { names: [], addresses: ['editor@imprint.example'] };
    const t = 'Please send the following to my colleague <colleague@example.org> as soon as you possibly can today:\n- the cover\n- the proof';
    eq(T.authoredText(t, owner).text, t);
  });

  test('body: hostile HTML stays fast', () => {
    const hostile = '<'.repeat(100000) + '<blockquote'.repeat(20000) + '&#'.repeat(50000);
    const t0 = Date.now();
    T.bodyFromParts({ parts: [part('text/html', hostile)] });
    assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
  });
})();
