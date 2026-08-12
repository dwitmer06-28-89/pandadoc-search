// The AI side: the Claude connection, the assessment library, and reading the
// contract that's currently on screen.
//
// Kept out of main.js because none of it touches windows — main.js owns the
// views and hands this module a getter for whichever WebContents is showing
// PandaDoc right now.

const path = require('path');
const fs = require('fs');

let app = null;
let safeStorage = null;
let getContractView = () => null; // set by init(); returns a WebContents or null

function init(deps) {
  app = deps.app;
  safeStorage = deps.safeStorage;
  getContractView = deps.getContractView;
}

// ---- the API key -----------------------------------------------------------
// Encrypted with the OS keychain via safeStorage, so it isn't sitting in
// config.json next to settings people are meant to open and edit by hand.

function keyFile() {
  return path.join(app.getPath('userData'), 'claude-key.enc');
}

function saveKey(plain) {
  const key = (plain || '').trim();

  if (!key) {
    try {
      fs.unlinkSync(keyFile());
    } catch {
      /* already gone */
    }
    return;
  }

  try {
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(keyFile(), safeStorage.encryptString(key));
    } else {
      // No OS-level encryption (a Linux session with no keyring, usually).
      // Storing it readable is worse than storing it encrypted, so the file is
      // owner-only at least.
      fs.writeFileSync(keyFile(), key, { encoding: 'utf8', mode: 0o600 });
    }
  } catch {
    /* the key still works for this run; it just won't survive a restart */
  }
}

function loadKey() {
  try {
    const raw = fs.readFileSync(keyFile());
    if (!safeStorage.isEncryptionAvailable()) return raw.toString('utf8');
    return safeStorage.decryptString(raw);
  } catch {
    return null;
  }
}

function hasKey() {
  return !!loadKey();
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

const IDLE_MS = 10 * 60 * 1000;

let conversation = [];
let threadTitle = '';
let idleTimer = null;

function resetThread() {
  conversation = [];
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
      // The document is the same bytes on every follow-up question, and it's
      // the bulk of the prompt — worth caching so a conversation about one
      // contract doesn't re-bill it each turn.
      cache_control: { type: 'ephemeral' },
    });
  }

  // Attachments sit between the contract and the task: after the cached prefix,
  // and before the instruction that refers to them.
  blocks.push(...attached);

  blocks.push({ type: 'text', text: task });
  return blocks;
}

// Streams an answer to `sender`, one 'ai:delta' per chunk, then resolves.
// `instruction` is set when an assessment button was used; `question` when
// something was typed. Both can be present.
async function ask(
  sender,
  { question = '', instruction = '', fresh = false, attachments = [] }
) {
  const apiKey = loadKey();
  if (!apiKey) return { error: 'no-key' };

  const task = [instruction, question && (instruction ? `Also: ${question}` : question)]
    .filter(Boolean)
    .join('\n\n');
  if (!task) return { error: 'empty' };

  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch {
    return { error: 'The Claude SDK is missing from this build.' };
  }

  let notice = '';
  const attached = attachmentBlocks(attachments);

  if (fresh) resetThread();

  if (!conversation.length) {
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
    conversation.push({
      role: 'user',
      content: openingContent(contract, task, attached),
    });
  } else if (attached.length) {
    conversation.push({
      role: 'user',
      content: [...attached, { type: 'text', text: task }],
    });
  } else {
    conversation.push({ role: 'user', content: task });
  }

  touchThread();

  const client = new Anthropic({ apiKey });

  try {
    const stream = client.messages.stream({
      model: 'claude-opus-5',
      max_tokens: 32000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: systemPrompt(),
      messages: conversation,
    });

    stream.on('text', (delta) => {
      if (!sender.isDestroyed()) sender.send('ai:delta', delta);
    });

    const final = await stream.finalMessage();
    conversation.push({ role: 'assistant', content: final.content });
    touchThread();

    if (final.stop_reason === 'refusal') {
      return {
        error:
          'Claude declined to answer this one. Rephrasing usually clears it.',
      };
    }

    return { done: true, title: threadTitle, notice };
  } catch (err) {
    // A failed turn shouldn't poison the thread with an unanswered question.
    conversation.pop();
    const msg = (err && err.message) || String(err);
    if (err && err.status === 401) {
      return { error: 'That API key was rejected. Re-enter it to try again.' };
    }
    if (err && err.status === 429) {
      return { error: 'Rate limited by the API. Wait a moment and try again.' };
    }
    return { error: msg };
  }
}

module.exports = {
  init,
  hasKey,
  saveKey,
  loadAssessments,
  saveAssessments,
  contractStatus,
  contractKey,
  captureContract,
  resetThread,
  ask,
};
