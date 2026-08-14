// The AI side: the Claude connection, the assessment library, and reading the
// contract that's currently on screen.
//
// Kept out of main.js because none of it touches windows — main.js owns the
// views and hands this module a getter for whichever WebContents is showing
// PandaDoc right now.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');

let app = null;
let getContractView = () => null; // set by init(); returns a WebContents or null

function init(deps) {
  app = deps.app;
  getContractView = deps.getContractView;
  retireOldKeyFile();
}

// ---- who's asking ----------------------------------------------------------
// Each person signs in with their own Claude account, and assessments run
// against that account's subscription rather than metered API credits. The
// login belongs to Claude Code — `claude auth login` opens a browser and stores
// the credential in the login keychain — and the Agent SDK picks it up from
// there, so nothing in this app ever holds a credential.
//
// The CLI is used for the account side only (status, sign in, sign out). The
// asking itself goes through the Agent SDK's own bundled executable, so a
// missing `claude` on PATH can't break a signed-in install.

// Earlier versions kept a pasted API key here. It's dead weight now, and a
// secret nobody is going to think to clean up by hand.
function retireOldKeyFile() {
  try {
    fs.unlinkSync(path.join(app.getPath('userData'), 'claude-key.enc'));
  } catch {
    /* never existed, or already gone */
  }
}

// Where the CLI might be. PATH first, because a dev run inherits a real shell
// environment; the fixed list is for the packaged app, which is launched by
// Finder with a PATH of little more than /usr/bin.
function cliCandidates() {
  const home = os.homedir();
  const fromPath = (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, 'claude'));

  return [
    ...fromPath,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(home, '.claude', 'local', 'claude'),
    path.join(home, '.local', 'bin', 'claude'),
  ];
}

let cliPath = null; // memoised across calls; the CLI doesn't move mid-session

function findCli() {
  if (cliPath) {
    try {
      fs.accessSync(cliPath, fs.constants.X_OK);
      return cliPath;
    } catch {
      cliPath = null; // uninstalled since we last looked
    }
  }

  const seen = new Set();
  for (const bin of cliCandidates()) {
    if (seen.has(bin)) continue;
    seen.add(bin);
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      cliPath = bin;
      return bin;
    } catch {
      /* not here */
    }
  }
  return null;
}

// Surfaced by authStatus() rather than returned from signIn(), because the
// failure usually happens after the spawn has already come back fine.
let signInError = '';

// Which account the last status check saw. A thread carries a document and its
// answers, and both belong to the account that paid for them — switching
// accounts mid-panel shouldn't inherit either.
let lastAccount = null;

// The account label as last seen, so an error about the account can name it
// rather than leaving people guessing which one the app is using.
let lastAccountLabel = '';

// `claude auth status` answers in JSON:
//   { loggedIn, authMethod, apiProvider, email, orgId, orgName, subscriptionType }
// authMethod is "claude.ai" for a subscription login and "console" for one
// pointed at API billing, which is the distinction this whole change is about.
function readAuth(cli) {
  return new Promise((resolve) => {
    execFile(cli, ['auth', 'status', '--json'], { timeout: 15000 }, (err, stdout) => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        // A CLI too old for `auth status`, or one that answered with prose.
        resolve(null);
      }
    });
  });
}

// { signedIn, cli, email, organization, subscription, console, error }
async function authStatus() {
  const cli = findCli();
  const said = cli ? await readAuth(cli) : null;

  const signedIn = !!(said && said.loggedIn);
  const email = (said && said.email) || '';
  const organization = (said && said.orgName) || '';
  const subscription = (said && said.subscriptionType) || '';

  // Signed in, but against API billing rather than a subscription — which is
  // the case that produced the out-of-credits error this app used to hit.
  const onConsole = signedIn && said.authMethod === 'console';

  lastAccountLabel = organization || email || '';

  const account = signedIn ? `${email}|${organization}|${said.authMethod}` : null;
  if (account !== lastAccount) {
    if (lastAccount !== null) resetThread();
    lastAccount = account;
  }

  return {
    signedIn,
    cli: !!cli,
    email,
    organization,
    subscription,
    console: onConsole,
    error: signInError,
  };
}

