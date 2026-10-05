#!/usr/bin/env node
/**
 * Make this project's dev-lane Electron refuse to start with no app path.
 *
 *   node scripts/guard-bare-electron.js      (runs as `postinstall`)
 *
 * A SHIM. It holds no policy — it finds the family's one implementation in
 * `ProjectGlobals/scripts/guard-bare-electron.js` and hands it this tree. That
 * file carries the full reasoning (a bare `node_modules/electron/dist/
 * Electron.app`, opened from a Login Item on 2026-10-05, ran the welcome app and
 * held ~/Library/Application Support/Electron for an hour); read it there, and
 * fix it there, once, for every app.
 *
 * THIS FILE IS BYTE-IDENTICAL IN EVERY APP and must stay that way — a local
 * amendment IS the drift. Its source of truth is
 * `ProjectGlobals/scripts/guard-bare-electron-shim.js`. Adopting the guard in a
 * new project is copying that file to `scripts/guard-bare-electron.js` and
 * running it from `postinstall`.
 *
 * The path to ProjectGlobals is DERIVED from the main checkout this tree belongs
 * to, so it also works from a git worktree (same reasoning as the
 * require-build-env shim). On macOS it FAILS LOUD when it cannot find the
 * implementation: a guard that cannot run must never read as a pass. Anywhere
 * else it exits 0 at once — there is no bundle there to guard.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// Only a macOS dev bundle can be opened bare from a Login Item or Finder, and
// only this Mac has ProjectGlobals beside the repo. A release build on a
// Windows CI runner (Claude Global, Pandadoc Search) runs this from `npm ci`
// with no sibling repo at all, and must not fail for a guard it cannot need.
if (process.platform !== 'darwin') process.exit(0);

/**
 * The main checkout this tree belongs to, or null unless this is a LINKED
 * WORKTREE. Only a linked worktree has a git dir that differs from its common
 * dir; comparing the common dir's parent to this tree instead would also fire
 * for a project that is not its own repo at all (Rooted Operations sits inside
 * the ~/Documents/Code repo) and send the lookup one level too high.
 */
function mainCheckout() {
  try {
    const [gitDir, common] = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim().split('\n');
    if (!gitDir || !common || path.resolve(gitDir) === path.resolve(common)) return null;
    return path.resolve(path.dirname(common));
  } catch {
    return null;
  }
}

const family = path.dirname(mainCheckout() ?? path.resolve(ROOT));
const central = path.join(family, 'ProjectGlobals', 'scripts', 'guard-bare-electron.js');

if (!fs.existsSync(central)) {
  console.error(`✗ guard-bare-electron: the implementation could not be found at ${central}.`);
  console.error('  ProjectGlobals is missing, renamed or not beside this repo. A guard that cannot run');
  console.error('  must not be mistaken for one that passed — restore it, then rerun `npm run postinstall`.');
  process.exit(1);
}

process.exit(require(central).guard(path.resolve(ROOT)));
