// Facts + model answers + the editor's own marks -> one row for the Today page:
// group, next step, reason, chips, explainable priority and the evidence list.
// Pure and deterministic: same inputs, same row.
//
// Safety properties that must survive any edit here:
//  - the model can take a row out of the active groups only with a strict
//    threshold AND when no code signal disagrees; the row stays on the page;
//  - consequential classes (someone acting for an author, a possible injected
//    instruction, an unclear reply to the editor's own request) always land in
//    "Needs review", whatever the scores say;
//  - nothing in a row is worded as a fact unless code established it.

var TriageState = (function () {
  'use strict';

  const S = TriageSchema;
  const T = S.THRESHOLDS;
  const DAY = 86400000;

  function isYes(p) { return typeof p === 'number' && p >= T.yes; }
  function isSureNo(p) { return typeof p === 'number' && p <= 1 - T.demote; }
  function isSureYes(p) { return typeof p === 'number' && p >= T.demote; }
  function confident(c) { return !!c && typeof c.option === 'string' && typeof c.confidence === 'number' && c.confidence >= T.choiceConfident; }

  // Mon–Fri days strictly after `fromMs` up to `toMs`, in UTC so a row does not
  // change with the machine's timezone.
  function workingDaysBetween(fromMs, toMs) {
    if (typeof fromMs !== 'number' || typeof toMs !== 'number' || toMs <= fromMs) return 0;
    const start = Math.floor(fromMs / DAY), end = Math.floor(toMs / DAY);
    const span = Math.min(end - start, 3660);
    let n = 0;
    for (let i = 1; i <= span; i++) {
      const dow = new Date((start + i) * DAY).getUTCDay();
      if (dow !== 0 && dow !== 6) n++;
    }
    return n;
  }

  // "During October" is a promise for the whole month: it is late only once the
  // month is over. A day-shaped date is late the day after.
  function datePassed(d, nowMs) {
    if (!d || !d.iso) return false;
    if (d.kind !== 'month') { const n = daysUntil(d.iso, nowMs); return n !== null && n < 0; }
    const t = Date.parse(d.iso.slice(0, 7) + '-01T00:00:00Z');
    if (isNaN(t)) return false;
    const end = new Date(t);
    end.setUTCMonth(end.getUTCMonth() + 1);           // first day of the next month
    return nowMs >= end.getTime();
  }

  function daysUntil(iso, nowMs) {
    const t = Date.parse(iso + 'T00:00:00Z');
    return isNaN(t) ? null : Math.floor((t - Math.floor(nowMs / DAY) * DAY) / DAY);
  }

  // Code signals that forbid demotion: there is something here to handle even
  // if the text reads like it needs no reply.
  function demotionBlockers(facts) {
    const out = [];
    if ((facts.files || []).some((f) => f.kind === 'document' || f.kind === 'archive')) out.push('file_attached');
    if (facts.transferHost) out.push('transfer_link');
    if (facts.lead && facts.lead.exists && facts.lead.status === 'no_response') out.push('lead_unmarked');
    return out;
  }

  // What makes a message urgent is what it asks for, not how long it has sat
  // there. Age only adds to a row that actually wants an answer — an old
  // message needing nothing is not urgent — and it adds at most one point, so
  // it can never carry a row to the top on its own. Every point is listed in
  // the Details panel, and the editor can override the result.
  function priority(facts, answers, userState, nowMs) {
    const factors = [];
    let score = 0;
    const a = answers || {};
    const add = (id, points, detail, source) => { score += points; factors.push({ id, points, detail: detail || null, source: source || 'model' }); };
    const intentId = confident(a.intent) ? a.intent.option : null;
    const wantsReply = isYes(a.needs_response);

    // A date that has gone by is overdue, never "coming up in three days".
    const dl = a.deadline_for_reply;
    if (confident(dl) && dl.option !== 'none' && dl.iso) {
      const d = daysUntil(dl.iso, nowMs);
      if (d !== null && d < 0) add('deadline_passed', 2, dl.iso);
      else if (d !== null && d <= 3) add('deadline_close', 3, dl.iso);
      else if (d !== null && d <= 10) add('deadline', 1, dl.iso);
    }
    const pd = a.promised_date;
    // "They promised" needs the sender to have promised something. An expiry
    // notice carries a date without anyone committing to anything, and it was
    // scoring twice: once as a missed deadline, once as a broken promise.
    if (confident(pd) && pd.option !== 'none' && pd.iso && isYes(a.states_future_commitment) && datePassed(pd, nowMs)) add('promised_date_passed', 2, pd.iso);
    // Production is blocked: the editor's answer is the next step for a book.
    const asked = isYes(a.previous_asks_for_approval) || intentId === 'cover_proof_response';
    const ak = asked ? a.approval_kind : null;
    let blocked = false;
    if (confident(ak) && (ak.option === 'approval' || ak.option === 'changes')) { add('production_waiting', 2, ak.option); blocked = true; }
    else if (intentId && wantsReply && (intentId === 'manuscript_correction' || intentId === 'metadata_cover_changes')) { add('production_waiting', 2, S.INTENT_PHRASES[intentId] || intentId); blocked = true; }

    // A manuscript that has arrived is work with a clock on it. An attachment on
    // its own is not one: a paid invoice is a PDF too. Either the sender says so,
    // or the file is named like a manuscript — otherwise it is just a file to
    // look at, which is worth one point, not three.
    const files = facts.files || [];
    const namedManuscript = files.some((f) => f.hint === 'manuscript') || (!!facts.transferHost && isYes(a.is_sending_manuscript));
    const manuscript = isYes(a.is_sending_manuscript) || namedManuscript;
    const hasFile = files.some((f) => f.kind === 'document' || f.kind === 'archive') || !!facts.transferHost;
    if (manuscript) add('manuscript_waiting', 3, null, isYes(a.is_sending_manuscript) ? 'model' : 'code');
    // A paid receipt is a PDF too. An attachment only raises a row while the
    // message might still want something; once the answers are confidently
    // "nothing to do", the file keeps the row visible but not urgent.
    else if (hasFile && !isSureNo(a.needs_response)) add('file_to_check', 1, fileDetail(facts), 'code');
    if (wantsReply && (intentId === 'orders_payment_delivery' || intentId === 'royalties_contract')) add('money_waiting', 1, S.INTENT_PHRASES[intentId] || intentId);
    // What she asked for has arrived: production can move, whether or not a
    // reply is needed.
    const broadcast = !!facts.broadcast;
    const supplied = isYes(a.missing_info_supplied);
    if (supplied) add('material_supplied', 2, null);
    if (wantsReply && !broadcast) add('needs_reply', 1);

    // Age, only where somebody is actually waiting for an answer, and capped.
    const wd = workingDaysBetween(facts.date, nowMs);
    if (wd >= 3 && !broadcast && (wantsReply || blocked || manuscript || supplied)) add('waiting', 1, String(wd), 'code');

    let bars = score >= 3 ? 3 : score >= 1 ? 2 : 1;
    const ov = userState && userState.priorityOverride;
    const override = ov === 1 || ov === 2 || ov === 3;
    if (override) bars = ov;
    return { bars, score, factors, override };
  }

  const SENTENCES = {
    manuscript_attached: 'Says they are sending their manuscript ({detail} attached).',
    manuscript_link: 'Says they are sharing their manuscript through {detail}.',
    publishing_interest: 'Shows interest in publishing and asks how to proceed.',
    approval: 'Approves what you sent for review.',
    changes: 'Asks for changes to what you sent for review.',
    acknowledgment: 'Acknowledges your message without approving or asking for changes.',
    reply_unclear: 'Replies to your request, but it is not clear what they are answering.',
    opt_out: 'Asks not to be contacted, or says they are not interested.',
    not_now: 'Declines for now and may come back later.',
    promised_date: 'Says they will get back to you ({detail}).',
    snoozed: 'You snoozed this until {detail}.',
    too_little_text: 'Too little of this message could be read to judge it \u2014 open it to see.',
    promised_date_passed: 'Said they would get back to you by {detail}; that date has passed.',
    representative: 'Writes on behalf of another person who is the author.',
    possible_injection: 'The text contains instructions aimed at an automated system.',
    low_confidence: 'The model could not classify this message with confidence.',
    body_too_large: 'The message is too large to load automatically.',
    body_unavailable: 'The message text could not be loaded.',
    body_empty: 'The message has no readable text.',
    quote_ambiguous: 'The reply is mixed into quoted text, so nothing was sent to the model.',
    reply_located: 'Your reply to this message was located.',
    replied_work_pending: 'You replied, but this message came with {detail} — check it has been dealt with.',
    authorization: 'Contains a statement of permission or authorization. Check it by hand.',
    lead_unmarked: 'You wrote back, but the lead is still "no response" in V4.',
    model_no_reply: 'Reads as needing no reply.',
    system_import: 'Submission notification: verify the manuscript, then import or reject.',
    system_transferred: 'Manuscripts were transferred to you.',
    system_info: 'Platform notification.',
    unclassified: 'Classification uncertain \u2014 see Details.',
    unclassified_off: 'Not classified: classification is switched off in Settings.',
    unclassified_no_v4_key: 'Not classified: add your V4 API key in the add-on\'s Preferences first.',
    unclassified_unavailable: 'Not classified: the classification service is not available right now.',
    unclassified_shadow: 'Shadow mode: the model\'s answers are under Details.',
    unclassified_error: 'Not classified: the model could not be reached.',
    unclassified_busy: 'Not classified yet: the model is busy. Today will ask again in a few minutes.',
    reply_to_you: 'Replies to a message you sent.',
    bulk_mail: 'Sent to a mailing list, not written to you.',
    automated_mail: 'Sent automatically, not written by a person.',
    bulk_asks: 'Sent to a mailing list, but it reads as asking you for something.',
    automated_asks: 'Sent automatically, but it asks you to do something.',
    file_received: 'A file is attached ({detail}).',
    needs_reply: 'Asks about {detail}. Expects a reply.',
    about: 'Writes about {detail}.'
  };

  function reason(id, detail) {
    const tpl = SENTENCES[id] || SENTENCES.unclassified;
    return { id, detail: detail || null, text: tpl.replace('{detail}', detail || '') };
  }

  function chip(id, label, tone, source, confidence) {
    return { id, label, tone, source, confidence: typeof confidence === 'number' ? confidence : null };
  }

  function laterOutboundLabel(lo) {
    if (!lo || lo.state === S.TRISTATE.UNKNOWN) return 'unable to check';
    if (lo.state === S.TRISTATE.NOT_FOUND) return 'not located in the scanned folders';
    if (lo.auto === false) return 'located';
    if (lo.auto === true) return 'only an automated message located';
    return 'located (may be automated)';
  }

  function repliedLabel(r) {
    if (r && r.state === S.TRISTATE.FOUND) return 'located (reply header)';
    if (r && r.note === 'unconfirmed') return 'a linked message was located, but it may be automated';
    if (r && r.note === 'automated_only') return 'only an automated reply was located';
    if (!r || r.state === S.TRISTATE.UNKNOWN) return 'unable to check';
    return 'not located in the scanned folders';
  }

  function introLabel(i) {
    if (!i || i.state === S.TRISTATE.UNKNOWN) return 'unable to check';
    if (i.state !== S.TRISTATE.FOUND) return 'not located in the scanned folders';
    return i.auto ? 'an introduction sent under your address was located' : 'a message you wrote was located';
  }

  function parentLabel(parent) {
    if (!parent) return 'no reply header, or the earlier message is not in the scanned folders';
    if (parent.role === 'editor') return 'your message (reply header)';
    if (parent.role === 'editor_automated') return 'an automated message sent under your address (reply header)';
    return "someone else's message (reply header)";
  }

  function evidence(facts, answers) {
    const rows = [];
    const add = (label, value, source, confidence) => rows.push({ label, value, source, confidence: typeof confidence === 'number' ? confidence : null });
    add('Replies to', parentLabel(facts.parent), 'code');
    add('Your reply to this message', repliedLabel(facts.replied), 'code');
    add('Later message from you to this correspondent', laterOutboundLabel(facts.laterOutbound), 'code');
    add('Earlier message from you to this correspondent', introLabel(facts.introduction), 'code');
    const refs = facts.refsMentioned || {};
    const mentioned = [].concat(refs.isbns || [], (refs.projectIds || []).map((p) => 'project ' + p));
    add('Project / ISBN mentioned', mentioned.length ? mentioned.join(', ') : 'none', 'code');
    if (facts.lead) add('V4 lead status', facts.lead.exists ? (facts.lead.status || 'lead') : 'not a lead', 'code');
    if ((facts.files || []).length) add('Files', facts.files.map((f) => '.' + (f.ext || '?')).join(' '), 'code');
    if (facts.transferHost) add('File-transfer link', facts.transferHost + ' (expiry unknown)', 'code');
    const a = answers || {};
    if (a.intent) add('Topic', S.INTENTS[a.intent.option] || a.intent.option, 'model', a.intent.confidence);
    const nouls = [
      ['needs_response', 'Requires a reply or action'], ['is_sending_manuscript', 'Says the manuscript is sent with this message'],
      ['shows_interest', 'Shows interest in publishing'], ['asks_next_steps', 'Asks for next steps or more information'],
      ['asks_where_to_send', 'Asks where or how to send a manuscript'], ['unfamiliar', 'Seems unfamiliar with the service'],
      ['opt_out', 'Refuses contact or is not interested'], ['not_now', 'Declines for now'],
      ['states_future_commitment', 'Promises a later action'], ['sender_is_representative', 'Writes on behalf of the author'],
      ['authorization_evidence', "Contains the author's own permission"], ['missing_info_supplied', 'Provides what you asked for'],
      ['previous_asks_for_approval', 'Your earlier message asked for a review or confirmation'],
      ['addressed_to_automation', 'Contains instructions for an automated system']
    ];
    for (const [id, label] of nouls) if (typeof a[id] === 'number') add(label, a[id] >= 0.5 ? 'yes' : 'no', 'model', a[id] >= 0.5 ? a[id] : 1 - a[id]);
    if (a.approval_kind) add('Response to your request', a.approval_kind.option, 'model', a.approval_kind.confidence);
    if (a.promised_date && a.promised_date.option !== 'none') add('Date the sender commits to', a.promised_date.iso || a.promised_date.option, 'model', a.promised_date.confidence);
    if (a.deadline_for_reply && a.deadline_for_reply.option !== 'none') add('Deadline the sender gives you', a.deadline_for_reply.iso || a.deadline_for_reply.option, 'model', a.deadline_for_reply.confidence);
    return rows;
  }

  function fileDetail(facts) {
    const f = (facts.files || []).find((x) => x.kind === 'document') || (facts.files || [])[0];
    return f ? '.' + (f.ext || 'file') : 'a file';
  }

  // opts: { useModel: boolean }  — false in shadow mode and with no backend:
  // answers are then shown as evidence only and never move the row.
  // Which of the six agreed cards this row belongs to, or null. First match
  // wins, most specific first, because the question set of this version cannot
  // separate every case on its own: `submission` covers both sending a
  // manuscript and registering a project, and `metadata_cover_changes` covers
  // both project details and cover changes. Code facts (a file, a transfer
  // link, a recognised notification, the message this one replies to) break
  // those ties, and a row nobody can place stays cardless rather than guessed.
  function cardOf(facts, answers) {
    const a = answers || {};
    const intentId = confident(a.intent) ? a.intent.option : null;
    const sys = facts.system && facts.system.type;
    const hasFile = (facts.files || []).some((f) => f.kind === 'document' || f.kind === 'archive') || !!facts.transferHost;

    // 2. Something actually arrived, or the platform says it did.
    if (sys === 'manuscript_submitted' || sys === 'manuscripts_transferred') return 'manuscript';
    if (isYes(a.is_sending_manuscript) && hasFile) return 'manuscript';

    // 5. A launch offer, or a reply to one.
    if (sys === 'book_launch_offer') return 'blo';
    if (facts.parent && TriageRules.systemTypeOfSubject(facts.parent.subject) === 'book_launch_offer') return 'blo';

    // 4. A cover or proof, read against the request that asked for it.
    const approvalAsked = isYes(a.previous_asks_for_approval) || intentId === 'cover_proof_response';
    const ak = approvalAsked ? a.approval_kind : null;
    if (intentId === 'cover_proof_response') return 'cover_proof';
    if (confident(ak) && (ak.option === 'approval' || ak.option === 'changes') && intentId === 'metadata_cover_changes') return 'cover_proof';

    // 1. Interest with no sign that they know us yet.
    // Interest is only a brochure case for someone we have not started with:
    // an author whose introduction went out, or who already has a project in
    // V4, is asking about work in progress.
    const known = (facts.introduction && facts.introduction.state === S.TRISTATE.FOUND && facts.introduction.auto) ||
      (facts.lead && facts.lead.exists && facts.lead.status && facts.lead.status !== 'no_response');
    if (!known && isYes(a.shows_interest) && (isYes(a.unfamiliar) || isYes(a.asks_next_steps) || isYes(a.asks_where_to_send))) return 'brochure';

    // 6. Money, and what comes after the book.
    if (intentId === 'orders_payment_delivery' || intentId === 'royalties_contract' || intentId === 'account_access') return 'orders';

    // 3. Everything about getting the project set up and out.
    if (intentId === 'submission' || intentId === 'metadata_cover_changes' || intentId === 'publication_status' || intentId === 'rights_authorization') return 'setup_publication';
    if (sys === 'publication' || sys === 'book_notice' || sys === 'voucher') return 'setup_publication';
    return null;
  }

  function deriveRow(facts, answers, userState, nowMs, opts) {
    const useModel = !!(opts && opts.useModel) && !!answers && Object.keys(answers).length > 0;
    const a = useModel ? answers : {};
    const us = userState || {};
    const chips = [];
    const blockers = demotionBlockers(facts);
    const pr = priority(facts, a, us, nowMs);
    const row = {
      key: facts.key, group: 'then', nextStep: 'none', reason: reason('unclassified'),
      chips, priority: pr, blockers, demotedBy: null, untilIso: null,
      ageWorkingDays: workingDaysBetween(facts.date, nowMs),
      evidence: evidence(facts, answers), modelUsed: useModel,
      card: cardOf(facts, a)
    };
    const finish = (group, nextStep, rsn, demotedBy) => {
      row.group = group; row.nextStep = nextStep; row.reason = rsn; row.demotedBy = demotedBy || null;
      return row;
    };
    // One band per bar count: three bars high, two medium, one low.
    const active = (nextStep, rsn) => finish(pr.bars === 3 ? 'do_first' : pr.bars === 2 ? 'then' : 'low', nextStep, rsn);

    if (facts.transferHost) chips.push(chip('transfer', 'Transfer link', 'blue', 'code'));

    if (us.state === 'done') return finish('done', 'none', row.reason);
    if (us.state === 'snoozed' && typeof us.until === 'number' && us.until > nowMs) {
      row.untilIso = new Date(us.until).toISOString().slice(0, 10);
      return finish('waiting_until', 'none', reason('snoozed', row.untilIso), 'editor');
    }

    if (facts.system) {
      if (facts.system.type === 'manuscript_submitted') return finish('system_tasks', 'import_or_reject', reason('system_import'));
      if (facts.system.type === 'manuscripts_transferred') return finish('system_tasks', 'review_message', reason('system_transferred'));
      return finish('no_reply_needed', 'none', reason('system_info'), 'code');
    }

    if (facts.bodyState && facts.bodyState !== 'ok') return finish('needs_review', 'review_message', reason('body_' + facts.bodyState));
    if (facts.authoredAmbiguous) return finish('needs_review', 'review_message', reason('quote_ambiguous'));

    // Only a reply that names THIS message (reply header) can take it off the
    // active list, and only when nothing that came with it is left to handle. A
    // later mail to the same person may be about another book: it is shown as
    // evidence and never moves the row.
    const replied = !!facts.replied && facts.replied.state === S.TRISTATE.FOUND;
    const afterReply = () => {
      if (blockers.indexOf('lead_unmarked') !== -1) return active('open_in_v4', reason('lead_unmarked'));
      if (blockers.indexOf('file_attached') !== -1) return active('review_message', reason('replied_work_pending', 'a file (' + fileDetail(facts) + ')'));
      if (blockers.indexOf('transfer_link') !== -1) return active('review_message', reason('replied_work_pending', 'a file-transfer link'));
      return finish('no_reply_needed', 'none', reason('reply_located'), 'code');
    };

    if (!useModel) {
      if (replied) return afterReply();
      if ((facts.files || []).length) return active('review_message', reason('file_received', fileDetail(facts)));
      // Say WHY there is no classification, and still say what code can see.
      if (facts.parent && facts.parent.role === 'editor') return active('none', reason('reply_to_you'));
      const why = opts && opts.modelState;
      const known = ['off', 'no_v4_key', 'unavailable', 'shadow', 'busy', 'error'];
      return active('none', reason(known.indexOf(why) !== -1 ? 'unclassified_' + why : 'unclassified'));
    }

    // A newsletter, an advertisement or a one-use sign-in link is addressed to
    // whoever opens it, not to this editor. Its own headers say so, so no
    // wording in the body can argue otherwise. It stays visible, and anything
    // that came WITH it — a file, a transfer link, an unmarked V4 lead — still
    // keeps it active.
    // A reply that names a message the editor wrote is addressed to this editor
    // however it was carried, so it is never "sent to a list": companies answer
    // through the same platform they send their newsletters with.
    const answersMe = !!(facts.parent && facts.parent.role === 'editor');
    const consequential = isYes(a.is_sending_manuscript) || isYes(a.authorization_evidence) || isYes(a.sender_is_representative);
    if (facts.broadcast && !blockers.length && !answersMe && !consequential) {
      // Automatic does not mean nothing to do: a platform mail can ask the
      // editor to approve, confirm or fix something, and it is addressed to her
      // alone. So an automated message steps aside only while nothing is being
      // asked of her.
      //
      // A mailing is different in kind — the headers say it went to a list, and
      // marketing copy asks questions of everybody. There the header wins over
      // an ordinary "yes", and only a SURE yes (the same strict threshold the
      // model needs to demote anything) is enough to keep the row. Then it goes
      // to review rather than into the work list, and nothing is ever dropped
      // silently while two signals disagree.
      if (facts.broadcast === 'automated') {
        if (!isYes(a.needs_response)) return finish('no_reply_needed', 'none', reason('automated_mail'), 'code');
        return finish('needs_review', 'review_message', reason('automated_asks'));
      }
      // A mailing gets three answers rather than two, because hiding and
      // demoting are different acts and only one of them is unrecoverable.
      // Below the ordinary threshold it is a newsletter and is hidden. At the
      // ordinary threshold the row is no longer hidden — whatever the header
      // says, a message this application calls actionable must remain somewhere
      // the editor can find it — but it is not put in the work list either,
      // because marketing copy asks questions of everybody. Only a sure yes,
      // the same bar the model needs to demote anything, sends it to review.
      if (!isYes(a.needs_response)) return finish('no_reply_needed', 'none', reason('bulk_mail'), 'code');
      if (!isSureYes(a.needs_response)) return finish('no_reply_needed', 'none', reason('bulk_asks'), 'code');
      return finish('needs_review', 'review_message', reason('bulk_asks'));
    }

    // ---- always-review classes ------------------------------------------------
    // The injection canary sends a row to a human, so a shaky "yes" costs the
    // editor a pointless review. It is held to the strict threshold; the answer
    // is still shown under Details whatever it says. (Measured: 4 false
    // positives in 94 synthetic cases at the ordinary threshold, 0 true ones
    // among the 200 real conversations.)
    if (isSureYes(a.addressed_to_automation)) {
      return finish('needs_review', 'review_message', reason('possible_injection'));
    }
    const intentId = confident(a.intent) ? a.intent.option : null;
    if (isYes(a.sender_is_representative)) {
      chips.push(chip('representative', 'Acting for an author', 'warn', 'model', a.sender_is_representative));
      return finish('needs_review', 'review_message', reason('representative'));
    }
    // A permission can come from the author in person: that is not a
    // "representative", but it is just as much a matter for a human. The model
    // detects the statement; it cannot tell who really wrote it.
    if (isYes(a.authorization_evidence) || intentId === 'rights_authorization') {
      chips.push(chip('authorization', 'Permission / authorization', 'warn', 'model',
        isYes(a.authorization_evidence) ? a.authorization_evidence : a.intent.confidence));
      return finish('needs_review', 'review_message', reason('authorization'));
    }
    // approval_kind counts only when the editor's earlier message really asked for
    // a review or confirmation (or the message is itself about a cover or proof).
    // A reply to an introduction is "unclear" by nature and must not flood review.
    const approvalAsked = isYes(a.previous_asks_for_approval) || intentId === 'cover_proof_response';
    const ak = approvalAsked ? a.approval_kind : null;
    if (ak && (!confident(ak) || ak.option === 'unclear')) {
      return finish('needs_review', 'review_message', reason('reply_unclear'));
    }

    if (replied) return afterReply();

    // ---- active by explicit response to the editor's own request ---------------
    if (ak && ak.option === 'approval') {
      chips.push(chip('approval', 'Explicit approval', 'ok', 'model', ak.confidence));
      return active('review_message', reason('approval'));
    }
    if (ak && ak.option === 'changes') {
      chips.push(chip('changes', 'Changes requested', 'warn', 'model', ak.confidence));
      return active('draft_reply', reason('changes'));
    }

    // ---- demotions: strict threshold, no disagreeing code signal, still visible --
    // A body that is only an unsubscribe control is not the sender asking to be
    // left alone; it is what the quote stripper had left after a newsletter.
    // Declining is not the same as wanting nothing: "take me off your list, and
    // please confirm you have deleted my data" opts out and asks for something in
    // the same breath. So closing a row needs BOTH halves of the demotion rule —
    // a sure opt-out AND a confident "nothing is being asked". Not merely the
    // absence of a yes: an answer of 0.5, or no answer at all, is not the model
    // saying no, and a row closed on that is closed on a coin toss.
    const sureNothingAsked = isSureNo(a.needs_response);
    const thinOptOut = isSureYes(a.opt_out) && facts.authoredChars !== undefined && facts.authoredChars <= 40;
    if (thinOptOut) return finish('needs_review', 'review_message', reason('too_little_text'));
    if (isSureYes(a.opt_out)) {
      if (blockers.length || !sureNothingAsked) return finish('needs_review', 'review_message', reason('opt_out'));
      chips.push(chip('opt_out', 'Not interested', 'neutral', 'model', a.opt_out));
      return finish('closed', 'none', reason('opt_out'), 'model');
    }
    if (isSureYes(a.not_now) && !blockers.length && sureNothingAsked) {
      chips.push(chip('not_now', 'Not now', 'neutral', 'model', a.not_now));
      return finish('closed', 'none', reason('not_now'), 'model');
    }
    // A promised date parks the row only under the same strict rule as every
    // other demotion: the PROBABILITY of the chosen date (not the answer's
    // `confidence` field, a different quantity) is at least T.demote, nothing
    // that came with the message is pending, and the message does not also ask
    // for something now ("please do X; I will send Y later" stays active).
    // Below that, the date is evidence on a row that stays where it is.
    const pd = a.promised_date;
    if (confident(pd) && pd.option !== 'none' && pd.iso) {
      // The same month-aware reckoning the priority factors use: "during
      // October" is late on 1 November, not on 2 October.
      if (datePassed(pd, nowMs)) {
        chips.push(chip('promise_passed', 'Promised date passed', 'warn', 'model', pd.confidence));
        if (!blockers.length) return active('draft_reply', reason('promised_date_passed', pd.iso));
      } else {
        // Deliberately not the strict "nothing asked" of a closure: parking a
        // row under Waiting is not the same act as closing it. The row stays on
        // the page, says which date it is waiting for, and comes back by itself
        // when that date passes — so an uncertain answer here costs a few days
        // of a row sitting one group lower, where closing it on the same answer
        // would end it.
        const sure = typeof pd.p === 'number' && pd.p >= T.demote;
        const nothingNow = typeof a.needs_response === 'number' && a.needs_response <= T.no;
        if (sure && nothingNow && !blockers.length) {
          row.untilIso = pd.iso;
          return finish('waiting_until', 'none', reason('promised_date', pd.kind === 'month' ? 'during ' + pd.iso.slice(0, 7) : 'by ' + pd.iso), 'model');
        }
      }
    }

    // ---- what the sender is asking for --------------------------------------------
    if (isYes(a.is_sending_manuscript)) {
      chips.push(chip('manuscript', 'Manuscript received', 'blue', 'model', a.is_sending_manuscript));
      return active('review_manuscript', facts.transferHost && !(facts.files || []).length
        ? reason('manuscript_link', facts.transferHost) : reason('manuscript_attached', fileDetail(facts)));
    }
    if (isYes(a.shows_interest) && (isYes(a.asks_next_steps) || isYes(a.asks_where_to_send) || isYes(a.unfamiliar))) {
      const intro = facts.introduction;
      const located = !!intro && intro.state === S.TRISTATE.FOUND;
      chips.push(located
        ? chip('intro_located', intro.auto ? 'Introduction already sent' : 'You wrote to them before', 'neutral', 'code')
        : chip('send_brochure', !intro || intro.state === S.TRISTATE.UNKNOWN ? 'Brochure not checked' : 'No introduction found', 'warn', 'code'));
      return active(located ? 'draft_reply' : 'send_brochure', reason('publishing_interest'));
    }

    if (isSureNo(a.needs_response) && !blockers.length) {
      return finish('no_reply_needed', 'none', reason('model_no_reply'), 'model');
    }

    const uncertain = typeof a.needs_response === 'number' && a.needs_response > T.no && a.needs_response < T.yes;
    if (!intentId && uncertain) return finish('needs_review', 'review_message', reason('low_confidence'));

    const label = intentId ? (S.INTENT_PHRASES[intentId] || S.INTENTS[intentId]) : null;
    if (isYes(a.needs_response)) return active('draft_reply', label ? reason('needs_reply', label) : reason('unclassified'));
    if ((facts.files || []).length) return active('review_message', reason('file_received', fileDetail(facts)));
    return active('none', label ? reason('about', label) : reason('unclassified'));
  }

  // ---- conversations -------------------------------------------------------
  // The editor works in conversations, not messages: four replies in one
  // thread are one thing to deal with, and four rows for it said four. Rows are
  // still derived one message at a time — every judgment above is about one
  // message — and are gathered here into one row per conversation.
  //
  // Two messages are one conversation only on the evidence of their own reply
  // headers, never on a matching subject: "Re: Your manuscript" is the subject
  // of half the mailbox. And a shared reference is not enough on its own. An
  // introduction sent to fifty authors in one message has one Message-ID, and
  // every author who answers it names that ID — fifty separate conversations
  // that would otherwise collapse into one row and hide forty-nine people. So
  // the messages must also share a person, other than the editor herself — and
  // when both involve someone outside the company, an outside person: a
  // colleague or a team address copied on every introduction is shared by
  // every author who answers, and would merge them all again. Threads between
  // colleagues only still join on any colleague they share.
  const URGENCY = ['do_first', 'needs_review', 'system_tasks', 'then', 'low'];

  function conversations(rows) {
    const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.key === 'string');
    const parent = new Map(list.map((r) => [r.key, r.key]));
    const find = (k) => { let x = k; while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const people = new Map(list.map((r) => [r.key, new Set((r.thread && r.thread.people) || [])]));
    const outside = new Map(list.map((r) => [r.key, new Set((r.thread && r.thread.outside) || [])]));
    const meet = (a, b) => { for (const p of b) if (a.has(p)) return true; return false; };
    const together = (x, y) => {
      const oa = outside.get(x), ob = outside.get(y);
      return oa.size && ob.size ? meet(oa, ob) : meet(people.get(x), people.get(y));
    };
    const byNode = new Map();
    for (const r of list) {
      const t = r.thread;
      if (!t || !t.acct || !t.hmid) continue;
      // One mailbox's conversation never reaches into another's: the same
      // message copied to two imprints is two pieces of work.
      for (const id of new Set([t.hmid].concat(t.refs || []))) {
        if (!id) continue;
        const node = t.acct + '|' + id;
        if (!byNode.has(node)) byNode.set(node, []);
        byNode.get(node).push(r.key);
      }
    }
    for (const keys of byNode.values()) {
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          if (together(keys[i], keys[j])) { const ra = find(keys[i]), rb = find(keys[j]); if (ra !== rb) parent.set(ra, rb); }
        }
      }
    }
    const byRoot = new Map();
    for (const r of list) {
      const root = find(r.key);
      if (!byRoot.has(root)) byRoot.set(root, []);
      byRoot.get(root).push(r);
    }
    return Array.from(byRoot.values()).map(mergeConversation);
  }

  // One row that stands for a conversation. It SAYS what was said last — the
  // latest message is what she will open, and where Reply and OmniReply act —
  // but it is RANKED by the most urgent thing still open in it, so a
  // manuscript waiting under a later "thanks" does not sink with the thanks.
  function mergeConversation(members) {
    const byDate = members.slice().sort((a, b) => (b.display.date || 0) - (a.display.date || 0));
    const latest = byDate[0];
    const open = members.filter((r) => URGENCY.indexOf(r.group) !== -1);
    const lead = !open.length ? latest : open.slice().sort((a, b) =>
      b.priority.bars - a.priority.bars || URGENCY.indexOf(a.group) - URGENCY.indexOf(b.group) || (b.display.date || 0) - (a.display.date || 0))[0];
    const names = [];
    for (const r of byDate) {
      const w = r.display.who || {};
      const n = w.name || w.address || '';
      if (n && names.indexOf(n) === -1) names.push(n);
    }
    const withCard = byDate.find((r) => r.card);
    return Object.assign({}, lead, {
      key: latest.key,
      keys: byDate.map((r) => r.key),
      count: members.length,
      // The stage the conversation is at now, which is the latest word on it.
      card: latest.card || (withCard ? withCard.card : null),
      display: Object.assign({}, latest.display, { people: names, read: members.every((r) => r.display.read) })
    });
  }

  return Object.freeze({ deriveRow, cardOf, priority, workingDaysBetween, demotionBlockers, laterOutboundLabel, repliedLabel, introLabel, parentLabel, conversations, SENTENCES });
})();
