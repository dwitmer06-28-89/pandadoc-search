---
id: 20260903-163950-cmd-k-opens-pandadoc-search-alongside-s
title: Cmd+K opens PandaDoc search alongside "s"
project: Pandadoc Search
lane: backlog
createdAt: 2026-09-03T16:39:50.773Z
---

## The ask

> we currently have "s" for searching pandadoc when inside of the app. Can you
> also support command K to do it as well?

## Where the session got to

**Done** — `main.js:1022`. Cmd+K opens the search bar over the PandaDoc window
alongside `s`, with two deliberate differences:

- **it fires immediately and is swallowed** (`preventDefault`) rather than going
  through the `unlessEditing` deferral — Cmd+K isn't a letter, so there is nothing
  to wait for
- **it works while a text field has the caret**, which is the point of a Cmd+K
  search shortcut

**The open question, left for you:** inside PandaDoc's editor, Cmd+K is normally
"insert link", and the app now takes that key. Say the word if you'd rather it
defer like `s` does and leave the editor's link shortcut alone.

Never verified in the dev shell — the pending step was to try it there,
especially from inside an opened document's iframe, before committing.

_Carried over from the Claude session "Command K search in PandaDoc" (2026-08-17).
Whatever it left in the working tree stays as-is._
