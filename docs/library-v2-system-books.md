# Library — system Books

A **system Book** is one Life OS created and maintains. Today there is one: the
Diary.

## The rule

> A system Book is a Book. It is marked by **material**, never by a control, a
> badge or a position outside the shelf.

The Diary stands **first among the ordinary Books**, on the Books shelf, in a
slot of its own thickness — not in a bay of its own, not on a separate ledge,
not pinned above the row. Earlier phases tried all three and each one said the
same wrong thing: *this is not really one of your Books.*

It is your Book. You write in it every day. It is the one you own most.

## How it is marked

| | ordinary Book | system Book |
|---|---|---|
| Spine edge | a highlight in its own accent | a **lavender** binding highlight |
| Cover accent edge | the Book's accent | `--a-lavender` |
| Imprint at the tail | the year | a **✦** |
| Cover label | NOTEBOOK | **JOURNAL** |

Four small differences in material, all of them things a real book would differ
in — the cloth, the foil, the imprint, the word on the cover.

## How it behaves

Identically. It turns on the same hinge, over the same 300ms, with the same
neighbour reflow; it opens on the second activation; it takes focus and Escape
the same way. A test fails if anything scoped to `is-system` makes it
un-openable, un-focusable or non-interactive.

At the measured sample it is 120 pages → **50px thick**, and it happened to draw
the tallest height step (208px). That is not special-casing: both numbers come
from the same functions every other Book uses.

## Why not a badge

A badge is a claim about status, and it invites the question "can I delete it?"
— which is the wrong question to raise on a shelf. Material says *this one is
different* without saying *this one is not yours*. It also means the mark costs
no layout, so the shelf silhouette is unaffected by which Books are system ones.

This is the L3.1 rule applied: *an appearance is a claim, and no two meanings
may share a look.* Lavender means "Life OS keeps this one". Nothing else in the
Library uses it.

## When there are more

The same treatment scales without change: any Book with `system: true` gets the
lavender binding and the ✦, and sorts to the front of the Books shelf. Nothing
in the rendering counts them or assumes there is one.

See [the C2 direction](library-v2-l3-c2-direction.md) and
[the cover system](library-v2-cover-system.md).
