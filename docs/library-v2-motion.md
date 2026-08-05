# Library — motion (Phase F1)

Tokens only: 90ms press, 140ms hover, 200ms content replacement, 260ms
structural movement, 320ms reserved for a full book open. No springs, no
overshoot, no looping decoration.

The Legacy book already used **0.26s `cubic-bezier(.4,0,.2,1)`** for its page
turn, which lands exactly on the structural token. That easing and duration
carry across unchanged.

---

## Page turn

Legacy's approach, kept: the outgoing spread translates 14% in the direction of
travel and fades; the incoming spread arrives from the opposite side.

```
@keyframes flipLeft  { to   { transform: translateX(-14%); opacity: 0 } }
@keyframes enterLeft { from { transform: translateX(14%);  opacity: 0 } }
```

**No 3D curl.** Legacy declares `perspective: 1600px` on the book and never uses
it — the ambition is visible in the source and was never made stable. A curl
that stutters is worse than a slide that does not, and the brief asks for the
slide.

The **gutter and the book frame stay still**. Only the page contents move, so the
object reads as a book being turned rather than a screen being replaced.

In a spread both pages animate together, so it is one motion rather than two
pages racing.

## Cover → spread

The cover settles and fades; the spread opens in its place. The book stays
spatially anchored — same centre, same footprint — so opening it is the book
opening, not a page navigating.

## Section change

The accent transitions, the content crossfades, **the tabs do not move**. A tab
strip that reflows when you select a tab makes the next selection a guess.

## What Legacy got wrong here, and F1 must not repeat

`nbSwapBook` starts the exit animation, then swaps `innerHTML` on a
`setTimeout(…, 220)`. Any render arriving inside that window replaces content the
animation is still using. F1's rendering has to hold the outgoing node until its
animation genuinely finishes, or skip the animation — not guess at 220ms.

## Reduced motion

Positions update immediately; opacity feedback and every status message remain;
functionality is identical. Handled by the existing `motion.js` helpers rather
than a Library-specific path.
