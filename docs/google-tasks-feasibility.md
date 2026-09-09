# Google Tasks — can we pull them in?

**Status:** research only, 7 September 2026. **Decision taken 8 September:
parked until after the beta** — not because of the code, but because a fourth
sensitive scope costs a fresh consent-screen verification video and forces
every connected user to reconnect. Revisit in one batch with any other scope
change; see `google-calendar-projection.md`, which reaches the same conclusion
from the other direction.

Nothing is built, no scope is requested, no API call is made.

**Short answer: yes, and it is a genuinely easy integration — with three real
limitations that shape what we can honestly promise.**

## What a tester actually saw

The tasks that appear inside Google Calendar are Google **Tasks**, not Calendar
events and not "reminders" in any technical sense. Calendar renders them; it
does not own them.

The name confusion is Google's doing and it is recent. Calendar Reminders were
a separate thing until 2023, when Google
[migrated Assistant and Calendar Reminders into Tasks](https://workspaceupdates.googleblog.com/2023/06/assistant-and-calendar-reminders-automatically-migrating-to-tasks.html)
and then deleted the old Reminders store. So a tester saying "Calendar has
tasks that look like reminders" is describing exactly what happened: her
reminders *became* tasks. Anyone who used Google Reminders heavily before 2023
has that history sitting in Tasks today.

## They are not in the Calendar API

This matters, because it is the thing that would be easy to assume wrongly.

The Calendar API's `eventType` field takes `default`, `birthday`, `focusTime`,
`fromGmail`, `outOfOffice` and `workingLocation`. There is no `task`. Tasks do
not appear in `events.list` under any parameter. Our existing Calendar
connection — three scopes, sync tokens, push channels, the whole
`calendar-sync.ts` machine — cannot see a single task and never will.

Tasks are a separate API at `tasks.googleapis.com`, with its own scopes, its own
quota and its own consent.

## What it would cost us

### A fourth scope, and a consent-screen re-review

| Scope | Grants |
|---|---|
| `https://www.googleapis.com/auth/tasks` | create, edit, organise, delete |
| `https://www.googleapis.com/auth/tasks.readonly` | read |

`tasks.readonly` is the one to want if we only mirror them in.

Neither appears on Google's
[restricted scope list](https://support.google.com/cloud/answer/13464325)
(that list is Gmail, Drive, Fit, Chat, Data Portability, Photos Ambient and
Health) — so **no CASA security assessment**, which is the expensive one. They
are, however, user-data scopes, which puts them in the sensitive tier: Google
labels the tier next to the scope on the Cloud Console Data Access page the
moment you add it, and that label is the authoritative check before committing
to anything here.

**This is the real cost, and it is not code.** Life OS has already won sensitive
scope verification for its three Calendar scopes. Adding a fourth sensitive
scope means going back through the
[verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification):
a written justification for the scope and why a narrower one will not do, a new
unlisted YouTube walkthrough showing consent and use, and Google's review —
documented at 3–5 business days, in practice longer when it bounces.

It also means bumping `SCOPES_VERSION` past 2, which forces **every existing
user to reconnect Google** — the mechanism in `google-calendar.ts` exists
precisely for this and it works, but it is a visible interruption for everyone,
not just people who want tasks.

The sequencing conclusion: **not during the beta.** Do it in one batch with any
other scope change, once, rather than putting the connected users through a
reconnect twice.

### The code is small

`tasklists.list` then `tasks.list` per list, both paginated at 100. Incremental
sync is `updatedMin` plus `showDeleted=true`, which is a weaker version of the
Calendar sync token we already handle — same shape, less precision. The
courtesy quota is
[50,000 queries/day](https://developers.google.com/workspace/tasks/limits)
per project, which for a beta is not a constraint.

**No push.** The API has `tasklists` and `tasks` resources and nothing else —
no `watch`, no channels, no notifications. Everything `calendar-watch.ts` does
has no counterpart, so tasks would be poll-only. Given `calendar-scheduler.ts`
already runs a pass loop, that is a scheduled job, not new infrastructure.

## The three limitations to be honest about

### 1. `due` has no time of day

The docs are unambiguous: *"Only date information is recorded; the time portion
of the timestamp is discarded when setting this field. It isn't possible to read
or write the time that a task is scheduled for using the API."*

Our `reminders` table has both `dueDate` and `dueTime`. A task imported from
Google can only ever fill `dueDate`. Worse, it is lossy in the other direction
too: if we ever push a Life OS reminder *out* to Google, its time is silently
dropped. A "3pm" reminder becomes a "today" task and nobody is told.

This is survivable for reading. It makes two-way sync a promise we would be
breaking every time somebody set a time.

### 2. Recurrence is not in the API

Google Tasks supports repeating tasks in its own apps. The API does not expose
that recurrence — it is a long-standing public feature request, not an
oversight we can work around. A repeating Google task arrives as a series of
unrelated single tasks with no link between them.

We have `reminder_recurrence_rules`, RRULE-shaped. There is nothing to map it
to. A recurring Google task would import as noise: the same title, over and
over, with no way to recognise it as one thing.

### 3. Assigned tasks are read-only

Tasks assigned from Docs or Chat carry `assignmentInfo` and are output-only in
parts. Editing them through the API is restricted, and tasks assigned from Docs
cannot have notes at all. Rare for a personal user, but it means "you can edit
anything here" is not true.

## What the shape should be, if we do it

Not a new section. Google Tasks is another **source** of the thing Reminders
already is, in the way Google Calendar is another source of events — that is the
architecture the app already has, and it is the right one here.

Against the `reminders` table:

| Google Task | Life OS reminder | Note |
|---|---|---|
| `title` | `title` | |
| `notes` | `notes` | 8,192 char cap on Google's side |
| `due` | `dueDate` | **date only** |
| — | `dueTime` | never populated from Google |
| `status` | `status` | `needsAction`→`open`, `completed`→`done` |
| `completed` | `completedAt` | |
| `updated` | — | drives `updatedMin` incremental sync |
| `parent`, `position` | — | subtasks and ordering; we have neither |
| `webViewLink` | — | worth storing: "open in Google Tasks" |
| — | `deferredTo`, `leadDays`, `areaId` | ours, no counterpart |

Read-only first, mirrored in, marked clearly as coming from Google, with a link
back. That is honest about all three limitations at once: we are not claiming to
own the record, so we are not claiming to preserve a time we cannot read or a
recurrence we cannot see.

Two-way sync is a separate, later, and much larger decision.

## Recommendation

Worth doing. Not now.

The blocker is not difficulty — it is that it costs a consent-screen re-review
and a forced reconnect for every connected user, which is the worst possible
thing to spend during a beta whose whole purpose is people trying the app for
the first time. Bank it, and ship it with the next scope change.

## Sources

- [Task resource](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks) —
  fields, and the `due` date-only rule
- [tasks.list](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/list) —
  `updatedMin`, `showDeleted`, `maxResults` 100
- [REST reference](https://developers.google.com/workspace/tasks/reference/rest) —
  the complete method list, which contains no `watch`
- [Choose Tasks API scopes](https://developers.google.com/workspace/tasks/auth)
- [Restricted scopes](https://support.google.com/cloud/answer/13464325) —
  Tasks is not on it
- [Sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)
- [Quotas](https://developers.google.com/workspace/tasks/limits)
- [Calendar Event resource](https://developers.google.com/workspace/calendar/api/v3/reference/events) —
  `eventType` has no `task`
- [Reminders migrating to Tasks](https://workspaceupdates.googleblog.com/2023/06/assistant-and-calendar-reminders-automatically-migrating-to-tasks.html)
