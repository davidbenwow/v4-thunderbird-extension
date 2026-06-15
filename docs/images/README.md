# Download-page images

The install page (`docs/index.html`) shows a screenshot slot for each sub-step.
Drop the screenshots here with these exact filenames and they appear automatically
(until then, each slot shows a dashed placeholder). Names are semantic (not step
numbers) so reordering steps never breaks the slots.

Step 2 — get your API key:
- `key-account.png` — V4 → Account → API key under your signatures

Step 3 — allow internal add-ons:
- `allow-settings.png` — Thunderbird menu → Settings
- `allow-config.png` — Settings → General → bottom → Config Editor…
- `allow-false.png` — Config Editor: `xpinstall.signatures.required` → false

Step 4 — install from file:
- `install-addons.png` — Tools → Add-ons and Themes
- `install-fromfile.png` — gear ⚙ → Install Add-on From File…

Step 5 — paste your API key:
- `key-paste.png` — the add-on's Preferences tab with the API-key field

`icon-96.png` is the page logo (copied from `src/images/icon-96.png`).
Step 1 (download) needs no screenshot — it's the button on the page.
