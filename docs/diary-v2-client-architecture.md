# Diary — client architecture (Phase D1)

## The modules

| File | Owns |
|---|---|
| `diary-api.js` | every URL, all civil-date arithmetic, and the one state object |
| `diary-save.js` | Diary's binding of the shared save coordinator |
| `diary-entry.js` | the day: header, date navigation, sheet, toolbar, context |
| `diary-history.js` | the month grid, recent entries, search results |
| `diary-view.js` | routing, and everything that is a decision rather than a rendering |

Shared with Library, and owned by neither:

| File | Owns |
|---|---|
| `editor-doc.js` | the document ⇄ DOM mapping |
| `editor-blocks.js` | Enter / Backspace rules, block styles, the F2.1 grid model |
| `editor-save.js` | the save state machine, as a `createSaveCoordinator` factory |

## The extraction, and why it is a factory

`library-doc.js` and `library-blocks.js` had nothing Library-specific in them;
they were renamed, not rewritten. `library-save.js` did — it called `savePage`
directly — so it became `createSaveCoordinator({ write })`.

A factory rather than an injected singleton because each surface needs its **own
set of entries**. A module-level map shared between Library and Diary would let
one surface's flush wait on the other's, and `forgetAll()` on closing a book
would clear a diary date's pending write. Library binds one coordinator, Diary
binds another, and they are strangers.

`library-save.js` is now a thin binding that keeps every name Library already
called, so nothing else in Library changed. The behavioural save tests in
`library-f2.test.ts` run the machine and passed unmodified through the
extraction, which is the actual proof it did not change.

## Ownership

| Concern | Owner |
|---|---|
| what "today" is | `diary-api.js` — `localToday()`, local getters only |
| all date arithmetic | `diary-api.js` — noon UTC, civil strings in and out |
| which date is showing | `diary-view.js`, mirrored into the hash |
| routing and Back | `diary-view.js`; `app.js` only dispatches the route |
| autosave, per date | `diary-save.js` over `editor-save.js` |
| what Enter means | `editor-blocks.js`, shared |
| auth, workspace, toasts, dialogs | injected by `app.js`; Diary imports no shell |

Diary receives the same `ctx` object Library does — `api`, `toast`, `run`,
`openSurface`, `closeSurface`, `choose` — so it has no opinion about auth,
workspaces or what an error looks like.

## The rendering rule

The history view rebuilds freely. The **entry does not**: while a day is on
screen its editor element is never replaced, because replacing a contenteditable
destroys the selection, the caret and the browser's undo history. The sheet is
rebuilt only when the **date** changes — never in response to typing, and never
in response to a save completing.

`paintSheet()` is the only place the editor is created. Everything that changes
while you are writing — the save status, the Archive control appearing when a
day first becomes real — patches around it.

### The bug that proves the rule matters

When a blank day first becomes an entry, the view needs to know. The
`onEntryCreated` hook did that, and also called `adopt()` to record the new
version token.

That broke saving completely. The coordinator sets the version from the write's
own result and then checks `e.version !== sentVersion` to detect a response for
a version already passed. `adopt()` had moved the version first, so the guard
fired on its own successful write, returned early, and left the status on
**Saving…** for ever — while the row sat happily in the database.

The hook now touches presentation only. The version belongs to the coordinator.

## Routing

```
#diary               today, in the browser's own reckoning
#diary/2026-08-05    that day
#diary/history       the month grid, recent entries and search
```

A date that is not a real day falls back to today rather than erroring: a
mistyped URL should open the diary, not a stack trace.

The hash is written on every date change, so Back walks back through the days
you visited and a refresh lands where you were. Typing and autosaving never
touch it. Opening a search result and pressing Back returns to the results, not
to a blank calendar.

---

# D2.2 — local patching on the right page

The rendering rule was "the right page repaints without touching the left". §12
asks for one more step: **update only its local component.**

    paintSheet()    the whole day. Only when the DATE changes.
    paintCheckin()  the whole right page. Only when its SHAPE changes.
    paintGroup(id)  ONE <section>. The normal case.
    paintPrompts()  the prompts block on the LEFT page — a sibling of the
                    editor, so the caret, the selection and the undo history
                    are untouched.

Selecting an energy replaces the energy group and leaves the other three,
including a Moment field somebody is typing in. Choosing a broad feeling
replaces the feeling group, because adding the row of finer words is a change to
what the group *is*.

## A repaint rewires only what it replaced

Found by measurement, and it is the kind of bug that looks like nothing at all:
`paintGroup` called `wireCheckin` on the whole scroller, so a chip in a group
that had **not** been replaced ended up with two click listeners. It selected
itself and then immediately deselected itself, and nothing happened.

`wireCheckin(root)` and `wirePrompts(root)` now take the subtree that was just
replaced. Fresh nodes only; then a node can never carry two.

## Typing never repaints the field being typed in

A Moment input patches state and queues a save. It does not repaint — repainting
the field you are typing in is how a caret jumps to the end of the line. The
tile's summary catches up when the group next redraws, which is exactly when it
should.

The local reflection copy is authoritative until the server answers, so a tap
shows immediately and no interaction can produce a false "Saved".
