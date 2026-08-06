# The shell: navigation and transitions (Phase D2.1)

## The rule

**The most recent user navigation wins.** Nothing that started earlier may take
the screen back.

## The defect this exists for

Reported from authenticated testing: inside a Library Book, clicking Projects →
Calendar → Today could eventually land you back in Library.

`go(id)` awaits `libraryWillLeave()` before it changes the route, so a pending
save finishes before the editor goes away. That await is correct and it can
take seconds.

During it, `state.route` was still the **old** route — so a second click entered
`go()` and took the same "I am leaving Library" branch, and a third did too.
Three concurrent navigations, each holding its own target, each eventually
calling `loadRoute()`. Whichever one's fetch finished LAST painted last.

Library and Diary made it worse. Their render functions call `setHash()`, so a
stale render did not merely repaint — it **rewrote the URL** and put the person
back inside the Book they had left.

## The guard

`web/nav.js`. One monotonic token.

```js
const nav = bumpNav();          // claimed BEFORE any await
…
if (navStale(nav)) return;      // checked before anything is drawn
```

Claimed at the top of `go()`, before it waits on anything. Checked:

- after the leave-flush, before the route changes;
- after every fetch in `loadRoute`, before `innerHTML`;
- in `renderLibrary` / `renderDiary`, before painting **and** before `setHash`.

`goToSectionRoot` and `renderHistory` carry it too.

### The trap inside the fix

`go()` writes `location.hash = id`, which fires `hashchange`. Bumping the token
there invalidated the very navigation that had just written the hash — Today
fetched its tasks and then refused to paint them, because by then it looked
stale. The handler now recognises its own write (`ownHashWrite`) and only bumps
for a real Back/forward.

### Saves are not navigations

A pending save may finish in the background. It updates its own record and its
own save coordinator, and it must never call a broad render routine.

Concretely: a 409 arriving for a page or a day nobody is looking at no longer
opens a dialog over whatever is on screen. `showConflict` returns early unless
its surface is still mounted; the conflict is resolved when the person comes
back to it.

## No blank frame

Known content is **not cleared before its replacement is ready**. A day already
on screen stays there while the next one loads; a Book stays until the next Book
arrives. The skeleton is only used when there is genuinely nothing to keep:

```js
if (!scroll.querySelector('.dia-book')) scroll.innerHTML = loadingHtml();
```

## What is NOT yet done

Prefetch of adjacent days / spreads / months (§5), the directional page-turn
illusion during a fetch (§4), and measured transition latency (§19) were not
reached in D2.1. The no-blank rule above is the half that mattered most: it
removes the empty colourless frame without needing a cache to do it.
