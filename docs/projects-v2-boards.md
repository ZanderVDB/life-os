# Boards — reserved architecture (not built)

**Nothing in this document exists in E2.** No tables, no routes, no UI, no
disabled buttons. It is written now so that Projects does not accidentally
foreclose it, and so the first Board phase starts from a decision rather than a
blank page.

The rule this document exists to protect:

> **A Board is a visual arrangement of references. It stores nothing that is not
> arrangement.**

A Board that owns content is a second copy of that content. The moment a sticky
note on a Board is the only place a decision is written down, the Board becomes
a storage system with no search, no API and no backup story.

---

## The model

A Project may eventually contain several named Boards — Overview, Marketing,
Logistics, Training, Event-day operations, Visual direction. They are *views on
the project's material*, not folders inside it.

```
project
  └── boards[]                     name, order
        └── board_items[]          x, y, w, h, z, style
              ├── ref → task
              ├── ref → event
              ├── ref → reminder
              ├── ref → library item
              ├── ref → another board        (a link, see below)
              └── own → note / heading / group
```

**Referenced items** (task, event, reminder, library item, board) store only
the reference and its placement. Deleting the board deletes the placement, never
the thing.

**Board-owned items** are the exception, and a deliberately small one: sticky
notes, headings and groups. These are arrangement furniture — a heading is not
information that belongs anywhere else. If a note grows into something worth
keeping, it should be promoted to a Library item, not left on a canvas.

---

## Board-to-board links

The interesting part, and the reason to think about it before building.

```
board_links
  source_board_id
  source_item_id      nullable — the anchor it was dragged from
  target_board_id
  label
  created_at
```

Requirements when this is built:

- **Backlinks are derived, never stored twice.** "What points here?" is a query
  on `target_board_id`. A stored reciprocal link is a second copy that will
  disagree.
- **Navigation history** — following a link pushes an entry; going back returns
  to the previous board *and its previous zoom and pan position*. Returning to a
  board you have never seen at a different scale than you left it is
  disorienting in exactly the way spatial interfaces are supposed to avoid.
- **A link is labelled.** An unlabelled arrow between two boards is a puzzle.

---

## Bounded, not infinite

Boards should be **bounded or intentionally expandable**, never an uncontrolled
infinite canvas. An infinite canvas has no "all of it", which means no fit, no
overview, no reliable share, and no way to be sure you have seen everything.

When built, a Board must have:

- **Fit content** — one action that frames everything.
- **Reset zoom** — back to 1:1.
- **Sensible zoom limits** — roughly 25%–200%. Beyond that the content is not
  legible and the control is not usable.
- **A list view** — every board must be readable as a list. This is the
  accessibility requirement and the search requirement and the "I am on a phone"
  requirement, and it is one feature.
- **Search** — across items on the board, landing with the item framed.

The list view is not a fallback. A spatial arrangement that cannot be read
linearly is unusable with a keyboard or a screen reader, and unusable on a phone,
which is most of when this app is open.

---

## What E2 did to prepare

Nothing structural, which is the point. Two things make Boards cheap later:

1. **`calendar_item_links` is already polymorphic** — `targetType: task |
   project | library | diary`. Board references fit the same shape. (Its name is
   wrong for general use; see technical-debt.md.)
2. **Projects owns no arrangement data.** There is no `layout` column, no
   `board_json` blob, nothing that would have to be migrated into a real Board
   model.

No Board tables were added. A placeholder table with no reader is a migration
that has to be undone.
