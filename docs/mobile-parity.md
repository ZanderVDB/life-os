# Mobile parity ledger

The rule this file exists to enforce:

> **Mobile preserves capability and information, not desktop geometry.**

It is fine for something to be one tap deeper on a phone. It is not fine for
it to be missing. This is the list of every desktop surface and where it is on
a phone, and `api/tests/mobile.test.ts` walks it — a destination that stops
being reachable fails a test rather than being noticed by somebody months
later.

The three modes:

| Mode | Width | Shell |
|---|---|---|
| Phone | ≤ 899px, or < 500px tall and < 1100px wide | Bottom navigation, no sidebar |
| Tablet | 900 – 1099px, and 1024px landscape | Sidebar returns, rail below content, two-page Books |
| Desktop | ≥ 1100px | Unchanged |

The second phone clause is landscape phones: an iPhone 14 Pro Max on its side
is 932 × 430, which is wider than an iPad in portrait and is not one. Height is
what tells them apart.

---

## Navigation

| Desktop | Phone |
|---|---|
| Sidebar → Today | Bottom bar, slot 1 |
| Sidebar → Calendar | Bottom bar, slot 2 |
| Sidebar → Projects | Bottom bar, slot 4 |
| Sidebar → Diary | **More** → Diary |
| Sidebar → Library | **More** → Library |
| Account block → Settings | **More** → Settings |
| Account menu → Completed | **More** → Completed |
| Calendar → Reminders utility | **More** → Reminders |
| Rail → Habits | Today's Habits card, and **More** → Habits |
| Composer ("Ask Life OS", soon) | Bottom bar centre — the assistant |
| Search (⌘K) | Top bar search, and **More** → Search |

Nothing in the sidebar or the account area is unreachable. The drawer is gone
entirely — not hidden — and with it the stacking-context defect that made the
whole application untappable while it was open.

## Today

| Desktop | Phone |
|---|---|
| Four bucket columns | Today open; This Week / This Month / Future in **Later**, each expanding to the same rows |
| Area filter chips | Same chips, horizontally scrolling |
| Held-back notice | Same |
| Add task | Same button, plus Quick add on the centre button |
| Habits rail | Habits card in the flow, expanding to the habits sheet |
| Rail day/date header | The greeting already carries it |
| — | **Next**: the next event or timed reminder today |
| — | The day in one line: tasks, meetings, habits |
| — | The assistant invitation |

Every task in every bucket is on the page. `Later` is collapsed, not filtered.

## Tasks

| Desktop | Phone |
|---|---|
| Hover-revealed row actions | Always visible |
| Drag grip | Hidden; the two Move buttons are the touch path |
| Row menu (⋯) | Same button, plus swipe left |
| Tick | Same, plus swipe right |
| Task editor dialog | Full-height sheet; title / when / area / steps / notes first, priority and dates behind a disclosure |
| Native `<select>` for when, priority, area | The shared dropdown, which opens as a sheet |

## Calendar

| Desktop | Phone |
|---|---|
| Month | Month — dates, density dots, selection; tap a day for its panel beneath |
| Agenda | Agenda, and the default |
| Plan week | **Day** and **3 day** — the same time grid with one or three columns |
| Rail beside the canvas | The same rail, stacked beneath it |
| Next / previous buttons | Same buttons, plus horizontal swipe in Day, 3 day and Month |
| Event, Reminder, Schedule task, Birthday composers | Same four, as full-height sheets |

Plan week is not offered on a phone: seven draggable columns across 390px is
seven columns nobody can read or hit. Everything it shows is in Day, 3 day and
Agenda.

## Projects

| Desktop | Phone |
|---|---|
| Title, next action, progress, area, status, focus, target, outcome | Title, next action, progress, status. Area, focus, target and outcome are on the project's own page |
| Hover-revealed ⋯ | Always visible |
| Status and Focus selects | The shared dropdown |
| Project Book button | Same, full width |

## Library and Books

| Desktop | Phone |
|---|---|
| Shelf-first | **Browse**-first — search, Recent, then a section per shelf. A Browse / Shelf switch is in the bar and the choice is remembered |
| Two-page spread | One page at a time |
| Section tab strip | The bar's centre control → **Contents** sheet (sections, bookmarks, search) |
| Bookmark row | In the Contents sheet |
| Project task rail | `Tasks · n` → a sheet holding **the same rail**, moved rather than copied |
| Formatting toolbar at the top | Above the keyboard while typing |
| Page arrows | Same arrows, over the page edges, plus swipe |
| Pinboard spread | Full-screen canvas: pan, pinch, fit, zoom controls |

## Diary and Settings

| Desktop | Phone |
|---|---|
| Diary: write left, check in right | Write above, check in below |
| Diary history | Unchanged — date navigation, calendar, search |
| Settings: nav column beside content | An index of pages; a section is a page with `‹ Settings` |

## What a phone does NOT have

Two things, and both are stated rather than quietly dropped:

1. **Plan week.** Its content is in Day, 3 day and Agenda.
2. **The desktop composer.** It is the bottom bar's centre button instead.

Everything else is present.