// `claude auth login` opens a browser and waits on a loopback callback rather
// than reading the terminal, so it runs headless from here. --claudeai pins it
// to subscription billing; the console flow is the thing we just moved off.
async function signIn() {
  const cli = findCli();
  if (!cli) return { error: 'no-cli' };

  signInError = '';

  try {
    const child = spawn(cli, ['auth', 'login', '--claudeai'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    let noise = '';
    const collect = (buf) => {
      noise = (noise + buf.toString()).slice(-2000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    child.on('error', (err) => {
      signInError = `Could not run ${cli}: ${(err && err.message) || err}`;
    });
    child.on('exit', (code) => {
      // Zero means the browser round trip finished and the credential is
      // stored; the panel is polling authStatus() and will see it.
      if (code === 0) return;
      signInError =
        noise.trim().split('\n').slice(-3).join(' ').trim() ||
        `\`claude auth login\` exited with code ${code}.`;
    });

    return { started: true };
  } catch (err) {
    return { error: (err && err.message) || String(err) };
  }
}

async function signOut() {
  const cli = findCli();
  if (!cli) return { error: 'no-cli' };

  return new Promise((resolve) => {
    execFile(cli, ['auth', 'logout'], { timeout: 20000 }, (err, stdout, stderr) => {
      resetThread();
      if (err) {
        const msg = `${stderr || ''}${stdout || ''}`.trim();
        resolve({ error: msg || (err.message || 'Sign-out failed.') });
        return;
      }
      resolve({ ok: true });
    });
  });
}

// ---- assessments -----------------------------------------------------------
// A named instruction that gets run against whatever contract is on screen.
// These are the "skills": the shipped set below is a starting point, and the
// panel's editor writes the user's own back to assessments.json.

const ASSESSMENTS_FILE = () =>
  path.join(app.getPath('userData'), 'assessments.json');

const DEFAULT_ASSESSMENTS = [
  {
    name: 'Risk scan',
    instruction:
      'Review this contract for risk to us as the vendor. Cover: uncapped or ' +
      'unusually high liability, indemnification we take on, termination the ' +
      'client can exercise unilaterally, auto-renewal we could miss, payment ' +
      'terms longer than 30 days, SLA or uptime commitments with penalties, ' +
      'IP assignment, and anything non-standard.\n\n' +
      'Order findings by how much they could cost us. For each: quote the ' +
      'clause, say plainly what the exposure is, and give the change that ' +
      'would fix it. If a category is clean, say so in one line rather than ' +
      'padding. If a term is genuinely absent from the document, say it is ' +
      'absent — do not infer it.',
  },
  {
    name: 'Key terms',
    instruction:
      'Extract the commercial terms as a compact table: total value, billing ' +
      'frequency, term length, start and end dates, renewal mechanics, notice ' +
      'period, payment terms, and named parties with signatories.\n\n' +
      'Use the exact figures and dates from the document. If a field is not ' +
      'stated anywhere, write "not stated" rather than guessing or ' +
      'calculating it from other terms.',
  },
  {
    name: 'Renewal & exit',
    instruction:
      'Explain how this contract ends and how it renews. Give me the concrete ' +
      'dates and deadlines: when the current term expires, whether it ' +
      'auto-renews and on what terms, the exact date by which either side ' +
      'must give notice to stop that, how much notice each side owes, and what ' +
      'either party can terminate for (cause, convenience, non-payment).\n\n' +
      'Lead with the next date we actually have to act on.',
  },
  {
    name: 'Payment terms',
    instruction:
      'Detail how and when we get paid: amounts, schedule, invoicing ' +
      'triggers, net terms, late-payment interest or fees, expense ' +
      'reimbursement, price-increase rights, and anything that lets the client ' +
      'withhold, dispute, or offset payment.\n\n' +
      'Flag anything that delays revenue or makes it conditional.',
  },
  {
    name: 'Obligations',
    instruction:
      'List what each side has committed to do, split into two sections: our ' +
      'obligations and the client\'s. Include deliverables, deadlines, ' +
      'response or uptime commitments, reporting, security and compliance ' +
      'requirements, and any client dependency our performance relies on.\n\n' +
      'Mark anything that is a hard deadline or carries a penalty.',
  },
];

function sanitizeAssessments(list) {
  return (Array.isArray(list) ? list : [])
    .map((a) => ({
      name: String((a && a.name) || '').trim().slice(0, 40),
      instruction: String((a && a.instruction) || '').trim(),
    }))
    .filter((a) => a.name && a.instruction)
    .slice(0, 24);
}

function loadAssessments() {
  try {
    const saved = JSON.parse(fs.readFileSync(ASSESSMENTS_FILE(), 'utf8'));
    const clean = sanitizeAssessments(saved);
    // An empty or unparseable file shouldn't leave the panel with no buttons.
    return clean.length ? clean : DEFAULT_ASSESSMENTS;
  } catch {
    return DEFAULT_ASSESSMENTS;
  }
}

function saveAssessments(list) {
  const clean = sanitizeAssessments(list);
  try {
    fs.writeFileSync(ASSESSMENTS_FILE(), JSON.stringify(clean, null, 2) + '\n');
  } catch {
    /* same as the key: applies this run, may not survive a restart */
  }
  return clean;
}

// ---- reading the contract off the screen ------------------------------------
// PandaDoc renders an opened document inside an `app.pandadoc.com/e/` iframe,
// so the text is never in the top-level document. Every frame is asked for its
// innerText and the longest answer wins — that's the document body rather than
// the surrounding chrome.

// Past this we'd be sending a whole book. Well inside the 1M context window;
// the point is to notice rather than to fit.
const MAX_CHARS = 400000;

// Below this there's nothing worth assessing — an unopened results list, or a
// viewer that draws to canvas — and we fall back to a screenshot.
const MIN_CHARS = 400;

const TEXT_JS = `(() => {
  const el = document.body || document.documentElement;
  if (!el) return null;
  return { text: (el.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim(),
           title: document.title || '' };
})()`;

async function frameText(frame) {
  try {
    const got = await frame.executeJavaScript(TEXT_JS);
    if (!got || !got.text) return null;
    return got;
  } catch {
    // Cross-origin frame that won't take eval, or it navigated mid-call.
    return null;
  }
}

// Is a contract actually on screen, and has it finished rendering?
//
// PandaDoc renders an opened document in an `app.pandadoc.com/e/` iframe — the
// same frame the dark-mode path special-cases above. Its presence is what
// separates "looking at a contract" from "looking at the search results list",
// which is all in the top-level document. That frame then spends a while on
// "Connecting…" behind a skeleton before the document appears, so the frame
// existing isn't enough: it has to have real text in it.
const DOC_FRAME = /\/\/[^/]*pandadoc\.com\/e\//i;

function isDocFrame(frame) {
  try {
    return DOC_FRAME.test(frame.url || '');
  } catch {
    return false; // frame went away mid-check
  }
}

// Deliberately lower than MIN_CHARS. This only decides whether the button is
// offered; a loaded document that happens to be text-light should still get one,
// and captureContract() falls back to a screenshot for it.
const READY_CHARS = 200;

// WHICH contract is on screen, as an identity that stays the same across a
// re-render and differs between documents. The document lives in an
// `app.pandadoc.com/e/<id>` iframe, so that id is the document itself — the
// outer window is hash-routed and its URL is as often the search you arrived
// from as the thing you clicked into. Only the id, so a query string or an extra
// path segment added per view doesn't read as a different contract.
function contractKey() {
  const wc = getContractView();
  if (!wc || wc.isDestroyed()) return null;

  let frames = [];
  try {
    frames = wc.mainFrame.framesInSubtree;
  } catch {
    return null;
  }

  const doc = frames.find(isDocFrame);
  if (!doc) return null;

  try {
    const found = /\/e\/([^/?#]+)/i.exec(doc.url || '');
    return found ? found[1] : null;
  } catch {
    return null; // frame went away mid-read
  }
}

async function contractStatus() {
  const wc = getContractView();
  if (!wc || wc.isDestroyed()) return { ready: false };

  let frames = [];
  try {
    frames = wc.mainFrame.framesInSubtree;
  } catch {
    return { ready: false };
  }

  const doc = frames.find(isDocFrame);
  if (!doc) return { ready: false };

  try {
    const len = await doc.executeJavaScript(
      '(((document.body && document.body.innerText) || "").trim()).length'
    );
    return { ready: typeof len === 'number' && len >= READY_CHARS };
  } catch {
    return { ready: false };
  }
}

// ---- the document outline ---------------------------------------------------
// The quick-jump list. Same `/e/` frame the text capture reads, since that's
// where the document — and the scroll position we want to move — actually is.
//
// PandaDoc doesn't promise real <h1> tags: a document built in its editor is
// often styled divs, so heading tags are tried first and a type-size pass backs
// them up. Only the top tier is kept either way, which is what "just the H1s"
// means in a document that never declared a level.
//
// Each heading is marked with a data attribute as it's found, so jumping is a
// lookup by mark rather than by index into a list the page may have re-rendered
// out from under us. The marks are cleared and rewritten on every open.
const HEADINGS_JS = `(() => {
  const MARK = 'data-pds-jump';
  document.querySelectorAll('[' + MARK + ']')
    .forEach((el) => el.removeAttribute(MARK));

  const seen = (el) => el.getClientRects().length > 0;
  const words = (el) => ((el.textContent || '').replace(/\\s+/g, ' ')).trim();
  const usable = (t) => t.length > 1 && t.length <= 120;

  let found = Array.from(
    document.querySelectorAll('h1, [role="heading"][aria-level="1"]')
  ).filter((el) => seen(el) && usable(words(el)));

  // Nothing declared a level — fall back to type size. Leaf elements only, so a
  // wrapper doesn't get counted as the heading it contains, and only the largest
  // tier survives, which is the document's own H1 equivalent.
  if (found.length < 2) {
    const base = parseFloat(getComputedStyle(document.body).fontSize) || 16;
    const sized = [];
    for (const el of document.body.querySelectorAll('h1,h2,h3,p,div,span,td')) {
      if (el.querySelector('*')) continue;
      const text = words(el);
      if (!usable(text) || !seen(el)) continue;
      const cs = getComputedStyle(el);
      const size = parseFloat(cs.fontSize) || 0;
      const weight = parseInt(cs.fontWeight, 10) || 400;
      if (size >= base * 1.6 || (size >= base * 1.25 && weight >= 600)) {
        sized.push({ el, size });
      }
    }
    if (sized.length) {
      const top = Math.max(...sized.map((s) => s.size));
      found = sized.filter((s) => s.size >= top - 0.5).map((s) => s.el);
    } else {
      found = [];
    }
  }

  const items = [];
  for (const el of found) {
    const text = words(el);
    // A heading repeated back-to-back is a wrapper and its own child, or a
    // sticky copy of the one above — either way it isn't a second destination.
    if (items.length && items[items.length - 1].text === text) continue;
    el.setAttribute(MARK, String(items.length));
    items.push({ id: items.length, text });
  }
  return items;
})()`;

// Fuzzy, because the same section is called different things in different
// contracts. Ordered strongest-first: the first pattern that matches anything
// wins, and among its matches the earliest heading in the document does — a
// contract that says "Payments" up top and "Payment Schedule" in an annex should
// pin the one you meant.
const PINNED = [
  {
    tag: 'scope',
    label: 'Scope',
    // "Out of Scope" is the opposite of what you asked for, and it's a real
    // heading in plenty of statements of work.
    patterns: [/\bscope\s+of\b/i, /\bscope\b/i],
    reject: /\b(out\s+of|outside|not\s+in|excluded\s+from)\s+scope\b/i,
  },
  {
    tag: 'payment',
    label: 'Payment Schedule',
    patterns: [
      /\bpayment\s+(schedule|terms|milestones)\b/i,
      /\bpayments?\b/i,
      /\bpricing\b/i,
      /\b(fees?|invoicing|invoices?)\b/i,
      /\binvest(ment)?\b/i,
      /\b(costs?|compensation)\b/i,
    ],
  },
];

function pinnedJumps(items) {
  const out = [];
  for (const want of PINNED) {
    const eligible = items.filter(
      (it) => !want.reject || !want.reject.test(it.text)
    );
    for (const pattern of want.patterns) {
      const hit = eligible.find((it) => pattern.test(it.text));
      if (hit) {
        out.push({ id: hit.id, text: hit.text, tag: want.tag });
        break;
      }
    }
  }
  return out;
}

// { items: [{ id, text }], pinned: [{ id, text, tag }] }
async function documentHeadings() {
  const wc = getContractView();
  if (!wc || wc.isDestroyed()) return { items: [], pinned: [] };

  let frames = [];
  try {
    frames = wc.mainFrame.framesInSubtree;
  } catch {
    return { items: [], pinned: [] };
  }

  const doc = frames.find(isDocFrame);
  if (!doc) return { items: [], pinned: [] };

  try {
    const items = await doc.executeJavaScript(HEADINGS_JS);
    if (!Array.isArray(items)) return { items: [], pinned: [] };
    return { items, pinned: pinnedJumps(items) };
  } catch {
    return { items: [], pinned: [] };
  }
}

// Scrolls the marked heading into view. `block: 'start'` rather than 'center'
// so the section reads from its title down, and scrollIntoView finds whichever
// element is actually scrolling — the document's own pane, not the window.
async function jumpTo(id) {
  const wc = getContractView();
  if (!wc || wc.isDestroyed()) return false;

  let frames = [];
  try {
    frames = wc.mainFrame.framesInSubtree;
  } catch {
    return false;
  }

  const doc = frames.find(isDocFrame);
  if (!doc) return false;

  const js = `(() => {
    const el = document.querySelector('[data-pds-jump="${Number(id)}"]');
    if (!el) return false;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // A beat of highlight, so you can see where you landed in a wall of text
    // that otherwise looks the same everywhere.
    const was = el.style.cssText;
    el.style.transition = 'box-shadow .18s';
    el.style.boxShadow = '0 0 0 3px rgba(56,189,248,.55)';
    el.style.borderRadius = '4px';
    setTimeout(() => { el.style.cssText = was; }, 1100);
    return true;
  })()`;

  try {
    return await doc.executeJavaScript(js);
  } catch {
    return false;
  }
}

// { kind: 'text' | 'image' | 'none', text?, image?, title, truncated }
async function captureContract() {
  const wc = getContractView();
  if (!wc || wc.isDestroyed()) return { kind: 'none' };

  let frames = [];
  try {
    frames = [wc.mainFrame, ...wc.mainFrame.framesInSubtree];
  } catch {
    return { kind: 'none' };
  }

  // Deduplicate: framesInSubtree includes the main frame on some versions.
  const seen = new Set();
  const unique = frames.filter((f) => {
    if (!f || seen.has(f)) return false;
    seen.add(f);
    return true;
  });

  const results = await Promise.all(unique.map(frameText));

  let best = null;
  for (const got of results) {
    if (got && (!best || got.text.length > best.text.length)) best = got;
  }

  let title = '';
  try {
    title = wc.getTitle() || (best && best.title) || '';
  } catch {
    title = (best && best.title) || '';
  }
  // PandaDoc suffixes its own name onto every title; the document name is the
  // useful half.
  title = title.replace(/\s*[|\-–]\s*PandaDoc\s*$/i, '').trim();

  if (best && best.text.length >= MIN_CHARS) {
    const truncated = best.text.length > MAX_CHARS;
    return {
      kind: 'text',
      text: truncated ? best.text.slice(0, MAX_CHARS) : best.text,
      title,
      truncated,
    };
  }

  // Not enough selectable text to assess — send what's on screen instead.
  // Only the visible area, which is why it's the fallback and not the default.
  try {
    const shot = await wc.capturePage();
    if (shot.isEmpty()) return { kind: 'none', title };
    return {
      kind: 'image',
      image: shot.toPNG().toString('base64'),
      title,
      truncated: false,
    };
  } catch {
    return { kind: 'none', title };
  }
}

// ---- the conversation ------------------------------------------------------
// One thread per contract. Follow-up questions keep the document and the
// previous answers in context; switching to a different document starts over,
// as does leaving it alone for ten minutes.
//
// The history lives in an Agent SDK session rather than in an array here, so a
// follow-up resumes by id and carries the document without re-sending it — the
// contract is the bulk of the prompt, and it used to go over on every turn.

const IDLE_MS = 10 * 60 * 1000;

let sessionId = null; // the Agent SDK session backing the current thread
let threadTitle = '';
let idleTimer = null;

function resetThread() {
  sessionId = null;
  threadTitle = '';
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function touchThread() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(resetThread, IDLE_MS);
}

function systemPrompt() {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    'You are reviewing a contract or proposal on behalf of Rooted Software, ' +
    'the vendor side of the agreement. The document the user is looking at is ' +
    'in the conversation.\n\n' +
    'Ground every claim in the document. Quote the clause you are relying on ' +
    'so the user can find it. If the document does not address something, say ' +
    'it is absent rather than inferring what it probably says — an absent ' +
    'indemnity cap is itself the finding. If the document you were given is a ' +
    'screenshot, you are seeing only the visible page; say so before drawing ' +
    'conclusions about terms that would live elsewhere in the document.\n\n' +
    'Lead with the answer. Keep it tight: no restating the question, no ' +
    'preamble, no summary of what you are about to do. Use short headings and ' +
    'bullets over paragraphs. Give the practical consequence, not just the ' +
    'clause.\n\n' +
    'The user may attach extra files to a question — a prior agreement, an ' +
    'amendment, a policy, a screenshot. Those are context, not the document ' +
    'under review: keep answering about the contract on screen, and when a fact ' +
    'comes from an attachment rather than the contract, say which.\n\n' +
    'You are not a lawyer and this is not legal advice; flag anything that ' +
    'genuinely needs counsel rather than hedging on everything.\n\n' +
    `Today is ${today}.`
  );
}

// Files attached to the question, as content blocks. Ported from Quick Claude's
// send-message handler: the renderer reads each file to base64 and tags it, and
// the kind decides the block type. Plain text is inlined rather than sent as a
// document block — the API's base64 document source is PDF, and a .txt is more
// useful to the model spelled out anyway.
const MAX_TEXT_CHARS = 200000;

function attachmentBlocks(list) {
  const blocks = [];

  for (const att of Array.isArray(list) ? list : []) {
    if (!att || !att.data) continue;

    if (att.kind === 'image') {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: att.media_type, data: att.data },
      });
      continue;
    }

    if (att.kind === 'document') {
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: att.data },
        // So the model can refer to it by name rather than "the attached PDF".
        ...(att.name ? { title: att.name } : {}),
      });
      continue;
    }

    if (att.kind === 'text') {
      let text = '';
      try {
        text = Buffer.from(att.data, 'base64').toString('utf8');
      } catch {
        continue; // not decodable as text after all
      }
      if (!text.trim()) continue;
      const cut = text.length > MAX_TEXT_CHARS;
      blocks.push({
        type: 'text',
        text:
          `Attached file — ${att.name || 'untitled'}:\n"""\n` +
          (cut ? text.slice(0, MAX_TEXT_CHARS) : text) +
          '\n"""' +
          (cut ? '\n[Attachment was truncated at this point.]' : ''),
      });
    }
  }

  if (blocks.length) {
    // Without this the model has no way to tell an attachment apart from the
    // contract itself, and will happily answer about the wrong document.
    blocks.unshift({
      type: 'text',
      text:
        'The following file(s) are attached to this question as extra context. ' +
        'They are NOT the document on screen — the contract above is. Use them ' +
        'to inform the answer, and say which one a fact came from when it ' +
        'matters.',
    });
  }

  return blocks;
}

