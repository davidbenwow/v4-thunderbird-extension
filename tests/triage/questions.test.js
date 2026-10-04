// Synthetic fixtures only — this repository is public.
(function () {
  const Q = TriageQuestions;
  const base = { subject: 'Re: Your cover', text: 'Please proceed.', files: [], transferHost: null, preceding: null, dateCandidates: [] };

  test('questions: nothing is built for empty text', () => {
    eq(Q.buildRequest({ subject: 'x', text: '   ' }), null);
    eq(Q.buildRequest(null), null);
  });

  test('questions: the model id is pinned, never an alias', () => {
    const r = Q.buildRequest(base);
    eq(r.model, TriageSchema.MODEL_ID);
    assert.ok(/^jev-\d+\.\d+\.\d+$/.test(r.model));
  });

  test('questions: every question has the wire shape the API documents', () => {
    const r = Q.buildRequest(Object.assign({}, base, {
      preceding: { subject: 'Your cover', text: 'Please review the attached cover.' },
      dateCandidates: [{ raw: '5 October', iso: '2026-10-05', kind: 'date' }]
    }));
    for (const [id, q] of Object.entries(r.questions)) {
      assert.ok(q.type === 'noul' || q.type === 'choice', id);
      assert.ok(typeof q.instructions === 'string' && q.instructions.length > 10, id);
      if (q.type === 'noul') eq(Object.keys(q.criteria).sort(), ['false', 'true'], id);
      if (q.type === 'choice') assert.ok(Object.keys(q.criteria).length >= 2 && Object.keys(q.criteria).length <= 255, id);
    }
  });

  test('questions: intent options are exactly the schema intents', () => {
    eq(Object.keys(Q.buildRequest(base).questions.intent.criteria).sort(), Object.keys(TriageSchema.INTENTS).sort());
  });

  test('questions: approval is only asked when there is a preceding editor message', () => {
    assert.ok(!('approval_kind' in Q.buildRequest(base).questions));
    assert.ok(!('previous_message_from_editor' in Q.buildRequest(base).state));
    const r = Q.buildRequest(Object.assign({}, base, { preceding: { subject: 'Your cover', text: 'Please review.' } }));
    assert.ok('approval_kind' in r.questions && 'missing_info_supplied' in r.questions && 'previous_asks_for_approval' in r.questions);
    eq(r.state.previous_message_from_editor.text, 'Please review.');
    eq(Object.keys(r.questions.approval_kind.criteria), TriageSchema.APPROVAL_KINDS);
  });

  test('questions: a blank preceding text does not enable the approval question', () => {
    const r = Q.buildRequest(Object.assign({}, base, { preceding: { subject: 's', text: '  ' } }));
    assert.ok(!('approval_kind' in r.questions));
  });

  test('questions: date questions appear only with candidates and always offer "none"', () => {
    assert.ok(!('promised_date' in Q.buildRequest(base).questions));
    const r = Q.buildRequest(Object.assign({}, base, { dateCandidates: [
      { raw: '5 October', iso: '2026-10-05', kind: 'date' }, { raw: 'November', iso: '2026-11-01', kind: 'month' }, { raw: 'bad', iso: null }] }));
    eq(Object.keys(r.questions.promised_date.criteria), ['d0', 'd1', 'none']);
    eq(Object.keys(r.questions.deadline_for_reply.criteria), ['d0', 'd1', 'none']);
    eq(r.meta.candidateMaps.promised_date.d1, { iso: '2026-11-01', kind: 'month' });
  });

  test('questions: the model never sees filenames, only type and a code-made hint', () => {
    const r = Q.buildRequest(Object.assign({}, base, { files: [{ name: 'Jane_Roe_thesis.pdf', ext: 'pdf', kind: 'document', hint: 'manuscript' }], transferHost: 'we.tl' }));
    eq(r.state.message.attachments, [{ file_type: 'pdf', filename_suggests: 'manuscript' }]);
    eq(r.state.message.contains_file_transfer_link, true);
    assert.ok(!JSON.stringify(Q.wirePayload(r)).includes('Jane_Roe'));
  });

  test('questions: the wire payload carries only model, state and questions', () => {
    eq(Object.keys(Q.wirePayload(Q.buildRequest(base))).sort(), ['model', 'questions', 'state']);
  });

  // ---- answers ----
  function fullResponse(r, over) {
    const answers = {};
    for (const [id, q] of Object.entries(r.questions)) {
      answers[id] = q.type === 'noul' ? { type: 'noul', noul: 0.1 }
        : { type: 'choice', choice: Object.keys(q.criteria)[0], probabilities: { [Object.keys(q.criteria)[0]]: 0.8, [Object.keys(q.criteria)[1]]: 0.15 }, confidence: 0.8 };
    }
    return { model: 'jev-1.13.0', answers: Object.assign(answers, over || {}), usage: { input_tokens: 300, output_tokens: 20 } };
  }

  test('answers: a well-formed response is normalised', () => {
    const r = Q.buildRequest(base);
    const p = Q.parseAnswers(r, fullResponse(r, { needs_response: { type: 'noul', noul: 0.92 } }));
    eq(p.ok, true);
    eq(p.answers.needs_response, 0.92);
    eq(p.answers.intent, { option: 'publishing_interest', p: 0.8, confidence: 0.8, runnerUp: 'submission' });
    eq(p.model, 'jev-1.13.0');
  });

  test('answers: a date choice is mapped back to its ISO date by code', () => {
    const r = Q.buildRequest(Object.assign({}, base, { dateCandidates: [{ raw: '5 October', iso: '2026-10-05', kind: 'date' }] }));
    const p = Q.parseAnswers(r, fullResponse(r));
    eq(p.answers.promised_date.iso, '2026-10-05');
    const none = Q.parseAnswers(r, fullResponse(r, { promised_date: { type: 'choice', choice: 'none', probabilities: { none: 0.9 }, confidence: 0.9 } }));
    eq(none.answers.promised_date.iso, null);
  });

  test('answers: an option we never offered is discarded, not coerced', () => {
    const r = Q.buildRequest(base);
    const p = Q.parseAnswers(r, fullResponse(r, { intent: { type: 'choice', choice: 'delete_everything', probabilities: {}, confidence: 1 } }));
    eq(p.ok, false);
    assert.ok(p.errors.includes('intent:option'));
    assert.ok(!('intent' in p.answers));
    assert.ok('needs_response' in p.answers);
  });

  test('answers: out-of-range, wrong-type and missing answers are reported', () => {
    const r = Q.buildRequest(base);
    const resp = fullResponse(r, { needs_response: { type: 'noul', noul: 1.4 }, opt_out: { type: 'choice', choice: 'x' } });
    delete resp.answers.not_now;
    const p = Q.parseAnswers(r, resp);
    eq(p.errors.sort(), ['needs_response:range', 'not_now:missing', 'opt_out:type']);
  });

  test('answers: garbage responses never throw', () => {
    const r = Q.buildRequest(base);
    for (const bad of [null, undefined, 'x', 7, {}, { answers: null }, { answers: 'x' }]) {
      const p = Q.parseAnswers(r, bad);
      eq(p.ok, false);
      eq(p.answers, {});
    }
  });

  test('answers: prototype keys are not accepted as options', () => {
    const r = Q.buildRequest(base);
    const p = Q.parseAnswers(r, fullResponse(r, { intent: { type: 'choice', choice: 'constructor', probabilities: {}, confidence: 1 } }));
    assert.ok(p.errors.includes('intent:option'));
  });

  test('contextHash: the same text with different date options is a different question', () => {
    const mk = (iso) => Q.buildRequest(Object.assign({}, base, { text: 'I will send it in October.', dateCandidates: [{ raw: 'October', iso, kind: 'month' }] }));
    const y26 = mk('2026-10-01'), y27 = mk('2027-10-01');
    eq(JSON.stringify(y26.state), JSON.stringify(y27.state));
    assert.notStrictEqual(Q.contextHash(y26), Q.contextHash(y27));
    // Same wording on the wire, different local meaning of the option: still different.
    const day = Q.buildRequest(Object.assign({}, base, { dateCandidates: [{ raw: '5 October', iso: '2026-10-05', kind: 'date' }] }));
    const other = JSON.parse(JSON.stringify(day));
    other.meta.candidateMaps.promised_date.d0.iso = '2026-10-06';
    assert.notStrictEqual(Q.contextHash(day), Q.contextHash(other));
  });

  test('contextHash: covers the wording of every question, and ignores key order', () => {
    const a = Q.buildRequest(base);
    const reworded = JSON.parse(JSON.stringify(a));
    reworded.questions.needs_response.instructions += ' ';
    assert.notStrictEqual(Q.contextHash(a), Q.contextHash(reworded));
    const shuffled = JSON.parse(JSON.stringify(a));
    shuffled.questions = Object.fromEntries(Object.entries(shuffled.questions).reverse());
    shuffled.state = { message: Object.fromEntries(Object.entries(shuffled.state.message).reverse()) };
    eq(Q.contextHash(a), Q.contextHash(shuffled));
  });

  test('contextHash: stable for the same request, different when the context changes', () => {
    const a = Q.buildRequest(base), b = Q.buildRequest(base);
    eq(Q.contextHash(a), Q.contextHash(b));
    const c = Q.buildRequest(Object.assign({}, base, { preceding: { subject: 'Your cover', text: 'Please review.' } }));
    assert.notStrictEqual(Q.contextHash(a), Q.contextHash(c));
    const d = Q.buildRequest(Object.assign({}, base, { text: 'Please proceed!' }));
    assert.notStrictEqual(Q.contextHash(a), Q.contextHash(d));
  });
})();
