// Which lane is this copy of the app?
//
// Four answers, and every one of them changes behaviour:
//
//   dev      not packaged. `npm run dev`, live reload, debug ON, no updates.
//   prod     packaged, debug ON. A test lane: `~/Applications/PandaDoc Search Prod.app`.
//   release  packaged, debug OFF. Byte-for-byte how it ships, minus the publish.
//   shipped  packaged, debug OFF, AUTO-UPDATES. The real app users run.
//
// The lane is stamped into the bundle at build time by `scripts/install-lane.sh`
// via electron-builder's `extraMetadata`, which writes the field into the
// package.json inside the app bundle. A build with nothing stamped is `shipped`,
// so `npm run release` keeps behaving exactly as it always has.
//
// WHY THIS EXISTS AT ALL: `app.isPackaged` cannot answer the question. It is
// true for prod, release, and shipped alike — so gating auto-updates on it means
// a locally-built test lane tries to update ITSELF to the published release,
// replacing the build you were trying to test with a different one. And it means
// a bundled build can never have debug on, which is the whole point of the prod
// lane.
const { app } = require('electron');
const path = require('path');

function resolveLane() {
  if (!app.isPackaged) return 'dev';
  try {
    // Packaged layout: this file sits at app.asar/lane.js, beside the bundle's
    // package.json — the one extraMetadata wrote the field into.
    return require('./package.json').lane || 'shipped';
  } catch (_) {
    // A bundle we can't read metadata from is treated as the real thing: debug
    // off. Failing closed is the safe direction — the worst case is a test lane
    // missing its DevTools, not a shipped app opening them on a user.
    return 'shipped';
  }
}

const LANE = resolveLane();

// Give the test lanes their own data directory.
//
// A DIFFERENT appId IS NOT ENOUGH, and that is worth stating plainly because it
// is easy to assume otherwise: Electron derives userData from the app NAME, not
// the bundle identifier. A lane built with `appId=…​.prod` still resolved to
// `~/Library/Application Support/pandadoc-search` — the shipped app's directory —
// and read and wrote the real `config.json` and `recents.json`. Testing anything
// destructive there would have damaged the app you use.
//
// Must run before `app` is ready and before `requestSingleInstanceLock()`:
// userData is what the lock is keyed on, so moving it is also what lets a test
// lane run at the same time as the shipped app instead of losing the lock to it.
//
// The shipped lane is deliberately left alone — it keeps the historical path, so
// no existing install sees its data move.
function isolateLaneData() {
  if (LANE !== 'prod' && LANE !== 'release') return;
  const current = app.getPath('userData');
  app.setPath('userData', path.join(path.dirname(current), `${path.basename(current)}-${LANE}`));
}

module.exports = {
  LANE,
  isolateLaneData,
  // Debug affordances: DevTools, verbose logging. On in dev and prod, off in
  // anything a user could plausibly be looking at.
  DEBUG: LANE === 'dev' || LANE === 'prod',
  // Only the published app updates itself. A test lane that auto-updated would
  // silently replace the build under test.
  AUTO_UPDATE: LANE === 'shipped',
};
