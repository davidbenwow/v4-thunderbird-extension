#!/bin/bash
# release.sh — bump version, build unsigned XPI, and update docs/updates.json
# Usage: ./scripts/release.sh 1.17.0

set -euo pipefail

cd "$(dirname "$0")/.."

if [ $# -ne 1 ]; then
  echo "Usage: $0 <new-version>   (e.g. 1.17.0)"
  exit 1
fi

NEW_VERSION="$1"

# Sanity-check version format (semver-ish, numbers and dots)
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: version must be NN.NN.NN (e.g. 1.17.0)"
  exit 1
fi

# Bump manifest version
python3 <<PY
import json
with open('src/manifest.json', 'r') as f:
    m = json.load(f)
m['version'] = '$NEW_VERSION'
with open('src/manifest.json', 'w') as f:
    json.dump(m, f, indent=2)
    f.write('\n')
PY

echo "Updated src/manifest.json to version $NEW_VERSION"

# Build the unsigned XPI
./scripts/build.sh

XPI="build/v4_contacts-$NEW_VERSION.xpi"
XPI_HASH="$(shasum -a 256 "$XPI" | awk '{print $1}')"

# Publish copies: the versioned XPI into both release trees (the GitHub-served
# docs/releases keeps EVERY version so historical update_links never 404), plus
# a rolling latest.xpi that the download page links to with a stable URL.
cp "$XPI" "releases/v4_contacts-$NEW_VERSION.xpi"
cp "$XPI" "docs/releases/v4_contacts-$NEW_VERSION.xpi"
cp "$XPI" "docs/releases/v4_contacts-latest.xpi"
cp "$XPI" "docs/v4_contacts-latest.xpi"
echo "Copied XPI to releases/, docs/releases/, and docs/releases/v4_contacts-latest.xpi"

# Update docs/updates.json — prepend a new entry so newest is first. update_hash
# lets Thunderbird verify the download against the manifest before installing.
XPI_HASH="$XPI_HASH" python3 <<PY
import json, os
with open('docs/updates.json', 'r') as f:
    updates = json.load(f)

addon_id = 'v4-contacts@snap-collective.com'
new_entry = {
    'version': '$NEW_VERSION',
    'update_link': f'https://davidbenwow.github.io/thunderbird-plugins/v4-contacts/releases/v4_contacts-$NEW_VERSION.xpi',
    'update_hash': 'sha256:' + os.environ['XPI_HASH'],
    'applications': {
        'gecko': {
            'strict_min_version': '115.0'
        }
    }
}

addons = updates.setdefault('addons', {}).setdefault(addon_id, {})
versions = addons.setdefault('updates', [])
# Remove any existing entry for this version, then insert at front
versions = [v for v in versions if v.get('version') != '$NEW_VERSION']
versions.insert(0, new_entry)
addons['updates'] = versions

with open('docs/updates.json', 'w') as f:
    json.dump(updates, f, indent=2)
    f.write('\n')
PY

echo "Updated docs/updates.json (with sha256 update_hash)"
echo ""
echo "Next steps:"
echo "  1. git add -A && git commit -m 'Release v$NEW_VERSION' && git push"
echo "  2. Verify https://davidbenwow.github.io/v4-thunderbird-extension/ serves v$NEW_VERSION"
