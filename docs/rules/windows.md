<!-- Full text for the "Windows & stacking" section of PandaDoc Search's rules.
     .claude/RULES-INDEX.md carries the one-line index and points here.
     Rule numbers are stable — cite them by number. -->

# PandaDoc Search — Windows & stacking

1. **A panel that belongs to a window is that window's CHILD, never an always-on-top window
   of its own — let the OS stack it, and decide only whether it should be on screen.**
   The Claude panel (`aiWin` in `main.js`) was fixed twice on the same day for this. First
   (`b2fbadc`, 6 Aug 2026) it was an always-on-top window that stayed up over whatever app you
   switched to, so visibility was made to track "is one of our windows focused"; that made it
   vanish whenever you focused an app on another screen and still pinned it over apps dragged
   in front. The real fix (`b12e71f`, same afternoon) dropped `alwaysOnTop` and
   `setVisibleOnAllWorkspaces`, parented the panel to the PandaDoc window, and tracks only that
   window's visibility (`refreshAIVisibility`). Focus-based visibility is the trap: focus moves
   in two steps, and the panel's own focus blurs the window under it.
   Known exception: the search pill (`win`) is deliberately a free-floating, focus-dismissed
   window — it is summoned by a global hotkey over any app and belongs to no window.
   Reviewer grep: `grep -n "alwaysOnTop\|setVisibleOnAllWorkspaces\|isFocused()" main.js`

2. **Parent a window only to a window the person can currently see.** On macOS a child of a
   minimized or hidden window is minimized or hidden with it, so a window opened from the
   tray or Help menu while the PandaDoc window is hidden — the normal state of this app, which
   hides itself — opens invisibly. Fixed for the feedback window in `eaf895b` (4 Oct 2026,
   `feedback/main.js`, the shared desktop-feedback client); the same check applies to any new
   window given a `parent`.
   Reviewer grep: `grep -n "parent:\|setParentWindow" main.js feedback/main.js`
