# Library L3 — the bookshelf (future, not built)

Approved direction, recorded so it is not re-derived later. **Nothing in this
document is implemented.**

Library should feel like a library, not a badge grid.

- Books represented by covers and spines, browsed on a shelf.
- **Scrolling** rather than repeated side-click navigation.
- A selected Book may come forward from the ones around it, and the ones around
  it stay spatially visible — you should never lose your place on the shelf.
- A curved or half-circle arrangement is worth trying and must be **tested for
  usability before it is committed to**. Curves look wonderful in a mockup and
  are frequently harder to scan and much harder to make keyboard-navigable.

## The question that gates it

**How do Documents, Links, Images, Videos and Files live on a shelf?**

Five of the six Library types are not books. Forcing them onto a literal
bookshelf makes a saved URL pretend to be an object it is not; putting them
somewhere else makes Library two browsers with one name.

Decorative shelves must not be built before that is answered. A shelf that only
works for one of six types is a redesign that immediately needs a second one.

## Diary on the shelf

Diary may appear as a system shortcut or a book-shaped reference. It remains a
**separate data model**: it cannot be archived, renamed or filed as an ordinary
Library Book, and it never becomes a `library_items` row.

That is precisely the pressure this idea puts on the boundary, and why it is
deferred rather than sketched: a diary that looks like a book on a shelf is a
diary somebody will try to rename.

## Related deferrals

Month-as-tabs, the month overview spread and the year jump are recorded in
`diary-v2-direction-d2.md`.
