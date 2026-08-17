// Dev-only live reload. The Dev lane's entire reason for existing: edit a file,
// see it, without waiting on electron-builder.
//
// This app has no bundler, and it does not need one — `win.loadFile()` reads
// straight off disk, so when you run `npm run dev` the files in this directory
// ARE the running app. Nothing has to be compiled for a change to take effect;
// something only has to notice and reload. That is all this module is.
//
// Two speeds, because two kinds of file:
//
//   html + preload  →  reload the page (instant). Every script and style in
//                      this app is inline in its .html, so a reload picks up
//                      all of it. A preload re-executes on reload, so it
//                      belongs here despite running with node access.
//   main process    →  relaunch the app (~1s). There is no way to swap
//                      main-process code into a running process; `main.js`,
//                      `assess.js`, and `config.js` all have to come up again.
//
// THE REMOTE PAGE IS LEFT ALONE. This app holds the real PandaDoc site in a
// WebContentsView, and reloading that would throw away the search you are in
// the middle of — for a change that cannot possibly have affected it. Only
// `file://` contents are reloaded: index, ai, overlay, shell.
//
// PACKAGED BUILDS NEVER REACH THIS. `app.isPackaged` is checked before a single
// watcher is installed, so the Prod and Release lanes carry this file as dead
// weight and nothing more. It is deliberately dependency-free — no chokidar,
// nothing new in package.json — because `fs.watch` on macOS is FSEvents-backed
// and already does everything needed here.
const { app, webContents } = require('electron');
const fs = require('fs');
const path = require('path');

// Coalescing window. Editors write in bursts (write, rename, chmod) and a git
// checkout rewrites dozens of files at once; without this, one save reloads
// three times and a branch switch relaunches the app repeatedly.
const DEBOUNCE_MS = 150;

// Files that are neither renderer nor main process and must never trigger
// anything: editor swap files, and the OS's own directory noise.
const IGNORED = /(^|\/)(\.DS_Store|\.git|node_modules|dist|build)(\/|$)|(~|\.swp|\.swx|\.tmp)$/;

/**
 * @param {object}   opts
 * @param {string}   opts.root      Absolute path everything below is relative to.
 * @param {string[]} opts.watch     Dirs/files to watch, relative to root.
 * @param {(rel: string) => ("reload"|"relaunch"|null)} opts.classify
 *        What a changed path means. Returning null ignores it.
 */
function start({ root, watch, classify }) {
  // The hard guard. Everything below this line is development-only.
  if (app.isPackaged) return;

  let pending = null;
  let timer = null;

  // "relaunch" outranks "reload": if a save touched both an .html file and
  // main.js, only the relaunch is correct — a page reload would leave the old
  // main-process code running and the two out of sync.
  const escalate = (action) => {
    if (action === 'relaunch' || pending === 'relaunch') pending = 'relaunch';
    else pending = action;
  };

  const flush = () => {
    const action = pending;
    pending = null;
    timer = null;
    if (action === 'relaunch') {
      console.log('[dev] main process changed — relaunching');
      app.relaunch();
      app.quit();
      return;
    }
    if (action === 'reload') {
      const targets = webContents
        .getAllWebContents()
        .filter((wc) => !wc.isDestroyed() && wc.getURL().startsWith('file://'));
      console.log(`[dev] reloading ${targets.length} local view(s)`);
      for (const wc of targets) wc.reloadIgnoringCache();
    }
  };

  const onChange = (rel) => {
    if (!rel || IGNORED.test(rel)) return;
    const action = classify(rel);
    if (!action) return;
    escalate(action);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
  };

  for (const entry of watch) {
    const abs = path.join(root, entry);
    if (!fs.existsSync(abs)) continue;
    // Watching a FILE reports that file's own basename back, so joining it onto
    // `entry` would produce `main.js/main.js`. It happens to still match an
    // endsWith() rule, which is exactly why this was worth fixing at the source
    // rather than leaving classify() to absorb it.
    const isDir = fs.statSync(abs).isDirectory();
    try {
      // `recursive` is supported on macOS and Windows. A watcher that throws
      // must not take the app down with it — the app runs fine without reload;
      // it just runs without this convenience.
      fs.watch(abs, { recursive: true }, (_event, filename) => {
        onChange(isDir && filename ? path.join(entry, filename) : entry);
      });
    } catch (err) {
      console.log(`[dev] not watching ${entry}: ${err.message}`);
    }
  }

  console.log(`[dev] live reload active — watching ${watch.join(', ')}`);
}

module.exports = { start };
