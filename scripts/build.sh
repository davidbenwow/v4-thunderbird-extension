#!/bin/bash
# build.sh — build an unsigned XPI from src/
# Usage: ./scripts/build.sh
# Output: build/v4_contacts-<version>.xpi

set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f src/manifest.json ]; then
  echo "Error: src/manifest.json not found. Run this script from the repo root."
  exit 1
fi

# Quality gate: a build that fails the test suite or basic syntax checks
# must never become an XPI — releases auto-install on the whole team.
echo "Running test suite..."
if ! node tests/run-tests.js; then
  echo "Error: tests failed — build aborted."
  exit 1
fi
for f in src/scripts/*.js; do
  node --check "$f" || { echo "Error: syntax check failed for $f — build aborted."; exit 1; }
done

VERSION=$(python3 -c "import json; print(json.load(open('src/manifest.json'))['version'])")
BUILD_DIR="build"
XPI_NAME="v4_contacts-${VERSION}.xpi"

mkdir -p "$BUILD_DIR"
rm -f "$BUILD_DIR/$XPI_NAME"

echo "Building v${VERSION}..."
cd src
find . -name ".DS_Store" -delete 2>/dev/null || true
zip -r -X "../$BUILD_DIR/$XPI_NAME" . -x "*.DS_Store"
cd ..

# Post-build sanity: the XPI's internal manifest version must match what we
# asked for, and manifest.json must sit at the archive root (ATN requirement).
BUILT_VERSION=$(unzip -p "$BUILD_DIR/$XPI_NAME" manifest.json | python3 -c "import sys, json; print(json.load(sys.stdin)['version'])")
if [ "$BUILT_VERSION" != "$VERSION" ]; then
  echo "Error: built XPI reports version $BUILT_VERSION, expected $VERSION — build aborted."
  exit 1
fi

echo ""
echo "Built: $BUILD_DIR/$XPI_NAME (tests passed, version verified)"
echo ""
echo "Next steps:"
echo "  1. Submit this XPI to addons.thunderbird.net for signing (Unlisted)"
echo "  2. Download the signed XPI they return"
echo "  3. Copy it to releases/$XPI_NAME AND docs/releases/$XPI_NAME"
echo "  4. Update docs/updates.json (or run ./scripts/release.sh)"
