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

# Update docs/updates.json — prepend a new entry so newest is first
python3 <<PY
import json
with open('docs/updates.json', 'r') as f:
    updates = json.load(f)

addon_id = 'v4-contacts@snap-collective.com'
new_entry = {
    'version': '$NEW_VERSION',
    'update_link': f'https://davidbenwow.github.io/v4-thunderbird-extension/releases/v4_contacts-$NEW_VERSION.xpi',
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

echo "Updated docs/updates.json"
echo ""
echo "Next steps:"
echo "  1. Submit build/v4_contacts-$NEW_VERSION.xpi to addons.thunderbird.net (Unlisted)"
echo "  2. Copy the signed XPI they return to:"
echo "       releases/v4_contacts-$NEW_VERSION.xpi"
echo "       docs/releases/v4_contacts-$NEW_VERSION.xpi"
echo "  3. git add -A && git commit -m 'Release v$NEW_VERSION' && git push"
