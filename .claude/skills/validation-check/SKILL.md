---
description: Work a work item's validation run-sheet by actually driving the built app — tick every check you can verify yourself, and leave the ones that genuinely need a person. Used by Develop's Validation lane after it has installed the build to each declared environment.
---

# /validation-check

Open the app that was just built, carry out each check on the run-sheet, and record what you
found. Tick what you verified. Leave what you could not.

## Who runs this

Develop's **Validation lane**, headlessly, straight after it has installed this work item's
build to every environment the project declares. Nobody is watching, and the same three
constraints apply as to `/regression-test`:

- **You cannot ask a question.** No stdin. A tool needing approval is auto-denied and comes back
  as an ordinary result.
- **How you end the turn decides what happens.** Finish cleanly and the lane checks the sheet,
  in this order:
  1. **Any check owned by `claude` still outstanding → the lane records a FAILURE** naming the
     first one, and the item stops. That is not a hand-off to anybody; it is the stage saying it
     did not do its job. There is no Approve button on it.
  2. Otherwise, any check owned by `you` still outstanding → it parks and asks the person for
     exactly those.
  3. Otherwise the item moves on by itself.

  Stopping blocked parks with your question instead, and is the better ending whenever you know
  why you could not finish.
- **The sheet is the record, not your prose.** A check you say you verified but do not tick is a
  check that did not happen, as far as anything downstream is concerned. Tick it.

  Read (1) above again, because it changed on 2026-08-30 and the old behaviour was the opposite:
  the lane used to look ONLY at the person's checks, so a run that ticked nothing at all counted
  as clean and carried the work item on toward Deploy. It no longer does. Finishing quietly over
  an untouched sheet is now the loudest possible outcome, which is the right way round.

## The one rule that matters most

**Never tick a check you did not actually carry out.** Not "this looks like it should work",
not "the code clearly does this", not "the unit test covers it". This lane exists precisely
because the other lanes already read the code and ran the tests — its entire contribution is
that somebody opened the thing and looked. A tick you did not earn deletes that contribution
and replaces it with a claim, and the item advances toward Deploy on the strength of it.

If you cannot carry a check out, say so against that check and leave it. Leaving it is a
completely acceptable outcome. Faking it is not.

---

## Implementation

### Step 1 — Read the sheet

The run-sheet is `steps.json` in the work item's folder — the path is in your prompt. Each
element is:

```json
{ "id": "…", "title": "…", "owner": "you" | "claude", "state": "queued",
  "lane": "validation", "env": "mac" | "iphone" | …, "updatedAt": "…" }
```

- `owner: "claude"` — **yours**, and on a sheet written since 2026-09-11 this is every check on
  it. A check that can be carried out by driving the app: a flow, a value that must persist, a
  control that must appear, a state that must survive a reload.
- `owner: "you"` — **the person's, and typed by them.** Nothing generates these any more; the
  run-sheet pass is told to omit what it cannot drive rather than file it to somebody else, so
  one of these is a note the operator added by hand on the board. Do NOT tick them, do not
  re-own them, and do not delete them. They do not block the stage either — the hand-back
  reports them and the operator decides.

Older work items still carry generated `owner: "you"` checks and are read exactly the same way.

Read only the elements whose `lane` is `validation`. Leave every other element in the file
exactly as it is — the file is shared, and rewriting it whole is how another lane's steps
disappear.

### Step 2 — Get the app in front of you

**If your prompt says "YOU CAN SEE THE APP", a window is already open and that is how you drive
it.** The lane started it on this work item's own worktree before spawning you, and gave you the
exact drive command to run. Use it verbatim. Do not go looking for browser or
simulator tools first — **you do not have any, and you cannot be given them**: a lane run is
spawned headlessly with an explicit `--allowedTools`, and the Browser pane is bound to the
session that owns it rather than being a session-connected MCP server, so `mcp__Claude_Browser__*`
never reaches you. `ToolSearch` will come back empty and that result means nothing is wrong.

Set the viewport for an environment **before** its checks (`size 402x874`). That is what selects
the platform — the app decides mobile-vs-desktop on window width alone — so a phone check run at
desktop width silently verifies the wrong component tree. The command prints back the width the
app now reports; then **confirm the tree actually switched by reading the page** (the phone tree
has no desktop left-nav), rather than assuming the resize took.

Taps are real mouse events, so React handlers fire. A synthetic `el.click()` in `eval` often does
nothing on exactly the controls worth testing, and reports success while doing it.

**What the window cannot show you**, so you never tick these against it: anything drawn by the
native iOS shell — Liquid Glass capsules, the native tab bar, system menus — renders its *web
fallback* here, and touch, haptics and safe-area insets do not exist at all. Those checks belong
to the operator **unless your prompt also offers the simulator** — see the next paragraph, which
is the one thing that changes that.

**If your prompt says YOU CAN DRIVE THE iOS SIMULATOR**, those native checks are yours after all,
because the real shell is actually running. It is a different surface from the window, not a
better one, and **you work from screenshots rather than from selectors**:

- `shot` is the **whole device**, native chrome included. It is the only view in this pipeline
  that can show a native overlay at all, so it is what a check about one is judged on.
- `tap <x,y>` is a **real touch in device points**, so it reaches the native shell AND the web
  contents. It is the only thing that can press a Liquid Glass capsule or the native tab bar.

