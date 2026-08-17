# The unified Book system

The core product decision, and the architecture that follows from it.

> Projects own execution.
> Library Books own information and knowledge.
> Project Books connect the two.
> AI will later understand and act across both.

---

## What is no longer planned

**Pinboards as a standalone feature.** A pinboard is a **page layout** —
specifically a page that occupies both halves of a spread. Its purpose is fully
absorbed by `Pinboard Spread` inside a Book. There is no top-level Boards
section and there will not be one; two competing future architectures for the
same thing is how a product ends up with neither.

**Brain as a knowledge store.** See
[brain-v2-future-model.md](brain-v2-future-model.md). Library owns stored
knowledge. Brain/AI becomes the layer that reasons over it.

---

## The model

```
library_items ──1:1── library_books ──┬── book_sections ──── book_pages
                                      ├── book_bookmarks ──▶ book_pages
                                      └── project_books ───▶ projects
item_links: (source_type, source_id) ──▶ (target_type='book_page', target_id)
```

### One page table, one content document

Eleven layouts share one `book_pages` row and one `content` column. A `layout`
discriminator decides how it renders and which grammar validates it. There is
deliberately **no table per template** — a schema that grows a table for every
layout is a schema that can never have user-defined layouts.

Three rendering families:

| family | layouts | mechanism |
|---|---|---|
| single flow | notes, blank, ideas, research, learning, checklist, meeting | one editor over all blocks |
| regions | two_columns, quad, comparison | blocks carry `attrs.region`; one editor per region |
| pinboard | pinboard | positioned items, `spans_spread = true` |

Moving between flowed layouts is free and cannot lose a block — they share the
grammar. Crossing into or out of a pinboard is **refused** while there is
anything to lose, and the refusal names what would have gone.

### References are ids, resolved live

A reference block stores an id and nothing else:

```json
{ "type": "taskRef", "attrs": { "id": "b3f", "taskId": "…" } }
```

Its title, status and due date are read from the Task every time the page
renders. Nothing is copied. Ticking a task in Projects changes what its card in
the Book says, because there is only ever one copy of that fact.

A reference whose target was deleted renders as **unavailable** and stays where
it is. Book content is never removed because something else changed.

### Every reference is also an edge

References are authored inside the document, because that is where the editor
needs them. But a reference that exists only inside JSON cannot be *queried*.

So every page save mirrors its references into `item_links` — the one
polymorphic edge table this application has — in the same transaction as the
write. The document is where references are authored; the edge table is where
they are asked about. The mirror is a diff, so re-saving an unchanged page
touches no rows and `created_at` keeps meaning "when the link was made".

That is what makes the relationship two-way: the Project screen shows a Task's
Book context by reading the same rows from the other end.

### Block identity

Every top-level block carries a stable `attrs.id`, assigned on write if absent
and **preserved** if present. Bookmarks, Task links and future AI citations all
address blocks by that id. An id regenerated on each save would break every one
of them, silently, the first time the page was edited.

This is what makes a citation like
`Garden Renovation → Payments → Contractor Deposit` navigable rather than
decorative — and why `#library/book/{id}?p={page}&b={block}` resolves.

### Project Books

Every Project gets a Primary Book at creation, in the same transaction. It is an
**ordinary Library item** — same ownership, same archive rules, same shelf. Only
the `project_books` join row makes it a Project Book. There is no second content
engine.

The join has a `role` (`primary` today) so a Project can gain further Books
later without a schema change.

**Which shelf a Project Book appears on is computed at read time** from the
Project's lifecycle — active, completed, archived. Nothing is stored on the Book
and nothing is moved, so completing a Project and reopening it cost no write to
the Book at all and cannot drift.

**Deleting a Project keeps its Book** by default. Deleting a project is a
statement about the plan; the notes are usually the part nobody can reconstruct.
`?book=archive` and `?book=delete` exist for a caller that means it.

---

## Built for AI to read, not yet for AI to act

No AI is implemented. What this phase guarantees is that when it is, it will not
have to infer relationships from prose:

- every object has a stable id, a type, an owner and timestamps
- every meaningful block has an id, so an answer can cite a precise location
- every cross-entity reference is an explicit row, not a phrase in a paragraph
- page text is extracted on write into `content_text`, so indexing or embeddings
  can be added later without reprocessing documents
- the operations AI would need — create a page, link a Task, bookmark, search —
  exist as service functions behind routes rather than as logic inside click
  handlers

Uncontrolled AI writes are not exposed, and nothing here asks for them.

---

## Diary is unaffected

Diary remains separate. It shares the editor and the document grammar and
nothing else. Diary entries are not Book pages and are not becoming them.
