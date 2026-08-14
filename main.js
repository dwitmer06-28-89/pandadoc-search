const {
  app,
  BaseWindow,
  BrowserWindow,
  WebContentsView,
  webFrameMain,
  globalShortcut,
  ipcMain,
  shell,
  Tray,
  Menu,
  nativeImage,
  nativeTheme,
  dialog,
  screen,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { autoUpdater } = require('electron-updater');
const assess = require('./assess');

// config.js holds the shipped defaults (read-only inside the packaged .app).
// Real settings live in a config.json under userData so each person can edit
// theirs and updates don't clobber it.
const config = { ...require('./config') };

const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

const IS_MAC = process.platform === 'darwin';

const DEFAULT_CHROME = {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  linux: '/usr/bin/google-chrome',
};

function chromePath() {
  return config.chromePath || DEFAULT_CHROME[process.platform] || '';
}

let win = null;
let aiWin = null; // the Claude panel, a second always-on-top pill
let tray = null;
let results = null; // the single reusable PandaDoc container window
let resultsView = null; // the WebContentsView inside it holding PandaDoc
let resultsStrip = null; // the drag strip above it
let resultsOverlay = null; // the floating dark-mode/search controls over it
let currentUrl = null; // what that view was last told to load
let aiDocKey = null; // the contract the thread and the panel's answers are about
let recents = [];

const MAX_RECENTS = 3;

function recentsFile() {
  return path.join(app.getPath('userData'), 'recents.json');
}

function configFile() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig() {
  try {
    if (!fs.existsSync(configFile())) {
      fs.writeFileSync(configFile(), JSON.stringify(config, null, 2) + '\n');
      return;
    }
    const saved = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    // Merge, so keys added by a later version still get their defaults.
    Object.assign(config, saved);
  } catch {
    // Malformed config.json — fall back to the shipped defaults rather than
    // refusing to start.
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(configFile(), JSON.stringify(config, null, 2) + '\n');
  } catch {
    // Read-only userData is unusual but not worth interrupting a toggle over —
    // the setting still applies for this run.
  }
}

function loadRecents() {
  try {
    const parsed = JSON.parse(fs.readFileSync(recentsFile(), 'utf8'));
    if (Array.isArray(parsed)) recents = parsed.slice(0, MAX_RECENTS);
  } catch {
    recents = [];
  }
}

function rememberSearch(term) {
  recents = [term, ...recents.filter((t) => t !== term)].slice(0, MAX_RECENTS);
  try {
    fs.writeFileSync(recentsFile(), JSON.stringify(recents));
  } catch {
    /* not worth bothering the user about */
  }
}

function createWindow() {
  win = new BrowserWindow({
    // Wider than the pill itself — the extra is transparent margin for the
    // feathered shadow (see --pad-x in index.html).
    width: 764,
    height: 200,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    // Native shadow would draw around the rectangular window and read as a
    // black box behind the rounded card — the CSS box-shadow handles it.
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile('index.html');

  // Dismiss when it loses focus, like Spotlight.
  win.on('blur', () => {
    hide();
    queueAIVisibility();
  });
  win.on('focus', queueAIVisibility);
}

function show() {
  if (!win) return;
  win.center();
  win.show();
  win.focus();
  win.webContents.send('reset', recents);
}

function hide() {
  if (win && win.isVisible()) win.hide();
}

// ---- the Claude panel -------------------------------------------------------
// Built like the search pill — frameless, transparent, always on top — because
// it does the same job: appear over whatever you're reading, take one line of
// input, get out of the way. It's just taller, since it has an answer to show.

function createAIWindow() {
  aiWin = new BrowserWindow({
    width: 1192,
    height: 389,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    // Not alwaysOnTop and not a top-level window of its own: it's made a child of
    // the PandaDoc window (see setParentWindow, below) so the OS stacks it with
    // that window — above the page, but under any other app brought in front of
    // it, and visible for as long as the page is, whatever else is focused.
    skipTaskbar: true,
    fullscreenable: false,
    hasShadow: false, // the CSS shadow draws the rounded card's own
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'ai-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  aiWin.loadFile('ai.html');

  // Unlike the search pill, this one does NOT dismiss on its own blur: an answer
  // is something you read while the contract sits behind it, and having it
  // vanish the moment you click elsewhere would make it useless. It rides with
  // the PandaDoc window instead — shown and hidden with it, see
  // refreshAIVisibility — and the OS keeps it on top of that window as a child.
  aiWin.on('blur', queueAIVisibility);
  aiWin.on('focus', queueAIVisibility);
}

// Centre the panel on its display, horizontally and vertically.
//
// Called on every resize as well as on open, and that's the point: setContentSize
// pins the top-left and grows the window downward, so a long answer streaming in
// would walk the panel down the screen and leave it sitting low. Recentring after
// each size change is what keeps it put.
//
// workArea rather than bounds, so "centred" means centred in the space you can
// actually see — the menu bar and Dock excluded.
function centerAI() {
  if (!aiWin || aiWin.isDestroyed()) return;
  const [w, h] = aiWin.getSize();
  const area = screen.getDisplayMatching(aiWin.getBounds()).workArea;
  aiWin.setBounds({
    x: Math.round(area.x + (area.width - w) / 2),
    y: Math.round(area.y + (area.height - h) / 2),
    width: w,
    height: h,
  });
}

// Whether a loaded contract is on screen. The AI button only exists while this
// is true, so it can't be offered on the search results list or against a
// half-rendered document.
let aiReady = false;
let aiWatch = null;

// Whether the panel is *meant* to be up. Separate from whether it's on screen:
// it belongs to the PandaDoc window, so it hides whenever that window is hidden
// or minimised and comes back with it, without the user having to reopen it.
let aiOpen = false;

// The panel rides with the PandaDoc window as its child, so the OS handles
// stacking — we only decide whether it should be on screen at all, which tracks
// the PandaDoc window's presence, not which app happens to be focused. (Focusing
// another app used to hide it; that's the bug this avoids.)
function refreshAIVisibility() {
  if (!aiWin || aiWin.isDestroyed()) return;
  const showing =
    aiOpen &&
    aiReady &&
    results &&
    !results.isDestroyed() &&
    results.isVisible() &&
    !results.isMinimized();

  if (showing) {
    if (!aiWin.isVisible()) aiWin.showInactive();
  } else if (aiWin.isVisible()) {
    aiWin.hide();
  }
}

// Focus moves in two steps — the old window blurs before the new one focuses —
// so answering on the blur alone would hide the panel every time you click it.
// A tick's delay lets the pair settle before anything is decided.
let aiVisibilityTimer = null;
function queueAIVisibility() {
  if (aiVisibilityTimer) return;
  aiVisibilityTimer = setTimeout(() => {
    aiVisibilityTimer = null;
    refreshAIVisibility();
  }, 0);
}

function sendAIAvailable() {
  if (!resultsOverlay || resultsOverlay.webContents.isDestroyed()) return;
  resultsOverlay.webContents.send('overlay:ai-available', aiReady);
}

// Readiness isn't a single event. The document iframe loads, and only then sits
// on "Connecting…" for a while before it renders — so `did-frame-finish-load`
// fires well before there's anything to assess. A one-second poll of the frame's
// own text is both simpler and more accurate than trying to pick the right event.
function startAIWatch() {
  stopAIWatch();
  aiWatch = setInterval(async () => {
    if (!results || results.isDestroyed()) {
      stopAIWatch();
      return;
    }
    const { ready } = await assess.contractStatus();

    noteContract();

    if (ready === aiReady) return;
    aiReady = ready;
    sendAIAvailable();
    // Navigated off the contract the open panel was talking about — it isn't
    // there to be assessed any more, so don't leave the panel up over it. The
    // thread stays: coming back to it should still take a follow-up.
    if (!ready) hideAI();
  }, 1000);
}

// The thread belongs to a DOCUMENT, not to a navigation. PandaDoc's router fires
// on plenty of things that leave the same contract on screen, and closing a
// contract and coming back to it should still answer a follow-up — so the thread
// is thrown away when the document actually changes to a different one, which is
// something only the page can tell us. Hence here rather than on 'did-navigate':
// at navigation time the new document's frame doesn't exist yet, and a page with
// no contract on it at all (a search, a folder listing) is a pass-through, not a
// switch. A visible panel is told too, since it holds the answers about the
// document that just left and nothing else would clear them.
function noteContract() {
  const key = assess.contractKey();
  if (!key || key === aiDocKey) return;
  if (aiDocKey) assess.resetThread();
  aiDocKey = key;
  if (aiWin && !aiWin.isDestroyed() && aiWin.isVisible()) {
    aiWin.webContents.send('ai:contract', key);
  }
}

function stopAIWatch() {
  if (aiWatch) {
    clearInterval(aiWatch);
    aiWatch = null;
  }
  aiReady = false;
}

// `quiet` is for the paths that are already gated — the bare `a` key and the
// overlay button, which isn't rendered when there's nothing to assess. The tray
// item is always clickable, so it explains itself instead of doing nothing.
function showAI(opts = {}) {
  if (!aiReady) {
    if (!opts.quiet) {
      dialog.showMessageBox({
        type: 'info',
        message: 'Open a contract first',
        detail:
          'Claude assesses the document on screen. Search for a contract, click ' +
          'into it, and let it finish loading — then the violet button appears ' +
          'over the bottom-right corner.',
      });
    }
    return;
  }
  if (!aiWin || aiWin.isDestroyed()) return;
  // Opened by hand can beat the poll to a document that just loaded, and the
  // panel is about to be told which contract it's showing — settle that first so
  // the two agree.
  noteContract();
  // The panel only shows over the PandaDoc window, so asking for it from the
  // tray — where that window may be buried — has to bring it up too.
  if (results && !results.isDestroyed()) {
    if (results.isMinimized()) results.restore();
    if (!results.isVisible()) results.show();
  }
  if (!aiWin.isVisible()) centerAI();
  aiOpen = true;
  aiWin.show();
  aiWin.focus();
  sendAIState();
}

// The panel's opening state. Async because working out who's signed in means
// reading the CLI's profile off disk, so the send lands a tick after the show —
// the panel is already up and asking for it either way.
async function sendAIState() {
  if (!aiWin || aiWin.isDestroyed()) return;
  const auth = await assess.authStatus();
  if (!aiWin || aiWin.isDestroyed()) return;
  aiWin.webContents.send('ai:open', {
    auth,
    assessments: assess.loadAssessments(),
    contract: aiDocKey,
  });
}

// Dismissal, not concealment: the panel stays down until it's asked for again.
// Everything that hides it temporarily goes through refreshAIVisibility instead.
function hideAI() {
  aiOpen = false;
  if (aiWin && !aiWin.isDestroyed() && aiWin.isVisible()) aiWin.hide();
}

// What the hotkey does. Once there's a PandaDoc window open, the first press
// brings that forward rather than the pill — the results you already have are
// almost always what you wanted, and the window may be buried behind whatever
// you were doing. Press it again, now that the window has focus, and you get the
// pill on top of it to run a new search. Its own search button is the same thing
// without the first press.
function summon() {
  const live = results && !results.isDestroyed();
  const pillUp = win && win.isVisible();

  if (live && !pillUp && !results.isFocused()) {
    if (results.isMinimized()) results.restore();
    results.show();
    results.focus();
    return;
  }

  show();
}

function buildUrl(term) {
  return `${config.baseUrl}?search=${encodeURIComponent(term)}${config.extraParams}`;
}

// Close the search window left over from a previous run so results don't pile
// up. Only windows still sitting on a search-results URL are closed — if you
// clicked through to an actual document, that window is left alone.
// macOS only: driving Chrome's windows this way needs AppleScript.
function closePreviousWindows(done) {
  if (!IS_MAC) {
    done();
    return;
  }

  const prefix = `${config.baseUrl}?search=`;
  const script = `
    if application "Google Chrome" is running then
      tell application "Google Chrome"
        repeat with w in (every window)
          try
            if (URL of active tab of w) starts with "${prefix}" then close w
          end try
        end repeat
      end tell
    end if`;

  execFile('osascript', ['-e', script], () => done());
}

// ---- forced dark mode ------------------------------------------------------
// PandaDoc has no dark theme, so we run the Dark Reader engine (the same one
// behind the browser extension) inside the results window and let it invert the
// page dynamically.
//
// The engine only goes in the top-level page. PandaDoc opens a document in an
// `app.pandadoc.com/e/` iframe, and Dark Reader inside that frame stops it ever
// finishing its "Connecting…" phase — the engine rewrites styles from a
// MutationObserver, and the editor evidently can't come up underneath that. That
// frame gets a plain inverting stylesheet instead: one <style> element, no
// observers, no patched DOM APIs, so there is nothing there to stall it.

const DARK_BG = '#181a1b'; // Dark Reader's own page background
let darkReaderSource = null;

function loadDarkReader() {
  if (darkReaderSource !== null) return darkReaderSource;
  try {
    darkReaderSource = fs.readFileSync(require.resolve('darkreader/darkreader.js'), 'utf8');
  } catch {
    darkReaderSource = ''; // missing dependency shouldn't stop the app opening
  }
  return darkReaderSource;
}

// Injected into the target's main world — Dark Reader expects to be a page
// script, so a preload's isolated world is the wrong place for it. `target` is a
// WebContents or a WebFrameMain; both take executeJavaScript.
//
// Load and enable have to happen in ONE evaluation. Two frames-worth of triggers
// fire per document (the subtree sweep and did-frame-finish-load), and if the
// "is it already there?" test is a separate round-trip they both come back false
// and each loads a copy. Two Dark Reader instances in one frame then chase each
// other's injected styles through their MutationObservers and peg that frame's
// main thread — the page never finishes loading. The flag below is set before
// anything can yield, so the second caller is a no-op.
function darkReaderPayload() {
  const src = loadDarkReader();
  if (!src) return null;

  return (
    '(function () {\n' +
    '  if (window.__pandadocSearchDark) return false;\n' +
    '  window.__pandadocSearchDark = true;\n' +
    '  try {\n' +
    // Only evaluated if it isn't there already: toggling dark mode off and on
    // re-enables the engine that's still loaded rather than shipping another
    // 346KB of source into the frame.
    '    if (!window.DarkReader) {\n' +
    src +
    '\n    }\n' +
    '  } catch (e) {\n' +
    '    window.__pandadocSearchDark = false;\n' +
    '    throw e;\n' +
    '  }\n' +
    `  DarkReader.enable(${JSON.stringify(config.darkModeOptions || {})});\n` +
    '  return true;\n' +
    '})()'
  );
}

// The engine-free alternative for frames that can't take Dark Reader. Inverting
// the whole document and then inverting media back is how the simplest dark-mode
// extensions work: cruder colours than Dark Reader, but it is one stylesheet and
// touches none of the frame's own JavaScript. Nested iframes are inverted back
// too, so they render normally and aren't darkened twice.
const INVERT_CSS = [
  ':root{background:#ffffff !important;',
  'filter:invert(1) hue-rotate(180deg) !important}',
  'img,picture,video,canvas,svg,iframe,embed,object,',
  '[style*="url("]{filter:invert(1) hue-rotate(180deg) !important}',
].join('');

function invertPayload() {
  return (
    '(function () {\n' +
    '  if (window.__pandadocSearchDark) return false;\n' +
    '  window.__pandadocSearchDark = true;\n' +
    '  var s = document.createElement("style");\n' +
    '  s.id = "pandadoc-search-dark";\n' +
    `  s.textContent = ${JSON.stringify(INVERT_CSS)};\n` +
    '  (document.head || document.documentElement).appendChild(s);\n' +
    '  return true;\n' +
    '})()'
  );
}

// Undoes either treatment, whichever the frame got. Dark Reader's own disable()
// removes every style it added, and the plain stylesheet is one element.
const UNDARK_JS = [
  '(function () {',
  '  if (!window.__pandadocSearchDark) return false;',
  '  window.__pandadocSearchDark = false;',
  '  try { if (window.DarkReader) DarkReader.disable(); } catch (e) {}',
  '  var s = document.getElementById("pandadoc-search-dark");',
  '  if (s) s.remove();',
  '  return true;',
  '})()',
].join('\n');

async function injectDark(target, method) {
  const payload = method === 'engine' ? darkReaderPayload() : invertPayload();
  if (!payload) return false;

  try {
    return await target.executeJavaScript(payload);
  } catch {
    // Navigated away mid-injection, or the frame blocked eval — not fatal.
    return false;
  }
}

function darkLog(line) {
  if (!config.darkModeDebug) return;
  try {
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'dark-mode.log'),
      `${new Date().toISOString()}  ${line}\n`
    );
  } catch {
    /* diagnostics are never worth failing over */
  }
}

// How deep a frame sits — 0 is the page itself, 1 an iframe in it, and so on.
function frameDepth(frame) {
  let depth = 0;
  try {
    for (let f = frame.parent; f; f = f.parent) depth += 1;
  } catch {
    /* frame went away mid-walk */
  }
  return depth;
}

function describeFrame(frame) {
  let url = '(gone)';
  try {
    url = frame.url || '(empty)';
  } catch {
    /* keep the placeholder */
  }
  return `depth=${frameDepth(frame)} url=${url.slice(0, 160)}`;
}

// "app.pandadoc.com" -> "pandadoc.com". Single-label hosts and IPs are their own
// site, so they're returned unchanged.
function siteOf(url) {
  try {
    const { hostname } = new URL(url);
    if (/^[\d.]+$/.test(hostname) || hostname.indexOf('.') === -1) return hostname;
    return hostname.split('.').slice(-2).join('.');
  } catch {
    return null;
  }
}

// Which treatment a frame gets, if any:
//   'engine' -> the Dark Reader engine, top-level page only
//   'invert' -> the plain inverting stylesheet, for PandaDoc's own iframes
// Everything else is left alone. That deliberately includes third-party frames —
// the doubleclick trackers PandaDoc embeds were getting a 346KB style engine
// injected into them for no visible benefit — and anything nested deeper than one
// level, which is inverted by its parent already.
function frameTreatment(frame, topUrl) {
  const depth = frameDepth(frame);
  let url;
  try {
    url = frame.url;
  } catch {
    return null; // frame went away
  }

  if (!/^https?:$/.test(new URL(url).protocol)) return null; // about:blank, blob:
  if (depth === 0) return 'engine';
  if (config.darkModeFrames !== 'all') return null;
  if (depth > 1) return null;
  if (siteOf(url) !== siteOf(topUrl)) return null;
  return 'invert';
}

function treatmentFor(frame, wc) {
  try {
    return frameTreatment(frame, wc.mainFrame.url);
  } catch {
    return null;
  }
}

async function applyDarkMode(wc) {
  if (!config.darkMode) return null;

  let frames;
  try {
    frames = wc.mainFrame.framesInSubtree; // includes the main frame
  } catch {
    return null; // window went away
  }

  darkLog(`sweep: ${frames.length} frame(s) in subtree`);

  await Promise.all(
    frames.map(async (frame) => {
      const where = describeFrame(frame);
      const method = treatmentFor(frame, wc);
      if (!method) {
        darkLog(`  leave   ${where}`);
        return;
      }
      const done = await injectDark(frame, method);
      darkLog(`  ${done ? method.padEnd(7) : 'noop   '} ${where}`);
    })
  );

  // The window background is matched to the top-level document's.
  try {
    return await wc.mainFrame.executeJavaScript(
      'getComputedStyle(document.documentElement).backgroundColor'
    );
  } catch {
    return null;
  }
}

// Everything currently showing PandaDoc content, so toggling the setting can
// reach the popups PandaDoc opened as well as the main view.
const darkTargets = new Set();

// Frames come and go long after the top-level document is ready — an iframe
// created when you click into a document never sees `dom-ready`.
function watchFramesForDarkMode(wc) {
  // Registered unconditionally, and the config is read per-event: dark mode is
  // a toggle now, so a window created while it was off still has to darken when
  // it's switched back on.
  darkTargets.add(wc);
  wc.on('destroyed', () => darkTargets.delete(wc));

  wc.on('did-frame-finish-load', (_e, isMainFrame, processId, routingId) => {
    if (!config.darkMode) return;
    if (isMainFrame) return; // the dom-ready hook covers that one
    const frame = webFrameMain.fromId(processId, routingId);
    if (!frame) return;

    const where = describeFrame(frame);
    const method = treatmentFor(frame, wc);
    if (!method) {
      darkLog(`late  leave   ${where}`);
      return;
    }
    injectDark(frame, method).then((done) =>
      darkLog(`late  ${done ? method.padEnd(7) : 'noop   '} ${where}`)
    );
  });
}

async function removeDarkMode(wc) {
  let frames;
  try {
    frames = wc.mainFrame.framesInSubtree;
  } catch {
    return; // window went away
  }

  darkLog(`undark: ${frames.length} frame(s) in subtree`);

  await Promise.all(
    frames.map(async (frame) => {
      const where = describeFrame(frame);
      let done = false;
      try {
        done = await frame.executeJavaScript(UNDARK_JS);
      } catch {
        /* navigated away, or the frame blocked eval */
      }
      darkLog(`  ${done ? 'undark ' : 'noop   '} ${where}`);
    })
  );
}

// ---- the PandaDoc container window -----------------------------------------
// Same shape as Driven's windows: `hiddenInset` so there's no separate titlebar
// strip and the whole window reads as one rounded card, the way native Mac apps
// look. That puts the traffic lights over the page, though, and unlike Driven we
// don't own this page's layout — so PandaDoc gets its own WebContentsView, inset
// below a strip that holds the traffic lights.
//
// `hiddenInset` means the content view covers the real titlebar, so the window
// is only draggable where web content asks to be (Driven does this in its CSS).
// The strip is therefore its own tiny view whose whole body is a drag region —
// bare window background there would look identical but not move the window.

const TOP_STRIP = 38;

// Chromium rounds its windows to about 9pt (14pt from Electron 41), while this
// version of macOS rounds its own to about 26pt — so a native-framed window is
// visibly squarer than Safari or Finder sitting next to it. Matching means
// drawing the shape ourselves: a transparent window with `roundedCorners` off,
// and the radius set on the views inside it.
//
// The catch is that macOS won't draw the traffic lights on a transparent window
// (no combination of titleBarStyle/transparent/setWindowButtonVisibility gets
// them back), so shell.html draws its own — see there for the rest.
const CORNER_RADIUS = 28;

function pageBackground() {
  return config.darkMode ? DARK_BG : '#ffffff';
}

// ---- the floating controls -------------------------------------------------
// A dark-mode toggle, an AI button, a quick-jump button, and a search button, in
// their own transparent view pinned over the bottom-right of PandaDoc. Small on
// purpose: the view swallows clicks wherever it sits, so it covers only the
// corner it needs — the width is four 38px buttons plus the gaps and padding set
// in overlay.html, and has to grow with them.

const OVERLAY_W = 208;
const OVERLAY_H = 64;

// Except while the quick-jump list is open, when the view has to be as big as
// the panel it's drawing. overlay.html measures the panel and asks for the size;
// closing puts it back to the buttons' own footprint, so the dead region over
// the document lasts exactly as long as the list does. Clamped so a stuck or
// hostile number can't blanket the window.
const OVERLAY_MAX_W = 520;
const OVERLAY_MAX_H = 720;

let overlayW = OVERLAY_W;
let overlayH = OVERLAY_H;

// createResultsWindow()'s layout(), kept here so a size change can re-run it
// without a resize event.
let layoutResults = null;

function setOverlaySize(width, height) {
  const fit = (n, min, max) =>
    Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : min;
  overlayW = fit(width, OVERLAY_W, OVERLAY_MAX_W);
  overlayH = fit(height, OVERLAY_H, OVERLAY_MAX_H);
  if (layoutResults) layoutResults();
}

function closeJump() {
  if (!resultsOverlay || resultsOverlay.webContents.isDestroyed()) return;
  resultsOverlay.webContents.send('overlay:jump-close');
}

// Bare "p" over the document. Gated on the same readiness as the button it
// stands in for, so the key does nothing rather than opening an empty list on a
// page that has no document to outline.
function toggleJump() {
  if (!aiReady) return;
  if (!resultsOverlay || resultsOverlay.webContents.isDestroyed()) return;
  resultsOverlay.webContents.send('overlay:jump-toggle');
}

function sendDarkState() {
  if (!resultsOverlay || resultsOverlay.webContents.isDestroyed()) return;
  resultsOverlay.webContents.send('overlay:dark-state', !!config.darkMode);
}

function paintChrome(color) {
  // Not the window itself — it stays transparent so the rounded views define the
  // shape. Painting it would put square corners back behind them.
  if (resultsView) resultsView.setBackgroundColor(color);
  if (resultsStrip) {
    resultsStrip.setBackgroundColor(color);
    if (!resultsStrip.webContents.isDestroyed()) {
      resultsStrip.webContents.send('shell:chrome', color);
    }
  }
}

async function toggleDarkMode() {
  config.darkMode = !config.darkMode;
  saveConfig();
  sendDarkState();

  // Darkens native scrollbars and form controls, and makes prefers-color-scheme
  // report dark — set at startup too, so it has to follow the toggle.
  nativeTheme.themeSource = config.darkMode ? 'dark' : 'light';

  paintChrome(pageBackground());

  for (const wc of darkTargets) {
    if (wc.isDestroyed()) continue;
    if (config.darkMode) {
      const bg = await applyDarkMode(wc);
      if (bg && resultsView && wc === resultsView.webContents) paintChrome(bg);
    } else {
      await removeDarkMode(wc);
    }
  }
}

function createResultsWindow() {
  const win = new BaseWindow({
    width: 1440,
    height: 900,
    title: 'PandaDoc',
    titleBarStyle: 'hidden',
    // We draw the window's shape, so the system must not draw its own.
    transparent: true,
    roundedCorners: false,
    backgroundColor: '#00000000',
    // Without this, the first click into an unfocused window is swallowed to
    // activate it and everything needs clicking twice.
    acceptFirstMouse: true,
  });

  const view = new WebContentsView({
    webPreferences: {
      // Its own persistent session, so you stay signed in between launches.
      partition: 'persist:pandadoc',
    },
  });
  view.setBackgroundColor(pageBackground());
  view.setBorderRadius(CORNER_RADIUS);

  // Full window height, not just the strip: it paints the window's colour behind
  // PandaDoc, so where the page view's rounded corners cut away, this shows
  // through rather than the desktop. Only its top strip is ever visible.
  const strip = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'shell-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  strip.setBackgroundColor(pageBackground());
  strip.setBorderRadius(CORNER_RADIUS);
  strip.webContents.loadFile(path.join(__dirname, 'shell.html'));

  const overlay = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Fully transparent, so PandaDoc shows through everywhere the buttons aren't.
  overlay.setBackgroundColor('#00000000');
  overlay.webContents.loadFile(path.join(__dirname, 'overlay.html'));

  // Added last, so it draws above PandaDoc.
  win.contentView.addChildView(strip);
  win.contentView.addChildView(view);
  win.contentView.addChildView(overlay);

  const layout = () => {
    const { width, height } = win.getContentBounds();
    strip.setBounds({ x: 0, y: 0, width, height });
    view.setBounds({
      x: 0,
      y: TOP_STRIP,
      width,
      height: Math.max(0, height - TOP_STRIP),
    });
    overlay.setBounds({
      x: Math.max(0, width - overlayW),
      y: Math.max(0, height - overlayH),
      width: Math.min(width, overlayW),
      height: Math.min(height, overlayH),
    });
  };
  layoutResults = layout;
  layout();
  win.on('resize', layout);

  // Our traffic lights are only coloured while the window is in front, like the
  // system's, so the strip has to be told.
  const tellFocus = (active) => {
    if (!strip.webContents.isDestroyed()) {
      strip.webContents.send('shell:focus', active);
    }
  };
  win.on('focus', () => {
    tellFocus(true);
    queueAIVisibility();
  });
  win.on('blur', () => {
    tellFocus(false);
    queueAIVisibility();
  });

  // The Claude panel is a floating window of its own, so nothing would otherwise
  // take it away when this one goes behind another app, is minimised, or hides.
  win.on('hide', queueAIVisibility);
  win.on('show', queueAIVisibility);
  win.on('minimize', queueAIVisibility);
  win.on('restore', queueAIVisibility);

  // Clicking the document means you're done with the answer. Fires for clicks in
  // PandaDoc's iframes too, and never for clicks on the panel itself — that's a
  // separate window and its events don't reach this view.
  view.webContents.on('input-event', (_e, input) => {
    if (input.type !== 'mouseDown') return;
    hideAI();
    // Same reasoning for the quick-jump list, and one more: while it's open the
    // view over it is eating clicks, so a click that lands on the document is
    // also the clearest sign it should stop.
    closeJump();
  });
  strip.webContents.on('did-finish-load', () => {
    tellFocus(win.isFocused());
    strip.webContents.send('shell:chrome', pageBackground());
  });

  // ---- back / forward ----
  // This window has no browser chrome and no menu bar, so nothing implements the
  // navigation keys a browser gives you for free. Handled in the main process
  // rather than injected into the page, so they work from inside PandaDoc's
  // document iframe too — which is exactly where you want to go back from.
  const navigate = (delta) => {
    const history = view.webContents.navigationHistory;
    if (delta < 0 && history.canGoBack()) history.goBack();
    else if (delta > 0 && history.canGoForward()) history.goForward();
  };

  // Cmd+arrow is also "move to start/end of line" whenever a text field has the
  // caret, and a browser decides which meaning applies by looking at what's
  // focused. We can't answer that synchronously, so the key is let through and
  // the navigation happens a beat later only if nothing was being edited. Asking
  // the focused frame rather than the top document is what makes this right
  // inside PandaDoc's editor iframe.
  const EDITING_CHECK =
    '(() => { const el = document.activeElement;' +
    ' return !!el && (el.isContentEditable ||' +
    ' /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)); })()';

  // Runs `action` a beat later, but only if the caret wasn't in a text field
  // when the key was pressed.
  const unlessEditing = (action) => {
    let frame;
    try {
      frame = view.webContents.focusedFrame || view.webContents.mainFrame;
    } catch {
      return;
    }
    frame
      .executeJavaScript(EDITING_CHECK)
      .then((editing) => {
        if (!editing) action();
      })
      .catch(() => action());
  };

  const navigateUnlessEditing = (delta) => unlessEditing(() => navigate(delta));

  view.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    // Bare "s" over the document is the same as the hotkey, "a" raises the
    // Claude panel, and "p" opens the quick-jump list — but only when nothing is
    // being typed into, so they can't eat a letter. The keys aren't swallowed
    // for the same reason the arrows aren't: whether they mean anything here is
    // only known once the editing check comes back.
    if (!input.meta && !input.control && !input.alt && !input.shift) {
      if (input.key === 's' || input.key === 'S') unlessEditing(show);
      else if (input.key === 'a' || input.key === 'A') {
        unlessEditing(() => showAI({ quiet: true }));
      } else if (input.key === 'p' || input.key === 'P') {
        unlessEditing(toggleJump);
      }
      return;
    }

    if (!input.meta || input.control || input.alt) return;

    // Cmd+[ and Cmd+] mean nothing else, so they act immediately.
    if (input.key === '[' || input.key === ']') {
      event.preventDefault();
      navigate(input.key === '[' ? -1 : 1);
      return;
    }

    if (input.key === 'ArrowLeft') navigateUnlessEditing(-1);
    else if (input.key === 'ArrowRight') navigateUnlessEditing(1);
  });

  // The other way macOS goes back: two-finger swipe, if the trackpad is set to it.
  win.on('swipe', (_e, direction) => {
    if (direction === 'right') navigate(-1);
    else if (direction === 'left') navigate(1);
  });

  watchFramesForDarkMode(view.webContents);

  // Anything PandaDoc opens with window.open gets the same treatment, otherwise
  // it arrives as a bare light window.
  view.webContents.on('did-create-window', (child) => {
    child.setBackgroundColor(pageBackground());
    watchFramesForDarkMode(child.webContents);
    child.webContents.on('dom-ready', () => applyDarkMode(child.webContents));
  });

  // Fires once per document load, before the page has done its own work — early
  // enough that it's rarely seen light.
  view.webContents.on('dom-ready', async () => {
    const bg = await applyDarkMode(view.webContents);
    // Dark Reader picks the page background from the original colours, so take
    // it from the page rather than guessing — otherwise the drag strip is a
    // slightly different dark and reads as a titlebar.
    if (bg && !win.isDestroyed()) {
      view.setBackgroundColor(bg);
      strip.setBackgroundColor(bg);
      if (!strip.webContents.isDestroyed()) {
        strip.webContents.send('shell:chrome', bg);
      }
    }
  });

  return { win, view, strip, overlay };
}

// One window, reused forever. A second search replaces its URL rather than
// stacking up another window.
function openInApp(term, url) {
  if (results && !results.isDestroyed()) {
    // Re-running the search you're already looking at would just throw away a
    // loaded page, so bring the window forward as-is instead. Only counts if the
    // window is still ON that search — if you clicked through to a document, the
    // live URL no longer carries the term and we do search again.
    const wc = resultsView.webContents;
    const live = wc.getURL();
    const unchanged =
      url === currentUrl && live.includes(`search=${encodeURIComponent(term)}`);

    if (!unchanged) {
      currentUrl = url;
      wc.loadURL(url);

      if (config.reloadOnSearch) {
        // PandaDoc is a hash-routed SPA, so swapping only the #fragment is an
        // in-page navigation. If its router ever fails to pick that up, this
        // forces the new URL to render.
        wc.once('did-finish-load', () => wc.reload());
      }
    }

    if (results.isMinimized()) results.restore();
    results.show();
    results.focus();
    return;
  }

  ({
    win: results,
    view: resultsView,
    strip: resultsStrip,
    overlay: resultsOverlay,
  } = createResultsWindow());

  // Hang the Claude panel off this window so the OS stacks and shows it with the
  // window it talks about — kept out of createAIWindow because the window it
  // parents to only exists now, and is remade on each fresh search.
  if (aiWin && !aiWin.isDestroyed()) aiWin.setParentWindow(results);

  currentUrl = url;
  resultsView.webContents.loadURL(url);
  startAIWatch();

  // The app is otherwise dock-less; give it a Dock icon while a real window is
  // up so Cmd-Tab and window management behave normally.
  if (app.dock) app.dock.show();

  results.on('closed', () => {
    stopAIWatch();
    hideAI();
    // Its parent is going away; detach so the panel doesn't die with it.
    if (aiWin && !aiWin.isDestroyed()) aiWin.setParentWindow(null);
    results = null;
    resultsView = null;
    resultsStrip = null;
    resultsOverlay = null;
    layoutResults = null;
    // The next window's overlay starts as the buttons again, whatever the last
    // one was left showing.
    overlayW = OVERLAY_W;
    overlayH = OVERLAY_H;
    currentUrl = null;
    // aiDocKey deliberately survives the window: closing it and opening the same
    // contract again is coming back to that contract, and the thread is keyed on
    // the document, not on how long the window it was in stayed up. The ten-minute
    // idle reset is what ends a thread nobody came back to.
    if (app.dock) app.dock.hide();
  });
}

function launch(term, url) {
  if (config.openMode === 'in-app') {
    openInApp(term, url);
    return;
  }

  if (config.openMode === 'chrome-app' && fs.existsSync(chromePath())) {
    // Calling the binary directly (rather than macOS `open -na`) is what makes
    // --app work when Chrome is already running.
    const child = spawn(chromePath(), [`--app=${url}`], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } else {
    shell.openExternal(url);
  }
}

function openUrl(term, url) {
  if (config.closePreviousWindow && config.openMode === 'chrome-app') {
    closePreviousWindows(() => launch(term, url));
  } else {
    launch(term, url);
  }
}

ipcMain.on('search', (_e, term) => {
  hide();
  const trimmed = (term || '').trim();
  if (!trimmed) return;
  rememberSearch(trimmed);
  openUrl(trimmed, buildUrl(trimmed));
});

ipcMain.on('cancel', () => hide());

// ---- the floating controls' channels ----------------------------------------
ipcMain.on('overlay:ready', () => {
  sendDarkState();
  sendAIAvailable();
});
ipcMain.on('overlay:toggle-dark', () => toggleDarkMode());
ipcMain.on('overlay:ai', () => showAI({ quiet: true }));
// The search button just raises the same pill the hotkey does; the pill is
// always-on-top, so it lands over the PandaDoc window.
ipcMain.on('overlay:search', () => show());

// ---- the quick-jump list ----------------------------------------------------
ipcMain.handle('overlay:jump-headings', () => assess.documentHeadings());
ipcMain.on('overlay:jump-to', (_e, id) => {
  if (typeof id === 'number') assess.jumpTo(id);
});
// Awaited by the renderer: it holds the list invisible until the view around it
// is the right size, so the panel can't be seen clipped to the button strip on
// the way open.
ipcMain.handle('overlay:jump-size', (_e, size) => {
  setOverlaySize(size && size.width, size && size.height);
});

// ---- the Claude panel's channels --------------------------------------------
ipcMain.on('ai:cancel', () => hideAI());

ipcMain.on('ai:resize', (_e, height) => {
  if (!aiWin || aiWin.isDestroyed()) return;
  const [w] = aiWin.getContentSize();
  aiWin.setContentSize(w, Math.max(239, Math.round(height)));
  centerAI();
});

// The panel asks for its own state once loaded, since it may finish loading
// after the click that opened it.
ipcMain.on('ai:ready', () => {
  sendAIState();
});

ipcMain.on('ai:open-docs', () => {
  shell.openExternal('https://code.claude.com/docs/en/quickstart');
});

ipcMain.handle('ai:auth-status', () => assess.authStatus());
ipcMain.handle('ai:sign-in', () => assess.signIn());
ipcMain.handle('ai:sign-out', () => assess.signOut());

ipcMain.handle('ai:get-assessments', () => assess.loadAssessments());
ipcMain.handle('ai:save-assessments', (_e, list) => assess.saveAssessments(list));

ipcMain.handle('ai:ask', (evt, payload) => assess.ask(evt.sender, payload || {}));

// ---- the results window's own chrome ----------------------------------------
// Its traffic lights are drawn in shell.html, because macOS won't render the
// real ones on the transparent window the corner radius needs.

ipcMain.on('shell:close', () => {
  if (results && !results.isDestroyed()) results.close();
});

ipcMain.on('shell:minimize', () => {
  if (results && !results.isDestroyed()) results.minimize();
});

ipcMain.on('shell:zoom', () => {
  if (!results || results.isDestroyed()) return;
  if (results.isMaximized()) results.unmaximize();
  else results.maximize();
});

// Where in the strip the window was grabbed. The move is always measured back to
// this point: the window follows the pointer, so the next event reports the same
// offset again and the drag can't accumulate drift.
let dragGrab = null;

ipcMain.on('shell:drag-start', (_e, x, y) => {
  dragGrab = { x, y };
});

ipcMain.on('shell:drag-move', (_e, x, y) => {
  if (!dragGrab || !results || results.isDestroyed()) return;
  const dx = Math.round(x - dragGrab.x);
  const dy = Math.round(y - dragGrab.y);
  if (!dx && !dy) return;
  const bounds = results.getBounds();
  results.setBounds({ ...bounds, x: bounds.x + dx, y: bounds.y + dy });
});

ipcMain.on('shell:drag-end', () => {
  dragGrab = null;
});

// The card sizes itself to its content (the chip row appears once there are
// recent searches), so the window follows it.
ipcMain.on('resize', (_e, height) => {
  if (!win) return;
  const [w] = win.getContentSize();
  win.setContentSize(w, Math.max(70, Math.round(height)));
  if (win.isVisible()) win.center();
});

// ---- auto-update (GitHub Releases) ----------------------------------------
// Only meaningful in a packaged, signed build: macOS refuses to swap in an
// update whose signature doesn't match the running app.
let updateState = 'idle';

function setupUpdater() {
  if (!app.isPackaged) {
    updateState = 'dev';
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.on('checking-for-update', () => (updateState = 'checking'));
  autoUpdater.on('update-not-available', () => (updateState = 'current'));
  autoUpdater.on('update-available', () => (updateState = 'downloading'));
  autoUpdater.on('error', () => (updateState = 'error'));

  autoUpdater.on('update-downloaded', (info) => {
    updateState = 'ready';
    dialog
      .showMessageBox({
        type: 'info',
        message: `PandaDoc Search ${info.version} is ready`,
        detail: 'Restart to finish installing.',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
  });

  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), UPDATE_INTERVAL_MS);
}

function checkForUpdatesNow() {
  if (!app.isPackaged) {
    dialog.showMessageBox({
      type: 'info',
      message: 'Updates are disabled in development',
      detail: 'Run the installed .app to check for updates.',
    });
    return;
  }

  if (updateState === 'ready') {
    autoUpdater.quitAndInstall();
    return;
  }

  autoUpdater
    .checkForUpdates()
    .then((r) => {
      if (!r || !r.updateInfo || r.updateInfo.version === app.getVersion()) {
        dialog.showMessageBox({
          type: 'info',
          message: `You're up to date`,
          detail: `Version ${app.getVersion()}.`,
        });
      }
    })
    .catch((err) => {
      dialog.showMessageBox({
        type: 'warning',
        message: 'Could not check for updates',
        detail: String(err && err.message ? err.message : err),
      });
    });
}

function createTray() {
  // nativeImage can't decode SVG, so these are real PNGs. macOS wants a black
  // template image it tints itself; the Windows tray is dark, so it gets white.
  const file = IS_MAC ? 'tray.png' : 'tray-win.png';
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', file));
  if (IS_MAC) icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip('PandaDoc Search');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Search  (${config.hotkey})`, click: show },
      { label: 'Assess Contract with Claude  (A)', click: showAI },
      { type: 'separator' },
      {
        label: 'Edit Config…',
        click: () => shell.openPath(configFile()),
      },
      { type: 'separator' },
      { label: `Version ${app.getVersion()}`, enabled: false },
      { label: 'Check for Updates…', click: checkForUpdatesNow },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
  tray.on('click', show);
}

// Single instance: a second launch just pops the search bar.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', show);

  app.whenReady().then(() => {
    if (app.dock) app.dock.hide();
    loadConfig();
    // Makes prefers-color-scheme report dark (in case PandaDoc ever grows a
    // dark theme of its own) and darkens scrollbars and native form controls.
    if (config.darkMode) nativeTheme.themeSource = 'dark';
    loadRecents();

    // The AI side reads whatever document the results window is showing, so it
    // gets a getter rather than a reference — the view is replaced every time
    // that window is closed and reopened.
    assess.init({
      app,
      getContractView: () =>
        resultsView && !resultsView.webContents.isDestroyed()
          ? resultsView.webContents
          : null,
    });

    createWindow();
    createAIWindow();
    createTray();
    setupUpdater();

    if (!globalShortcut.register(config.hotkey, summon)) {
      dialog.showErrorBox(
        'Hotkey unavailable',
        `Could not register "${config.hotkey}" — something else owns it.\n\n` +
          'Change the `hotkey` value in config.js and restart.'
      );
    }
  });
}

app.on('window-all-closed', () => {}); // stay alive in the menu bar
app.on('will-quit', () => globalShortcut.unregisterAll());
