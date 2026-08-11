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
| **Hover** | a pointer | `translateY(-5px)` + contact shadow | required for anything |
| **Focus** | the keyboard | a 2px accent outline | the group colour |
| **Pulled forward** | a click, Enter/Space or a tap | lift, `scale(1.06)`, deeper shadow, the whole cover clear of its neighbours, an **Open** control and the full title | a selection, or the route |
| **Opening** | activating a pulled object | the handoff | surviving the paint |
| **Returned** | coming back from an object | a 320ms glow in the object's own accent | an outline |

**Focus is the only state that draws an outline.** That is what keeps it from
being confused with pulled-forward, and it is asserted by a test that walks
every `.lib-obj` rule in the stylesheet.

## Two stages, on purpose

| | First activation | Second |
|---|---|---|
| pointer | pulls forward | click the object again, or its **Open** control |
| keyboard | pulls forward, `aria-expanded="true"` | Enter/Space again |
| touch | pulls forward | press the labelled **Open** button |

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
