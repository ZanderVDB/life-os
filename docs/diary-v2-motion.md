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
