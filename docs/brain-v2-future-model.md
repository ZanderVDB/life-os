# Brain — future model (recorded, not built)

**Nothing in this document is implemented.** No schema, no endpoints, no
placeholder UI. It is written down so the shape stays stable while the rest of
v2 is built around it, and so nobody models these as ordinary Future Tasks in
the meantime.

Recorded at E2.8, on the user's direction.

---

## Growth items are not Tasks

A Task is something you finish. Growth is something you *become*, and the
difference matters enough that forcing one into the other would corrupt both.

"Learn Portuguese" as a Future Task is wrong in every direction: it has no due
date that means anything, completing it is not a moment, and it sits in a bucket
whose whole purpose is "when am I doing this" — a question it cannot answer. It
would clutter Future forever and never be finished, which is exactly how a
backlog stops being trusted.

So Brain gets its own item kinds:

| Kind | What it is |
|---|---|
| **Skill** | something you can do, better with practice |
| **Knowledge** | something you understand |
| **Life improvement** | something you are changing about how you live |
| **Experience** | something you want to have done |
| **Curiosity** | something you want to look into, with no commitment yet |

## States, not completion

| State | Meaning |
|---|---|
| **Interested** | noted, not started. The honest home for a passing thought. |
| **Learning** | actively taking it in |
| **Practising** | doing it repeatedly to get better |
| **Learned** | it is yours now |
| **Dropped** | deliberately stopped, and that is a real answer |

**Dropped is a first-class state, not a failure.** Deciding not to pursue
something is a decision worth recording; deleting it loses the fact that you
considered it, and leaving it "Interested" forever makes the list a graveyard.

Note that these are not a linear pipeline. Curiosity can go straight to Dropped.
A Skill can return from Learned to Practising. Nothing forces a sequence.

## A future Today surface

Today may later show a small number of **selected active** Brain items — not the
list, a selection. Growth deserves a place in a day without competing with the
work that day actually requires.

Rules that must hold when it is built:

- it is a **third** surface, alongside standalone Tasks and Project Tasks, not a
  bucket and not a task list;
- Brain items are never dragged into a time bucket;
- the daily arrangement does not touch them — it sorts standalone Tasks, and a
  Growth item is not one;
- an item appears there because the user selected it, never automatically.

## Skills & Knowledge history

Items that reach **Learned** may enter a lasting history — what you have picked
up, and when. This is the counterpart to completed-task history: one is what you
did, the other is what you became.

---

## Why this is deferred

Brain needs the Library to exist first — a Skill points at durable resources
(articles, courses, notes), and Library owns durable resources. Building Brain
before Library would mean Brain inventing its own storage for them, which is the
second-source-of-truth mistake this codebase has spent several phases removing.

The order is Library, then Brain, then the Today Growth surface.
