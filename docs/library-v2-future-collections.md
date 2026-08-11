# Library — future: Collections and Favourites

**Nothing in this document is built.** It exists so two ideas that came up
during L3.1 are recorded properly rather than half-implemented, and so the
things that would make them cheap later are not accidentally spent now.

---

## Collections / thematic shelves

The wish: shelves like **Science**, **Business**, **Personal**, alongside (or
instead of) the type shelves the Library has today.

### What exists now, and why it is not that

Today's shelves are **derived**, not stored. `SHELVES` in
`library-overview.js` maps a shelf id to a set of `library_items.type` values,
and a shelf is drawn if anything matches. Nothing in the database knows what a
shelf is.

That is deliberate and it is also the constraint: **a visual shelf name must
never become a hidden storage model.** Encoding "Science" as, say, a prefix on a
title, a magic tag inside `metadata`, or a reserved `legacy_id` would give the
feature for free and cost a migration the first time somebody renamed it.

### The shape it would need

A real Collections feature needs three things, and the data model has none yet:

1. a `collections` table — id, workspace, name, position, maybe an accent;
2. a join table, because an item belongs to **several** collections. Library's
   founding premise is that a resource exists once and is pointed at from
   everywhere; a single `collection_id` column on `library_items` would
   reintroduce exactly the "which one folder does this live in?" question
   Library exists to avoid;
3. an explicit position, so a collection's order is something somebody chose.

### Rules to carry forward

- Type shelves stay. A Collection is an **extra** way to look at the Library,
  not a replacement — a resource with no collection must never become
  unreachable.
- No auto-classification. A Library that decides *Science* for you is a Library
  you have to correct.
- Empty collections are still drawn, unlike type shelves: an empty shelf you
  made on purpose is information; an empty type shelf is a divider.

## Favourite / Pin

The wish: star an item so it comes first.

**This is the reason the Diary's star mark was removed in L3.1.** It looked like
a favourite control, sat exactly where one goes, and did nothing. §12 and §13
both say it: do not imply the feature until it exists, and do not repurpose the
system mark as it.

### The shape it would need

One nullable column would do — `library_items.pinned_at` — with the same
discipline `last_opened_at` got in L3:

- nullable, never backfilled;
- ordering only, and any UI that shows it says what it is;
- **no silent reordering.** A pinned item moves because somebody pinned it, and
  the change is visible when it happens.

### Where it would live

Two options, both cheap once the column exists:

- pinned items sort first **within their own shelf** — least disruptive, and it
  keeps the room's structure;
- or a dedicated **Pinned** shelf above the rest, in the same position the
  Personal ledge occupies.

The first is the safer default. A second copy of an item on a second shelf is
the thing "Recently opened" already does, and doing it twice starts to make the
room a list of lists.

### And the control

It must be a real control with a real state — pressed or not — never a mark
that looks pressable. The L3.1 lesson stands: on a shelf, anything drawn in a
corner in a rounded tinted box is read as a button, whatever it is called.
