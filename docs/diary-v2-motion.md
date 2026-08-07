# Diary — motion (Phase D1)

Diary is chronological, not a physical book. **No page curl, no flip.** The
Book's 0.26s translateX belongs to an object you hold; a diary is a sequence you
move through, and the motion says so with a small directional shift.

Tokens, from the locked set: 90ms press, 140ms hover, 200ms content
replacement, 260ms structural, 320ms only for a genuine mode change.

| Moment | What moves | Duration |
|---|---|---|
| Date change | the sheet shifts 3% and fades out, the next arrives from the opposite side | 200ms `--e-inout` out, `--e-out` in |
| Entry creation | nothing moves; the footer hint clears and Archive appears in place | none |
| History to entry | the shell is untouched; only `main-scroll` is replaced | 200ms |
| Search result | the day opens, then the editor pulses once | 1.4s ease-out, one shot |
| Save status | text changes inside a fixed 96px box | none |

3%, not 14%. The Book slides a whole page out of view because a page is a thing
that leaves. A diary day is being replaced in the same frame, and a large
translation reads as the layout breaking rather than as time passing.

**The frame never moves.** The date navigation, the header and the page chrome
stay exactly where they are through a date change; only the sheet animates. That
is what makes it possible to press Previous four times quickly without losing
the button.

**No blank flash.** The outgoing sheet finishes its animation before the
incoming one is drawn — `afterAnimation` waits on `animationend` with a timeout
that always fires, because the event does not arrive if the element is removed
or the tab is backgrounded, and a half-faded sheet that never completes is worse
than no animation at all.

**Reduced motion**: `reducedMotion()` is checked before any class is added, so
the sheet is replaced instantly. Opacity feedback and every function remain.

---

# D2.2 — what the audit found

## The transition had not been running

`goToDate` added `leave-next` to `.dia-sheet` — an element that stopped existing
when D2 made Diary a spread. The selector matched nothing, so the directional
date transition had silently not run since D2 shipped. It now targets
`.dia-book`, via `leaveSpread`.

## Two animations were allowed to own a final state

**The leave.** `.dia-book.leave-next` is `animation-fill-mode: forwards`, which
holds the element translated aside and transparent. Correct while the next day
is on its way; catastrophic if it never arrives — a `renderEntry` that returns
early on a stale navigation would leave the day permanently invisible. The class
now comes off in a `finally`.

**The entrance.** `diaEnterPrev` starts at `opacity: 0` with fill-mode `none`,
so it *looks* safe: the element returns to its computed style the moment the
animation finishes. An animation that never finishes never returns anything.
Measured in a browser with a throttled timeline, a **200ms entrance was still
`running` at six seconds with the whole spread at opacity 0** — the day was
there, laid out correctly, and invisible. `enterOnce()` now takes the class off
on a timer.

Both are instances of one rule, now written down in
`docs/animation-house-rules.md`:

> **Animations illustrate state changes; DOM and CSS own the final state.**

## The height animates nothing at all

The strongest form of the rule is not needing it. The spread's height is
`max(base, left, right)`, resolved entirely by CSS grid — see
`diary-v2-responsive.md`. Growth and shrink are the grid re-solving: instant,
correct under any throttling, and leaving no stale value behind because there
was never a value to leave.

## The right page's motion

Restrained, and none of it load-bearing:

- the energy meter's segments transition their fill colour, and lift 12% while
  the group has focus
- the battery's cells transition their fill
- a Moment tile's input fades in with the existing `diaOpen` keyframe
- the feeling tint transitions on the group's background

All are covered by the global reduced-motion rules — `prefers-reduced-motion`
and `html[data-motion="reduced"]`. Because no animation owns a final state,
reducing every duration to 1ms cannot break a layout. Verified: with reduced
motion on, the tint, the meter, the battery, the tile expansion, the save and
the caret all behaved identically.

---

# D2.3 — the right page's motion, and the day turn

## The right page

| | |
|---|---|
| broad feeling | 140ms (`--d-fast`) |
| precise expansion | 200ms (`--d-base`) |
| Day Pulse | 200ms |
| energy meter | 140ms |
| social battery | 200ms |
| passive selection | 140ms |

Nothing loops, bounces or celebrates. A selection should feel **answered, not
rewarded** — this is a diary, not a game.

## The day turn

D2.2 animated the live spread and **awaited** it before fetching, which added
200ms to every day change and meant the old day was still the only thing on
screen while it played.

The outgoing day is now a detached clone pinned over the box it replaces, and
the live layer underneath becomes the requested day immediately. The book frame,
the gutter and the coloured edges never move; only content crosses. 260ms.

The clone is `inert`, `aria-hidden`, has every id stripped and every
contenteditable disabled — never a second editor, even briefly — and it removes
itself on `animationend` **and** on a timer.

## The ring

The habit ring's completion sweep needs a dash to animate along; the finished
ring must not have one, or its two butt caps meet and leave a seam. The offset
is driven to 0 and the dash is dropped on a timer once it has arrived. See
`animation-house-rules.md` for the measurements — the seam is worst at high DPR,
where coverage fell to 0.6% of the surrounding stroke.
