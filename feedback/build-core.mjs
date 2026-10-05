// Generates `feedback-core.browser.js` from the canonical `../feedback-core.ts`.
//
// The desktop apps without sign-in are plain JavaScript with no bundler, so the
// feedback window cannot import TypeScript. This strips the core's types (Node's
// own stripper, no dependencies) and wraps what is left as one classic script that
// sets `window.FeedbackCore`. Nothing is rewritten by hand: the browser build IS
// the core, so a report built here is byte-for-byte the row the core builds.
//
//   node build-core.mjs           regenerate after any edit to feedback-core.ts
//   node build-core.mjs --check   exit 1 if the generated file is stale
//
// Regenerating is part of every core edit, like re-copying it into the apps; the
// five desktop apps then re-copy this folder (see FEEDBACK.md).
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, '..', 'feedback-core.ts');
const target = path.join(here, 'feedback-core.browser.js');

function build() {
  const ts = readFileSync(source, 'utf8');
  const names = [];
  const js = stripTypeScriptTypes(ts, { mode: 'strip' })
    .replace(/^export (async function|function|const) ([A-Za-z_$][\w$]*)/gm, (_m, kind, name) => {
      names.push(name);
      return `${kind} ${name}`;
    })
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
  if (/^\s*(export|import)\b/m.test(js)) throw new Error('feedback-core.ts has an export or import this build does not handle');
  return [
    '// GENERATED from ProjectGlobals/shared-code/feedback-core.ts by build-core.mjs — DO NOT EDIT.',
    '// Edit the core, then run `node build-core.mjs` and re-copy this folder into the desktop apps.',
    '(function () {',
    "'use strict';",
    js.trim(),
    '',
    `window.FeedbackCore = Object.freeze({ ${names.join(', ')} });`,
    '})();',
    '',
  ].join('\n');
}

const out = build();
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    /* missing reads as stale */
  }
  if (current !== out) {
    console.error('feedback-core.browser.js is stale — run `node build-core.mjs`.');
    process.exit(1);
  }
  console.log('feedback-core.browser.js is current.');
} else {
  writeFileSync(target, out);
  console.log(`wrote ${path.relative(process.cwd(), target) || target}`);
}
