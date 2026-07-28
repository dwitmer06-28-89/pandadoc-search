const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  shell,
  Tray,
  Menu,
  nativeImage,
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

let win = null;
let tray = null;
let results = null; // the single reusable PandaDoc container window
let currentUrl = null; // what that window was last told to load
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
function closePreviousWindows(done) {
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

// One window, reused forever. A second search replaces its URL rather than
// stacking up another window.
function openInApp(term, url) {
  if (results && !results.isDestroyed()) {
    // Re-running the search you're already looking at would just throw away a
    // loaded page, so bring the window forward as-is instead. Only counts if the
    // window is still ON that search — if you clicked through to a document, the
    // live URL no longer carries the term and we do search again.
    const live = results.webContents.getURL();
    const unchanged =
      url === currentUrl && live.includes(`search=${encodeURIComponent(term)}`);

    if (!unchanged) {
      currentUrl = url;
      results.webContents.loadURL(url);

      if (config.reloadOnSearch) {
        // PandaDoc is a hash-routed SPA, so swapping only the #fragment is an
        // in-page navigation. If its router ever fails to pick that up, this
        // forces the new URL to render.
        results.webContents.once('did-finish-load', () => results.webContents.reload());
      }
    }

    if (results.isMinimized()) results.restore();
    results.show();
    results.focus();
    return;
  }

  results = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'PandaDoc',
    backgroundColor: '#ffffff',
    webPreferences: {
      // Its own persistent session, so you stay signed in between launches.
      partition: 'persist:pandadoc',
    },
  });

  currentUrl = url;
  results.loadURL(url);

  // The app is otherwise dock-less; give it a Dock icon while a real window is
  // up so Cmd-Tab and window management behave normally.
  if (app.dock) app.dock.show();

  results.on('closed', () => {
    results = null;
    currentUrl = null;
    if (app.dock) app.dock.hide();
  });
}

function launch(term, url) {
  if (config.openMode === 'in-app') {
    openInApp(term, url);
    return;
  }

  if (config.openMode === 'chrome-app' && fs.existsSync(config.chromePath)) {
    // Calling the binary directly (rather than `open -na`) is what makes
    // --app work when Chrome is already running.
    const child = spawn(config.chromePath, [`--app=${url}`], {
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
  // 16x16 template icon drawn inline so there's no asset to ship.
  const icon = nativeImage.createFromDataURL(
    'data:image/svg+xml;base64,' +
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
           <circle cx="7" cy="7" r="5" fill="none" stroke="black" stroke-width="1.8"/>
           <line x1="11" y1="11" x2="15" y2="15" stroke="black" stroke-width="1.8"/>
         </svg>`
      ).toString('base64')
  );
  icon.setTemplateImage(true);

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
