# Calendar v2 — product model

**Status:** locked for Phase D. Supersedes the Legacy Calendar entirely.

## Why Calendar exists

Calendar answers three questions, and nothing else:

1. **What is happening across my life?** → Month
2. **What is approaching and needs attention or preparation?** → Agenda
3. **Where do I have space to plan work?** → Plan

Anything that does not serve one of those three is out of scope. That test is
what removed most of the Legacy Calendar.

## The three modes

| Mode | Question | Default |
|---|---|---|
| **Month** | "What does my life look like?" | ✅ yes |
| **Agenda** | "What is coming next?" | strongest on mobile |
| **Plan** | "When am I actually going to do the work?" | — |

### Removed, deliberately

- **3 Day** — never used. Removed entirely, not hidden.
- **Day** — added little value as a top-level destination. A selected date still
  opens a focused day experience; that is a *selection state*, not a mode.
- **Week** — more useful as a compact strip on Today than as a Calendar
  destination. Plan may use a weekly time structure internally; that is a
  planning surface, not a "week view".
- **Bars / Expanded Month** — one adaptive Month design instead of two modes
  that differed only in density.
- **Events / Reminders / Habits top tabs** — see "one timeline" below.
- **Coming Up dashboard** — replaced by Agenda.

The mistake being corrected: Legacy offered views because calendar apps
conventionally have them, then split one timeline across tabs so that no view
ever answered a whole question.

## One timeline, several layers

Calendar is **one temporal system with multiple item types**, never several
calendar applications sharing a page.

Two control axes, and they must not be confused:

- **Mode** answers *how am I viewing time?* — Month / Agenda / Plan. Primary,
  prominent.
- **Layers** answer *what kinds of information are visible?* — Events /
  Reminders / Tasks / Habits. Secondary, compact, and off the critical path.

The default state must be understandable without touching the layer control. A
user who never discovers layers should still have a working calendar.

## Item types stay distinct

Rendering everything as an event bar is the single biggest Legacy error. Each
type has its own semantics and its own visual language.

| Type | Occupies time? | Source | Distinguishing behaviour |
|---|---|---|---|
| **Event** | yes — timed or all-day | usually Google | attendees, location, recurrence, conferencing |
| **Reminder** | no | Life OS | asks for attention *on or before* a date; completable, deferrable, recurring |
| **Task** | optionally | Life OS | **due date ≠ scheduled time**; may be unscheduled entirely |
| **Habit** | no | Life OS | repeated behaviour; shows rhythm and progress, never becomes an event |

Two rules follow:

1. A Habit does **not** become a calendar event. If time-blocking habits is ever
   wanted, that is a separate design that explicitly creates a block.
2. **Due date and scheduled time are different concepts** and must never be
   collapsed. A task due Friday that you plan to do Wednesday morning has both,
   and they mean different things.

## What each mode must deliver

### Month — the default

Answers: what is happening this month, which dates matter, which weeks are
crowded, where there is open space, what might be missed.

Cell content priority, highest first — a cell shows what fits, in this order:

1. selected or important events
2. deadlines
3. due reminders
4. count of remaining items
5. subtle habit / workload summary

One adaptive design. Wider screens show slightly more labels; narrower screens
fall back to dots and counts. Row heights stay consistent, and text is never
squeezed into unreadable fragments — a truncated fragment is worse than a count.

### Agenda

A chronological stream, grouped by Today / Tomorrow / This week / Later this
month / future dates. Chronology is primary; the Legacy categories (Birthdays,
Meetings, Faith, Other) become filters or secondary group labels, never the
primary structure.

Habits must not generate daily agenda noise. Only exceptions or meaningful
summaries appear.

### Plan

Active weekly planning. Combines the week's commitments, free windows, the
unscheduled task queue and due-soon tasks, so the user can drag work into real
time.

Shows relevant working hours by default, expandable. An empty 24-hour grid with
no planning purpose is exactly what Day view was, and it is not coming back.

No AI auto-scheduling in this phase.

## Free time, workload, attention

**Free windows** are gaps between time-blocking commitments, bounded by
working/planning hours — not "every empty minute". All-day blocks and time
zones are respected.

**Workload** is a restrained four-state indicator: `open` / `moderate` / `busy`
/ `overloaded`. Deliberately not a bright heatmap; the point is a glance, not a
data visualisation.

**Needs attention** must be *calendar-relevant*: overlapping events, an
insufficient travel gap, an overdue reminder, a deadline with no planned work, a
due-soon task with no schedule, an event needing preparation, a failed sync.

It must **not** simply repeat every urgent task. Today already does that, and
duplicating it here would make both surfaces less trustworthy.

## Colour

Purple stays the Life OS interaction colour. Google and source-calendar colours
appear **inside the event's own representation** — a small edge, dot or header —
never across the shell.

One colour, one meaning:

