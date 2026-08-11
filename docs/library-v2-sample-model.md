# Library — the sample collection

Staging only. Exists so the shelf can be judged against something, without
importing a single row of Legacy content and without asking anybody to hand-make
twenty Books.

## Safety, unchanged since F1

Every sample row carries `legacy_id` beginning **`sample:f1:`**, and cleanup
matches **only** that prefix. Never a title, never a date, never "created
recently" — each of which can also describe something the user made.

L3 reuses that prefix rather than inventing a second one. One marker, one
cleanup, one thing to reason about. Sections and pages carry no prefix of their
own; they go because the item cascades (`library_items` → `library_books` →
`book_sections` → `book_pages`, every FK `ON DELETE CASCADE`), which is
precisely what makes it impossible for cleanup to reach a page somebody wrote.

Verified by a test that creates real content **deliberately named like the
sample** and confirms it survives.

`POST …/library/sample` and `…/sample/remove` are refused unless
`NODE_ENV !== 'production'`. The stronger guard is that a production
environment refuses to boot with `DEV_AUTH_BYPASS` set at all, so there is no
route to these endpoints in production.

## The size dial

    __sampleLibrary.add('solo')    1 Book, nothing else
    __sampleLibrary.add('small')   3 Books and a few resources
    __sampleLibrary.add('full')    the whole shelf   (default)

§38 asks for the design to be judged at **one Book, at three, and at many**, and
those are three different screens: one Book must not look like a mistake, three
must not hug the far left, and many must scroll well. A collection of "many"
cannot demonstrate the first two.

This is **one sample system with a dial on it**, not three systems. All three
sizes write the same prefix and are removed by the same cleanup.

## What `full` contains

| | | |
|---|---|---|
| Books | 12 | 1 deep + 11 shelf books |
| Documents | 7 | |
| Images | 5 | |
| Videos | 4 | |
| Links | 6 | |
| Files | 5 | |

The **deep** book (*Life OS Field Notes*) is unchanged from F1 and is still what
the Book *editor* is reviewed against: three sections, an empty page, an odd page
count, both list kinds, a quote and a link.

The **shelf** books are deliberately shallow — one section, two pages each.
What they exercise is the shelf, and eleven deep books would slow seeding and
make cleanup harder to reason about for no extra coverage.

## The awkward cases, on purpose (§38)

Each one is a state the shelf has to survive, and each is only unmissable in
review if it is actually present. All are asserted by test, so a future trim
cannot quietly remove one:

| Case | How |
|---|---|
| long title | *"Systems That Survive Contact With A Tuesday"* |
| short title | *"Atlas"*, *"Money"*, *"Recipes"* |
| mixed accents | five of the six section accents across the shelf |
| subtitle present / absent | roughly half and half |
| **missing thumbnail** | an image row with no `thumbnailKey` and no dimensions |
| **broken external preview** | `https://never.invalid/photo.jpg` |
| archived item | one Book seeded already archived |
| search match | **`quokka`** appears exactly once in the whole set |
| filter match | every one of the six types present |
| extreme aspect ratio | a 4000×900 panorama |
| formatter extremes | a 1.8 GB file, a 1:15:17 video, a video with no duration |

### Why `.invalid`

`.invalid` is reserved by RFC 2606 and can never resolve. It tests the failure
path without pointing a repeated load at somebody else's server, which a real
broken URL would.

### Why 1.8 GB and not 3 GB

`library_items.size_bytes` is an `integer`, so **2,147,483,647 is the largest
size the column can hold** — a 3 GB sample failed to insert. 1.8 GB still
exercises the gigabyte branch of the formatter. The limit is recorded in
`technical-debt.md`; no real row can reach it yet because uploads are not built,
and widening the column was not L3's business.

## No private data, no copyrighted text

Every title, description and body line is written for the sample. Nothing is
quoted from anywhere, and nothing describes a real person, account or document.
