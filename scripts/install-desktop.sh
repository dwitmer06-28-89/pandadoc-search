#!/usr/bin/env bash
# Build the PACKAGED Electron app and install it to ~/Applications — the copy
# you actually use, as opposed to the dev shell.
#
# "Packaged" is the whole point: electron-builder produces a bundle where
# `app.isPackaged === true`, so the shell runs with every dev affordance OFF —
# no DevTools opening on launch, no dev menu, no dev-only logging, and it serves
# its own bundled assets instead of a dev server on localhost. Running
# `electron .` against a dev server is a different app with different behaviour;
# this is the one to check a change in before calling it shipped.
#
# Pass --install-only to skip the build and install whatever is already in
# dist/ — useful right after a build you already ran.
#
# Your data is untouched. userData lives under
# ~/Library/Application Support/, keyed by appId, and is never part of the
# bundle this replaces.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PRODUCT="PandaDoc Search"
OUT_DIR="$ROOT/dist"
DEST="$HOME/Applications/$PRODUCT.app"

die() { echo "✗ $*" >&2; exit 1; }

INSTALL_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --install-only) INSTALL_ONLY=1 ;;
    *) die "unknown argument: $arg" ;;
  esac
done

if [[ "$INSTALL_ONLY" == "0" ]]; then
  echo "── Build ────────────────────────────────────────────────────────"
  echo "  npm run build — a full production build, so give it a couple of minutes."
  npm run build || die "the build failed — see the output above. Nothing was installed."
fi

echo
echo "── Locate the built app ─────────────────────────────────────────"
# Globbed rather than hardcoded: electron-builder names the unpacked directory
# after the architecture it built (mac-arm64, mac-universal, plain mac), and
# that changes with the target config. Prefer arm64, since that's this machine.
BUILT=""
for dir in "$OUT_DIR/mac-arm64" "$OUT_DIR/mac-universal" "$OUT_DIR/mac"; do
  if [[ -d "$dir/$PRODUCT.app" ]]; then BUILT="$dir/$PRODUCT.app"; break; fi
done
[[ -n "$BUILT" ]] || die "no built $PRODUCT.app under $OUT_DIR.
  Looked in mac-arm64/, mac-universal/ and mac/.$( [[ "$INSTALL_ONLY" == "1" ]] && printf '\n  --install-only skips the build — run without it.' )"
echo "  $BUILT"

echo
echo "── Stop the installed copy ──────────────────────────────────────"
# A running app holds its own binary open, and replacing the bundle underneath
# it produces a half-installed app that won't launch. Matched on the INSTALLED
# path specifically, so a dev Electron — a different binary — is left alone.
if pgrep -f "$DEST/Contents/MacOS/" >/dev/null 2>&1; then
  osascript -e "tell application \"$PRODUCT\" to quit" >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6; do
    pgrep -f "$DEST/Contents/MacOS/" >/dev/null 2>&1 || break
    sleep 0.5
  done
  pkill -9 -f "$DEST/Contents/MacOS/" 2>/dev/null || true
  # CONFIRM it's gone rather than sleeping and hoping: a survivor keeps running
  # off a bundle being replaced underneath it, and its stale single-instance
  # lock then stops the new copy launching at all.
  gone=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if ! pgrep -f "$DEST/Contents/MacOS/" >/dev/null 2>&1; then gone=1; break; fi
    sleep 0.5
  done
  [[ "$gone" == "1" ]] || die "$PRODUCT is still running after SIGKILL — refusing to replace a live bundle.
  Check: pgrep -fl '$PRODUCT.app/Contents/MacOS/'"
  echo "  stopped"
else
  echo "  (not running)"
fi

echo
echo "── Install ──────────────────────────────────────────────────────"
mkdir -p "$(dirname "$DEST")"
# --delete so a file dropped from the build doesn't linger in the install and
# get loaded by the new bundle.
rsync -a --delete "$BUILT/" "$DEST/" || die "install to $DEST failed."
# An unsigned local build carries no quarantine, but a downloaded dependency
# inside it can — clearing it here avoids Gatekeeper refusing to open the app.
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
mdimport "$DEST" >/dev/null 2>&1 || true
echo "  $DEST"

echo
echo "── Launch ───────────────────────────────────────────────────────"
open "$DEST" || die "open failed."
# `open` exiting 0 only means LaunchServices ACCEPTED the request — it says
# nothing about whether the app stayed up, and a bundle that dies during boot
# exits silently. Without this check the script reports success over a dead app.
alive=0
for _ in $(seq 1 15); do
  if pgrep -f "$DEST/Contents/MacOS/" >/dev/null 2>&1; then alive=1; break; fi
  sleep 1
done

echo
if [[ "$alive" == "1" ]]; then
  echo "✓ $PRODUCT installed to ~/Applications and running (packaged, debug off)."
else
  echo "⚠ $PRODUCT installed, but it did NOT stay up — it exited during launch."
  echo "  The install completed, so ~/Applications/$PRODUCT.app is this new build,"
  echo "  and your data is untouched. Check for another copy holding the"
  echo "  single-instance lock:  pgrep -fl '$PRODUCT.app/Contents/MacOS/'"
fi
