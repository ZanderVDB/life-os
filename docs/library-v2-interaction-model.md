# Library — the interaction model

> **RESTING → PULLED FORWARD → OPEN**

Every object on a Library shelf follows it: a Book, the Diary, a Document, an
image, a link, a file. Only the object differs.

---

## Why this replaced "prominence"

L3 gave one object per shelf a raised appearance, chosen by whichever was
nearest a read line as the shelf scrolled. The review found what that actually
produces:

- a shelf nobody had touched had **one book standing proud of the others**, for
  no reason the user had given — it reads as *this one is chosen*;
- it **survived returning from a Book**, so the Library never looked settled;
- combined with a 1400ms accent ring on return, two different things (focus and
  "you were just here") looked the same.

The correction is not a smaller raise. It is that **nothing is raised until
somebody raises it**.

## The six states

| State | Caused by | Owns | Never |
|---|---|---|---|
| **Resting** | — | nothing at all | any transform |
| **Hover** | a pointer | `translateY(-3px)` + contact shadow | required for anything |
| **Focus** | the keyboard | a 2px accent outline | the group colour |
| **Pulled forward** | a click, Enter/Space or a tap | `translateY(-32px)` (no scale), a deeper shadow, neighbours stepping aside, and a footer carrying the full title and **Open** | a selection, or the route |
| **Opening** | activating a pulled object | the handoff | surviving the paint |
| **Returned** | coming back from an object | a 320ms glow in the object's own accent | an outline |

**Focus is the only state that draws an outline.** That is what keeps it from
being confused with pulled-forward, and it is asserted by a test that walks
every `.lib-obj` rule in the stylesheet.

## Two stages, on purpose

| | First activation | Second |
|---|---|---|
| pointer | pulls forward | click the object again, or **Open** in its footer |
| keyboard | pulls forward, `aria-expanded="true"` | Enter/Space again |
| touch | pulls forward | press **Open** in the footer (a 44px target) |

The second stage is never a mystery, because the first one produces a control
that says what happens next. That single decision is what makes the model work
on a phone (no double-tap) and for a screen reader (`aria-expanded` says the
first press did something; the Open button says what the next one does).

### Four ways back out

1. pull something else — the previous object returns;
2. click empty shelf space, or anywhere else on the page;
3. **Escape**, which also returns focus to the object;
4. scroll the shelf more than **48px**, or browse past it with the arrow keys.

48px is about a third of a book. Below it, a trackpad settling would twitch the
object back; above it, you are looking somewhere else and a book held out over a
shelf that has moved on is an object in the wrong place.

## Touch: option A, and why

`§26` offered two: tap-to-pull-with-an-Open-button, or tap-to-open-directly.
**Tap-to-pull** was chosen because the shelf is a browsing surface — the whole
point of a shelf is looking without committing — and because a direct-open tap
next to a horizontally scrolling rail turns every imprecise swipe into a
navigation.

A swipe is separated from a tap by movement: if the pointer travelled more than
**10px**, *or* the rail scrolled more than 10px between `pointerdown` and
`click`, nothing happens. Either one means browsing.

Hover is switched off entirely below 820px. There is no hover on a finger, and
a state that only a mouse can reach must never be on the path to anything.

## The keyboard cursor is not a state

The shelf keeps a **cursor** — the index of its single tab stop — and it has no
appearance whatsoever. An object at the cursor looks exactly like every other
resting object until it is focused or pulled.

L3 had one function doing both jobs, and that coupling *is* the defect this
phase corrects: scrolling moved the tab stop, so scrolling raised a book. They
are separate functions now, and a test asserts `setCursor` never writes a class.

## What the shelf may never do

- change the route because something moved;
- raise, glow or outline anything without a user action;
- use "last opened" as an appearance — it may **order** the Recently opened
  shelf and nothing more;
- leave any state behind after a return.

## Two measured traps, recorded so they are not rebuilt

**The pull anchor must be read when the object is pulled.** It was originally
maintained by the scroll handler, which only learns about positions it is told
about — and `restoreShelfScroll` moves rails by assignment on every paint. The
anchor went stale and pulls cleared themselves on the next scroll.

**The pull's reveal must be instant.** Pulling an object near the shelf edge
scrolls it into view, and a *smooth* scroll is far from its target for the whole
animation — so the clear-on-scroll rule fired mid-reveal and cancelled the pull
that caused it. Measured: the last book on the Books shelf pulled and vanished
in the same gesture. Making that one reveal instant removes timing from the
question entirely; arrow-key browsing keeps its smooth scroll, where the travel
is the point.

---

## L3.2 corrections

The grammar is unchanged — `RESTING → PULLED FORWARD → OPEN` — but three
parts of how it looks were wrong.

**The pull no longer scales.** `translateY(-22px) scale(1.06)` resampled every
glyph inside the object: a 126px cover became 133.56px. Now `translateY(-32px)`
and nothing else. Measured resting against pulled: identical widths to four
decimal places and an identical subpixel phase.

**32px, not 30.** The travel must land on a whole device pixel at every
supported ratio. 30 x 1.25 = 37.5; any multiple of four is exact at 1, 1.25, 1.5
and 2.

**The Open control became a footer.** L3.1 put a purple pill over the cover, in
the same corner as the overflow menu. The title, the subtitle and the Open
action now share one footer beneath the object at its own width; the overflow
menu moved to the object's top. Opposite ends, so neither can cover the other.

**Hover shrank to 3px.** It was 5px against a 22px pull, which was close enough
to read as the same gesture. 3 against 32 is not.

**Neighbours step aside.** Pulling an object translates its two immediate
siblings 16px apart — local, transform-only, and the rail never reflows.

---

## L3.4 — the final interaction

```
RESTING  spine on the shelf
  hover  8px up, cloth brightens          — nothing revealed
  press  pull 32px up, turn 90 degrees    — neighbours step aside 16px
FRONT    crisp flat cover, quiet Title / Open beneath
  press  opens the Book
```

- **First activation pulls and turns. Second opens.** Clicking the cover works;
  the `Open` label beneath is a convenience, not the only way through.
- **Clicking another Book** returns the first, resets its neighbours, and pulls
  the new one — there is no close-first step.
- **Clicking the shelf** returns the Book. **Escape** returns it and restores
  focus. **Scrolling the shelf** returns it, because a Book held open over a
  shelf that has moved on is in the wrong place.
- **Keyboard**: first Enter/Space pulls, second opens.
- **Mobile**: one tap turns, one tap opens. No double-tap anywhere, and the
  `Open` action is a 44px target. The swipe-vs-tap threshold is unchanged.
- **Management** (Rename / Archive) appears only when a Book is front-facing,
  and is `pointer-events: none` until then — never painted onto a resting spine.
- **The Diary** does all of this and opens Diary. It has no overflow menu because
  it has nothing to rename or archive.
- **Flat resources** — Documents, Media, Links, Files — lift 4px on hover, come
  forward on the first activation and open on the second. **They never rotate.**

Reduced motion reaches every one of these states immediately, with identical
semantics and no rotation.
