// GENERATED from ProjectGlobals/shared-code/feedback-core.ts by build-core.mjs — DO NOT EDIT.
// Edit the core, then run `node build-core.mjs` and re-copy this folder into the desktop apps.
(function () {
'use strict';
/**
 * In-app feedback — the shared core every starred app uses.
 *
 * CANONICAL COPY: `ProjectGlobals/shared-code/feedback-core.ts`. Each app carries a
 * byte-identical copy at `src/lib/feedback/core.ts`; edit this file, then re-copy it to
 * every app in the same pass (`/audit-standards` hashes them). A local edit is drift.
 *
 * What lives here is everything that must behave the SAME in every app — the report's
 * shape, the path-through-the-app trail, the diagnostic-info preference, the screenshot
 * downscale and clipboard paste, the title and the body Develop files. What does NOT live here is UI: each
 * app draws the form with its own sheet, buttons and toast, so it looks native to that
 * app. No React, no DOM-only imports at module scope — Develop's Mac process imports
 * this file to format the reports it collects.
 *
 * Privacy contract (stated to the person on the form and in Settings):
 *  - The TRAIL records screens and the names of controls tapped. Never anything typed,
 *    and never the visible text of a list row — a row's text is the person's own
 *    content (a prayer title, a task name). It is sent with every bug.
 *  - The LOG is sent with a bug only while diagnostic info is on (the default). Feature
 *    requests never carry it.
 */

/** Develop's `FlagColor`, spelled out so this file imports nothing. */

/** One report, exactly as it is stored in the app's own synced `feedback` table. */

                                

                                                                 

                                                                                  

/**
 * What the form collects before it becomes a row. The two text boxes belong to the
 * form, not to the type: switching Bug ↔ Feature request relabels them and keeps
 * what was typed. `buildFeedbackRow` files them under the type that is sent.
 */

function emptyDraft(kind               = 'bug')                {
  return { kind, flag: null, summary: '', detail: '', screenshots: [] };
}

// ── The trail ─────────────────────────────────────────────────────────────────

const TRAIL_MAX = 50;
const LABEL_MAX = 60;
let trail              = [];
let trailInstalled = false;

function pushStep(kind                   , raw        )       {
  const label = raw.replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX);
  if (!label) return;
  const last = trail[trail.length - 1];
  // A double-tap or a re-render reporting the same screen twice is one step.
  if (last && last.kind === kind && last.label === label) return;
  trail.push({ at: new Date().toISOString(), kind, label });
  if (trail.length > TRAIL_MAX) trail = trail.slice(-TRAIL_MAX);
}

/** A screen the person is now on — a route, a view, a tab. Call on every change. */
function recordScreen(name        )       {
  pushStep('screen', name);
}

/** A sheet, dialog or panel that opened over the current screen. */
function recordOpen(name        )       {
  pushStep('open', name);
}

/** The trail so far, oldest first. This session only — it is never persisted. */
function getTrail()              {
  return trail.slice();
}

const TAPPABLE =
  'button, a[href], summary, [role="button"], [role="tab"], [role="menuitem"], [role="switch"], [role="checkbox"], [role="option"]';
// Inside one of these the visible text is the person's own content, never a control name.
const CONTENT_ROW = 'li, [role="listitem"], [role="row"], [role="gridcell"], [role="option"], [data-trail-content]';
const TEXT_LABEL_MAX = 32;

function tapLabel(el         )         {
  // `data-trail` is a static name an app chose on purpose, so it always wins.
  const named = el.getAttribute('data-trail');
  if (named) return named;
  const role = el.getAttribute('role') || el.tagName.toLowerCase();
  // Inside a content row even an aria-label is usually built from the row's data
  // ("Delete prayer for Mom"), so nothing the row says is recorded.
  if (el.closest(CONTENT_ROW)) return `${role} in a list`;
  const aria = el.getAttribute('aria-label');
  if (aria) return aria;
  if (el.tagName === 'A') {
    const href = el.getAttribute('href') || '';
    // The path only — a query string can carry a search the person typed.
    if (href.startsWith('/')) return `link ${href.split(/[?#]/)[0]}`;
    // Anything else (`sms:`, `mailto:`, a web page) names a person or a place they
    // went: record only its kind, never its text or address.
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
    return scheme ? `${scheme} link` : 'link';
  }
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  if (text && text.length <= TEXT_LABEL_MAX) return text;
  return role;
}

function onTap(e       )       {
  const target = e.target                  ;
  const el = target && typeof target.closest === 'function' ? target.closest(TAPPABLE) : null;
  if (el) pushStep('tap', tapLabel(el));
}

/**
 * Start recording taps. Idempotent; call once from the app shell. Screens are NOT
 * observed here — every app routes differently, so each calls `recordScreen` itself.
 */
function installTrail()       {
  if (trailInstalled || typeof document === 'undefined') return;
  trailInstalled = true;
  // Capture phase, so a handler that stops propagation cannot hide the tap.
  document.addEventListener('click', onTap, { capture: true });
}

function formatTrail(steps             )         {
  if (steps.length === 0) return '(no steps recorded)';
  return steps
    .map((s) => `${s.at.slice(11, 19)}  ${s.kind.padEnd(6)} ${s.label}`)
    .join('\n');
}

// ── A log for apps that have none of their own ────────────────────────────────
// Driven and Dividends pass their own export; the rest install this.

const LOG_MAX = 300;
const LOG_ARG_MAX = 500;
let logLines           = [];
let logInstalled = false;

function fmtArg(a         )         {
  if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ''}`;
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a)?.slice(0, LOG_ARG_MAX) ?? String(a);
  } catch {
    return String(a);
  }
}

function logLine(level        , args           )       {
  logLines.push(`${new Date().toISOString()} ${level} ${args.map(fmtArg).join(' ')}`);
  if (logLines.length > LOG_MAX) logLines = logLines.slice(-LOG_MAX);
}

/** Capture console warnings/errors, uncaught errors and unhandled rejections. Idempotent. */
function installLogCapture()       {
  if (logInstalled || typeof window === 'undefined') return;
  logInstalled = true;
  for (const level of ['error', 'warn']         ) {
    const original = console[level].bind(console);
    console[level] = (...args           ) => {
      logLine(level.toUpperCase(), args);
      original(...args);
    };
  }
  window.addEventListener('error', (e) => logLine('UNCAUGHT', [e.error ?? e.message]));
  window.addEventListener('unhandledrejection', (e) => logLine('REJECTED', [e.reason]));
  logLine('INFO', [`started ${typeof location !== 'undefined' ? location.pathname : ''}`]);
}

function exportCapturedLog()         {
  return logLines.join('\n');
}

// ── The diagnostic-info preference ────────────────────────────────────────────
// Device-local on purpose: it is a privacy choice about THIS device's log.

const DIAG_KEY = 'feedback.diagnostics';
const NOTICE_KEY = 'feedback.noticeSeen';
const prefListeners = new Set            ();

function readPref(key        )                {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key        , value        )       {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode — the choice holds for this session only */
  }
  prefListeners.forEach((l) => l());
}

/** On unless the person turned it off. */
function diagnosticsEnabled()          {
  return readPref(DIAG_KEY) !== 'off';
}

function setDiagnosticsEnabled(on         )       {
  writePref(DIAG_KEY, on ? 'on' : 'off');
}

/** Whether the one-time "diagnostic info is included" notice has been shown. */
function diagnosticsNoticeSeen()          {
  return readPref(NOTICE_KEY) === '1';
}

function markDiagnosticsNoticeSeen()       {
  writePref(NOTICE_KEY, '1');
}

/** For `useSyncExternalStore(subscribeFeedbackPrefs, diagnosticsEnabled, () => true)`. */
function subscribeFeedbackPrefs(listener            )             {
  prefListeners.add(listener);
  return () => prefListeners.delete(listener);
}

const DIAGNOSTICS_SETTING_LABEL = 'Include diagnostic info with bug reports';
const DIAGNOSTICS_SETTING_HINT =
  'Sends a record of what the app was doing so a bug can be found. Turn it off and only the screens you visited are sent — bugs may take longer to fix.';
const DIAGNOSTICS_NOTICE =
  'Bug reports include diagnostic info about what the app was doing. You can turn this off in Settings.';
const SENDER_NOTICE = 'Your name and email are sent with the report.';

// ── Opening the form ──────────────────────────────────────────────────────────

const OPEN_EVENT = 'feedback:open';

/** Ask the app's mounted form to open. `source` lands in the trail. */
function openFeedback(source        )       {
  if (typeof window === 'undefined') return;
  recordOpen(`feedback form (${source})`);
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { source } }));
}

function onOpenFeedback(handler                          )             {
  if (typeof window === 'undefined') return () => {};
  const listener = (e       ) => handler(String((e               ).detail?.source ?? ''));
  window.addEventListener(OPEN_EVENT, listener);
  return () => window.removeEventListener(OPEN_EVENT, listener);
}

// ── The screenshot ────────────────────────────────────────────────────────────

const SHOT_MAX_EDGE = 1280;
const SHOT_QUALITY = 0.72;

/** How many screenshots one report carries. The form stops offering more at this. */
const SCREENSHOTS_MAX = 5;

const TOO_MANY_SCREENSHOTS = `Only ${SCREENSHOTS_MAX} screenshots fit in one report — the rest were left out.`;

/** What to say after adding `adding` screenshots to a draft holding `holding`: null, or `TOO_MANY_SCREENSHOTS`. */
function screenshotOverflow(holding        , adding        )                {
  return holding + adding > SCREENSHOTS_MAX ? TOO_MANY_SCREENSHOTS : null;
}

/** The draft with one more screenshot, unless it already has `SCREENSHOTS_MAX`. */
function withScreenshot(d               , shot        )                {
  return d.screenshots.length >= SCREENSHOTS_MAX ? d : { ...d, screenshots: [...d.screenshots, shot] };
}

/** The draft without the screenshot at `index`. */
function withoutScreenshot(d               , index        )                {
  return { ...d, screenshots: d.screenshots.filter((_, i) => i !== index) };
}

/**
 * A row's stored `screenshot` back to its data URLs. They are stored end to end;
 * each begins `data:image/`, which base64 can never contain, so the split is exact.
 */
function screenshotsOf(v         )           {
  const all = joinPieces(v);
  return all ? all.split(/(?=data:image\/)/).filter(Boolean) : [];
}

/** A picked or pasted image → a downscaled JPEG data URL small enough to sync. */
async function screenshotFromFile(file      )                  {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise                  ((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('That image could not be read.'));
      el.src = url;
    });
    const scale = Math.min(1, SHOT_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('That image could not be read.');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', SHOT_QUALITY);
  } finally {
    URL.revokeObjectURL(url);
  }
}

const NO_CLIPBOARD_IMAGE = 'There is no image on the clipboard. Copy a screenshot first.';
const CLIPBOARD_UNREADABLE = 'The clipboard could not be read. Copy the screenshot again, then paste.';

/**
 * Picked (or ⌘V-pasted) image files → downscaled data URLs, in order. One at a time,
 * so picking a dozen photos on a phone never holds a dozen full-size decodes at once,
 * and a file that cannot be read is skipped rather than sinking the rest. Throws only
 * when none could be read.
 */
async function screenshotsFromFiles(files                                    )                    {
  const out           = [];
  let firstError          = null;
  for (const f of Array.from(files ?? [])) {
    try {
      out.push(await screenshotFromFile(f));
    } catch (err) {
      firstError ??= err;
    }
  }
  if (out.length === 0 && firstError) throw firstError;
  return out;
}

/**
 * The form's Paste button: every image on the system clipboard, downscaled — or []
 * when it holds none (say `NO_CLIPBOARD_IMAGE`). Call it straight from the tap: iOS
 * only lets a page read the clipboard inside a gesture, and asks the person to
 * confirm with its own Paste callout.
 */
async function screenshotsFromClipboard()                    {
  const clip = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!clip || typeof clip.read !== 'function') throw new Error(CLIPBOARD_UNREADABLE);
  let items                ;
  try {
    items = await clip.read();
  } catch {
    // Refused, or the person dismissed iOS's Paste callout.
    throw new Error(CLIPBOARD_UNREADABLE);
  }
  const images         = [];
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith('image/'));
    if (type) images.push(await item.getType(type));
  }
  return screenshotsFromFiles(images);
}

/** The image a paste carries, or null. A paste into a text box that carries text stays text. */
function imageFromPaste(e                )              {
  const data = e.clipboardData;
  if (!data) return null;
  const target = e.target                  ;
  const intoText = !!target && typeof target.closest === 'function' && !!target.closest('textarea, input, [contenteditable]');
  if (intoText && data.getData('text/plain')) return null;
  for (const item of Array.from(data.items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile();
  }
  return null;
}

/**
 * ⌘V / Ctrl-V anywhere while the form is open: an image on the clipboard is added as a
 * screenshot. Subscribe while the form is mounted; returns the unsubscribe.
 */
function onPastedImage(handler                       )             {
  if (typeof document === 'undefined') return () => {};
  const listener = (e                ) => {
    // Something focused already took this paste (a notes editor left focused under
    // a phone sheet); adding it here too would put one image in two places.
    if (e.defaultPrevented) return;
    const image = imageFromPaste(e);
    if (!image) return;
    e.preventDefault();
    handler(image);
  };
  document.addEventListener('paste', listener);
  return () => document.removeEventListener('paste', listener);
}

/** The bytes inside a `data:` URL, for Develop's attachment store. */
function dataUrlBytes(dataUrl        )                    {
  const m = /^data:[^;,]+;base64,(.*)$/.exec(dataUrl);
  if (!m) return null;
  const bin = atob(m[1]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

// ── Building the report ───────────────────────────────────────────────────────

/** Why the draft cannot be sent yet, or null when it can. */
function draftProblem(d               )                {
  if (d.kind === 'bug') {
    if (!d.summary.trim()) return 'Say what happened.';
    if (!d.detail.trim()) return 'Say what you expected to happen.';
  } else if (!d.summary.trim()) {
    return 'Describe your request.';
  }
  return null;
}

const TITLE_MAX = 80;

/** The work item's title: the first line of what happened, or of the request. */
function titleFor(d                                         )         {
  const line = d.summary.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const prefix = d.kind === 'bug' ? 'Bug: ' : 'Request: ';
  const room = TITLE_MAX - prefix.length;
  return prefix + (line.length > room ? `${line.slice(0, room - 1).trimEnd()}…` : line);
}

/** The newest end of a log is the end that matters; keep the row small enough to sync. */
const LOG_KEEP = 80_000;

/**
 * Dexie Cloud moves any string longer than 32,768 characters out of its row into
 * blob storage, and a blob is readable only by the person who wrote it — never by
 * Develop's collector, whose API-client token is refused (403). A log and a
 * screenshot are routinely longer than that, so they are stored as a list of
 * pieces each under the limit (the addon checks every array item on its own), and
 * stay inline where the collector can read them.
 */
const SYNC_PIECE = 30_000;

function toPieces(s        )           {
  const out           = [];
  for (let i = 0; i < s.length; i += SYNC_PIECE) out.push(s.slice(i, i + SYNC_PIECE));
  return out;
}

/** A stored `log` or `screenshot` back to one string: pieces, a plain string, or null. */
function joinPieces(v         )                {
  if (typeof v === 'string') return v || null;
  if (Array.isArray(v) && v.length > 0 && v.every((p) => typeof p === 'string')) return v.join('') || null;
  return null;
}

function platformName()         {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/Electron/.test(ua)) return 'Mac app';
  return 'Web';
}

function buildFeedbackRow(
  d               ,
  ctx
)              {
  const steps = getTrail();
  const isBug = d.kind === 'bug';
  const withDiagnostics = isBug && diagnosticsEnabled();
  let log                = null;
  if (withDiagnostics) {
    const body = (ctx.log ?? '').slice(-LOG_KEEP).trimEnd();
    log = `${body}${body ? '\n\n' : ''}=== path through the app ===\n${formatTrail(steps)}`;
  }
  return {
    id: ctx.id,
    createdAt: new Date().toISOString(),
    app: ctx.app,
    kind: d.kind,
    flag: d.flag,
    title: titleFor(d),
    happened: isBug ? d.summary.trim() : '',
    expected: isBug ? d.detail.trim() : '',
    request: isBug ? '' : d.summary.trim(),
    currentHandling: isBug ? '' : d.detail.trim(),
    screenshot: d.screenshots.length ? toPieces(d.screenshots.slice(0, SCREENSHOTS_MAX).join('')) : null,
    trail: isBug ? steps : [],
    log: log === null ? null : toPieces(log),
    diagnosticsIncluded: withDiagnostics,
    senderName: ctx.senderName,
    senderEmail: ctx.senderEmail,
    platform: platformName(),
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
  };
}

/**
 * The work item body Develop files — ticket.md. `screenshotRefs` are the attachment
 * paths the screenshots were stored under (`attachments/<name>`), in order.
 */
function reportBody(r             , screenshotRefs                   )         {
  const who = r.senderName && r.senderEmail ? `${r.senderName} <${r.senderEmail}>` : r.senderEmail || r.senderName || 'unknown sender';
  const what = r.kind === 'bug' ? 'Bug report' : 'Feature request';
  const out           = [
    `**${what}** from ${who} · ${r.app} · ${r.platform} · ${r.createdAt.slice(0, 16).replace('T', ' ')} UTC`,
    '',
  ];
  if (r.kind === 'bug') {
    out.push('**What happened**', '', r.happened, '', '**What they expected to happen**', '', r.expected, '');
  } else {
    out.push('**Request**', '', r.request, '');
    if (r.currentHandling) out.push('**How the app handles it today**', '', r.currentHandling, '');
  }
  screenshotRefs.forEach((ref, i) => {
    out.push(`![${screenshotRefs.length > 1 ? `screenshot ${i + 1}` : 'screenshot'}](${ref})`, '');
  });
  if (r.kind === 'bug') {
    out.push('**Path through the app**', '', '```', formatTrail(r.trail), '```', '');
    const log = joinPieces(r.log);
    if (log) out.push('**Diagnostic log**', '', '```', log, '```', '');
    else if (r.diagnosticsIncluded) out.push('_Sent with diagnostic info on, but the log could not be read._', '');
    else out.push('_Sent with diagnostic info turned off — only the path above is included._', '');
  }
  out.push(`<sub>${r.userAgent}</sub>`);
  return out.join('\n');
}

window.FeedbackCore = Object.freeze({ emptyDraft, recordScreen, recordOpen, getTrail, installTrail, formatTrail, installLogCapture, exportCapturedLog, diagnosticsEnabled, setDiagnosticsEnabled, diagnosticsNoticeSeen, markDiagnosticsNoticeSeen, subscribeFeedbackPrefs, DIAGNOSTICS_SETTING_LABEL, DIAGNOSTICS_SETTING_HINT, DIAGNOSTICS_NOTICE, SENDER_NOTICE, openFeedback, onOpenFeedback, SCREENSHOTS_MAX, TOO_MANY_SCREENSHOTS, screenshotOverflow, withScreenshot, withoutScreenshot, screenshotsOf, screenshotFromFile, NO_CLIPBOARD_IMAGE, screenshotsFromFiles, screenshotsFromClipboard, imageFromPaste, onPastedImage, dataUrlBytes, draftProblem, titleFor, SYNC_PIECE, toPieces, joinPieces, buildFeedbackRow, reportBody });
})();
