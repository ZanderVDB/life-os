# Library — data model (Phase F1)

Migration `0006_library.sql`. Additive apart from one rename, and it **moves no
data**: no INSERT, no UPDATE, no DROP TABLE. Asserted by test.

---

## `item_links` — the rename

`calendar_item_links` became `item_links`.

The table was **already** polymorphic — `source_type`/`source_id`,
`target_type`/`target_id`, a `kind`, and a unique index across all four. Its
original comment already named `library` as a future target type. Only the
*name* said Calendar.

That name was the problem. Library is the first system that needs edges to
Projects, Tasks, Diary, Brain and Boards; a table called `calendar_item_links`
would have been quietly worked around, and the workaround is always a second
general link table. Then there are two answers to "what relates to what".

Traced before touching it: **one** select, **one** insert, two test files. The
API response field is still `links`, so Calendar behaviour is unchanged —
asserted by a test that reads the range response.

| | |
|---|---|
| source types | `event`, `reminder`, `task`, `habit`, `library`, `book_page` |
| target types | `task`, `project`, `library`, `diary`, `brain`, `board` |

Nothing writes a Library edge yet. The table is ready; F1 deliberately does not
build the relationships.

---

## `library_items`

One row per durable resource, whatever kind.

| Column | Notes |
|---|---|
| `type` | **stored**, checked against six values. Never inferred from MIME. |
| `title` | what Library lists. For a book, also what the cover shows. |
| `status` / `archived_at` | `active \| archived`, and the timestamp. Both, so "when" survives. |
| `source_url` | links, and anything with a canonical address |
| `storage_key` / `mime_type` / `size_bytes` / `thumbnail_key` | uploads. Columns exist; storage does not. |
| `metadata` jsonb | type-specific facts with no column: image dimensions, video duration, a link's domain. **Never** filtered or sorted by — the moment something is queried it earns a column. |
| `legacy_id` | provenance. In F1 its only writer is the sample seeder, carrying `sample:f1:`. |

Indexes: `(workspace_id, type, updated_at desc)` for the filtered shelf, a
**partial** `(workspace_id, updated_at desc) where archived_at is null` because
the default view never wants archived rows, and a unique partial on `legacy_id`.

## `library_books`

Beside the item, not instead of it. Holds `subtitle`, `author_label`,
`cover_style`, `page_style` — things only a book has. Five of the six types
would leave every one of them null, and a table that is mostly null has stopped
describing anything.

`library_item_id` is **unique** and `ON DELETE CASCADE`. Deleting the item *is*
deleting the book; there is no state where one should outlive the other.

## `book_sections`

`title`, `accent`, `position`, `archived_at`.

`accent` is a **token** — one of the six Legacy colours — never a hex value. The
palette follows the theme; a stored `#hex` cannot.

`position` is sparse (gap 1000) so one move rewrites one row.

## `book_pages`

`title`, `content`, `content_text`, `position`, `archived_at`.

**`content` is jsonb — a document, not HTML.** See
`library-v2-security-and-save-model.md`. Storing generated HTML means storing
whatever the browser's editor produced, which is how Legacy ended up with
font-colour wrappers that made text invisible on the dark theme.

**`content_text` is the plain text, maintained on write.** Search is then one
indexed `LIKE` rather than parsing every document in the workspace on every
keystroke — which is exactly what Legacy did.

## Cascade, deliberately chosen

```
workspaces ─cascade─> library_items ─cascade─> library_books
                                                  └─cascade─> book_sections
                                                                 └─cascade─> book_pages
```

Every step is `ON DELETE CASCADE`, and that is what makes sample cleanup safe:
sections and pages carry **no** `legacy_id` of their own. Cleanup deletes
`library_items` matching the exact prefix and the database removes the rest, so
there is no query that could reach a page a person wrote.

## What is deliberately absent

**No `page_cells`.** Legacy stored `page.cells[]`, a fixed array indexed by
layout, which entangles layout with content — changing layout could strand text.
A page has content; how it is displayed is not data.

**No `book_id` on `book_pages`.** It would be derivable from the section and
therefore a second truth. One join.

**No full-text index yet.** `content_text` with `LIKE` is honest at this scale
and can become a `tsvector` without changing the API.
