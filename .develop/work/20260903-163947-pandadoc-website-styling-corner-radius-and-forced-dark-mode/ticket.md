---
id: 20260903-163947-pandadoc-website-styling-corner-radius-and-forced-dark-mode
title: Pandadoc website styling — corner radius and forced dark mode
project: Pandadoc Search
lane: backlog
createdAt: 2026-09-03T16:39:47.590Z
---

## The ask

> take a look at the driven project
>
> 1. make the corners of the pandadoc website wrapper the same radius
> 2. force dark mode on the website (use something like how the lux or darkreader
>    browser plugins use or just install one of those)

Followed by, over eleven turns: the window became undraggable, the doc loaded
indefinitely (twice), and then — once working — *"just take a look at that safari
window behind it - the corners are more rounded - match"* and *"it's rounded but
not a perfect match"*.

## Where the session got to

Dark mode and the wrapper work landed and were pushed (`def531e` → `origin/main`,
`049bd2e..def531e`), and the version was bumped to **1.0.1** in `package.json`
(uncommitted, no tag). A full universal release build was verified locally —
`x86_64 arm64`, signed with the Developer ID, producing the dmg, zip and
`latest-mac.yml` — which retired the Electron 41 upgrade risk.

**It stopped short of publishing**, deliberately: notarization couldn't run
(`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` unset and no
`notarytool` keychain profile), so `spctl` reported `rejected / Unnotarized
Developer ID` and publishing would have put a Gatekeeper-blocked release on a
public page.

**Two things outstanding:**

1. the corner radius is *close but not a perfect match* to the Safari window — the
   last open item on the actual ask
2. notarization credentials (since resolved in the "PandaDoc contract search
   shortcut" work, which stored a `PandaDoc-Search` notarytool profile — so this
   half may now be moot)

_Carried over from the Claude session "Pandadoc website styling" (2026-07-29).
Whatever it left in the working tree stays as-is._
