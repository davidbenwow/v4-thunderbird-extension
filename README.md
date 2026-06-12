# V4 Contacts Checker — Thunderbird extension

A Thunderbird MailExtension for the OmniScriptum acquisitions team. It checks
the email addresses in every displayed message against the V4 Contacts CRM
(`https://v4.vdm-vsg.de`), shows each lead's **live CRM status** (no response /
response / manuscript received / rejected / locked / invalid email), and offers
the right next action — *Mark as response* or *Mark as manuscript received* —
opening the lead in V4 so the editor can set the status there.

Current version: see `src/manifest.json`. Requires Thunderbird 115+.

## For users

1. Download the latest XPI from
   `https://davidbenwow.github.io/v4-thunderbird-extension/releases/` (or the
   [releases](./releases) folder).
2. **One-time, while builds are unsigned** (see *Signing*, below): Thunderbird →
   Settings → Config Editor → set `xpinstall.signatures.required` to `false`,
   then restart Thunderbird.
3. Tools → Add-ons and Themes → ⚙ → *Install Add-on From File…* → pick the XPI.
4. Add-ons and Themes → V4 Contacts Checker → Preferences → paste your V4 API key.

After that, updates install silently — pushing a release to this repo updates
the whole team within ~24 hours.

### What you see

- **Toolbar icon**: gray when the open message has nothing to mark; orange ring
  when it contains a lead that needs action.
- **Popup**: the lead's email in the header, the *current status* (live from
  V4) as the colored headline, and the action button. A 📄 marker means the
  message carries a likely manuscript (a `.docx`/`.doc`/`.pdf` attachment or a
  link to a file-transfer service such as WeTransfer, Drive, Dropbox, …).
- The action button only **opens** V4 — you still set the status in the CRM
  itself. The extension verifies against the live status afterwards, so a lead
  stays visible until its status really changed.
- **Settings → Diagnostics** shows the installed version and the time/result
  of the last V4 API contact — check there first if leads stop lighting up.

## For maintainers

### Repository layout

```
src/                    Extension source (MV2, plain JS, no build step)
  scripts/background.js   Scanning, API adapter, decision matrix, state
  scripts/popup-status.js Popup UI (status headline, action buttons)
  scripts/popup-settings.js + popup-settings.html   Settings & diagnostics
  scripts/internal-domains.js   Internal-imprint domains never sent to the API
  scripts/lead-statuses.js      Single source of truth for status vocabulary
tests/run-tests.js      Zero-dependency test suite (Node `vm` + stubbed browser)
scripts/build.sh        Tests + syntax-gate, then zips src/ into build/*.xpi
scripts/release.sh      Bumps version, builds, prepends docs/updates.json entry
releases/               Tracked copies of released XPIs
docs/                   GitHub Pages root (serves the auto-update feed)
  updates.json            Thunderbird auto-update manifest
  releases/               XPIs downloaded by auto-update
.github/workflows/      CI: tests + syntax + manifest/updates.json consistency
```

### Architecture in five sentences

`background.js` scans each displayed message, batches the addresses to
`POST /api/existence_check/<key>?include_response_status=1`, and normalizes the
reply in **one adapter** (`parseCheckResponse`) — the only code that touches
the wire format. A single decision function (`decideActionable`) answers
"does this lead need action?" for the scan loop and the popup alike; per-email
behavior is **status-driven**: the live CRM status is the source of truth, and
local flags only bridge the minutes between a Mark click and the CRM catching
up (plus a full legacy fallback if the API ever stops sending statuses — also
forceable via the *Use V4 lead status* kill-switch in Settings). Manuscript
arrival is detected from attachments and transfer-service links and unlocks
the *Mark as manuscript received* action. Persistent state lives in
`browser.storage.local`: `opened:v1:*`, `marked:v1:*`, `markedTerminal:v1:*`
(all legacy-mode only since v1.21.4 — in status mode the live status is the
sole truth), plus `lastCheck:v1` diagnostics; `dismissed:v1:*` is read-only
legacy, and removed mechanisms (`queue:v1`, `statusSeen:v1`,
`pendingMark:v1:*`) are deleted by a startup cleanup. The API is
**read-only** by IT policy — the extension never writes to V4.

### Releasing

```bash
# 1. Edit src/, then:
./scripts/release.sh 1.23.0        # runs tests, builds, updates updates.json
cp build/v4_contacts-1.23.0.xpi releases/
cp build/v4_contacts-1.23.0.xpi docs/releases/
git add -A && git commit -m "Release v1.23.0: …" && git push
# 2. GitHub Pages redeploys in ~60 s; verify:
curl -s https://davidbenwow.github.io/v4-thunderbird-extension/updates.json | head
# 3. Team auto-updates within ~24 h. Rollback = re-point updates.json at the
#    previous version and push.
```

`build.sh` refuses to produce an XPI if `tests/run-tests.js` fails, any script
fails `node --check`, or the built XPI's internal version mismatches. CI runs
the same checks on every push.

### Signing (known issue)

addons.thunderbird.net's unlisted-signing pipeline has returned **unsigned
bytes** for every submission of this add-on (v1.16.0, v1.17.0, v1.22.1 across
April–June 2026): the dashboard says "Approved" but the downloaded XPI is
byte-identical to the upload, with no `META-INF/`. Until Mozilla fixes it,
team machines need `xpinstall.signatures.required=false` (set at install).
If a future submission comes back genuinely signed (different hash +
`META-INF/` present), ship it as a normal release and have the team re-enable
signature enforcement.

### Testing

```bash
node tests/run-tests.js   # adapter, decision matrix, manuscript detection,
                          # email/URL extraction, internal-domain filter
```

The suite loads the real `background.js` into a Node `vm` with a stubbed
`browser` API — no frameworks, no dependencies. Add assertions there for any
new pure logic; UI changes still need a manual look in Thunderbird.

## License

Internal OmniScriptum use. Not for redistribution.
