// lead-statuses.js — THE single source of truth for V4 lead statuses.
//
// Loaded by BOTH the background script (manifest background.scripts) and the
// popup (script tag), same pattern as internal-domains.js. Adding a status
// means editing THIS file (and, if it needs a new color family, one CSS
// block) — nothing else. Before this file existed the vocabulary was spread
// across six places in two scripts, and adding a status meant finding all of
// them.
//
// Canonical keys mirror the V4 API's response_status values
// (LeadAcquisition::RESPONSE_* on the server).
//
// Fields:
//   label         — popup display text (sentence case)
//   cls           — popup pill color class; the families follow V4's own
//                   button language: green = response, blue = manuscript,
//                   red = rejected, gray = neutral/no-action
//   infoOnly      — true when there is nothing to mark for this lead: the
//                   row renders informationally (pill + Open in V4), the
//                   scan never rings, decideActionable returns false.
//                   ('locked' is transient — recomputed per scan, so the
//                   lead resurfaces automatically if the lock lifts.)
const LEAD_STATUS_DEFS = {
  no_response:         { label: 'No response yet',     cls: 'st-gray',  infoOnly: false },
  response:            { label: 'Responded',           cls: 'st-green', infoOnly: false },
  manuscript_received: { label: 'Manuscript received', cls: 'st-blue',  infoOnly: true  },
  rejected:            { label: 'Rejected',            cls: 'st-red',   infoOnly: true  },
  locked:              { label: 'Locked',              cls: 'st-gray',  infoOnly: true  },
  invalid_email:       { label: 'Invalid email',       cls: 'st-gray',  infoOnly: true  }
};

// Tolerant wire-value aliases → canonical keys. Kept liberal on purpose:
// the API's exact spellings are IT's to change.
const LEAD_STATUS_ALIASES = {
  'no_response': 'no_response', 'no response': 'no_response', 'noresponse': 'no_response',
  'response': 'response', 'responded': 'response',
  'manuscript_received': 'manuscript_received', 'manuscript received': 'manuscript_received',
  'manuscript': 'manuscript_received',
  'rejected': 'rejected', 'reject': 'rejected',
  'locked': 'locked',
  'invalid_email': 'invalid_email', 'invalid email': 'invalid_email'
};

// Normalize a raw wire value to a canonical status key, or null when the
// value is absent or unknown (→ legacy handling; warn, never throw, never
// guess).
function normalizeLeadStatus(raw) {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  if (LEAD_STATUS_ALIASES[key]) return LEAD_STATUS_ALIASES[key];
  console.warn('V4 Contacts: unknown lead status from API, treating as legacy:', raw);
  return null;
}

// True when the status means "nothing to mark for this lead".
function isInfoOnlyStatus(status) {
  return !!(LEAD_STATUS_DEFS[status] && LEAD_STATUS_DEFS[status].infoOnly);
}