// Builds the first user turn: the document, any attachments, then what to do.
function openingContent(contract, task, attached = []) {
  const blocks = [];

  if (contract.kind === 'image') {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: contract.image },
    });
    blocks.push({
      type: 'text',
      text:
        'Above is a screenshot of the document currently on screen' +
        (contract.title ? ` ("${contract.title}")` : '') +
        '. Its text could not be read directly, so this is the visible page only.',
    });
  } else if (contract.kind === 'text') {
    blocks.push({
      type: 'text',
      text:
        `Document${contract.title ? ` — ${contract.title}` : ''}:\n"""\n` +
        contract.text +
        '\n"""' +
        (contract.truncated
          ? '\n\n[This document was long enough to be cut off at this point. ' +
            'Say so if the answer depends on what came after.]'
          : ''),
    });
  }

  // Attachments sit between the contract and the task: after the document, and
  // before the instruction that refers to them.
  blocks.push(...attached);

  blocks.push({ type: 'text', text: task });
  return blocks;
}

// The Agent SDK is ESM-only. `require` of ESM works on the Node that Electron
// ships, but the dynamic import is there for the build where it doesn't.
let agentSdk = null;

async function loadAgentSdk() {
  if (agentSdk) return agentSdk;
  try {
    agentSdk = require('@anthropic-ai/claude-agent-sdk');
  } catch {
    agentSdk = await import('@anthropic-ai/claude-agent-sdk');
  }
  return agentSdk;
}

