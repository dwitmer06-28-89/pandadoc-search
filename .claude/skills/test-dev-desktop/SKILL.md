---
name: test-dev-desktop
description: Run PandaDoc Search from the working tree with live reload — no build, no signing, no install. Edit a file and the change is on screen in under a second. Use whenever a change needs looking at, which is nearly always. For a bundled check before shipping use test-prod-desktop (debug on) or test-release-desktop (debug off).
---

# Run the Dev lane (live reload)

```bash
npm run dev
```

That is `electron .` against this directory. **No build runs.** `win.loadFile()`
reads off disk, so the files here *are* the running app — and `dev-reload.js`
watches them and reloads. Edit, save, look.

This is the default lane. Reach for it unless you specifically need to know how
something behaves once bundled.

## What it costs you, per change

| You edited | What happens | How long |
|---|---|---|
| `index.html`, `ai.html`, `overlay.html`, `shell.html` | page reloads | instant |
| `assets/**` | page reloads | instant |
| `preload.js`, `ai-preload.js`, `overlay-preload.js`, `shell-preload.js` | page reloads (preloads re-execute) | instant |
| `main.js`, `assess.js`, `config.js` | app relaunches | ~1s |
| `package.json` deps | nothing — restart by hand | — |

Every script and style in this app is **inline in its `.html`** — there are no
external `src=` or `href=` files to miss — so a reload really is the whole
update.

A burst of saves coalesces into one reload, and a save that touched both an
`.html` and a main-process file relaunches rather than reloading; a reload there
would leave old main-process code running against a new page.

**The remote PandaDoc page is deliberately left alone.** The real site lives in a
`WebContentsView` and only `file://` contents are reloaded, so a reload does not
throw away the search you're in the middle of. If you *want* that view refreshed,
refresh it in the app.

Watch the terminal: every reload prints `[dev] reloading N local view(s)` and
every relaunch prints `[dev] main process changed — relaunching`. **If you don't
see a line, the change didn't land** — check that before wondering why the UI
looks unchanged.

## 1. Quit the installed copy first — this is not optional

```bash
pgrep -f "PandaDoc Search.app" >/dev/null && echo "RUNNING — quit it" || echo "clear"
```

If `~/Applications/PandaDoc Search.app` is running, `npm run dev` **exits
immediately and silently**, and it looks like the command did nothing.
`requestSingleInstanceLock()` is keyed to the userData directory, which the dev
lane and the installed app share, so the second copy to start loses. A second
launch is wired to just pop the existing app's search bar — which is exactly what
you'll see instead of a dev instance.

Tell the user to quit it from the tray rather than killing it, so it shuts down
cleanly.

## 2. Know that this lane shares the real app's data

Both copies use `~/Library/Application Support/pandadoc-search`.

The upside is real: your PandaDoc session, config, and recents carry straight
over, so there's no signing back in. The cost is the other side of the same
coin — **this lane can write to the data the installed app depends on**, config
and recents included.

For UI and behaviour work that's fine. Before anything that clears config,
rewrites recents, or migrates stored state, say so plainly and let the user
decide.

## 3. Report what to look at, not that it launched

The user can see that a window opened. What they can't see is which change is on
screen. State in one line what you edited and what should now be different, and
name the specific thing to check.

If a change genuinely needs bundled behaviour — anything touching
`app.isPackaged`, auto-updates, notarization, the tray in a signed build, or the
packaged file layout — say so and move to `test-prod-desktop`. This lane cannot
tell you about any of them: `app.isPackaged` is `false` here, which is precisely
why the reload works.

## What this lane never does

No build, no `dist/`, no signing, no notarizing, no version bump, no commit, no
push, no tag, no publish. Nothing that reaches a user. `test-release-desktop` is
the pre-ship check; the deploy skill is the thing that ships.
