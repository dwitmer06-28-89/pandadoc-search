---
name: test-prod-desktop
description: Build the PandaDoc Search PROD lane — a bundled, signed desktop build with debug ON — from the current working tree and install it to ~/Applications/PandaDoc Search Prod.app. Use when a change needs checking in a real bundled app rather than the dev shell, or when something works in dev and not once packaged. Leaves the shipped app and the Release lane untouched. Never commits, pushes, tags, or publishes.
---

# Install the Prod lane (bundled, debug ON)

```bash
npm run test:prod
```

That is `bash scripts/install-lane.sh prod`. It builds from the working tree,
signs, installs to `~/Applications/PandaDoc Search Prod.app`, and reads the lane
back out of the bundle to prove the flag was honoured.

**Reach for `test-dev-desktop` first.** It is instant and it is right for almost
everything. This lane exists for the questions dev genuinely cannot answer.

## What only this lane can tell you

`app.isPackaged` is `false` in dev and `true` here. Anything downstream of that
behaves differently, and dev will lie to you about all of it:

- the packaged file layout — everything runs from inside `app.asar`, so a path
  that worked in dev can be missing here, and `build.files` in `package.json`
  decides what got included at all. This app's `files` list is **explicit**, so a
  newly added file is missing from the bundle until it is added there
- the bundled `darkreader` copy, and `asarUnpack` for the agent SDK
- signing and entitlements, and anything the OS gates on them
- the tray and `LSUIElement` in a signed app
- Chrome launching, since `execFile` paths behave differently from a bundle
- first-launch behaviour against an empty data directory

## The four lanes

| | dev | **prod ← this one** | release | shipped |
|---|---|---|---|---|
| Bundled | no | **yes** | yes | yes |
| Debug (⌥⌘I DevTools) | on | **on** | off | off |
| Auto-updates | no | **no** | no | **yes** |
| Where | `npm run dev` | `~/Applications/PandaDoc Search Prod.app` | `…​ Release.app` | `…​/PandaDoc Search.app` |
| Installed by | — | **`/test-prod-desktop`** | `/test-release-desktop` | `npm run release` + the tag workflow |

`lane.js` is the whole mechanism. `scripts/install-lane.sh` stamps `lane` into the
bundle's metadata; `lane.js` reads it back and decides `DEBUG` and `AUTO_UPDATE`.

**Auto-update is off here on purpose.** It is gated on the lane, not on
`app.isPackaged` — a packaged test lane gated the old way would download the
published release straight over the build you were trying to test. The tray's
"Check for Updates…" says so explicitly in a test lane.

## 1. It builds from the working tree — say what's in it

The script prints `git status --porcelain` before building and includes dirty work
deliberately; that is the point of a test lane, so don't ask to commit first. Just
state in one line what uncommitted work is going into the build.

## 2. This lane has its own data — and that is what makes it safe

`~/Library/Application Support/pandadoc-search-prod`, separate from the shipped
app's `pandadoc-search`.

So it starts empty: **its own `config.json`, its own `recents.json`, and its own
PandaDoc session to sign into once.** That is not a bug to fix — it is what keeps
a destructive test away from your real config and recents. Say so rather than
debugging it.

The isolation is done in code (`isolateLaneData()` in `lane.js`), not by the build
flags. Worth knowing why: a distinct `appId` alone does **not** isolate data.
Electron derives userData from the app *name*, so a lane built with
`appId=…​.prod` still landed in the shipped app's directory and read and wrote the
real `config.json` and `recents.json`. `app.setPath('userData', …)` before the
single-instance lock is what actually separates them.

If a `chromePath` or other config setting is needed for the test, set it in this
lane's own `config.json` — editing the real one to make a test pass changes the
app you use every day.

## 3. It runs at the same time as your shipped app

Because userData is separate, so is the single-instance lock. The shipped app,
this lane, and the Release lane can all be open at once — which is exactly how you
compare behaviour. Without that, a second launch just pops the first app's search
bar.

They look identical on screen. Two ways to tell them apart: the app name in
Activity Monitor, and the `[lane] prod (debug on, auto-update off)` line logged at
startup when launched from a terminal.

Note the dev lane is the one exception — it shares the shipped app's identity, so
it cannot run alongside it. See `test-dev-desktop`.

## 4. Notarization is skipped unless you ask

`--notarize` enables it. Without it the build is signed but not notarized, which
runs fine on this Mac and saves ten-plus minutes on a build you are about to throw
away. Use `--notarize` only when specifically checking notarization or Gatekeeper.

## 5. Report what to look at

Say which change is in the build and name the specific thing to check. If it
behaves here but not in dev, that difference *is* the finding — say which lane
each result came from.

## What this lane never does

No version bump, no commit, no push, no tag, no publish, no auto-update. It cannot
reach a user.
