---
name: test-release-desktop
description: Build the PandaDoc Search RELEASE lane — a bundled, signed desktop build with debug OFF — from the current working tree and install it to ~/Applications/PandaDoc Search Release.app. Use to check how something behaves as shipped, to sanity-check before cutting a release, or to rule out a debug-only artifact. Leaves the shipped app and the Prod lane untouched. Never commits, pushes, tags, or publishes.
---

# Install the Release lane (bundled, debug OFF)

```bash
npm run test:release
```

That is `bash scripts/install-lane.sh release`. Identical to what ships in every
way except that it does not auto-update and it came from your working tree rather
than a published tag.

That is the point: it is the last thing to check before cutting a release, and the
way to tell a real bug from a debug-lane artifact.

## Why this lane exists — the dev and prod lanes both lie

Both have debug ON. `⌥⌘I` opens DevTools on the search pill and the Claude panel,
and — specifically in this app — the search pill's **blur handler is suppressed
while DevTools are open**, because otherwise the pill would dismiss itself the
moment you clicked into them.

That suppression is a real behavioural difference in the exact area this app is
most delicate: a frameless, transparent, always-on-top, dismiss-on-blur pill,
plus a child panel whose visibility is driven by focus events. A focus,
dismissal, or stacking bug can be invisible in dev and prod and obvious here.
Anything involving blur, focus, window chrome, or first paint deserves this lane
before you believe it.

## The four lanes

| | dev | prod | **release ← this one** | shipped |
|---|---|---|---|---|
| Bundled | no | yes | **yes** | yes |
| Debug (⌥⌘I DevTools) | on | on | **off** | off |
| Blur suppressed w/ DevTools | yes | yes | **no** | no |
| Auto-updates | no | no | **no** | yes |
| Where | `npm run dev` | `…​ Prod.app` | **`…​ Release.app`** | `…​/PandaDoc Search.app` |
| Installed by | — | `/test-prod-desktop` | **`/test-release-desktop`** | `npm run release` + the tag workflow |

**This is not the shipped app.** `~/Applications/PandaDoc Search.app` is what you
actually use and it auto-updates; installing an unreleased build there by hand is
both risky and pointless, since the next release silently replaces it. Release is
the debug-off build you can freely clobber.

## 1. It builds from the working tree — say what's in it

The script prints `git status --porcelain` first. Dirty work is included by design.
State in one line what is going into the build.

If this is a pre-ship check, that line matters more than usual: what you validate
here is only what will ship if it is also **committed and tagged**. Point out
anything uncommitted.

## 2. This lane has its own data

`~/Library/Application Support/pandadoc-search-release`. Starts empty — its own
`config.json`, its own `recents.json`, its own PandaDoc sign-in. That isolation is
deliberate; see `isolateLaneData()` in `lane.js` and the note in
`test-prod-desktop`.

It runs alongside the shipped app and the Prod lane; all three can be open at once.
They look identical, so name the lane in anything you report.

## 3. Two things this lane still does not prove

**Notarization.** By default the build is signed but not notarized — that saves
ten-plus minutes. So this lane answers "does it behave as shipped?" but not "will
Gatekeeper accept it?"

```bash
bash scripts/install-lane.sh release --notarize
```

Use that when notarization or Gatekeeper is the actual question. Otherwise say
plainly that notarization was skipped, so nobody reads this lane as a full
pre-flight.

**Windows.** The Windows installer is built by `.github/workflows/release.yml` on a
Windows runner, and nothing local can validate it. This lane is macOS only.

## 4. How this actually ships, when you get there

Not by pushing. `git push` publishes nothing:

```bash
npm version patch && git push --follow-tags
```

The `v*` tag is what triggers the workflow, and that workflow builds **Windows
only** — the macOS half is signed and published locally with `npm run release`,
because notarization needs the Developer ID cert in this Mac's keychain. Both
halves have to land on the same `v<version>` release.

## 5. Report what to look at

Name the change, name the thing to check, and name the lane. If something
reproduces in dev or prod but not here, that is a debug-lane artifact and worth
saying outright — it is the main reason this lane exists.

## What this lane never does

No version bump, no commit, no push, no tag, no publish, no auto-update. It cannot
reach a user.
