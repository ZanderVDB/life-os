# Projects — future architecture (reserved, not built)

What E2 deliberately left room for, and what it deliberately did not build. The
index; the detail is in the linked documents.

| Future system | Document | Built in E2? |
|---|---|---|
| Boards inside a Project | [projects-v2-boards.md](projects-v2-boards.md) | No |
| Library ownership | [projects-v2-library-integration.md](projects-v2-library-integration.md) | No |
| AI proposal + approval | [projects-v2-ai-proposals.md](projects-v2-ai-proposals.md) | No |
| Project ↔ Calendar links | below | No |
| Project ↔ Reminder links | below | No |
| Project ↔ Brain idea links | below | No |

---

## The relationship decision

Every future connection above is an **edge between two records**, and there is
already a polymorphic edge table:

```
calendar_item_links
  kind         what sort of relationship
  source_type  event | reminder | task | habit
  source_id
  target_type  task | project | library | diary
  target_id
```

**Decision for E2: do not rename it.** The prompt allowed a rename to
`item_links` only if it could be done without destabilising Calendar. It could
have been — the table has few readers — but the rename buys nothing today: no
E2 feature writes a link, so the only effect would be churn in working Calendar
code that is frozen.

Recorded instead as debt, with the trigger written down: **rename it in the same
migration as the first non-calendar link**, which will be Project ↔ Library or
Project ↔ Event, whichever lands first. Doing it then is one migration for a
feature that needs it; doing it now is one migration for a feature that does
not.

Renaming later costs: one `ALTER TABLE ... RENAME`, updating ~4 call sites, and
the schema/test/doc references. Renaming after Projects ships links against the
old name costs the same plus a data-shape decision. Neither is expensive; the
difference is that only one of them is necessary.

## Calendar relationships (later)

Three, in the order they are likely to be worth building:

1. **Project target date on the canvas** — a Life OS marker in Month/Agenda.
   Not an event. Never written to Google.
2. **A scheduled task block knows its project** — already possible today, since
   a block points at a task and a task points at a project. Plan week could show
   what a block is *for* with no schema change at all.
3. **Link an existing event to a project** — `sourceType: 'event'`,
   `targetType: 'project'`. The event stays a Google projection; the link is
   Life OS's, and it lives only in Life OS.

**Google stays read-only.** A project date does not create a Google event. If a
link is ever mirrored to Google it goes into a private extended property, and
the user is told plainly that nobody else will see it.

## Reminder and Brain relationships (later)

Same edge table, same rule: a reminder may point at a project, and it is never
project progress. An idea may point at a project, and it is never work.

## What E2 built that makes all of this cheaper

- **Every mutation is a discrete named endpoint** with a validated body. A
  future AI executor, a Board action and a keyboard shortcut all call the same
  one, so a rule enforced there is enforced everywhere.
- **Projects owns no arrangement data and no file records**, so Boards and
  Library do not have to unpick anything first.
- **Derived values are derived** — progress and next action are computed on
  read, so nothing has to be recalculated or backfilled when a new writer
  appears.
