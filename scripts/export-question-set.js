#!/usr/bin/env node
// Writes the approved Today question set as JSON (stdout), straight from
// src/scripts/triage-questions.js, so the OmniReply gateway can check incoming
// requests against exactly what this add-on version asks. Nothing here is
// secret: the same text ships in the add-on.
//
//   node scripts/export-question-set.js > triage-question-set-v<N>.json
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = vm.createContext({});
for (const f of ['triage-schema.js', 'triage-questions.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'scripts', f), 'utf8'), ctx, { filename: f });
}
const def = JSON.parse(vm.runInContext('JSON.stringify(TriageQuestions.definition())', ctx));
const limits = JSON.parse(vm.runInContext('JSON.stringify(TriageSchema.LIMITS)', ctx));

process.stdout.write(JSON.stringify(Object.assign({
  about: 'Approved question set for POST /api/extension/triage/decide. A request is acceptable when its `questions` object is exactly: `always`; or `always` + `withPrevious` (if and only if state.previous_message_from_editor is present); each optionally + BOTH `dates` questions. Every static question must match id, type, instructions and criteria exactly. In a date question the option keys match `dateOptionKeys` (1 to `maxDateOptions` of them, numbered from d0 without gaps) plus the key `none` whose text equals `none`; every other option text matches one of `dateOptionPatterns`; both date questions carry identical d-options.',
  state: {
    message: { subject: 'string, <= 200 chars', text: 'string, 1..' + limits.incomingChars + ' chars', attachments: 'optional array, <= 10 of { file_type: string <= 12 chars, filename_suggests: "manuscript" | "form_or_payment" | "image_or_cover" | "unknown" }', contains_file_transfer_link: 'optional, only ever true' },
    previous_message_from_editor: 'optional { subject: string <= 200 chars, text: string, 1..' + limits.precedingChars + ' chars }'
  }
}, def), null, 2) + '\n');