- source calendar → small edge / dot
- category → icon or label, not colour
- status → its own treatment
- selection → purple
- conflict / error → red
- completed habit → green

The Legacy failure to avoid: the same colour meaning source, category, urgency
and selection at once, so none of them read.

## Right rail by mode

The rail changes with the mode and the selection, and shows nothing when it has
nothing useful.

| Mode | Rail |
|---|---|
| Month | selected-day preview; important dates this month; upcoming birthdays; genuine conflicts |
| Agenda | filters; compact date navigation; sync/source state |
| Plan | unscheduled tasks; due-soon tasks; free-window summary; conflicts |

Daily Habits do **not** appear in every Calendar mode. Habits are strongest on
Today; Calendar may show habit history inside selected-day detail or as a subtle
Month summary.

## Relationships to other systems

Designed now, built later. Only relationship *architecture* and synthetic
examples exist in D1–D4.

- **Event ↔ Task** — preparation tasks, follow-up tasks, scheduled task blocks
- **Event ↔ Project** — project context, future milestones
- **Event ↔ Library** — meeting notes, diary reflection, reference material

These are stored as **internal Life OS relationship records**, never by
overloading Google event fields. Controls for systems that do not exist yet are
not shown.

## Delivery order

| Step | Scope | State |
|---|---|---|
| D1 | Audit, product model, data model | ✅ this phase |
| D2 | PostgreSQL Calendar foundation | ✅ this phase |
| D3 | Calendar UI on synthetic staging data | ⏳ next |
| D4 | Visual and interaction approval | ⏳ next |
| D5 | Google OAuth connection | blocked on D4 approval |
| D6 | Read-only Google sync | blocked |
| D7 | Write support, two-way editing | blocked |
| D8 | Legacy Reminders preview/import | blocked |
| D9 | Today integration | blocked |

**The user's real Google Calendar is not connected in D1–D4.** No scopes are
requested, no live calls are made, and all Calendar content is synthetic and
clearly marked.

## Clarity rule (locked in D4.2)

> **Nothing persistent in Life OS should make the user stop and wonder what it means.**

Every visual indicator must satisfy at least one of:

- universally recognisable;
- clearly labelled;
- explained through concise hover/focus detail;
- explained by a small legend;
- **removed**, because its value is too low to justify the cost of learning it.

A tooltip is not sufficient on its own for an indicator that repeats throughout
the interface and forms part of everyday scanning. If someone scans Month fifty
times a week, every mark in it is either instantly legible or it is friction.

### Applied in D4.2

| Indicator | Decision |
|---|---|
| Habit completion pie in the month cell | **Removed.** It was the most repeated mark in Month and nobody could say what it meant. Habits now appear in the selected-day rail, in words. |
| Workload edge colour | **Reduced to two states.** Busy (amber) and Heavily booked (red) only; everything else unmarked. The old four-state ramp used purple for "moderate", and purple already means selection. |
| Conflict marker | **Kept, with an icon, a count and an accessible label.** Explained on hover and in the legend. |
| Source-calendar colour | **Kept.** It sits inside the event's own representation and is explained in the legend. |

Colour is never the only carrier of meaning. Purple means selected or
interactive, everywhere, and nothing else.


## Discoverability rule (locked in D4.5)

> **No feature is complete unless the user has an obvious place to find it, understand it, review it and manage it.**

Contextual display is not enough. Showing a reminder on the date it falls on
tells you about one occurrence; it never tells you what reminders you own,
which of them repeat, or how to change them.

The user must never have to wonder what records exist, where they are stored,
which are active, how to edit them, how to pause or remove them, or what
happens next.

**Settings is for configuration** - preferences, permissions, integrations. It
is not a home for a product system. A list of your reminders is not a setting.

### Applied in D4.5

| System | Contextual surface | Home |
|---|---|---|
| Reminders | Month cells, Agenda rows, Plan strip, selected-day rail | **Calendar -> Reminders** workspace |
| Completed tasks | - | End of the Today board |
| Account, sign out, version | - | Settings -> Account |

## Rail usefulness rule (locked in D4.5)

> **The rail is optional. It exists only when it provides actionable or contextual value.**

A count is not a decision. "58 events", "0 deadlines" and "90 hours free" were
removed because nobody opens a calendar wondering how many events they have.

Every rail item must have source data, an explainable calculation, and
somewhere to click. "Tuesday has 3h free from 09:00" is a plan; "90 hours free"
is arithmetic.

## Recurrence visibility (D4.5)

A reminder stores ONE canonical due date - the occurrence being asked about
right now. Views expand the rule into virtual occurrences for whatever range
they display, so September is visible without August having been completed.

Future occurrences are never written to the database. Materialising them would
mean every edit had to chase down and rewrite an unbounded set, and a missed
one becomes a reminder that fires on a date its own rule no longer agrees with.
