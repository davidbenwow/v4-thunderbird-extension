// Synthetic fixtures only — this repository is public.
(function () {
  const St = TriageState;
  const S = TriageSchema;
  const TR = TriageSchema.TRISTATE;
  const DAY = 86400000;
  const NOW = Date.UTC(2026, 8, 21, 9);                     // Monday 21 Sep 2026
  const ON = { useModel: true };

  function facts(over) {
    return Object.assign({
      key: 'acct1|m1@example.org', date: NOW - 3 * 3600000, bodyState: 'ok', authoredAmbiguous: false,
      files: [], transferHost: null, parent: null, system: null, lead: null,
      laterOutbound: { state: TR.NOT_FOUND, hmid: null, auto: null }, refsMentioned: { isbns: [], projectIds: [] }
    }, over || {});
  }
  const C = (option, confidence, extra) => Object.assign({ option, p: confidence, confidence, runnerUp: null }, extra || {});
  const quiet = { needs_response: 0.5, addressed_to_automation: 0.02, sender_is_representative: 0.03, opt_out: 0.02, not_now: 0.02 };
  const A = (over) => Object.assign({}, quiet, over || {});

  // ---- working days / priority ----
  test('state: working days skip the weekend', () => {
    eq(St.workingDaysBetween(Date.UTC(2026, 8, 18, 12), NOW), 1);      // Fri -> Mon
    eq(St.workingDaysBetween(Date.UTC(2026, 8, 14, 12), NOW), 5);      // Mon -> Mon
    eq(St.workingDaysBetween(NOW, NOW - DAY), 0);
    eq(St.workingDaysBetween(null, NOW), 0);
  });

  test('state: priority is a list of factors, and age alone never raises a row', () => {
    const fresh = St.priority(facts(), {}, {}, NOW);
    eq([fresh.bars, fresh.factors.length], [1, 0]);
    // Old, but nobody is waiting for an answer: still the bottom band.
    const oldQuiet = St.priority(facts({ date: NOW - 300 * DAY }), A({ needs_response: 0.02 }), {}, NOW);
    eq([oldQuiet.bars, oldQuiet.factors.map((f) => f.id)], [1, []]);
    // Old AND waiting for an answer: one step up, never to the top on age alone.
    const oldWaiting = St.priority(facts({ date: NOW - 8 * DAY }), A({ needs_response: 0.9 }), {}, NOW);
    eq([oldWaiting.bars, oldWaiting.factors.map((f) => f.id)], [2, ['needs_reply', 'waiting']]);
  });

  test('state: the top band is earned by what the message is, not by how long it sat', () => {
    const old = facts({ date: NOW - 30 * DAY });
    const top = [
      ['a manuscript arrived', A({ needs_response: 0.9, is_sending_manuscript: 0.95 })],
      ['production is blocked', A({ needs_response: 0.9, previous_asks_for_approval: 0.9, approval_kind: C('changes', 0.9) })],
      ['a deadline within three days', A({ needs_response: 0.9, deadline_for_reply: C('d0', 0.9, { iso: '2026-09-22', kind: 'date' }) })]
    ];
    for (const [name, a] of top) eq(St.priority(old, a, {}, NOW).bars, 3, name);
    // Money and a plain request for an answer are real, but they do not reach
    // the top band on their own — only with waiting time on top.
    eq(St.priority(facts(), A({ needs_response: 0.9, intent: C('orders_payment_delivery', 0.9) }), {}, NOW).bars, 2);
    eq(St.priority(facts(), A({ needs_response: 0.9 }), {}, NOW).bars, 2);
    eq(St.priority(facts(), A({ needs_response: 0.02 }), {}, NOW).bars, 1);
  });

  test('state: a file on the row raises it even when the model says nothing about it', () => {
    const withFile = facts({ date: NOW - 8 * DAY, files: [{ ext: 'docx', kind: 'document', hint: 'manuscript' }] });
    const p = St.priority(withFile, A({ needs_response: 0.5 }), {}, NOW);
    eq([p.bars, p.factors.map((f) => [f.id, f.source])], [3, [['manuscript_waiting', 'code'], ['waiting', 'code']]]);
  });

  test('state: no topic is automatically high — a fresh brochure request sits in the middle band, not the top', () => {
    const r = St.deriveRow(facts(), A({ shows_interest: 0.95, asks_next_steps: 0.9, needs_response: 0.9 }), {}, NOW, ON);
    eq([r.group, r.priority.bars, r.priority.factors.map((f) => f.id), r.nextStep], ['then', 2, ['needs_reply'], 'send_brochure']);
  });

  test('state: a close deadline stated by the sender makes it "Do first"', () => {
    const a = A({ needs_response: 0.95, intent: C('orders_payment_delivery', 0.9), deadline_for_reply: C('d0', 0.9, { iso: '2026-09-23', kind: 'date' }) });
    const r = St.deriveRow(facts(), a, {}, NOW, ON);
    eq([r.group, r.priority.bars, r.priority.factors[0].id], ['do_first', 3, 'deadline_close']);
  });

  test('state: the editor can override priority, and the factors stay visible', () => {
    const r = St.deriveRow(facts({ date: NOW - 8 * DAY }), A({ needs_response: 0.9 }), { priorityOverride: 3 }, NOW, ON);
    eq([r.priority.bars, r.priority.override, r.priority.factors.map((f) => f.id), r.group], [3, true, ['needs_reply', 'waiting'], 'do_first']);
  });

  // ---- always-review classes ----
  test('state: someone acting for an author always goes to Needs review', () => {
    const r = St.deriveRow(facts(), A({ sender_is_representative: 0.9, authorization_evidence: 0.99, needs_response: 0.01 }), {}, NOW, ON);
    eq([r.group, r.reason.id], ['needs_review', 'representative']);
  });

  test('state: an instruction aimed at the classifier goes to Needs review, even if everything else says "no reply"', () => {
    const r = St.deriveRow(facts(), A({ addressed_to_automation: 0.9, needs_response: 0.01, opt_out: 0.99 }), {}, NOW, ON);
    eq([r.group, r.reason.id], ['needs_review', 'possible_injection']);
  });

  test('state: an unclear or low-confidence response to the editor request goes to Needs review', () => {
    const asked = { previous_asks_for_approval: 0.9 };
    eq(St.deriveRow(facts(), A(Object.assign({ approval_kind: C('unclear', 0.9) }, asked)), {}, NOW, ON).group, 'needs_review');
    eq(St.deriveRow(facts(), A(Object.assign({ approval_kind: C('approval', 0.4) }, asked)), {}, NOW, ON).group, 'needs_review');
    eq(St.deriveRow(facts(), A({ approval_kind: C('unclear', 0.9), intent: C('cover_proof_response', 0.9) }), {}, NOW, ON).group, 'needs_review');
  });

  test('state: unreadable bodies and inline replies are reviewed by hand and never classified', () => {
    eq(St.deriveRow(facts({ bodyState: 'too_large' }), A(), {}, NOW, ON).reason.id, 'body_too_large');
    eq(St.deriveRow(facts({ bodyState: 'unavailable' }), A(), {}, NOW, ON).group, 'needs_review');
    eq(St.deriveRow(facts({ authoredAmbiguous: true }), A({ needs_response: 0.01 }), {}, NOW, ON).reason.id, 'quote_ambiguous');
  });

  test('state: a reply to a message that asked for NO approval is not judged as an approval at all', () => {
    // e.g. the editor's earlier message was an introduction: "unclear" is the right answer and must not force review
    const r = St.deriveRow(facts(), A({ approval_kind: C('unclear', 0.9), previous_asks_for_approval: 0.05, needs_response: 0.9, intent: C('publishing_interest', 0.9) }), {}, NOW, ON);
    assert.notStrictEqual(r.group, 'needs_review');
    eq(r.reason.id, 'needs_reply');
    const fake = St.deriveRow(facts(), A({ approval_kind: C('approval', 0.99), previous_asks_for_approval: 0.05, needs_response: 0.9 }), {}, NOW, ON);
    assert.notStrictEqual(fake.reason.id, 'approval', 'no approval is claimed when nothing was up for approval');
    eq(St.priority(facts(), A({ approval_kind: C('approval', 0.99), previous_asks_for_approval: 0.05 }), {}, NOW).factors.length, 0);
  });

  // ---- approvals ----
  test('state: a confident approval or change request stays active and is never demoted', () => {
    const ap = St.deriveRow(facts(), A({ approval_kind: C('approval', 0.92), needs_response: 0.02, previous_asks_for_approval: 0.9 }), {}, NOW, ON);
    eq([ap.group, ap.nextStep, ap.reason.id], ['then', 'review_message', 'approval']);
    const ch = St.deriveRow(facts(), A({ approval_kind: C('changes', 0.9), needs_response: 0.02, previous_asks_for_approval: 0.9 }), {}, NOW, ON);
    eq([ch.nextStep, ch.reason.id], ['draft_reply', 'changes']);
  });

  // ---- demotion guard ----
  test('state: "no reply needed" requires a strict threshold', () => {
    eq(St.deriveRow(facts(), A({ needs_response: 0.05 }), {}, NOW, ON).group, 'no_reply_needed');
    assert.notStrictEqual(St.deriveRow(facts(), A({ needs_response: 0.2, intent: C('publication_status', 0.9) }), {}, NOW, ON).group, 'no_reply_needed');
  });

  test('state: a code signal blocks demotion — file, transfer link, unmarked lead', () => {
    const sureNo = A({ needs_response: 0.01, intent: C('other_unclear', 0.9) });
    for (const f of [facts({ files: [{ ext: 'pdf', kind: 'document', hint: 'unknown' }] }), facts({ transferHost: 'we.tl' }),
                     facts({ lead: { exists: true, status: 'no_response' } })]) {
      const r = St.deriveRow(f, sureNo, {}, NOW, ON);
      assert.ok(TriageSchema.DEMOTED_GROUPS.indexOf(r.group) === -1, r.group);
    }
  });

  test('state: an opt-out with a file attached is a contradiction, so it is reviewed', () => {
    const r = St.deriveRow(facts({ files: [{ ext: 'docx', kind: 'document', hint: 'manuscript' }] }), A({ opt_out: 0.97 }), {}, NOW, ON);
    eq(r.group, 'needs_review');
  });

  test('state: demoted rows stay on the page and say who demoted them', () => {
    const r = St.deriveRow(facts(), A({ opt_out: 0.97, needs_response: 0.05 }), {}, NOW, ON);
    eq([r.group, r.demotedBy], ['closed', 'model']);
    assert.ok(TriageSchema.GROUPS.indexOf(r.group) !== -1);
  });

  // ---- dates ----
  test('state: a promised future date parks the row until then; a passed one reactivates it', () => {
    const future = St.deriveRow(facts(), A({ needs_response: 0.1, promised_date: C('d0', 0.9, { iso: '2026-10-01', kind: 'month' }) }), {}, NOW, ON);
    eq([future.group, future.untilIso, future.reason.text, future.demotedBy], ['waiting_until', '2026-10-01', 'Says they will get back to you (during 2026-10).', 'model']);
    const past = St.deriveRow(facts({ date: NOW - 20 * DAY }), A({ states_future_commitment: 0.9, promised_date: C('d0', 0.9, { iso: '2026-09-10', kind: 'date' }) }), {}, NOW, ON);
    eq([past.reason.id, past.nextStep], ['promised_date_passed', 'draft_reply']);
    assert.ok(past.group === 'do_first' || past.group === 'then');
  });

  test('state: a promised date parks a row only at the strict demotion threshold — just below, it is evidence on an active row', () => {
    const at = (p, nr) => St.deriveRow(facts(), A({ needs_response: nr, intent: C('manuscript_correction', 0.9), promised_date: Object.assign(C('d0', p), { iso: '2026-10-05', kind: 'date' }) }), {}, NOW, ON);
    eq(at(0.90, 0.1).group, 'waiting_until');
    for (const p of [0.61, 0.89]) {
      const r = at(p, 0.1);
      assert.notStrictEqual(r.group, 'waiting_until', String(p));
      // The date is kept as evidence; the heading already says the row waits.
      assert.ok(r.evidence.some((e) => e.label === 'Date the sender commits to'), String(p));
    }
  });

  test('state: the chosen date\'s probability is what counts, not the answer\'s confidence field', () => {
    const pd = { option: 'd0', p: 0.61, confidence: 0.97, runnerUp: null, iso: '2026-10-05', kind: 'date' };
    assert.notStrictEqual(St.deriveRow(facts(), A({ needs_response: 0.05, promised_date: pd }), {}, NOW, ON).group, 'waiting_until');
    const noP = { option: 'd0', confidence: 0.97, runnerUp: null, iso: '2026-10-05', kind: 'date' };
    assert.notStrictEqual(St.deriveRow(facts(), A({ needs_response: 0.05, promised_date: noP }), {}, NOW, ON).group, 'waiting_until');
  });

  test('state: "please do X now; I will send Y later" stays active however sure the date is', () => {
    const pd = Object.assign(C('d0', 0.98), { iso: '2026-10-05', kind: 'date' });
    for (const nr of [0.95, 0.5, undefined]) {
      const r = St.deriveRow(facts(), A({ needs_response: nr, intent: C('metadata_cover_changes', 0.9), promised_date: pd }), {}, NOW, ON);
      assert.ok(['do_first', 'then', 'low', 'needs_review'].indexOf(r.group) !== -1, String(nr) + ' -> ' + r.group);
    }
    const asked = St.deriveRow(facts(), A({ needs_response: 0.95, intent: C('metadata_cover_changes', 0.9), promised_date: pd }), {}, NOW, ON);
    eq([asked.nextStep, asked.reason.id], ['draft_reply', 'needs_reply']);
  });

  test('state: a promised date never parks a row that came with a file or a transfer link', () => {
    const pd = Object.assign(C('d0', 0.98), { iso: '2026-10-05', kind: 'date' });
    for (const extra of [{ files: [{ ext: 'docx', kind: 'document', hint: 'manuscript' }] }, { transferHost: 'we.tl' }]) {
      assert.notStrictEqual(St.deriveRow(facts(extra), A({ needs_response: 0.05, promised_date: pd }), {}, NOW, ON).group, 'waiting_until');
    }
  });

  // ---- manuscripts and brochures ----
  test('state: manuscript by attachment or by link', () => {
    const att = St.deriveRow(facts({ files: [{ ext: 'docx', kind: 'document', hint: 'manuscript' }] }), A({ is_sending_manuscript: 0.95 }), {}, NOW, ON);
    eq([att.nextStep, att.reason.text], ['review_manuscript', 'Says they are sending their manuscript (.docx attached).']);
    const link = St.deriveRow(facts({ transferHost: 'we.tl' }), A({ is_sending_manuscript: 0.9 }), {}, NOW, ON);
    eq(link.reason.text, 'Says they are sharing their manuscript through we.tl.');
    // The row carries the short label; "links expire" is said in the details panel.
    assert.ok(link.chips.some((c) => c.id === 'transfer' && c.label === 'Transfer link'));
  });

  test('state: brochure step depends on whether an introduction from the editor was located', () => {
    const a = A({ shows_interest: 0.9, asks_where_to_send: 0.9 });
    eq(St.deriveRow(facts(), a, {}, NOW, ON).nextStep, 'send_brochure');
    eq(St.deriveRow(facts({ introduction: { state: TR.FOUND } }), a, {}, NOW, ON).nextStep, 'draft_reply');
    const unk = St.deriveRow(facts({ introduction: { state: TR.UNKNOWN } }), a, {}, NOW, ON);
    assert.ok(unk.chips.some((c) => c.id === 'send_brochure' && c.label === 'Brochure not checked'));
  });

  test('state: interest alone, without a question, is not a brochure request', () => {
    assert.notStrictEqual(St.deriveRow(facts(), A({ shows_interest: 0.95 }), {}, NOW, ON).nextStep, 'send_brochure');
  });

  // ---- later outbound ----
  // ---- "you replied" ----
  const REPLIED = { replied: { state: TR.FOUND, hmid: 'r@example.org' } };
  const LATER_MAIL = { laterOutbound: { state: TR.FOUND, hmid: 'x', auto: false }, replied: { state: TR.NOT_FOUND, hmid: null } };

  test('state: a later mail to the same person about something else never takes a task off the list', () => {
    const a = A({ needs_response: 0.95, intent: C('manuscript_correction', 0.95) });
    for (const opts of [ON, { useModel: false }]) {
      const r = St.deriveRow(facts(LATER_MAIL), a, {}, NOW, opts);
      assert.ok(['do_first', 'then', 'low'].indexOf(r.group) !== -1, r.group);
      // Shown in the evidence panel, not as a row label: it is a fact about the
      // correspondent, not a state of this message.
      eq(r.evidence.find((e) => e.label === 'Later message from you to this correspondent').value, 'located');
    }
    eq(St.deriveRow(facts(LATER_MAIL), a, {}, NOW, ON).nextStep, 'draft_reply');
    for (const auto of [true, null]) {
      const r = St.deriveRow(facts({ laterOutbound: { state: TR.FOUND, hmid: 'x', auto } }), a, {}, NOW, ON);
      assert.ok(!r.chips.some((c) => c.id === 'later_mail'), 'an automated or unknown later mail is not even a hint');
    }
  });

  test('state: a reply that names this message (reply header) closes it — with or without the model', () => {
    for (const opts of [ON, { useModel: false }]) {
      const r = St.deriveRow(facts(REPLIED), A({ needs_response: 0.95, intent: C('publication_status', 0.9) }), {}, NOW, opts);
      eq([r.group, r.reason.id, r.demotedBy], ['no_reply_needed', 'reply_located', 'code']);
    }
  });

  test('state: replied, but a manuscript or a transfer link came with the message -> it stays active', () => {
    const file = { files: [{ ext: 'docx', kind: 'document', hint: 'manuscript' }] };
    for (const opts of [ON, { useModel: false }]) {
      const active = (g) => ['do_first', 'then', 'low'].indexOf(g) !== -1;
      const r = St.deriveRow(facts(Object.assign({}, REPLIED, file)), A({ needs_response: 0.05 }), {}, NOW, opts);
      eq([active(r.group), r.nextStep, r.reason.id], [true, 'review_message', 'replied_work_pending']);
      const l = St.deriveRow(facts(Object.assign({}, REPLIED, { transferHost: 'we.tl' })), A({ needs_response: 0.05 }), {}, NOW, opts);
      eq([active(l.group), l.reason.id], [true, 'replied_work_pending']);
    }
  });

  test('state: replied but the lead is still "no response" in V4 -> next step is V4', () => {
    const r = St.deriveRow(facts(Object.assign({}, REPLIED, { lead: { exists: true, status: 'no_response' } })), A(), {}, NOW, ON);
    eq([r.nextStep, r.reason.id], ['open_in_v4', 'lead_unmarked']);
  });

  test('state: an unreadable or missing reply check is never read as "replied"', () => {
    for (const replied of [undefined, null, { state: TR.UNKNOWN }, { state: TR.NOT_FOUND }]) {
      const r = St.deriveRow(facts({ replied }), A({ needs_response: 0.95, intent: C('publication_status', 0.9) }), {}, NOW, ON);
      assert.notStrictEqual(r.group, 'no_reply_needed');
    }
    eq([St.repliedLabel(null), St.repliedLabel({ state: TR.NOT_FOUND }), St.repliedLabel({ state: TR.FOUND })],
      ['unable to check', 'not located in the scanned folders', 'located (reply header)']);
  });

  // ---- authorization ----
  test('state: a permission statement goes to review even when the author wrote it in person and nothing else is asked', () => {
    const r = St.deriveRow(facts(), A({ authorization_evidence: 0.99, sender_is_representative: 0.02, needs_response: 0.01, intent: C('other_unclear', 0.95) }), {}, NOW, ON);
    eq([r.group, r.reason.id], ['needs_review', 'authorization']);
    assert.ok(!r.chips.some((c) => c.id === 'representative'), 'the author is not labelled a representative');
    assert.ok(r.chips.some((c) => c.id === 'authorization'));
  });

  test('state: authorization outranks every demotion — opt-out, not-now, promised date, "no reply needed", a located reply', () => {
    const pd = Object.assign(C('d0', 0.98), { iso: '2026-10-05', kind: 'date' });
    const cases = [{ opt_out: 0.97 }, { not_now: 0.97 }, { promised_date: pd, needs_response: 0.02 }, { needs_response: 0.01 }];
    for (const extra of cases) {
      eq(St.deriveRow(facts(), A(Object.assign({ authorization_evidence: 0.8 }, extra)), {}, NOW, ON).group, 'needs_review', JSON.stringify(Object.keys(extra)));
    }
    eq(St.deriveRow(facts(REPLIED), A({ authorization_evidence: 0.8 }), {}, NOW, ON).group, 'needs_review');
    eq(St.deriveRow(facts(), A({ intent: C('rights_authorization', 0.9), authorization_evidence: 0.1 }), {}, NOW, ON).reason.id, 'authorization');
    eq(St.deriveRow(facts(), A({ sender_is_representative: 0.9, authorization_evidence: 0.9 }), {}, NOW, ON).reason.id, 'representative');
  });

  test('state: the editor\'s own Done still overrides an authorization row', () => {
    eq(St.deriveRow(facts(), A({ authorization_evidence: 0.99 }), { state: 'done' }, NOW, ON).group, 'done');
  });

  test('state: absence is worded as an observation', () => {
    eq(St.laterOutboundLabel({ state: TR.NOT_FOUND }), 'not located in the scanned folders');
    eq(St.laterOutboundLabel({ state: TR.UNKNOWN }), 'unable to check');
    eq(St.laterOutboundLabel(null), 'unable to check');
    eq(St.laterOutboundLabel({ state: TR.FOUND, auto: null }), 'located (may be automated)');
    eq(St.parentLabel({ role: 'other' }), "someone else's message (reply header)");
  });

  // ---- system, user state, shadow ----
  test('state: submission notifications are system tasks; other notices need nothing', () => {
    eq(St.deriveRow(facts({ system: { type: 'manuscript_submitted' } }), null, {}, NOW, ON).nextStep, 'import_or_reject');
    eq(St.deriveRow(facts({ system: { type: 'publication' } }), null, {}, NOW, ON).group, 'no_reply_needed');
  });

  test('state: Done and Snooze are the editor\'s and win over everything', () => {
    const hot = A({ needs_response: 0.99, approval_kind: C('changes', 0.95), previous_asks_for_approval: 0.95 });
    eq(St.deriveRow(facts(), hot, { state: 'done' }, NOW, ON).group, 'done');
    const sn = St.deriveRow(facts(), hot, { state: 'snoozed', until: NOW + 2 * DAY }, NOW, ON);
    eq([sn.group, sn.demotedBy], ['waiting_until', 'editor']);
    eq(St.deriveRow(facts(), hot, { state: 'snoozed', until: NOW - DAY }, NOW, ON).reason.id, 'changes');
  });

  test('state: in shadow mode the answers are evidence only and never move the row', () => {
    const a = A({ needs_response: 0.01, opt_out: 0.99 });
    const r = St.deriveRow(facts(), a, {}, NOW, { useModel: false });
    eq([r.group, r.modelUsed, r.reason.id], ['low', false, 'unclassified']);
    assert.ok(r.evidence.some((e) => e.source === 'model'));
  });

  test('state: a row without a classification says why', () => {
    const say = (modelState, f) => St.deriveRow(f || facts(), null, {}, NOW, { useModel: false, modelState }).reason.text;
    eq(say('off'), 'Not classified: classification is switched off in Settings.');
    eq(say('no_v4_key'), "Not classified: add your V4 API key in the add-on's Preferences first.");
    eq(say('unavailable'), 'Not classified: the classification service is not available right now.');
    eq(say('something-new'), 'Classification uncertain \u2014 see Details.');
    eq(say('error'), 'Not classified: the model could not be reached.');
    eq(say('shadow'), "Shadow mode: the model's answers are under Details.");
    eq(say('off', facts({ parent: { role: 'editor' } })), 'Replies to a message you sent.');
  });

  test('state: without a model a file still gives a concrete next step', () => {
    const r = St.deriveRow(facts({ files: [{ ext: 'pdf', kind: 'document', hint: 'unknown' }] }), null, {}, NOW, { useModel: false });
    eq([r.nextStep, r.reason.text], ['review_message', 'A file is attached (.pdf).']);
  });

  test('state: every evidence line names its source, and model lines carry a confidence', () => {
    const r = St.deriveRow(facts({ lead: { exists: true, status: 'response' } }), A({ intent: C('cover_proof_response', 0.8) }), {}, NOW, ON);
    for (const e of r.evidence) {
      assert.ok(e.source === 'code' || e.source === 'model', e.label);
      if (e.source === 'model') assert.ok(typeof e.confidence === 'number', e.label);
    }
  });

  test('state: every group and next step a row can take exists in the schema', () => {
    const variants = [A(), A({ opt_out: 0.97 }), A({ needs_response: 0.95 }), A({ needs_response: 0.02 }), A({ is_sending_manuscript: 0.9 }), null];
    for (const a of variants) for (const useModel of [true, false]) {
      const r = St.deriveRow(facts(), a, {}, NOW, { useModel });
      assert.ok(TriageSchema.isGroup(r.group), r.group);
      assert.ok(TriageSchema.isNextStep(r.nextStep), r.nextStep);
      assert.ok(r.reason.text && r.reason.text.indexOf('{') === -1, r.reason.text);
    }
  });
  // ---- the six agreed cards ----
  test('state: a row lands in at most one of the six cards, and code facts break the ties the questions cannot', () => {
    const card = (f, a) => St.cardOf(facts(f || {}), A(a || {}));
    const doc = [{ ext: 'docx', kind: 'document', hint: 'manuscript' }];

    // 2. Something actually arrived — a claim alone is not receipt.
    eq(card({ files: doc }, { is_sending_manuscript: 0.95, intent: C('submission', 0.9) }), 'manuscript');
    eq(card({ transferHost: 'we.tl' }, { is_sending_manuscript: 0.95 }), 'manuscript');
    eq(card({ system: { type: 'manuscript_submitted' } }, {}), 'manuscript');
    eq(card({}, { is_sending_manuscript: 0.95, intent: C('submission', 0.9) }), 'setup_publication', 'promised, not received');

    // 5. A launch offer, and a reply to one.
    eq(card({ system: { type: 'book_launch_offer' } }, {}), 'blo');
    eq(card({ parent: { role: 'editor', subject: 'Re: Get ready for your book\u2019s launch' } }, { intent: C('orders_payment_delivery', 0.9) }), 'blo', 'a price question about the offer is still the offer');
    eq(card({}, { intent: C('orders_payment_delivery', 0.9) }), 'orders');

    // 4. Cover and proof, read against the request.
    eq(card({}, { intent: C('cover_proof_response', 0.9) }), 'cover_proof');
    eq(card({}, { intent: C('metadata_cover_changes', 0.9), previous_asks_for_approval: 0.9, approval_kind: C('changes', 0.9) }), 'cover_proof');
    eq(card({}, { intent: C('metadata_cover_changes', 0.9) }), 'setup_publication', 'a metadata change with no review request is setup');
    // A permission confirmation also "asks for approval": it must not become a cover.
    eq(card({}, { intent: C('rights_authorization', 0.9), previous_asks_for_approval: 0.9, approval_kind: C('approval', 0.9) }), 'setup_publication');

    // 1, 3 and 6.
    eq(card({}, { shows_interest: 0.95, asks_next_steps: 0.9 }), 'brochure');
    eq(card({}, { intent: C('publication_status', 0.9) }), 'setup_publication');
    eq(card({}, { intent: C('account_access', 0.9) }), 'orders');
    eq(card({}, { intent: C('royalties_contract', 0.9) }), 'orders');

    // Nothing that fits is left uncarded rather than guessed.
    eq(card({}, { intent: C('other_unclear', 0.9) }), null);
    eq(card({}, { intent: C('manuscript_correction', 0.9) }), null);
    eq(card({}, {}), null);
    eq(St.cardOf(facts(), null), null);
  });

  test('state: the card travels on the row and every card id is one the schema knows', () => {
    const r = St.deriveRow(facts({ files: [{ ext: 'pdf', kind: 'document', hint: 'manuscript' }] }), A({ is_sending_manuscript: 0.95 }), {}, NOW, ON);
    eq(r.card, 'manuscript');
    assert.ok(S.CARDS.indexOf(r.card) !== -1);
    eq(Object.keys(S.CARD_LABELS).sort(), S.CARDS.slice().sort());
    // Without the model there is nothing to place a row with, except code facts.
    eq(St.deriveRow(facts(), null, {}, NOW, { useModel: false }).card, null);
    eq(St.deriveRow(facts({ system: { type: 'manuscript_submitted' } }), null, {}, NOW, { useModel: false }).card, 'manuscript');
  });
  // ---- defects the 21 Sep editorial audit found ----
  test('audit: a paid invoice PDF is a file to look at, not a manuscript', () => {
    const invoice = facts({ files: [{ ext: 'pdf', kind: 'document', hint: 'form_or_payment' }] });
    const p = St.priority(invoice, A({ is_sending_manuscript: 0.05, needs_response: 0.1 }), {}, NOW);
    eq(p.factors.map((f) => f.id), ['file_to_check']);
    eq(p.bars, 2, 'worth a look, not the top band');
    // A real manuscript still is one, by the sender saying so or by the filename.
    eq(St.priority(facts({ files: [{ ext: 'docx', kind: 'document', hint: 'manuscript' }] }), A({ is_sending_manuscript: 0.05 }), {}, NOW)
      .factors.some((f) => f.id === 'manuscript_waiting'), true);
    eq(St.priority(invoice, A({ is_sending_manuscript: 0.95 }), {}, NOW).factors.some((f) => f.id === 'manuscript_waiting'), true);
  });

  test('audit: a date that has gone by is overdue, never "within three days"', () => {
    const past = A({ deadline_for_reply: Object.assign(C('d0', 0.9), { iso: '2026-06-07', kind: 'date' }) });
    const ids = St.priority(facts(), past, {}, NOW).factors.map((f) => f.id);
    eq([ids.indexOf('deadline_close'), ids.indexOf('deadline_passed') !== -1], [-1, true]);
    // A real one three days out still counts.
    eq(St.priority(facts(), A({ deadline_for_reply: Object.assign(C('d0', 0.9), { iso: '2026-09-23', kind: 'date' }) }), {}, NOW)
      .factors.some((f) => f.id === 'deadline_close'), true);
  });

  test('audit: "during October" is late only once October is over', () => {
    const oct = A({ needs_response: 0.05, states_future_commitment: 0.9, promised_date: Object.assign(C('d0', 0.95), { iso: '2026-10-01', kind: 'month' }) });
    const late = (ms) => St.priority(facts(), oct, {}, ms).factors.some((f) => f.id === 'promised_date_passed');
    eq([late(Date.UTC(2026, 9, 2)), late(Date.UTC(2026, 9, 31)), late(Date.UTC(2026, 10, 1))], [false, false, true], '2 Oct, 31 Oct, 1 Nov');
    // A day-shaped date is still late the day after.
    const day = A({ states_future_commitment: 0.9, promised_date: Object.assign(C('d0', 0.95), { iso: '2026-10-01', kind: 'date' }) });
    eq(St.priority(facts(), day, {}, Date.UTC(2026, 9, 2)).factors.some((f) => f.id === 'promised_date_passed'), true);
  });

  test('audit: material the editor asked for counts even when no reply is needed', () => {
    const p = St.priority(facts({ date: NOW - 5 * DAY }), A({ needs_response: 0.05, missing_info_supplied: 0.9, intent: C('metadata_cover_changes', 0.95) }), {}, NOW);
    eq(p.factors.map((f) => f.id), ['material_supplied', 'waiting']);
    eq(p.bars, 3);
  });

  test('audit: an author we have already introduced ourselves to is not a brochure case', () => {
    const interested = A({ shows_interest: 0.95, asks_next_steps: 0.9, needs_response: 0.9 });
    eq(St.cardOf(facts(), interested), 'brochure');
    eq(St.cardOf(facts({ introduction: { state: TR.FOUND, auto: true } }), interested), null);
    eq(St.cardOf(facts({ lead: { exists: true, status: 'response' } }), interested), null);
    // Someone genuinely new stays in.
    eq(St.cardOf(facts({ introduction: { state: TR.NOT_FOUND }, lead: { exists: true, status: 'no_response' } }), interested), 'brochure');
  });

  test('audit: a body that is only an unsubscribe footer is not an opt-out', () => {
    const thin = St.deriveRow(facts({ authoredChars: 11 }), A({ opt_out: 0.95 }), {}, NOW, ON);
    eq([thin.group, thin.reason.id], ['needs_review', 'too_little_text']);
    // A real refusal in a real message still closes.
    eq(St.deriveRow(facts({ authoredChars: 240 }), A({ opt_out: 0.95, needs_response: 0.05 }), {}, NOW, ON).group, 'closed');
  });

  // Closing is terminal, so it takes a confident "nothing is being asked" —
  // not merely the absence of a yes. An answer of 0.5, or no answer at all, is
  // the model declining to say, and a row must not end on that.
  test('audit: an opt-out closes a row only on a confident "nothing asked"', () => {
    const at = (nr) => St.deriveRow(facts({ authoredChars: 240 }), A(nr === undefined ? { opt_out: 0.97, needs_response: undefined } : { opt_out: 0.97, needs_response: nr }), {}, NOW, ON);
    eq(at(0.05).group, 'closed');
    for (const nr of [0.5, 0.74, 0.95, undefined]) {
      const r = at(nr);
      eq([r.group, r.reason.id], ['needs_review', 'opt_out'], 'needs_response=' + nr);
    }
    // "Not now" keeps its ordinary classification instead of ending the row.
    assert.notStrictEqual(St.deriveRow(facts({ authoredChars: 240 }), A({ not_now: 0.97, needs_response: 0.5 }), {}, NOW, ON).group, 'closed');
    eq(St.deriveRow(facts({ authoredChars: 240 }), A({ not_now: 0.97, needs_response: 0.05 }), {}, NOW, ON).group, 'closed');
  });

  test('audit: snoozing says who snoozed it, and does not invent a promise', () => {
    const r = St.deriveRow(facts(), A(), { state: 'snoozed', until: NOW + 2 * DAY }, NOW, ON);
    eq([r.group, r.reason.id, r.reason.text], ['waiting_until', 'snoozed', 'You snoozed this until ' + r.untilIso + '.']);
  });
  test('audit: only a sender who actually committed can have missed a promise', () => {
    const expiry = A({ promised_date: Object.assign(C('d0', 0.95), { iso: '2026-06-07', kind: 'date' }), states_future_commitment: 0.05,
      deadline_for_reply: Object.assign(C('d0', 0.9), { iso: '2026-06-07', kind: 'date' }) });
    const ids = St.priority(facts(), expiry, {}, NOW).factors.map((f) => f.id);
    // One past date, one factor — not a missed deadline AND a broken promise.
    eq([ids.indexOf('promised_date_passed'), ids.filter((i) => i === 'deadline_passed').length], [-1, 1]);
  });

  // Three answers, not two, because hiding and demoting are different acts.
  // Marketing copy asks questions of everybody, so an ordinary "expects a
  // reply" does not put a mailing in the work list — but it does stop it being
  // hidden, because a row this application calls actionable must stay somewhere
  // the editor can find it. `bulk_mail` is the only reason the newsletter
  // filter removes, so the reason id is what decides that.
  test('audit: a mass mailing is hidden, shown or reviewed by how sure the model is', () => {
    const loud = A({ needs_response: 0.8, intent: C('orders_payment_delivery', 0.9) });
    const quiet = St.deriveRow(facts({ broadcast: 'bulk', date: NOW - 9 * DAY }), A({ needs_response: 0.5 }), {}, NOW, ON);
    eq([quiet.group, quiet.reason.id], ['no_reply_needed', 'bulk_mail'], 'an ordinary newsletter is hidden');
    const r = St.deriveRow(facts({ broadcast: 'bulk', date: NOW - 9 * DAY }), loud, {}, NOW, ON);
    eq([r.group, r.reason.id, r.priority.factors.map((f) => f.id)], ['no_reply_needed', 'bulk_asks', ['money_waiting']],
      'at the ordinary threshold it is out of the work list but no longer hidden');
    const sure = St.deriveRow(facts({ broadcast: 'bulk' }), A({ needs_response: 0.97 }), {}, NOW, ON);
    eq([sure.group, sure.reason.id], ['needs_review', 'bulk_asks']);
    // But anything that came with it keeps it active whatever the answer.
    for (const over of [{ files: [{ ext: 'docx', kind: 'document', hint: 'manuscript' }] }, { transferHost: 'we.tl' }, { lead: { exists: true, status: 'no_response' } }]) {
      const kept = St.deriveRow(facts(Object.assign({ broadcast: 'bulk' }, over)), loud, {}, NOW, ON);
      assert.notStrictEqual(kept.group, 'no_reply_needed', JSON.stringify(Object.keys(over)));
    }
    // And a real person writing about a manuscript is untouched by any of this.
    eq(St.deriveRow(facts(), loud, {}, NOW, ON).group === 'no_reply_needed', false);
  });

  // Automatic is a statement about who typed it, not about whether the editor
  // has anything to do. A platform mail asking her to approve something is
  // addressed to her alone.
  test('audit: an automated message that asks for something is not "no reply needed"', () => {
    const quietly = A({ needs_response: 0.05 });
    eq(St.deriveRow(facts({ broadcast: 'automated' }), quietly, {}, NOW, ON).reason.id, 'automated_mail');
    const asking = St.deriveRow(facts({ broadcast: 'automated' }), A({ needs_response: 0.8 }), {}, NOW, ON);
    eq([asking.group, asking.reason.id], ['needs_review', 'automated_asks']);
  });
  test('schema: a colleague photo is derived from the address, and anything else falls back to initials', () => {
    eq(S.employeePhoto('j.doe@globeedit.com'), { photoUrl: 'https://people.omniscriptum.com/signature/jdoe.jpg', initials: 'JD' });
    eq(S.employeePhoto('A.Bauer@OmniScriptum.com ').photoUrl, 'https://people.omniscriptum.com/signature/abauer.jpg');
    eq(S.employeePhoto('van.der-berg@x.de').photoUrl, 'https://people.omniscriptum.com/signature/vder-berg.jpg');
    // No first-initial-dot-surname shape, no guess.
    for (const e of ['alina@omniscriptum.com', 'no.reply.bot@x.com', 'a.b.c@x.com', '', null]) eq(S.employeePhoto(e).photoUrl, null, String(e));
    eq([S.employeePhoto('alina@x.com').initials, S.employeePhoto('').initials], ['AL', '?']);
  });
  test('audit: a paid receipt stays visible but not urgent; an unexplained attachment still counts', () => {
    const receipt = facts({ files: [{ ext: 'pdf', kind: 'document', hint: 'form_or_payment' }] });
    const paid = St.priority(receipt, A({ needs_response: 0.04, intent: C('orders_payment_delivery', 0.9) }), {}, NOW);
    eq([paid.factors.map((f) => f.id), paid.bars], [[], 1], 'nothing asked, nothing raised');
    // It is still kept out of the demoted groups by the attachment.
    const row = St.deriveRow(receipt, A({ needs_response: 0.04 }), {}, NOW, ON);
    assert.notStrictEqual(row.group, 'no_reply_needed');
    // An attachment on a message that might want something still raises it.
    eq(St.priority(receipt, A({ needs_response: 0.5 }), {}, NOW).factors.map((f) => f.id), ['file_to_check']);
  });

  // ---- the demotion rule holds even where the evidence is loud ----------------
  // Both halves are needed: a sure "no" from the model AND nothing in the code
  // that says otherwise. These are the places where one half went missing.
  test('audit: declining and asking for something in the same message is not closed', () => {
    const asks = St.deriveRow(facts({ authoredChars: 120 }), A({ opt_out: 0.99, needs_response: 0.95 }), {}, NOW, ON);
    eq([asks.group, asks.reason.id], ['needs_review', 'opt_out'], 'a request inside an opt-out is still a request');
    // A plain opt-out is still closed — the rule did not simply get stricter.
    const plain = St.deriveRow(facts({ authoredChars: 120 }), A({ opt_out: 0.99, needs_response: 0.02 }), {}, NOW, ON);
    eq([plain.group, plain.demotedBy], ['closed', 'model']);
    // Same for "not now".
    eq(St.deriveRow(facts({ authoredChars: 120 }), A({ not_now: 0.99, needs_response: 0.95 }), {}, NOW, ON).group !== 'closed', true);
    eq(St.deriveRow(facts({ authoredChars: 120 }), A({ not_now: 0.99, needs_response: 0.02 }), {}, NOW, ON).group, 'closed');
  });

  test('audit: a mass mailing that answers the editor is not "not written to you"', () => {
    const list = facts({ broadcast: 'bulk' });
    eq(St.deriveRow(list, A({ needs_response: 0.5 }), {}, NOW, ON).reason.id, 'bulk_mail', 'a plain mailing still steps aside');
    // Companies answer through the platform they send their newsletters with.
    const answer = facts({ broadcast: 'bulk', parent: { role: 'editor', via: 'in-reply-to', subject: 'Our invoice', date: NOW - DAY } });
    for (const id of ['bulk_mail', 'bulk_asks']) {
      assert.notStrictEqual(St.deriveRow(answer, A({ needs_response: 0.5 }), {}, NOW, ON).reason.id, id);
    }
  });

  test('audit: "during October" is not late on 2 October — in the row as well as in the score', () => {
    const oct = A({ needs_response: 0.05, states_future_commitment: 0.99, promised_date: Object.assign(C('d0', 0.95), { iso: '2026-10-01', kind: 'month' }) });
    const row = (ms) => St.deriveRow(facts(), oct, {}, ms, ON);
    assert.notStrictEqual(row(Date.UTC(2026, 9, 2, 9)).reason.id, 'promised_date_passed');
    eq(row(Date.UTC(2026, 9, 2, 9)).group, 'waiting_until', 'it is parked until the month is out');
    eq(row(Date.UTC(2026, 10, 1, 9)).reason.id, 'promised_date_passed');
    // A day-shaped promise is late the day after, as before.
    const day = A({ needs_response: 0.05, states_future_commitment: 0.99, promised_date: Object.assign(C('d0', 0.95), { iso: '2026-09-20', kind: 'date' }) });
    eq(St.deriveRow(facts(), day, {}, NOW, ON).reason.id, 'promised_date_passed');
  });

  // ---- conversations --------------------------------------------------------
  // A row as the scanner hands it over: one message, its judgment, and the
  // evidence of which conversation it belongs to.
  const msgRow = (hmid, o) => Object.assign({
    key: (o.acct || 'a1') + '|' + hmid, group: o.group || 'then', priority: { bars: o.bars || 2 }, card: o.card || null,
    display: { date: NOW - (o.hoursAgo || 1) * 3600000, who: { name: o.from || 'Ana Pop', address: (o.from || 'ana') + '@example.net' }, read: !!o.read },
    thread: { acct: o.acct || 'a1', hmid, refs: o.refs || [], people: o.people || [(o.from || 'ana') + '@example.net'] }
  }, o.extra || {});

  test('conversations: four replies in one thread are one row, saying the latest and ranked by the most urgent', () => {
    const rows = [
      msgRow('m1@x', { hoursAgo: 30, bars: 3, group: 'do_first', card: 'manuscript', from: 'Mira', people: ['mira@x', 'paul@x'] }),
      msgRow('m2@x', { hoursAgo: 20, refs: ['m1@x'], from: 'Paul', people: ['paul@x', 'mira@x'] }),
      msgRow('m3@x', { hoursAgo: 10, refs: ['m1@x', 'm2@x'], from: 'Mira', people: ['mira@x', 'lena@x'] }),
      msgRow('m4@x', { hoursAgo: 2, refs: ['m1@x', 'm3@x'], group: 'no_reply_needed', bars: 1, card: 'cover_proof', from: 'Lena', people: ['lena@x', 'paul@x'], read: true })
    ];
    const out = St.conversations(rows);
    eq(out.length, 1);
    const c = out[0];
    eq([c.key, c.count, c.keys], ['a1|m4@x', 4, ['a1|m4@x', 'a1|m3@x', 'a1|m2@x', 'a1|m1@x']], 'shown and opened as the latest message');
    eq([c.group, c.priority.bars], ['do_first', 3], 'the manuscript under the later "thanks" still ranks it');
    eq(c.card, 'cover_proof', 'the stage it is at now is the latest word on it');
    eq(c.display.people, ['Lena', 'Mira', 'Paul'], 'everyone who wrote, latest first, once each');
    eq(c.display.read, false, 'unread while any of it is unread');
  });

  // An introduction sent to fifty authors in one message has one Message-ID,
  // and every author who answers names it. Merging on that alone would put
  // fifty people behind one row.
  test('conversations: authors answering the same mass mailing stay separate conversations', () => {
    const rows = ['ana', 'bek', 'carl'].map((who, i) => msgRow(who + '@x', { hoursAgo: i + 1, refs: ['intro-blast@imprint'], from: who }));
    const out = St.conversations(rows);
    eq(out.length, 3);
    eq(out.map((c) => c.count), [1, 1, 1]);
    // But the same author writing twice about it is one conversation.
    const twice = St.conversations([msgRow('a1@x', { refs: ['intro-blast@imprint'] }), msgRow('a2@x', { refs: ['intro-blast@imprint', 'a1@x'] })]);
    eq([twice.length, twice[0].count], [1, 2]);
  });

  test('conversations: a subject is never evidence, and one mailbox never reaches into another', () => {
    // Same author, same subject, no reply headers: two separate messages.
    const noHeaders = St.conversations([msgRow('p1@x', {}), msgRow('p2@x', {})]);
    eq(noHeaders.length, 2);
    // The same thread copied into two imprints' mailboxes is two pieces of work.
    const twoBoxes = St.conversations([msgRow('t1@x', { acct: 'a1' }), msgRow('t2@x', { acct: 'a2', refs: ['t1@x'] })]);
    eq(twoBoxes.length, 2);
  });

  test('conversations: a finished conversation takes the state of its latest message; a single message is a conversation of one', () => {
    const done = St.conversations([
      msgRow('d1@x', { hoursAgo: 5, group: 'closed', bars: 1 }),
      msgRow('d2@x', { hoursAgo: 1, refs: ['d1@x'], group: 'no_reply_needed', bars: 1 })
    ]);
    eq([done.length, done[0].group, done[0].key], [1, 'no_reply_needed', 'a1|d2@x']);
    // A new message in a conversation she dismissed brings it back.
    const revived = St.conversations([
      msgRow('r1@x', { hoursAgo: 5, group: 'done', bars: 2 }),
      msgRow('r2@x', { hoursAgo: 1, refs: ['r1@x'], group: 'then', bars: 2 })
    ]);
    eq(revived[0].group, 'then');
    const one = St.conversations([msgRow('s1@x', {})]);
    eq([one[0].key, one[0].keys, one[0].count], ['a1|s1@x', ['a1|s1@x'], 1]);
    eq(St.conversations(null), []);
  });
})();