// The whole point of the Claude login is that assessments come out of the
// person's subscription. A key left in the environment would quietly send them
// to metered API billing instead, so it doesn't get passed down.
function subprocessEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

const LIMIT_NAMES = {
  five_hour: 'five-hour limit',
  seven_day: 'weekly limit',
  seven_day_opus: 'weekly Opus limit',
  seven_day_sonnet: 'weekly Sonnet limit',
};

// A subscription that's out of runway for now, as opposed to an account that
// can't pay at all — worth saying which, and when it comes back.
function limitMessage(info) {
  const which = LIMIT_NAMES[info.rateLimitType] || 'usage limit';
  const when = info.resetsAt
    ? new Date(info.resetsAt * 1000).toLocaleString('en-US', {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '';
  const who = lastAccountLabel ? `${lastAccountLabel}’s` : 'Your';

  if (info.errorCode === 'credits_required') {
    return (
      `${who} Claude plan is out of usage and has no credits to fall back on. ` +
      'Add credits or wait for the limit to reset.'
    );
  }
  return (
    `${who} Claude ${which} is used up, so this couldn’t run` +
    (when ? `. It resets ${when}.` : '.')
  );
}

// Streams an answer to `sender`, one 'ai:delta' per chunk, then resolves.
// `instruction` is set when an assessment button was used; `question` when
// something was typed. Both can be present.
async function ask(
  sender,
  { question = '', instruction = '', fresh = false, attachments = [] }
) {
  const auth = await authStatus();
  if (!auth.signedIn) return { error: 'no-login' };

  const task = [instruction, question && (instruction ? `Also: ${question}` : question)]
    .filter(Boolean)
    .join('\n\n');
  if (!task) return { error: 'empty' };

  let query;
  try {
    ({ query } = await loadAgentSdk());
  } catch {
    return { error: 'The Claude Agent SDK is missing from this build.' };
  }

  if (fresh) resetThread();

  const attached = attachmentBlocks(attachments);
  const resuming = !!sessionId;
  let notice = '';
  let content;

  if (!resuming) {
    const contract = await captureContract();
    if (contract.kind === 'none') {
      return {
        error:
          'Could not read the document. Open a contract in the PandaDoc window first.',
      };
    }
    threadTitle = contract.title || '';
    if (contract.kind === 'image') {
      notice = 'Read as a screenshot — only the visible page.';
    } else if (contract.truncated) {
      notice = 'Document was long; the tail was left off.';
    }
    content = openingContent(contract, task, attached);
  } else {
    // Resuming carries the document and the previous answers, so a follow-up is
    // only the new question.
    content = attached.length
      ? [...attached, { type: 'text', text: task }]
      : [{ type: 'text', text: task }];
  }

  touchThread();

  async function* turn() {
    yield {
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content },
    };
  }

  let streamed = false;
  let whole = '';
  let limit = null;
  let ranAs = null;
  let run = null;

  try {
    run = query({
      prompt: turn(),
      options: {
        model: 'claude-opus-5',
        effort: 'high',
        // Replaces Claude Code's own prompt outright: this is a contract
        // reviewer, and none of the coding-agent framing applies.
        systemPrompt: systemPrompt(),
        // No bash, no file access, nothing. The document arrives in the prompt
        // and attachments arrive as content blocks, so there is nothing for a
        // tool to do — and a contract reviewer has no business reading disks.
        tools: [],
        // Ignore any CLAUDE.md or settings.json lying around; the answer
        // shouldn't change based on which folder the app was launched from.
        settingSources: [],
        includePartialMessages: true,
        maxTurns: 1,
        cwd: app.getPath('userData'),
        env: subprocessEnv(),
        // Use the Claude Code the person actually signed in with. Left to
        // itself the SDK resolves its own native build, which on a machine
        // that has none means a ~290MB download at the worst possible moment —
        // the first time someone asks about a contract.
        ...(cliPath ? { pathToClaudeCodeExecutable: cliPath } : {}),
        ...(resuming ? { resume: sessionId } : {}),
      },
    });

    for await (const msg of run) {
      if (msg.session_id) ranAs = msg.session_id;

      if (msg.type === 'stream_event') {
        const delta = msg.event && msg.event.delta;
        if (delta && delta.type === 'text_delta' && delta.text) {
          streamed = true;
          if (!sender.isDestroyed()) sender.send('ai:delta', delta.text);
        }
        continue;
      }

      if (msg.type === 'assistant') {
        for (const block of (msg.message && msg.message.content) || []) {
          if (block.type === 'text') whole += block.text;
        }
        continue;
      }

      // Subscription limits arrive as their own event rather than an error, and
      // a warning-level one shouldn't derail an answer that's streaming fine.
      if (msg.type === 'rate_limit_event') {
        const info = msg.rate_limit_info || {};
        if (info.status === 'rejected') limit = info;
        continue;
      }

      // The result ends the turn. Stop reading here rather than waiting for the
      // iterator to close on its own — a resumed session holds it open, and the
      // panel would sit on a finished answer showing its spinner.
      if (msg.type === 'result') {
        if (msg.subtype !== 'success') {
          const why = ((msg.errors || []).join(' ') || '').trim();
          throw new Error(why || msg.subtype);
        }
        break;
      }
    }
  } catch (err) {
    const msg = (err && err.message) || String(err);

    // A rejected limit is the reason the turn died, not whatever the harness
    // reported on the way out.
    if (limit) return { error: limitMessage(limit) };

    if (/not logged in|unauthor|authentication|invalid.*credential/i.test(msg)) {
      return {
        error: 'no-login',
        notice: 'That sign-in was rejected or has expired. Sign in again.',
      };
    }
    // The thread is only kept when a turn actually landed, so a failure here
    // leaves the next question to start over with the document.
    return { error: msg };
  } finally {
    // Breaking out of the loop leaves the generator suspended. Closing it hands
    // back whatever the transport is still holding rather than waiting on the
    // main process to exit — which, being the app, it never does.
    try {
      if (run && run.return) await run.return(undefined);
    } catch {
      /* already finished, or nothing to unwind */
    }
  }

  // Deltas are the normal path; this is the build where partial messages didn't
  // arrive but the answer did, and the panel would otherwise show nothing.
  if (!streamed && whole && !sender.isDestroyed()) {
    sender.send('ai:delta', whole);
    streamed = true;
  }

  if (limit) return { error: limitMessage(limit) };
  if (!streamed) {
    return { error: 'Claude came back with nothing. Try asking again.' };
  }

  sessionId = ranAs || sessionId;
  touchThread();

  return { done: true, title: threadTitle, notice };
}

module.exports = {
  init,
  authStatus,
  signIn,
  signOut,
  loadAssessments,
  saveAssessments,
  contractStatus,
  contractKey,
  documentHeadings,
  jumpTo,
  captureContract,
  resetThread,
  ask,
};