So the loop is: `shot` → find the control in the picture → `tap` its coordinates → `shot` again to
see what happened. Do not go looking for a way to query the DOM. Two separate reasons, either of
which alone would settle it: a native control is invisible to the web layer entirely (it cannot be
found, and it will not be reported as covering anything either), and on a simulator the web
inspector cannot be reached at all right now, so `text`/`eval`/`tapel` fail outright. `doctor`
will tell you rather than making you find out mid-check. Anything that genuinely needs the DOM
belongs on the window drive instead.

Still not yours, even here, and D2 is explicit about it: haptics, real push, the camera, Face ID
and true performance. The simulator cannot show them, so leave them and say why — an honest
`unverifiable` is worth more than a soft pass, because the manual list then keeps asking for it.

**If the prompt offers no simulator drive but the thread says this work item's build was installed
on a simulator — or you installed it there yourself from this worktree during this run — drive
it with `idb`.** A simulator you merely find booted is not that: it may be carrying `main` or
another worktree's build, and every check it passes would be a false pass. If you cannot tie the
installed shell to this worktree, the native checks are the operator's. It is the same surface and the same loop as above — `shot` → find the
control → `tap` → `shot` — and it talks to the **device** through its own companion, never the
Mac's cursor or focus, so it is not screen control. It lives under `~/.local/bin`:

```bash
export PATH="$HOME/.local/bin:$PATH"
idb list-targets                                             # the UDID the build went onto, Booted
xcrun simctl io "$UDID" screenshot "<evidence dir>/<check>.png"   # shot — then Read the file
idb ui tap --udid "$UDID" <x> <y>                            # device points, origin top-left
idb ui swipe --udid "$UDID" <x1> <y1> <x2> <y2> --duration 0.3
idb ui text --udid "$UDID" "<text>"
idb ui describe-all --udid "$UDID"                           # accessibility tree, with frames
```

`describe-all` gives exact frames for labelled controls — prefer them to coordinates estimated
from a picture. Everything the previous paragraphs say the simulator cannot show still holds.

If your prompt does **not** offer a window, this project declared nothing drivable or the window
failed to open; the thread says which. If it offered no simulator and `idb` has no booted device
to drive (or is not installed), either none was declared or this Mac is missing the tools — the
thread names them and the remedy. Either way every affected check is the operator's: hand them
over per step 4 rather than inventing a way to see the app.

- Anything else (a CLI, a library): run it however its own docs say and observe its actual output.

If you cannot get the app running at all, that is a step-2 failure and it is not a subtle one:
stop blocked, say what you tried and what happened, and tick nothing. A validation pass over an
app that never started is the worst possible outcome, because everything simply stays queued and
looks like a pass that ran out of time.

**Do not rebuild, deploy, or start a second dev server.** For environments you drive, the
window already serves this work item's own tree — it IS the thing under test. For any
environment the lane installed to instead, the build is already on it, and building again would
validate something other than what was installed.

### Step 3 — Carry out each `claude` check

One at a time. For each:

1. Do the actions the title describes, literally.
2. Observe the result. Read the actual page, screen or output — not the code that should have
   produced it.
3. **Screenshot what you observed — pass and fail alike — before you write the tick.** Your
   prompt dictates the exact place: a directory named for this run, one subdirectory per
   environment, one `<stepId>.png` per check, written with the drive command's `shot`. The
   directories normally already exist; `mkdir -p` if one does not. This is the evidence the
   person at the gate reviews instead of re-validating by hand, and the failing shots matter
   most. A check without its screenshot is a claim.
4. Decide: does the stated outcome hold?

Then record it by rewriting that element in `steps.json`:

- **It holds** → `"state": "done"`, and update `updatedAt` to now (ISO8601).
- **It does not hold** → leave `"state": "queued"`. Do not invent a "failed" state; the sheet has
  none, and a check that did not pass is a check still outstanding.

**Skip any check already marked `"state": "waived"`, and do not report it.** A waiver is written
only when the operator moved the work item forward past this stage by hand, which is their answer
to that check — it is closed, and it is not yours to re-open. Do not drive it, do not tick it, do
not list it as outstanding, and do not ask about it. It is the one state on this sheet that is
neither passed nor owed, and treating it as owed is how a later stage comes to park asking for
work its owner has already decided against.

Write the file back with every other element preserved byte-for-byte.

**Do not fix anything.** If a check fails, that is the finding. Editing code here would mean the
build you validated is no longer the build that was installed, and the tree that gets reviewed is
not the tree that was tested.

### Step 4 — End the turn

**Every `claude` check passed** — finish cleanly, with a short report:

- what you drove, and how (which environment, which tool)
- each check, and that it passed
- any `you`-owned check still outstanding, named. A `waived` check is NOT outstanding and does
  not go in this list.
- anything you noticed that is not on the sheet but should be. A real observation here is worth
  more than the checks, because the sheet was written before anyone looked at the thing.

A clean finish here does NOT advance the work item. Validation is where the pipeline stops for
the operator (`docs/autonomy-contract.md`, 2026-09-11): the lane hands back your screenshots and
he approves them, so finishing cleanly is you saying "here is what I saw", not "this is done".
Write the report for someone who is about to look at the pictures rather than at the code.

**A check did not hold** — stop blocked, and lead with what broke, because that line is what
reaches a phone:

> Validation found 2 problems on iPhone: the notes field does not keep an edit after backing out,
> and the flag chip draws under the header.

Then, per failure: the check's title, what you did, what you expected, what you actually saw, and
the screenshot you took of it (you always take one — step 3).

**You could not drive it** — stop blocked and say so plainly, as step 2 says. Do not report
partial success over checks you never reached.
