#!/usr/bin/env bash
# Build a BUNDLED test lane from the working tree and install it beside the real
# app. Two lanes, and the only difference between them is whether debug is on:
#
#   prod     debug ON  →  ~/Applications/PandaDoc Search Prod.app
#   release  debug OFF →  ~/Applications/PandaDoc Search Release.app
#
# Neither one is what your users run. `~/Applications/PandaDoc Search.app` is the
# shipped app, it auto-updates, and nothing here ever touches it — which is the
# point. An unreleased build installed by hand over the shipped app gets
# silently replaced by the next release anyway.
#
# THREE PROPERTIES THAT MAKE THIS SAFE, all from stamping a distinct appId:
#
#   1. Its own userData directory, so a destructive test cannot reach the real
#      app's config, recents, or PandaDoc session.
#   2. Its own single-instance lock, so a test lane runs AT THE SAME TIME as the
#      shipped app. (The dev lane cannot — it shares the real appId. See
#      test-dev-desktop.)
#   3. Its own auto-update identity, and `lane` in the bundle metadata turns
#      auto-update off outright. A test lane cannot update itself into the
#      published release mid-test.
#
# The cost of that isolation: each lane needs its own one-time sign-in. That is
# not a bug to fix, it is what keeps the real app's data out of reach.
#
# Notarization is SKIPPED by default, because it adds ten-plus minutes to a
# build you are about to throw away, and a locally-signed app runs fine on the
# Mac that built it. Pass --notarize for a true pre-ship check.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BASE_PRODUCT="PandaDoc Search"
BASE_APPID="software.rooted.pandadoc-search"

die() { echo "✗ $*" >&2; exit 1; }

LANE=""
NOTARIZE=0
INSTALL_ONLY=0
for arg in "$@"; do
  case "$arg" in
    prod|release) LANE="$arg" ;;
    --notarize) NOTARIZE=1 ;;
    --install-only) INSTALL_ONLY=1 ;;
    *) die "unknown argument: $arg (expected: prod | release [--notarize] [--install-only])" ;;
  esac
done
[[ -n "$LANE" ]] || die "which lane? usage: install-lane.sh prod|release [--notarize]"

# Capitalised for the product name: "PandaDoc Search Prod", not "PandaDoc Search prod".
LANE_TITLE="$(tr '[:lower:]' '[:upper:]' <<< "${LANE:0:1}")${LANE:1}"
PRODUCT="$BASE_PRODUCT $LANE_TITLE"
APPID="$BASE_APPID.$LANE"
DEST="$HOME/Applications/$PRODUCT.app"
OUT_DIR="$ROOT/dist/lane-$LANE"

echo "── Lane ─────────────────────────────────────────────────────────"
echo "  lane      $LANE  (debug $([[ "$LANE" == "prod" ]] && echo ON || echo OFF))"
echo "  product   $PRODUCT"
echo "  appId     $APPID"
echo "  install   $DEST"
echo "  notarize  $([[ "$NOTARIZE" == "1" ]] && echo yes || echo "no (--notarize to enable)")"

# What is actually in this build. It builds from the working tree, dirty or not —
# that is the point of a test lane — so just say what is going in.
echo
echo "── Working tree ─────────────────────────────────────────────────"
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  git status --porcelain | sed 's/^/  /'
  echo "  (uncommitted work above is included in this build)"
else
  echo "  clean — building $(git rev-parse --short HEAD 2>/dev/null || echo 'working tree')"
fi

if [[ "$INSTALL_ONLY" == "0" ]]; then
  echo
  echo "── Build ────────────────────────────────────────────────────────"
  # --dir stops after producing the .app: no dmg, no zip, nothing to upload.
  # extraMetadata.lane is what the app reads back at runtime (see lane.js) to
  # decide debug and auto-update.
  # Host arch only. The shipped build is universal, but a lane you are about to
  # throw away does not need the other half — it doubles the build time for a
  # slice you will never launch.
  ARCH="$([[ "$(uname -m)" == "arm64" ]] && echo --arm64 || echo --x64)"
  ARGS=(
    --dir
    "$ARCH"
    -c.productName="$PRODUCT"
    -c.appId="$APPID"
    -c.extraMetadata.lane="$LANE"
    -c.directories.output="$OUT_DIR"
    --publish never
  )
  [[ "$NOTARIZE" == "1" ]] || ARGS+=( -c.mac.notarize=false )
  npx electron-builder "${ARGS[@]}" || die "the build failed — see above. Nothing was installed."
fi

echo
echo "── Locate the built app ─────────────────────────────────────────"
# Globbed rather than hardcoded: electron-builder names the unpacked directory
# after the arch it built (mac-arm64, mac-universal, …).
BUILT=""
for candidate in "$OUT_DIR"/mac*/"$PRODUCT.app"; do
  [[ -d "$candidate" ]] && BUILT="$candidate" && break
done
[[ -n "$BUILT" ]] || die "no $PRODUCT.app under $OUT_DIR — did the build actually finish?"
echo "  $BUILT"

echo
echo "── Install ──────────────────────────────────────────────────────"
# Quit only THIS lane. The shipped app and the other lane keep running — they
# are different bundle ids and different processes.
if pgrep -f "$PRODUCT.app/Contents/MacOS/" >/dev/null 2>&1; then
  echo "  $PRODUCT is running — quitting it"
  osascript -e "quit app \"$PRODUCT\"" >/dev/null 2>&1
  sleep 1
  pkill -f "$PRODUCT.app/Contents/MacOS/" >/dev/null 2>&1
fi

mkdir -p "$HOME/Applications"
rm -rf "$DEST" || die "could not remove the old $DEST"
cp -R "$BUILT" "$DEST" || die "could not copy into $DEST"
echo "  installed → $DEST"

echo
echo "── Verify what got installed ───────────────────────────────────"
# Read the lane back OUT of the bundle rather than trusting that the flag was
# honoured. A lane that silently built as `shipped` would auto-update itself and
# quietly replace the build under test.
STAMPED="$(node -e "
  const fs=require('fs');
  const p='$DEST/Contents/Resources/app.asar';
  try {
    const asar=require('$ROOT/node_modules/@electron/asar');
    process.stdout.write(String(JSON.parse(asar.extractFile(p,'package.json')).lane||'(none)'));
  } catch(e) { process.stdout.write('(unreadable: '+e.message+')'); }
" 2>/dev/null)"
echo "  lane stamped in bundle: $STAMPED"
[[ "$STAMPED" == "$LANE" ]] || echo "  ⚠ expected '$LANE' — debug and auto-update may not be what you asked for"

echo
echo "✓ $PRODUCT installed. Open it from ~/Applications."
[[ "$LANE" == "prod" ]] && echo "  Debug is ON: ⌥⌘I toggles DevTools."
echo "  This lane has its own data and needs its own one-time sign-in."
