# PandaDoc Search engineering rules

A macOS (and Windows) menu-bar Electron app: a global hotkey (`Control+Shift+P`, set in
`config.js`) pops a search pill, and results open in an in-app PandaDoc window with a floating
overlay and a Claude panel that assesses the contract on screen (`assess.js`, the Claude Agent
SDK). Plain Electron — **no bundler, no framework, no dev server, no port**: every page is an
`.html` file with its scripts and styles inline, loaded by `loadFile()`, and `main.js` is the
whole main process. `npm run dev` (`electron .`) is the dev lane; `dev-reload.js` reloads pages
and relaunches on a main-process change. Lanes are dev / prod / release / shipped (`lane.js`).

## Frozen facts

- **A new runtime file must be added to `build.files` in `package.json`.** There is no bundler
  to follow imports: a file missing from that list works in the dev lane and is absent from
  every bundled build.
- **`feedback/` is a byte-identical copy of `ProjectGlobals/shared-code/desktop-feedback/`.**
  Edit the canonical copy and re-copy it into every app; never edit it here.
- **The dev lane shares the shipped app's data and single-instance lock**
  (`~/Library/Application Support/pandadoc-search`); prod and release have their own.

## The rules are an INDEX, and it is NOT in this file

This project's engineering rules live in two places, and neither of them is here:

- **`.claude/RULES-INDEX.md`** — one line per rule, grouped into sections, each section
  pointing at its full text. **Read it before judging any change against the rules.**
- **`docs/rules/*.md`** — the full text of each rule: the reasoning, the failure it
  exists to prevent, the fix history that earned it, and its `Reviewer grep:` line.

The index was moved out of this file on 2026-08-21. This file is **auto-loaded into every
agent on every turn**, the index was 50-64% of it, and most of the agents paying that cost
have no use for it — the quality gate, the app drive and the validation-steps agent never touch
a rule (`ProjectGlobals/.claude/rules-protocol.md` §3). Three phases read the index, and each
names it by path: **`/design` step 1**, **`/implement` step 2** — scoped to the areas it edits,
to CHECK the ticket's quoted rules, never to re-decide them — and **`/code-review` step 1**.

**Judging a change against the rules without opening `.claude/RULES-INDEX.md` is a fault,
not a shortcut.** A pointed-at index can be skipped in a way an auto-loaded one cannot; that
is the one real cost of this split, and it is why both readers name the file rather than
saying "check the rules".

## Communication & how to present fixes

- **Explain every problem and every fix in TLDR-for-dummies form first** — plain language, no
  jargon, the gist in a sentence or two — before any technical detail.
- **Pick the approach yourself — don't ask which to use.** For animation/motion, choose the
  most Apple-native-feeling option; for everything else, the most conventional/idiomatic web
  option. Say in one line which you chose; surface the alternative only when the tradeoff is
  genuinely decision-worthy.
- **Describe a visual change relative to the running app**, not to a mockup.
- **Before reporting a request done, check that the instance the user would test it in is
  actually healthy — and fix it if it isn't.** "Done" means done *and testable*. A hung or
  orphaned half is the normal failure: the supervising process dies and leaves a dev server or
  a shell behind, so the window is still on screen serving nothing. Restart it yourself and say
  what you found. Kill only this project's processes — another app's dev server may be running
  on this Mac.
- **Say "ready to test" only once the lane the user will actually look at is serving the
  change — and say WHICH lane.** A stale install or a dead dev server means the user tests old
  code, and nothing on screen says so.

- **"Liquid glass" ALWAYS means the native UIKit material, and a CSS imitation of it is a
  REJECTED solution — never offer it as an option, never ship it as an interim step, and never
  hand it back as done.** A popover that morphs out of a control is the system's own menu or a
  native panel drawn by a plugin; the `backdrop-filter` version has been proposed and rejected
  every single time it has been proposed. The one legitimate CSS arm is a fallback for a
  platform that cannot draw the material, and it says so at its own call site. **H14** carries
  the argument, including the two "native isn't reachable here" claims that were both false.

## Committing

- `/commit` stages at **file granularity** (`git add -- <file>`) and commits only files edited
  this session. When a session-edited file also carries unrelated pre-existing hunks, commit the
  whole file — that's intended, don't ask which hunks. **Never `git add -A` / `git add .`** —
  that sweeps every unreviewed file in the tree into the commit.
- **A commit that imports a new module must include that module.** A brand-new file is
  untracked, so it is silently left behind and `main` stops building while the working tree it
  came from still works — no error locally, and the author is the one person who can't
  reproduce it. After staging, confirm every import in the staged files resolves inside the
  commit.
- **`git push` of a branch needs no permission** — nothing builds or deploys from a branch push.
  **A pushed `v*` tag is a deploy act**: `.github/workflows/` builds the Windows installer on it
  and uploads it to the GitHub Release. The gated act is `/deploy-desktop` (`npm run release`,
  which signs, notarizes and publishes to the public update feed); never push a `v*` tag outside it.

## High-blast-radius files

| File | Why | Rules |
|---|---|---|
| `main.js` | The whole main process: every window, the hotkey, the tray, auto-update and every IPC handler. A window-stacking change here is how the Claude panel broke twice. | 1, 2, 3 |
| `preload.js` / `overlay-preload.js` / `shell-preload.js` / `ai-preload.js` + their `.html` + `main.js` | Joined by IPC channel *strings*, not imports. A channel renamed in fewer than all three places fails silently at runtime. | — |
| `lane.js` + `scripts/install-lane.sh` | Decide which lane a build is, its data directory and whether it auto-updates. Wrong here and a test build reads the real app's data or updates itself away. | 3 |
| `package.json` `build` | `build.files` is the bundle's whole file list, and `publish` is the public update feed. A missing file ships a broken app; a dmg without the zip freezes every install. | — |
| `claude-config.js` + `assess.js` | This app's own Claude sign-in folder, linked into `~/.claude`. Writing inside `~/.claude` loses the person's own setup. | — |
| `feedback/` | Shared byte-identical with four other apps; a local edit is drift. | 2 |

## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes_tool` or `query_graph_tool` instead of Grep
- **Understanding impact**: `get_impact_radius_tool` instead of manually tracing imports
- **Code review**: `detect_changes_tool` + `get_review_context_tool` instead of reading entire files
- **Finding relationships**: `query_graph_tool` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview_tool` + `list_communities_tool`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
| ------ | ---------- |
| `detect_changes_tool` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context_tool` | Need source snippets for review — token-efficient |
| `get_impact_radius_tool` | Understanding blast radius of a change |
| `get_affected_flows_tool` | Finding which execution paths are impacted |
| `query_graph_tool` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes_tool` | Finding functions/classes by name or keyword |
| `get_architecture_overview_tool` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes_tool` for code review.
3. Use `get_affected_flows_tool` to understand impact.
4. Use `query_graph_tool` pattern="tests_for" to check coverage.
