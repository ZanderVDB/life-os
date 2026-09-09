# Putting Life OS things on a real Google calendar

**Status:** researched and designed, 8–9 September 2026. **Nothing is built.**
No new scope is requested and no calendar is created. This records the finding
so the decision is made once.

## The question

Tasks, deadlines and reminders live in Life OS and appear only in Life OS. The
recurring beta-tester question is whether they can appear on a phone's calendar
— which would also mean **Google's** notifications, on a phone, without Life OS
building push at all.

The fear that goes with it is the right one: nobody wants their work calendar
filled with personal tasks.

## The answer: a calendar of our own

A **secondary Google calendar** solves both halves at once. It appears in the
Google Calendar sidebar and in the phone app with its own checkbox and its own
colour, so hiding it during work hours is one tap in an app the person already
has. We do not build the toggle — Google already did.

### Can Life OS create it?

**No, not with the scopes we hold.** `calendars.insert` accepts exactly three:

| Scope | |
|---|---|
| `…/auth/calendar` | full access to everything — far too much |
| `…/auth/calendar.calendars` | properties of any calendar, plus creation |
| `…/auth/calendar.app.created` | *"Make secondary Google calendars, and see, create, change, and delete events on them."* |

`…/auth/calendar.events`, which we do hold, is **not** among them. It can write
events onto a calendar that already exists; it cannot make one.

`calendar.app.created` is the one worth wanting. It reaches only calendars our
app created — it could not read a work calendar if it tried, which is a
*better* security story than the `calendar.events` we already hold. But it is a
new scope, and a new scope means consent-screen re-verification: justification,
a fresh video, Google's review, and a `SCOPES_VERSION` bump that forces every
connected user to reconnect. See [[google-scope-changes-are-parked]].

### What works today, with no new scope

The person creates the calendar themselves, and we write to it.

1. A button in Integrations opens Google's create-calendar page directly.
2. They name it and save.
3. `calendar.calendarlist.readonly` — which we already hold — lets us notice
   the new calendar and offer it: *"Found a new calendar, 'Life OS'. Send your
   tasks and reminders there?"* No dropdown hunting.
4. We write with `calendar.events`, which we already hold.

Three taps and one typed name, once. The calendar-source panel already has a
"New events go to" select built on exactly this data, so the picker exists.

## The model, if it is built

**Life OS is the record. Google is a projection.** One-way, us → Google, onto a
calendar only we write to.

That removes every hard question at once. Nothing lives only on Google, so
there is no "which one wins", no merge conflict, and no path by which we could
damage a real work event. The `mirroredEventId` column already in
`task_schedule_blocks` is exactly this link, and nothing writes it today.

Three things project, as three different shapes:

| | on Google | why |
|---|---|---|
| Schedule blocks | timed event | you *are* busy; Google should stop people booking you |
| Task due dates | all-day | a deadline occupies no time, and a timed block would be a lie |
| Reminders | all-day, with the lead time as Google's notification offset | the one that actually buzzes a phone |

### Decide it per Area, not per task

Every task already belongs to an Area. "Work projects, Personal does not" is
one decision made once, rather than a question on every task — and one Life OS
calendar per opted-in Area gives Google separate checkboxes and separate
colours for each. That is what Google's calendar model is for.

## What this does not solve

Life OS still has no notifications of its own. Projecting to Google borrows
Google's, for the things that project, for people who connect an account. A
reminder that is not projected still only appears when the app is open — which
is why the lead-time field now says "Start showing" rather than "Notify".

## Sources

- [Choose Calendar API scopes](https://developers.google.com/workspace/calendar/api/auth)
- [calendars.insert](https://developers.google.com/workspace/calendar/api/v3/reference/calendars/insert) —
  the three scopes it accepts
- [Sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)
- Related: `google-tasks-feasibility.md`, which reaches the same conclusion
  about scope cost from the other direction.
