// Shared vocabulary for the Today triage page: ids, labels, versions and
// thresholds. Pure data — no browser APIs. Every triage-* module and the page
// read from here so ids never drift between code, storage and the model
// question set.
//
// Wrapped in a var + IIFE because all classic scripts share one lexical scope
// in the background page: a second top-level `const` with the same name in
// another file would be a SyntaxError for that whole file.
//
// Data shapes used across the triage modules:
//
//   IndexEntry (headers only, one per physical message copy)
//     { key, acct, hmid, folderPath, specialUse[], date(ms), from{name,address},
//       to[address], cc[address], subject, subjN, size, read, flagged,
//       dir: 'inbound'|'outbound'|'internal'|'system', sysType|null,
//       auto: true|false|null }            // null = unknown, never assume human
//
//   BodyFacts (candidates only; text is kept in memory, never stored)
//     { irt|null, refs[], files[{name,ext}], transferHost|null, text,
//       bodyState: 'ok'|'too_large'|'unavailable'|'empty' }
//
//   Facts (code-only, per inbound message)
//     { key, acct, hmid, correspondent{name,address}, subject, date,
//       parent: { entry, role:'editor'|'editor_automated'|'other', via }|null,  // explicit reply header only
//       laterOutbound: { state: TRISTATE, hmid|null, auto|null },
//       files[], transferHost|null, refsMentioned{projectIds[],isbns[]},
//       dateCandidates[], system|null, lead{exists,status}|null,
//       inInbox, read, flagged, bodyState, coverageNote|null }
//
//   Answers (model, normalised by TriageQuestions.parseAnswers; any may be absent)
//     { intent{option,p,confidence}, needs_response, approval_kind{...},
//       unfamiliar, shows_interest, asks_next_steps, asks_where_to_send,
//       is_sending_manuscript, opt_out, not_now, promised_date{option,...},
//       sender_is_representative, authorization_evidence, missing_info_supplied,
//       addressed_to_automation }          // bare numbers are noul values 0..1

