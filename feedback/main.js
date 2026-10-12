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
//   const feedback = require('./feedback/main.js').setup({ app: 'Pandadoc Search' });
//   ...menu template, under Help or the app menu: feedback.menuItem('help menu')
//   ...anywhere else:                              feedback.open('right-click')

const { app: electronApp, BrowserWindow, clipboard, ipcMain, nativeTheme, net, webContents } = require('electron');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
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

/**
 * Whether this is Deron's Mac: Develop writes its lane scripts into this folder at
 * every launch, and Develop only runs on his Macs. The Feature picker is his alone
 * (FEEDBACK.md, "The feature picker"); these apps have no sign-in to ask instead.
 */
function isOwnersMac() {
  try {
    return fs.statSync(path.join(electronApp.getPath('appData'), 'develop-claude-lanes')).isDirectory();
  } catch {
    return false;
  }
}

/** The app's Develop features, `[{ id, name }]` — [] off Deron's Mac, when it has none, or when unreachable. Never throws. */
async function readFeatures(appName) {
  if (!isOwnersMac()) return [];
  const doFetch = typeof net?.fetch === 'function' ? net.fetch.bind(net) : fetch;
  try {
    const res = await doFetch(`${INBOX.url}/features/${encodeURIComponent(appName)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const list = await res.json();
    return Array.isArray(list)
      ? list.filter((f) => f && typeof f.id === 'string' && f.id && typeof f.name === 'string' && f.name.trim())
          .slice(0, 100)
          .map((f) => ({ id: f.id, name: f.name.trim() }))
      : [];
  } catch {
    return [];
  }
}

// ── The app's own record ─────────────────────────────────────────────────────
// What a bug report's diagnostic info and Copy Log carry when the app keeps no log
// of its own (Deron, 2026-10-11: every desktop app records). Warnings and errors
// only — from the main process and from the app's OWN pages (file:// and its local
// server), never from a site it wraps (Slack, Core), whose console is someone
// else's and may carry their content. The newest LOG_MAX_LINES are kept, each
// capped, in memory only: nothing is written to disk and it ends with the app.

const LOG_MAX_LINES = 300;
const LOG_LINE_MAX = 1000;
let logLines = [];

function logArg(a) {
  if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ''}`;
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a) ?? String(a);
  } catch {
    return String(a);
  }
}

function logLine(level, text) {
  logLines.push(`${new Date().toISOString()} ${level} ${String(text).slice(0, LOG_LINE_MAX)}`);
  if (logLines.length > LOG_MAX_LINES) logLines = logLines.slice(-LOG_MAX_LINES);
}

/** The app's own UI — a bundled file or its own local server — rather than a site it wraps. */
function isOwnPage(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'file:' || (/^https?:$/.test(u.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
  } catch {
    return false;
  }
}

const CONSOLE_LEVELS = ['debug', 'info', 'warning', 'error'];

function watchContents(wc) {
  // Electron 35+ hands one event with named fields; older ones (SwapSaver, Claude
  // Global ride 33) pass them positionally. Rest parameters keep the listener's
  // declared arity at one, so a newer Electron sees nothing to call deprecated.
  wc.on('console-message', (e, ...legacy) => {
    const [level, message, line, sourceId] = legacy;
    const lvl = typeof e?.level === 'string' ? e.level : CONSOLE_LEVELS[level];
    if (lvl !== 'warning' && lvl !== 'error') return;
    if (!isOwnPage(wc.getURL())) return;
    const msg = typeof e?.message === 'string' ? e.message : message;
    const src = typeof e?.sourceId === 'string' ? e.sourceId : sourceId;
    const ln = typeof e?.lineNumber === 'number' ? e.lineNumber : line;
    logLine(lvl === 'error' ? 'ERROR' : 'WARN', `[page] ${msg}${src ? ` (${path.basename(String(src))}:${ln})` : ''}`);
  });
  wc.on('render-process-gone', (_e, d) => logLine('GONE', `a window's page stopped: ${d?.reason ?? 'unknown'}`));
  wc.on('unresponsive', () => logLine('WARN', 'a window stopped responding'));
}

function installLogCapture(appName) {
  for (const level of ['warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      logLine(level.toUpperCase(), args.map(logArg).join(' '));
      original(...args);
    };
  }
  // The monitor observes a crash without changing what the app does about it —
  // an 'uncaughtException' listener would stop it from crashing at all.
  process.on('uncaughtExceptionMonitor', (err, origin) => logLine('UNCAUGHT', `${origin}: ${logArg(err)}`));
  electronApp.on('child-process-gone', (_e, d) => logLine('GONE', `${d?.type ?? 'helper'} stopped: ${d?.reason ?? 'unknown'}`));
  electronApp.on('web-contents-created', (_e, wc) => watchContents(wc));
  // Windows made before setup() still get watched.
  try {
    for (const wc of webContents.getAllWebContents()) watchContents(wc);
  } catch {
    /* before the app is ready there are none */
  }
  logLine('INFO', `${appName} ${electronApp.getVersion()} started · Electron ${process.versions.electron} · macOS ${process.getSystemVersion?.() ?? os.release()}`);
}

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
 * @param {() => (string | null | Promise<string | null>)} [options.getLog]  The app's own log,
 *   if it keeps a better one (its newest end matters; the core keeps the last 80k characters).
 *   Omit it and this module keeps one for the app — see "The app's own record". Either way it
 *   is sent with a bug only while diagnostic info is on, and Copy Log copies it.
 * @param {() => (import('electron').BrowserWindow | null | undefined)} [options.parent]  The
 *   window the feedback window should stay above, if any.
 * @returns {{ open: (source?: string) => void, menuItem: (source?: string) => object }}
 */
function setup(options) {
  const appName = options && typeof options.app === 'string' ? options.app.trim() : '';
  if (!appName) throw new Error('desktop-feedback: setup({ app }) needs the Develop project name');
  if (installed) throw new Error('desktop-feedback: setup() was already called');
  installed = true;

  // Every app has a log now: its own, or the record kept here.
  if (typeof options.getLog !== 'function') installLogCapture(appName);
  const getLog = typeof options.getLog === 'function' ? options.getLog : () => logLines.join('\n');
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
    return { app: appName, id: reportId, source, hasLog: true, senderName: s.senderName, senderNotice: SENDER_NOTICE };
  });

  // Asked separately so the form opens at once and the picker appears when the list arrives.
  ipcMain.handle('desktop-feedback:features', async (event) => {
    if (!fromForm(event)) return [];
    return readFeatures(appName);
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

  ipcMain.handle('desktop-feedback:copy', (event, text) => {
    if (!fromForm(event) || typeof text !== 'string') return false;
    clipboard.writeText(text);
    return true;
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
