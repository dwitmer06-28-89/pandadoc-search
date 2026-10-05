'use strict';
// SEND FEEDBACK from a desktop app that has no sign-in — main process side.
//
// CANONICAL COPY: `ProjectGlobals/shared-code/desktop-feedback/`. Each desktop app
// without sign-in (Pandadoc Search, Slack Wrapper, CoreWrapper, SwapSaver, Claude
// Global) carries a byte-identical copy of this folder as `feedback/` beside its
// main file. Edit here, then re-copy into every app. Spec and wiring:
// `ProjectGlobals/shared-code/FEEDBACK.md`, "Desktop apps without sign-in".
//
// What it does: opens a small "Send Feedback" window (form.html — plain
// HTML/CSS/JS, no framework), which builds the report with the SHARED CORE's
// `buildFeedbackRow` (feedback-core.browser.js, generated from feedback-core.ts)
// and hands it back here; this posts it to the feedback inbox (inbox.json). The
// report waits there until Develop, on Deron's Mac, files it as a backlog work
// item in this app's project.
//
// There is no signed-in sender, so the report carries the Mac user's full name
// and the computer's name instead. Posting happens here rather than in the window
// so the window needs no network access at all (its CSP allows none).
//
// Usage (the whole of an app's wiring):
//   const feedback = require('./feedback/main.js').setup({ app: 'Pandadoc Search', getLog });
//   ...menu template, under Help or the app menu: feedback.menuItem('help menu')
//   ...anywhere else:                              feedback.open('right-click')

const { BrowserWindow, ipcMain, nativeTheme, net } = require('electron');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const INBOX = require('./inbox.json');

/** The inbox's own cap (feedback-inbox/src/validate.js); refused here first so the person hears why. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const WIDTH = 460;
const MIN_HEIGHT = 300;
const MAX_HEIGHT = 860;

/** Said under the fields. The core's SENDER_NOTICE says "name and email"; there is no email here. */
const SENDER_NOTICE = 'Your name and this Mac’s name are sent with the report.';

let installed = false;

/** A command's trimmed output, or '' when it is missing or fails. Never throws. */
function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 3000 }, (err, stdout) => resolve(err ? '' : String(stdout).trim()));
  });
}

/** Who is sending: the macOS user's full name and the computer's name, with plain fallbacks. */
async function readSender() {
  let user = '';
  try {
    user = os.userInfo().username;
  } catch {
    /* no passwd entry — fall through to the name lookups */
  }
  const fullName = (await run('/usr/bin/id', ['-F'])) || user || 'Unknown user';
  const computer = (await run('/usr/sbin/scutil', ['--get', 'ComputerName'])) || os.hostname() || 'unknown Mac';
  return { fullName, computer, senderName: `${fullName} on ${computer}` };
}

