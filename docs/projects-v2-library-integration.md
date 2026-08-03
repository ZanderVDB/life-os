# Library ownership — the rule (not built)

**Library does not exist in E2.** No Resources section, no Files tab, no upload
control, no empty placeholder anywhere in Projects. This document locks the
ownership rule so that when Library arrives, Projects does not have to be
unpicked first.

---

## The rule

> **Projects organise resources. Library owns them.**

A Project links to a Library item. It never holds a copy, never owns a file
record, and never becomes the place a document lives.

```
library_item          ← the ONE record. Owns the file, the metadata, the versions.
    ▲   ▲   ▲   ▲
    │   │   │   └── diary entry links to it
    │   │   └────── brain idea links to it
    │   └────────── board places it
    └────────────── project links to it
```

The same Library item may appear in several Projects, several Boards, a Diary
entry and a Brain idea **at once**, and there is still exactly one of it. Rename
it, replace it, delete it — every reference sees the same answer, because there
is only one answer.

## Why this is worth locking now

The alternative is what most tools do: a project "has files". It looks simpler
for about a month. Then the same brief exists in two projects with two names,
one is updated, and there is no way to know which. Search returns both. Deleting
a project deletes a document someone else was relying on.

Once Projects owns file records, undoing it is a data migration with no clean
answer for the duplicates.

## What Library will own

Images, video, PDFs, spreadsheets, documents, saved links, research notes,
meeting notes, briefs, templates, reference material. Storage is R2 — see
`r2-storage-architecture.md`.

## What Projects will do

Link, unlink, and show what is linked. That is the entire surface.

## The link model

`calendar_item_links` is already polymorphic and already names `library` as a
target type, so no schema change is needed to point a project at a Library item.
Its **name** is wrong for the job — a project-to-document link is not a calendar
concern. Renaming it to `item_links` is cheap now and expensive once Projects
ships against it; recorded in technical-debt.md.

## What E2 deliberately did not build

- No "Resources" section in Project detail.
- No file upload anywhere in Projects.
- No disabled buttons hinting at either.

An empty section on every project is a promise the app cannot keep, and it makes
the detail page longer while making it say less.
