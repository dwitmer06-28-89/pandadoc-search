/**
 * PandaDoc Search's own Claude settings folder — what keeps its Claude sign-in separate
 * from Develop's, Terminal's and every other app's.
 *
 * The `claude` CLI keeps its sign-in per settings folder: the default
 * `~/.claude` maps to the keychain item `Claude Code-credentials`, and any other
 * folder named by `CLAUDE_CONFIG_DIR` gets its own item (`…-<hash>`). PandaDoc Search
 * used to run on the default folder, so switching accounts in Develop switched
 * this app too, and the other way round (found in Driven, 2026-10-07; this is
 * the same fix). Every `claude` this app starts — status, sign-in, sign-out and the Agent SDK's assessments — now gets `claudeEnv()`,
 * which points it at this folder instead.
 *
 * The folder holds the SIGN-IN only. The person's own setup — their
 * instructions, settings, skills, agents, commands and plugins — is LINKED in
 * from `~/.claude`, so this app's Claude follows the same setup as Terminal and
 * an edit in either place is an edit in both. The rules for that are strict,
 * because `~/.claude` is the person's and getting this wrong loses their work:
 *
 *  - Nothing is ever written inside `~/.claude`. Only links are made, and only
 *    inside this app's folder.
 *  - A link is made only where nothing exists yet, and only to a source that
 *    exists. A link of ours pointing somewhere else is re-pointed — a link is
 *    all it ever was.
 *  - A REAL file or folder sitting where a link would go is left exactly as it
 *    is and reported, never deleted or moved. It means something wrote there on
 *    purpose; the person decides.
 *  - The sign-in itself (`.claude.json`, the keychain) is never linked or copied.
 *    That is the one thing this folder exists to keep apart.
 *
 * In `appData`, not `userData`: every lane of this app on the Mac (shipped,
 * release, prod, dev) shares the ONE sign-in.
 *
 * A copy of Driven's `electron/claude-config.js` with the folder renamed — a fix
 * to one is a fix to all four. Free of `require('electron')`; `assess.js`
 * supplies the paths.
 */

const fs = require('node:fs');
const path = require('node:path');

const FOLDER_NAME = 'pandadoc-search-claude-config';

/** The personal setup this app's Claude shares with Terminal's. Nothing else. */
const SHARED_ENTRIES = ['CLAUDE.md', 'settings.json', 'skills', 'agents', 'commands', 'plugins'];

function configDirFor(appData) {
  return path.join(appData, FOLDER_NAME);
}

/**
 * Make sure this app's folder exists and links the person's setup.
 *
 * Returns what it could not link (a real file in the way), so the caller can
 * log it. Never throws: a run without a linked skill is still a run, and the
 * sign-in — the point of the folder — does not depend on any link.
 */
function ensureConfigDir({ appData, home }) {
  const dir = configDirFor(appData);
  const blocked = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { dir, blocked: [`${dir}: ${err.message}`] };
  }
  const personal = path.join(home, '.claude');

  for (const name of SHARED_ENTRIES) {
    const source = path.join(personal, name);
    const target = path.join(dir, name);
    if (!fs.existsSync(source)) continue;

    let here = null;
    try { here = fs.lstatSync(target); } catch { /* nothing there yet */ }

    if (here && !here.isSymbolicLink()) {
      blocked.push(target);
      continue;
    }
    if (here) {
      let points = null;
      try { points = fs.readlinkSync(target); } catch { /* unreadable — re-point it */ }
      if (points === source) continue;
      // Removes the LINK only — unlink never follows it to what it points at.
      try { fs.unlinkSync(target); } catch { blocked.push(target); continue; }
    }
    try { fs.symlinkSync(source, target); } catch (err) { blocked.push(`${target}: ${err.message}`); }
  }
  return { dir, blocked };
}

/**
 * The environment every `claude` this app starts runs with.
 *
 * Points the CLI at this app's folder, and strips both API credentials. The strip
 * is NOT tidying: a stray `ANTHROPIC_API_KEY` would still let a run succeed, but
 * bill metered API credits instead of the subscription the person signed in
 * with. The failure is a surprise invoice, not an error.
 */
function claudeEnv({ appData, baseEnv }) {
  const env = { ...baseEnv };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.CLAUDE_CONFIG_DIR = configDirFor(appData);
  return env;
}

module.exports = { FOLDER_NAME, SHARED_ENTRIES, configDirFor, ensureConfigDir, claudeEnv };
