# Diary — date navigation

## The defect

Authenticated staging, moving between days:

1. the requested day began appearing;
2. the screen snapped back to the previous day;
3. then flashed to the requested day again.

Reproduced before any change was made. Pressing **Next, Next, Previous, Next**
showed 8 Aug, then **7 Aug**, then 8 Aug — settling after **3.6 seconds**, with
**four requests for three different days**.

## Three causes

**1. `loadDay` decided which day was open.** It ended with `dia.date = date`, so
a response for a day already left did not merely repaint that day — it made
that day *current* again. The state moved backwards, and everything downstream
was then correctly drawing the wrong day.

**2. Nothing said which press a render belonged to.** The shell's route token
(D2.1) cannot answer this: moving between days does not change the route, so
`navStale` was false for every date press and every stale render was free to
paint. Whichever finished last painted last.

**3. The target was computed from a date that had not been committed yet.**
`goToDate` flushed the pending save *before* changing `dia.date`, and that wait
could take seconds. A second press therefore computed `addDays(dia.date, 1)`
from the day still on screen.

---

## The transaction

> **THE LATEST DATE NAVIGATION WINS.**

A monotonically increasing **day-navigation token**, separate from but
compatible with the shell's route token. Both live in the modules that own the
state they guard: the route token in `web/nav.js`, the day token in
`web/diary-api.js` beside `dia`.

    beginDayNav(date)   claims the navigation AND commits the date
    dayNavToken()       the token to capture
    dayNavStale(t)      has a newer date press happened?

Every render checks **both**:

    const stale = () => navStale(nav) || dayNavStale(day);

They are genuinely different questions — *did you leave Diary* and *did you ask
for another day* — and one token cannot answer both.

## The order, on Previous or Next

1. **Claim the navigation and commit the date**, before anything is awaited.
   The heading, the day controls and the hash are correct in the first frame,
   so the next press computes from the right base.
2. **Start the outgoing layer moving** (see below).
3. **Let the flush for the day being LEFT continue in the background.**
4. **Fetch**, and paint only if this is still the newest navigation.

### What a late save may and may not do

It may finish. It may update its own record and its own coordinator — the save
coordinator is keyed by DATE, so a write for yesterday lands on yesterday.

It may **not** touch the date heading, the document, the reflection, the
prompts, the hash or the month. Enforced in two places:

    // diary-save.js
    if (date === dia.date) { dia.entry = r.entry; onCreated?.(…, date); }

    // diary-view.js
    onEntryCreated((entry, created, date) => {
      if (date && date !== dia.date) return;
      …

This changes D2's rule that the flush blocks the move. The guarantee survives
— nothing typed is lost, `beforeunload` still guards the tab, and History and
archiving still flush first because they take the editor away without a date to
hand the write to. What is gone is the UI waiting on the network.

Verified: navigating mid-autosave landed on the requested day, and the
abandoned day's text was on the server afterwards.

### Month preloads may not move the selection

`loadMonth(monthDate, day)` takes the token and applies nothing when stale.
A History or date-jump preload cannot change which day is selected.

---

## The turn (§21)

Two layers, not one element being cleared.

The outgoing day is a **detached clone**, pinned over the box it is replacing,
`inert`, `aria-hidden`, with every id removed and every contenteditable
disabled — never a second editor, even for 260ms. The live layer underneath is
replaced immediately with the **requested** day's paper and heading.

That last part matters more than it looks. The ghost fades in 260ms; whatever
is underneath then becomes visible. If that were still the old day, a slow
connection would show the day you just left as the current one — the
rubber-band wearing a different hat. Verified with 1.2s of injected latency:
the visible date went straight to the requested day and never showed the old
one alone.

The book frame, the gutter and the coloured edges never move. Only content
crosses. 260ms is the stated structural maximum.

The clone removes itself on `animationend` **and** on a timer, and every paint
sweeps any survivor — see `animation-house-rules.md`.

---

## Measured latency (§22)

Against the local API, click → paint, with a `MutationObserver` rather than a
polling timer (the harness throttles `setTimeout` to ~1s, which made a first
attempt read 990ms for a 26ms operation):

| | ms |
|---|---|
| heading, controls and hash committed | **~3** |
| requests start | ~3 |
| entry response | 10.5 – 13.4 |
| streak response | 13.6 – 17.4 |
| month response | 17.5 – 21.5 |
| **paper painted** | **23.9 – 27.9** |
| ghost removed | same frame |

**One request each per press.** No duplicates, at any speed.

### Prefetch: not built, and not justified

§22 permits a small adjacent-day prefetch *if the numbers justify it*. They do
not. The whole navigation is ~26ms locally and the three requests are already
parallel; a prefetch would add background load to hide nothing.

Over a real network one round trip would dominate, and that is the case a
prefetch could help — but I have no measurement of the user's own latency to
staging, and building a cache against an unmeasured number is how caches become
correctness bugs. **Recorded in `technical-debt.md` as a measurement to take,
not a feature to add.**

What the design already does is make latency *harmless*: the date, the controls
and the hash are correct in ~3ms regardless, so a slow day is a slow **body**,
never a wrong date.

---

## Hash ownership (§20)

`nav.js` remains the sole owner. Diary imports `setHash` and keeps no private
suppress flag — that was the D2.2 Library regression and it does not come back.

Back, Forward, a pasted URL and the first entry into Diary are all real date
navigations, so `renderDiary` claims a token for each. Without that, a render
started by Back carried whatever token the last button press had, and the first
in-flight day change would silently cancel it.

Verified: rapid **Next → Next → Previous → Next** produced four states in
order, one request each, ending on the requested day with the hash to match;
Back and Forward both resolved correctly.
