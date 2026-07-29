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
} = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { autoUpdater } = require('electron-updater');

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
let tray = null;
let results = null; // the single reusable PandaDoc container window
let resultsView = null; // the WebContentsView inside it holding PandaDoc
let currentUrl = null; // what that view was last told to load
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
  win.on('blur', () => hide());
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
async function injectDarkReader(target) {
  const src = loadDarkReader();
  if (!src) return false;

  try {
    // The UMD bundle hangs itself off globalThis; re-running it after an
    // in-page navigation would be wasted work.
    const already = await target.executeJavaScript('typeof DarkReader !== "undefined"');
    if (!already) await target.executeJavaScript(src);
    await target.executeJavaScript(
      `DarkReader.enable(${JSON.stringify(config.darkModeOptions || {})})`
    );
    return true;
  } catch {
    // Navigated away mid-injection, or the frame blocked eval — not fatal.
    return false;
  }
}

// Dark Reader only styles the document it was loaded into, so every frame needs
// its own copy: PandaDoc renders a document/contract in an iframe, which is why
// opening one from the results list came up light.
async function applyDarkMode(wc) {
  if (!config.darkMode) return null;

  let frames;
  try {
    frames = wc.mainFrame.framesInSubtree; // includes the main frame
  } catch {
    return null; // window went away
  }

  await Promise.all(frames.map((frame) => injectDarkReader(frame)));

  // The window background is matched to the top-level document's.
  try {
    return await wc.mainFrame.executeJavaScript(
      'getComputedStyle(document.documentElement).backgroundColor'
    );
  } catch {
    return null;
  }
}

// Frames come and go long after the top-level document is ready — an iframe
// created when you click into a document never sees `dom-ready`.
function watchFramesForDarkMode(wc) {
  if (!config.darkMode) return;

  wc.on('did-frame-finish-load', (_e, isMainFrame, processId, routingId) => {
    if (isMainFrame) return; // the dom-ready hook covers that one
    const frame = webFrameMain.fromId(processId, routingId);
    if (frame) injectDarkReader(frame);
  });
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

const STRIP_HTML =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    '<style>html,body{margin:0;height:100%;background:transparent;' +
      'cursor:default;-webkit-app-region:drag}</style>'
  );

function pageBackground() {
  return config.darkMode ? DARK_BG : '#ffffff';
}

function createResultsWindow() {
  const win = new BaseWindow({
    width: 1440,
    height: 900,
    title: 'PandaDoc',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: (TOP_STRIP - 12) / 2 },
    // Matching the page keeps the strip from reading as a titlebar, and keeps
    // the pre-paint flash from being a white rectangle.
    backgroundColor: pageBackground(),
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

  const strip = new WebContentsView();
  strip.setBackgroundColor(pageBackground());
  strip.webContents.loadURL(STRIP_HTML);

  win.contentView.addChildView(strip);
  win.contentView.addChildView(view);

  const layout = () => {
    const { width, height } = win.getContentBounds();
    strip.setBounds({ x: 0, y: 0, width, height: TOP_STRIP });
    view.setBounds({
      x: 0,
      y: TOP_STRIP,
      width,
      height: Math.max(0, height - TOP_STRIP),
    });
  };
  layout();
  win.on('resize', layout);

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
      win.setBackgroundColor(bg);
      view.setBackgroundColor(bg);
      strip.setBackgroundColor(bg);
    }
  });

  return { win, view };
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

  ({ win: results, view: resultsView } = createResultsWindow());

  currentUrl = url;
  resultsView.webContents.loadURL(url);

  // The app is otherwise dock-less; give it a Dock icon while a real window is
  // up so Cmd-Tab and window management behave normally.
  if (app.dock) app.dock.show();

  results.on('closed', () => {
    results = null;
    resultsView = null;
    currentUrl = null;
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
    createWindow();
    createTray();
    setupUpdater();

    if (!globalShortcut.register(config.hotkey, show)) {
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
