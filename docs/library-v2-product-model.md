# Library — product model (Phase F1)

Library is the **durable home for information and resources** in Life OS.

It is not another Diary, not another Project system, not one giant notebook,
and not a file manager. It is the place a resource exists **once**, so that
everything else can point at it.

---

## What Library owns

Eventually, resources referenced by Projects, Boards, Diary, Brain, Tasks,
Calendar items and AI proposals. One item, many references — never a copy per
place that mentions it.

F1 builds the foundation for that (the schema and one general link table) and
deliberately builds none of the relationships themselves.

## The types

| Type | What it is |
|---|---|
| **Book** | a structured, editable Life OS notebook — sections and pages |
| **Document** | durable written information that does not need the Book |
| **Image** | an uploaded or linked image |
| **Video** | an uploaded video or durable external reference |
| **Link** | a saved URL with title, description and metadata |
| **File** | any other uploaded file |

**The type is stored, never inferred from a MIME string.** A Document and a
File can both be `text/plain` and be entirely different things to the person who
saved them — one is something they wrote, the other something they kept.
Deriving that distinction from a header would mean the application deciding what
the user meant.

Book is the deeply implemented type in F1. The others have real rows, real
validation and restrained Library cards; they do not have editors or viewers
yet, and uploads are not built.

## Library is not Diary

They will share the **Book engine** and nothing else.

Diary is chronological and personal — one entry per day, ordered by time, and it
is *about* your life. Library is durable and referential — items with no
inherent order, kept because they are useful later.

A diary entry is not a Library item and will not appear in Library. When Diary
is built it reuses the Book's rendering and editing, in the same way two screens
can share a task card without one owning the other's data.

## A Book is one Library item

Not the whole of Library, and not a special case beside it. A book has a
`library_items` row like everything else — which is what puts it on the same
shelf, in the same search, under the same archive rules.

`library_books` holds only what is true of books alone: a subtitle, an author
label, a cover style, a page style. Five of the six types would never use any of
those, and a table where most columns are null for most rows has stopped
describing anything.

## Safety rules that have teeth

- **A book cannot be created through the generic item route.** It would produce
  an item with no section and no pages — a book you cannot open. Books are made
  by `POST …/library/books`, which creates the item, the book, a first section
  and two pages in one transaction.
- **A book arrives ready to write in.** Two pages, because a spread needs two
  pages to be a spread, and because a book whose first act is administration is
  a worse book.
- **The last section of a book refuses to archive**, and so does the last page
  of a section. A book with no sections has nowhere to put a page and no way to
  reach its own content. The caller is told to archive the book instead, which
  is what they meant.
- **There is no DELETE route at all.** Items, sections and pages archive.
  Permanent deletion is deliberately unexposed — see retention below.
- **Pages save with `expectedUpdatedAt`** and 409 on mismatch, so a second tab
  or a late response cannot overwrite newer content.

## Retention, and what deletion will have to consider

Archive is reversible and is the only removal F1 offers. Before permanent
deletion can exist it has to answer:

- what happens to `item_links` pointing at the deleted item — cascade, or
  refuse while references exist;
- whether a Board card referencing a deleted item shows a tombstone or vanishes;
- whether uploaded bytes are deleted with the row, and after how long;
- whether an archived item's storage is retained at all.

None of those are answerable before Boards and uploads exist, which is why the
route does not.

## The Add menu, and no fake buttons

F1 offers **New Book**, **New Document** and **Save Link** — the three that have
a complete endpoint.

Upload Image, Upload Video and Upload File are **absent, not disabled**. A
greyed-out button still says the feature exists; an absent one says nothing and
is therefore honest. Upload storage is the next Library infrastructure phase.

## No right rail

Library uses its width for Library. A contextual rail could eventually carry
item details, links and backlinks and activity — none of which exist in F1, and
an empty rail is worse than no rail.

## What F1 does not do

- **No Legacy content migration**, of any kind. Notebook, Diary, images, links,
  notes, Projects — none of it is read. Legacy was inspected for its *design*
  only; see `library-v2-legacy-book-audit.md`.
- **No uploads.** The columns exist (`storage_key`, `mime_type`, `size_bytes`,
  `thumbnail_key`); the storage integration does not.
- **No cross-system links.** `item_links` is ready; nothing writes Library edges
  into it yet.
- **No mobile refinement.** The Book is responsive but the dedicated mobile
  design remains deferred.