async function postReport(row) {
  const body = JSON.stringify(row);
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
    return { ok: false, error: 'The report is too large to send. Try a smaller screenshot.' };
  }
  // `net.fetch` goes through Chromium's network stack, so it honours the Mac's
  // proxy settings the way the rest of the app does.
  const doFetch = typeof net?.fetch === 'function' ? net.fetch.bind(net) : fetch;
  let res;
  try {
    res = await doFetch(`${INBOX.url}/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Feedback-Key': INBOX.appKey },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: 'Couldn’t reach the feedback service. Check your internet connection and try again.' };
  }
  if (res.ok) return { ok: true };
  let detail = '';
  try {
    detail = String((await res.json()).error ?? '');
  } catch {
    /* not JSON */
  }
  return { ok: false, error: `The feedback service refused the report (${res.status}${detail ? `: ${detail}` : ''}).` };
}

/**
 * Enable "Send Feedback…" for this app. Call once, from the main process, at
 * startup (before or after `app.whenReady()` — the window is made on first open).
 *
 * @param {object} options
 * @param {string} options.app  This app's Develop project name, exactly: "Pandadoc Search",
 *   "Slack Wrapper", "CoreWrapper", "SwapSaver" or "Claude Global". The inbox refuses others.
 * @param {() => (string | null | Promise<string | null>)} [options.getLog]  The app's log,
 *   if it keeps one (its newest end matters; the core keeps the last 80k characters). Sent
 *   with a bug only while diagnostic info is on. Omit when the app has no log.
 * @param {() => (import('electron').BrowserWindow | null | undefined)} [options.parent]  The
 *   window the feedback window should stay above, if any.
 * @returns {{ open: (source?: string) => void, menuItem: (source?: string) => object }}
 */
function setup(options) {
  const appName = options && typeof options.app === 'string' ? options.app.trim() : '';
  if (!appName) throw new Error('desktop-feedback: setup({ app }) needs the Develop project name');
  if (installed) throw new Error('desktop-feedback: setup() was already called');
  installed = true;

  const hasLog = typeof options.getLog === 'function';
  const getLog = hasLog ? options.getLog : () => null;
  const getParent = typeof options.parent === 'function' ? options.parent : () => null;
  let win = null;
  // One report id per opened form: a retry after a lost reply stores the same
  // report once (the inbox keys on the id).
  let reportId = null;
  let source = '';
  const senderPromise = readSender();

  const fromForm = (event) => win !== null && !win.isDestroyed() && event.sender === win.webContents;

  ipcMain.handle('desktop-feedback:context', async (event) => {
    if (!fromForm(event)) return null;
    const s = await senderPromise;
    return { app: appName, id: reportId, source, hasLog, senderName: s.senderName, senderNotice: SENDER_NOTICE };
  });

  ipcMain.handle('desktop-feedback:log', async (event) => {
    if (!fromForm(event)) return null;
    try {
      const log = await getLog();
      return typeof log === 'string' ? log : null;
    } catch {
      return null;
    }
  });

  ipcMain.handle('desktop-feedback:send', async (event, row) => {
    if (!fromForm(event)) return { ok: false, error: 'Not from the feedback window.' };
    if (!row || typeof row !== 'object' || row.app !== appName || row.id !== reportId) {
      return { ok: false, error: 'The report could not be prepared. Close the window and try again.' };
    }
    return postReport(row);
  });

  ipcMain.on('desktop-feedback:close', (event) => {
    if (fromForm(event)) win.close();
  });

  ipcMain.on('desktop-feedback:resize', (event, height) => {
    if (!fromForm(event) || typeof height !== 'number' || !Number.isFinite(height)) return;
    const h = Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height)));
    const [, current] = win.getContentSize();
    if (current !== h) win.setContentSize(WIDTH, h, false);
  });

  function open(from = 'menu') {
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
      return;
    }
    reportId = crypto.randomUUID();
    source = String(from);
    // Only a window the person can see makes a parent. A child of a minimized or
    // hidden window is minimized or hidden with it on macOS, so the form would open
    // invisibly — Pandadoc Search's results window and Claude Global's popup hide
    // themselves, and any main window can be minimized when Help is used.
    const candidate = getParent();
    const parent = candidate && !candidate.isDestroyed() && candidate.isVisible() && !candidate.isMinimized()
      ? candidate
      : null;
    win = new BrowserWindow({
      width: WIDTH,
      height: 560,
      useContentSize: true,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: 'Send Feedback',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ececec',
      ...(parent ? { parent } : {}),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: true,
      },
    });
    const wc = win.webContents;
    // The form never navigates: a dropped file or a stray link stays put.
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.once('ready-to-show', () => win && !win.isDestroyed() && win.show());
    win.on('closed', () => {
      win = null;
      reportId = null;
    });
    win.loadFile(path.join(__dirname, 'form.html'));
  }

  return {
    open,
    /** A menu template item, for the app menu, the Help menu or a context menu. */
    menuItem: (from = 'menu') => ({ label: 'Send Feedback…', click: () => open(from) }),
  };
}

module.exports = { setup };