var TriageSchema = (function () {
  'use strict';

  const QUESTIONS_VERSION = 2;
  // Pinned on purpose: thresholds are tuned against one model version, and
  // TypeSafe's aliases (jev-latest) move without notice.
  const MODEL_ID = 'jev-1.13.0';

  const INTENTS = Object.freeze({
    publishing_interest: 'Publishing interest',
    submission: 'Submission / registration',
    metadata_cover_changes: 'Metadata / cover changes',
    cover_proof_response: 'Cover / proof response',
    manuscript_correction: 'Manuscript correction',
    rights_authorization: 'Rights / representative authorization',
    publication_status: 'Publication status / ebook / certificate',
    orders_payment_delivery: 'Copies / order / payment / delivery',
    royalties_contract: 'Royalties / contract terms',
    account_access: 'Account / access',
    internal_production: 'Internal production support',
    system_event: 'System event',
    other_unclear: 'Other / unclear'
  });

  // The same topics as INTENTS, written the way a sentence needs them. INTENTS
  // labels head a menu ("Copies / order / payment / delivery"); these go inside
  // a line the editor reads ("Asks about copies, payment or delivery.").
  const INTENT_PHRASES = Object.freeze({
    publishing_interest: 'publishing with us',
    submission: 'sending a manuscript',
    metadata_cover_changes: 'a change to the metadata or the cover',
    cover_proof_response: 'the cover or proof you sent',
    manuscript_correction: 'a correction to the manuscript',
    rights_authorization: 'rights or permission',
    publication_status: 'when the book will be out',
    orders_payment_delivery: 'copies, payment or delivery',
    royalties_contract: 'royalties or contract terms',
    account_access: 'access to their account',
    internal_production: 'production work',
    system_event: 'a platform notification',
    other_unclear: 'something that is not clear'
  });

  // Display order on the page. needs_review is never collapsed or hidden.
  // The six main cards Benoit agreed with the mailbox analysis (20 Sep 2026).
  // They are queues an editor works through, not urgency: a row belongs to at
  // most one, and a row may belong to none (it still appears in its group).
  const CARDS = Object.freeze(['brochure', 'manuscript', 'setup_publication', 'cover_proof', 'blo', 'orders']);
  const CARD_LABELS = Object.freeze({
    brochure: 'Brochures to send',
    manuscript: 'Manuscript received',
    setup_publication: 'Project setup & publication',
    cover_proof: 'Cover & proof',
    blo: 'BLO',
    orders: 'Orders & aftercare'
  });

  // The three active groups are the three priority bands, so the bars on a row
  // and the heading above it can never tell the editor different things.
  // Imprint behind a mailbox address, so the picker can show whose mailbox it
  // is. Names and domains are the list Benoit supplied on 20 Sep 2026; the
  // logos are the company's own files, reduced to the size a chip needs.
  const IMPRINTS = Object.freeze({
    'akademikerverlag.de': { name: 'AV Akademikerverlag', logo: 'images/imprints/akv.png' },
    'al-ilm-publishing.com': { name: 'Al Ilm Publishing', logo: null },
    'blessedhope-publishing.com': { name: 'Blessed Hope Publishing', logo: 'images/imprints/bhp.png' },
    'bloggingbooks.de': { name: 'Bloggingbooks', logo: 'images/imprints/bbp.png' },
    'credo-ediciones.com': { name: 'Credo Ediciones', logo: 'images/imprints/ces.png' },
    'dictus-publishing.eu': { name: 'Dictus Publishing', logo: 'images/imprints/dic.png' },
    'drugoe-reshenie.ru': { name: 'Drugoe Reshenie', logo: 'images/imprints/dre.png' },
    'eae-publishing.com': { name: 'Editorial Academica Espanola', logo: 'images/imprints/eae.png' },
    'editorial-publicia.com': { name: 'Editorial PUBLICIA', logo: 'images/imprints/pub.png' },
    'editorial-redactum.com': { name: 'Editorial Redactum', logo: null },
    'edizioni-ai.com': { name: 'Edizioni Accademiche Italiane', logo: 'images/imprints/eai.png' },
    'edizioni-santantonio.com': { name: 'Edizioni Sant’Antonio', logo: 'images/imprints/esa.png' },
    'frommverlag.de': { name: 'Fromm Verlag', logo: 'images/imprints/fro.png' },
    'gearup-publishing.com': { name: 'Gear Up Publishing', logo: 'images/imprints/gup.png' },
    'globeedit.com': { name: 'GlobeEdit', logo: 'images/imprints/gle.png' },
    'goldenlight-publishing.com': { name: 'Golden Light Publishing', logo: 'images/imprints/glp.png' },
    'goldenerakete.de': { name: 'Goldene Rakete', logo: 'images/imprints/gol.png' },
    'hakodesh-press.com': { name: 'Hakodesh Press', logo: null },
    'just-a-life.com': { name: 'Just a Life', logo: null },
    'justfiction-edition.com': { name: 'JustFiction! Edition', logo: 'images/imprints/jfe.png' },
    'lap-publishing.com': { name: 'Lambert Academic Publishing', logo: 'images/imprints/lap.png' },
    'verlag-lehrbuch.de': { name: 'Lehrbuchverlag', logo: 'images/imprints/lbv.png' },
    'noor-publishing.com': { name: 'Noor Publishing', logo: 'images/imprints/nrp.png' },
    'omniscriptum.com': { name: 'OmniScriptum', logo: 'images/imprints/oms.png' },
    'nea-edicoes.com': { name: 'Novas Edições Acadêmicas', logo: 'images/imprints/nea.png' },
    'palmarium-publishing.ru': { name: 'Palmarium Academic Publishing', logo: 'images/imprints/pal.png' },
    'presses-academiques.com': { name: 'Presses Académiques Francophones', logo: 'images/imprints/paf.png' },
    'rov-publishing.com': { name: 'Roditelskie Vstrechi', logo: null },
    'svr-verlag.de': { name: 'Saarbrücker Verlag für Rechtswissenschaften', logo: 'images/imprints/svr.png' },
    'sanktum-publishing.ru': { name: 'Sanktum', logo: 'images/imprints/san.png' },
    'scholars-press.com': { name: 'Scholars’ Press', logo: 'images/imprints/sps.png' },
    'snap-collective.com': { name: 'Snap Collective', logo: 'images/imprints/snap.png' },
    'shams-publishing.com': { name: 'Shams Publishing', logo: null },
    'svh-verlag.de': { name: 'Südwestdeutscher Verlag für Hochschulschriften', logo: 'images/imprints/svh.png' },
    'verlag-trainer.de': { name: 'Trainerverlag', logo: 'images/imprints/trainer.png' },
    'verlag-familienbande.de': { name: 'Verlag Familienbande', logo: 'images/imprints/fam.png' },
    'verlag-lebensreise.de': { name: 'Verlag Lebensreise', logo: 'images/imprints/vlr.png' },
    'verlag-naturleben.de': { name: 'Verlag Natur & Leben', logo: 'images/imprints/vnl.png' },
    'vitascript-press.com': { name: 'Vitascript Press', logo: 'images/imprints/vit.png' },
    'bezkresywiedzy.com': { name: 'Wydawnictwo Bezkresy Wiedzy', logo: 'images/imprints/wbw.png' },
    'yam-publishing.ru': { name: 'Yam Publishing', logo: 'images/imprints/yam.png' },
    'editions-croix.com': { name: 'Éditions Croix du Salut', logo: 'images/imprints/ecs.png' },
    'editions-muse.com': { name: 'Éditions Muse', logo: 'images/imprints/edm.png' },
    'editions-ue.com': { name: 'Éditions Universitaires Européennes', logo: 'images/imprints/eue.png' },
    'editions-vie.com': { name: 'Éditions Vie', logo: 'images/imprints/vie.png' },
  });

  // What to show for a mailbox: the imprint its address belongs to, otherwise
  // whatever Thunderbird calls the account.
  function mailboxImprint(account) {
    for (const addr of (account && account.identities) || []) {
      const at = String(addr || '').lastIndexOf('@');
      if (at === -1) continue;
      const domain = String(addr).slice(at + 1).toLowerCase();
      const hit = IMPRINTS[domain] || IMPRINTS[domain.split('.').slice(-2).join('.')];
      if (hit) return hit;
    }
    return null;
  }

  function mailboxLabel(account) {
    const hit = mailboxImprint(account);
    const a = account || {};
    return (hit && hit.name) || a.name || (a.identities || [])[0] || a.id || 'Mailbox';
  }

  // Colleagues' photos come from OmniScriptum's signature directory, named by
  // first initial + surname: j.doe@globeedit.com -> jdoe.jpg. It is a
  // naming convention, not a list, so a missing photo is normal and the initials
  // take over. Only tried for colleagues, so no author's name is ever sent to
  // that server.
  const PHOTO_BASE = 'https://people.omniscriptum.com/signature/';

  function employeePhoto(email) {
    const normalized = String(email || '').trim().toLowerCase();
    const name = /^([a-z]+)\.([a-z][a-z-]*)@[^@\s]+$/.exec(normalized);
    if (name) return { photoUrl: PHOTO_BASE + name[1][0] + name[2] + '.jpg', initials: (name[1][0] + name[2][0]).toUpperCase() };
    const local = normalized.split('@')[0].replace(/[^a-z0-9]/g, '').slice(0, 2).toUpperCase();
    return { photoUrl: null, initials: local || '?' };
  }

  const GROUPS = Object.freeze([
    'do_first', 'then', 'low', 'needs_review', 'system_tasks',
    'waiting_until', 'no_reply_needed', 'closed', 'done'
  ]);

  const GROUP_LABELS = Object.freeze({
    do_first: 'High priority',
    then: 'Medium priority',
    low: 'Low priority',
    needs_review: 'Needs review',
    system_tasks: 'System tasks',
    waiting_until: 'Waiting until a date',
    no_reply_needed: 'No reply needed — check',
    closed: 'Closed / not interested',
    done: 'Done'
  });

  // Groups a row can only reach by the model or code taking it out of the
  // editor's active work. Every one of them stays visible on the page.
  const DEMOTED_GROUPS = Object.freeze(['waiting_until', 'no_reply_needed', 'closed']);

  const NEXT_STEPS = Object.freeze({
    draft_reply: 'Draft reply',
    send_brochure: 'Send brochure',
    review_manuscript: 'Review manuscript',
    review_message: 'Review message',
    prepare_author_update: 'Prepare author update',
    import_or_reject: 'Import or reject',
    open_in_v4: 'Open in V4',
    none: 'Open message'
  });

  const SYSTEM_TYPES = Object.freeze({
    manuscript_submitted: 'Manuscript submitted',
    manuscripts_transferred: 'Manuscripts transferred',
    publication: 'Publication notice',
    voucher: 'Voucher notice',
    book_notice: 'Book notice',
    book_launch_offer: 'Book Launch Offer'
  });

  const APPROVAL_KINDS = Object.freeze(['approval', 'changes', 'acknowledgment', 'unclear']);

  // Absence is never stated as fact: "not located in the folders we scanned"
  // and "could not check" are different answers and are worded differently.
  const TRISTATE = Object.freeze({
    FOUND: 'found',
    NOT_FOUND: 'not_found_in_scope',
    UNKNOWN: 'unknown'
  });

  const USER_STATES = Object.freeze(['active', 'done', 'snoozed']);

  // Starting points, tuned in the evaluation. `demote` is deliberately strict:
  // taking a message out of the active groups is the costliest mistake.
  const THRESHOLDS = Object.freeze({
    yes: 0.75,
    no: 0.25,
    demote: 0.90,
    choiceConfident: 0.60
  });

  const LIMITS = Object.freeze({
    incomingChars: 4000,
    precedingChars: 2000,
    maxBodyBytes: 5 * 1024 * 1024,
    subjectDisplay: 160,
    nameDisplay: 120,
    excerptDisplay: 1200
  });

  function isIntent(id) { return Object.prototype.hasOwnProperty.call(INTENTS, id); }
  function isGroup(id) { return GROUPS.indexOf(id) !== -1; }
  function isNextStep(id) { return Object.prototype.hasOwnProperty.call(NEXT_STEPS, id); }

  return Object.freeze({
    QUESTIONS_VERSION, MODEL_ID,
    INTENTS, INTENT_PHRASES, CARDS, CARD_LABELS, IMPRINTS, mailboxImprint, mailboxLabel, employeePhoto, GROUPS, GROUP_LABELS, DEMOTED_GROUPS, NEXT_STEPS, SYSTEM_TYPES, APPROVAL_KINDS,
    TRISTATE, USER_STATES, THRESHOLDS, LIMITS,
    isIntent, isGroup, isNextStep
  });
})();
