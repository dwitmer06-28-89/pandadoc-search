---
id: 20260903-163948-bloom-all-buttons-on-click
title: Bloom all buttons on click
project: Pandadoc Search
lane: backlog
createdAt: 2026-09-03T16:39:48.651Z
---

## The ask

> can you bloom all buttons on click?
> especially, but not limited to
>
> * back button
> * tabs

## Where the session got to

Interrupted before it produced any written answer — nothing to carry forward but
the ask.

One thing to settle first, because it is now a family-wide rule: **H7** pins the
press treatment by object type. A **row or surface SINKS** — `scale(0.97)`, ~140ms
hold, 220–240ms release. A **glass control BLOOMS** — `scale(1.045)`, 140ms down
on the overshoot curve `cubic-bezier(0.34, 1.56, 0.64, 1)`, 240ms back on the
house curve `cubic-bezier(0.32, 0.72, 0, 1)`, and the magnitude is size-dependent
(a wide control takes `1.012`, not `1.045`). So "bloom all buttons" needs sorting
into which of these each control actually is.

_Carried over from the Claude session "💲Button bloom on click" (2026-08-04).
Whatever it left in the working tree stays as-is._
