# Library — the document and save model (Phase F1)

Two decisions, and the second only works because of the first.

---

## 1. A page is a document, not HTML

Legacy stored `contenteditable.innerHTML` directly. Its own source comment
records what that cost:

> execCommand (especially insertOrderedList / removeFormat) can leave behind
> `<font color="black">` wrappers or inline `color:black` styles, which made
> un-numbered text vanish on the dark theme.

The workaround was `!important` on every descendant of a cell. That is the shape
of the problem: **the data carried presentation decisions nobody made**, and
every future renderer inherits them.

So the wire format is a small, closed grammar:

```
doc         { type:'doc', content: Block[] }
Block       paragraph | heading | bulletList | orderedList | blockquote
heading     attrs.level ∈ {2, 3}
listItem    contains paragraphs
Inline      { type:'text', text, marks?: Mark[] }
Mark        bold | italic | underline | strike | link{href}
```

### Why this and not the alternatives

**Not HTML**, for the reason above, and because "sanitised HTML" is a
never-ending arms race against an input surface you do not control.

**Not Markdown.** It cannot express what Library already needs to grow into —
an embedded image with an id, a Task reference, a Library link, an AI proposal.
Each would need invented syntax, and then a parser nobody else can read.

**Structured JSON**, because every one of those is a *node with attributes*.
Adding `libraryRef` or `taskRef` later is adding a case to `cleanBlock`, not
inventing a language.

### Validation, not sanitisation

There is no HTML to sanitise because none is ever accepted. `validateDoc` walks
the incoming tree and keeps only what it recognises.

**Unknown nodes are dropped, not rejected.** A 400 on an unrecognised node would
lose everything the user just wrote in order to salvage nothing. Dropping one
node keeps the page. What it must never do is *store* something it does not
understand — that is what comes back to bite.

**Links are `http(s)` only.** `javascript:`, `data:` and `file:` lose the mark
and keep the words, so a bad href costs you a link, not a sentence.

**Headings are two levels.** A page is not a document outline, and `h1` belongs
to the book.

---

## 2. Saving is ordered, and never silently loses

`PATCH …/library/pages/:id` accepts `expectedUpdatedAt`. If the stored
`updated_at` differs, the write is **409** and the caller re-reads.

That is the guard against the two failures that actually happen:

- **two tabs.** The second one's save carries a timestamp from before the
  first's, and is refused rather than winning by arriving later.
- **a stale response.** A slow save issued at T1 landing after one issued at T2
  cannot overwrite the newer content.

Verified by test: two writes with the same `expectedUpdatedAt`; the first
succeeds, the second 409s, and the stored content is the newer one.

### What the client must do with it

Not built in F1 — the client layer is the next step — but the contract it has to
honour, so the requirement is recorded now:

- debounce, then flush on **page turn**, **section change**, **book close** and
  **navigation away**;
- keep the local text on failure and show `Save failed` with a retry — never
  clear the editor;
- never render a blank page because a save failed;
- carry `expectedUpdatedAt` from the last successful response, so ordering is
  the server's decision rather than the network's;
- warn before discarding unsaved content.

Status vocabulary: `Saved`, `Saving…`, `Unsaved`, `Save failed`.

These are the same rules E2.4 established for Task notes after they were lost,
and E2.6 for steps. The point of writing them here before the editor exists is
that Library should not have to learn them the same way.

---

## Workspace isolation

Every Library table carries `workspace_id` and every route filters on the
resolved workspace before doing anything else. A cross-workspace id is a 404,
not a 403 — the existence of another workspace's book is not information this
workspace is entitled to.

Verified by test across get, update, page save and archive.
