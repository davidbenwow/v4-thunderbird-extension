# V4 Contacts Checker — Thunderbird Extension

A Thunderbird MailExtension that checks email addresses in displayed messages and compose windows against the V4 Contacts CRM at `https://v4.vdm-vsg.de`, and lets you jump to a lead's page to mark its status.

## For users

1. Download the latest signed XPI from the [releases](./releases) folder.
2. In Thunderbird: **Tools → Add-ons and Themes → ⚙️ (gear icon) → Install Add-on From File…** and pick the XPI.
3. After install, go to **Add-ons and Themes → V4 Contacts Checker → Preferences** and paste your V4 API key.

Once installed, auto-updates are handled automatically — you'll get future versions without doing anything.

## Features

- Scans sender, recipients (To/Cc/Bcc), and the quoted thread body of every displayed message
- Orange-ringed toolbar icon when the message contains leads to mark in V4
- Popup lists leads; clicking **Mark Lead in V4** opens the V4 search page in your default browser
- The button persists as "Opened in browser" per-message after clicking, so you can track what's done
- Compose window support: checks recipients (including address-book contacts and mailing lists) before sending
- Filters out internal OmniScriptum / Lambert imprint domains so they never hit the API

## For maintainers

### Repository layout

```
src/                   Extension source (manifest.json, scripts/, images/, etc.)
releases/              Human-readable list of signed XPI builds
docs/
  updates.json         Update manifest consumed by Thunderbird's auto-update
  releases/            XPIs served via GitHub Pages for auto-update downloads
scripts/
  build.sh             Creates an unsigned XPI from src/
  release.sh           Bumps version, builds, and updates docs/updates.json
```

### Releasing a new version

1. Make your changes in `src/`
2. Run `./scripts/release.sh 1.17.0` (or whatever new version)
3. Submit the unsigned XPI from `build/` to addons.thunderbird.net for signing (select "self-distributed" / unlisted)
4. Replace the XPI in `releases/` and `docs/releases/` with the signed one returned by ATN
5. Commit everything and push
6. Within 24 hours, every installed copy auto-updates

### How auto-update works

Thunderbird reads the `update_url` from the extension's `manifest.json` and periodically fetches `https://davidbenwow.github.io/v4-thunderbird-extension/updates.json`. If that JSON advertises a higher version than what's installed, Thunderbird downloads the XPI from the URL listed in the `update_link` field and installs it silently.

For this to work end-to-end:
- GitHub Pages must be enabled for this repo, serving from `/docs` on `main`
- The XPI must be **signed** by addons.thunderbird.net (unlisted signing is fine — no public listing required)
- Every release must bump `version` in `src/manifest.json` AND add a new entry in `docs/updates.json`

## License

Internal OmniScriptum use. Not for redistribution.
