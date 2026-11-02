# PandaDoc Search — rule index

**This is the index the project's rules are read through.** It is pointed at by `CLAUDE.md`
rather than living inside it, because `CLAUDE.md` is auto-loaded into every agent on every
turn while most agents have no use for it. Three phases read this index: `/design` (which
determines conformance and quotes the binding rules into the ticket), `/implement` (scoped to
the areas it edits, to CHECK the ticket's quotes — never to re-decide them) and `/code-review`
(which catches the drift). See `ProjectGlobals/.claude/rules-protocol.md` for the full protocol.

## How these rules are stored

This file is an **index**. Each entry below states the rule in one line and points
at the file holding its full text and the fix history that earned it.

**Read the rule file for any area you are changing** — the one-liner is a reminder,
not the rule. The full text is where the reasoning, the failure it prevents, and the
reviewer grep live, and a change judged against the one-liner alone will miss them.

Rule numbers are stable and are cited by number. Editing a rule means editing its
file and, if the one-liner no longer matches, this index too.

## Windows & stacking

Full text: [`docs/rules/windows.md`](docs/rules/windows.md)

- **1** — A panel that belongs to a window is that window's CHILD, never an always-on-top window of its own — let the OS stack it, and decide only whether…
- **2** — Parent a window only to a window the person can currently see.

## Desktop lanes

Full text: [`docs/rules/lanes.md`](docs/rules/lanes.md)

- **3** — A bundled test lane (prod, release) gets its own `userData` directory — a different `appId` is not enough — and only the `shipped` lane auto-updates.

## Reviewing changes

The project half of the shared `/code-review`; every item binds like a step of the review.

- Tests: none — no test suite, no typecheck and no lint. `node --check` each edited `.js` file; behaviour is proved only by driving the app in the dev lane (`/validate desktop`). A regression test has nowhere to go yet; say so rather than inventing one.
- Highest-signal checks: rules 1–2 for any change that creates, parents, shows or hides a window; rule 3 for anything touching `lane.js`, `userData`, auto-update or `scripts/install-lane.sh`.
- Parallel sites: each IPC channel lives in `main.js`, its preload (`preload.js`, `overlay-preload.js`, `shell-preload.js`, `ai-preload.js`) and the inline script of its `.html`; a new runtime file also goes in `package.json` `build.files`; the dev-reload watch list in `dev-reload.js` follows new file types; `feedback/` changes go to `ProjectGlobals/shared-code/desktop-feedback/` and every app's copy.
- Platforms: macOS menu-bar app (tray, global hotkey, LSUIElement — no Dock icon) is the one driven here; Windows (NSIS, built by GitHub Actions on a `v*` tag) shares `main.js` and is never run on this Mac.
- Can't verify from here: Windows behaviour; notarization and auto-update (only a published shipped build, rule 3); the live PandaDoc site's markup, which the overlay and `assess.js` read.
- Global doc section: none yet.
- Extra passes: none.
