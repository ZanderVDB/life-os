# Diary — editor and save model (Phase D1)

Diary uses the Library editor. Same document grammar, same block rules, same
save guarantees — bound to a different endpoint and a different unit of work.

## The editor

Body, Heading, Subheading, Quote; bold, italic, underline, strikethrough;
bullet and numbered lists; link; undo; redo. The same restrained set, in
Diary's own chrome. No colours, no fonts, no sizes.

Everything routes through `execCommand`, which is deprecated and is still the
only API that edits a contenteditable while keeping the browser's undo stack.
Nothing it produces is stored: `htmlToDoc` reads the DOM back through a fixed
grammar, so a stray wrapper contributes its text and nothing else.

Paste is taken as plain text. Whatever was copied is usually a whole styled
document, and re-blocking the text is the only way to be certain nothing enters
that the model cannot describe.

The F2.1 block grid applies, because Diary uses ruled paper:

    height = (lead + lines) x 30px

Lead is **padding**, and a lead row is **unruled** — `h2::before` paints paper
over it. A writable blank line always has a rule; typography-owned space never
does. Without that, a heading draws a ruled line the caret cannot reach.

### The blank-page prompt

A contenteditable is never `:empty` — it holds `<p><br></p>` — so `:empty` and
`:placeholder-shown` are both useless here. The prompt is driven by the same
text test the server uses to decide whether a day is worth a row, which also
means the prompt disappears exactly when the entry becomes real.

## Saving

Five states: `Saved`, `Unsaved`, `Saving…`, `Save failed`, `Changed elsewhere`.

Keyed by **date**, not by entry id — the date is the only stable handle a blank
day has, and the first successful write is what brings the row into being.

- One writer per date. A second flush waits for the first, then sends whatever
  is pending by then, coalescing a burst of typing into one more write.
- Every write carries `expectedUpdatedAt` from the last successful response.
- **A response for a version already moved past updates the token and nothing
  else.** Without that, a slow save arriving after newer typing declares the
  newer text safe when the server has never seen it.
- A failure puts the content back into `pending`. Nothing is discarded because a
  request lost. Retry sends the same words again.
- A flush happens **before** anything takes the editor away: a date change, a
  move to history, leaving the route, closing the tab. `app.js` awaits
  `diaryWillLeave()` before the route changes, not alongside it. If the write
  cannot complete, the navigation is abandoned and the words stay on screen.

### An empty day is a successful save of nothing

The server answers a meaningless payload with `entry: null`. The coordinator
treats a `null` write result as **Saved** — there is simply still nothing to be
newer than. Without that a blank page would sit on "Unsaved" for ever while
correctly creating no row.

Fields (title, mood, energy, notes, summary) are **merged** rather than
replaced, so a title change and a mood change a moment apart both survive into
one write.

## Conflicts

A 409 stops the writer and asks. Three ways out, all of which keep the words:

- **Keep what I wrote** — re-reads for a fresh token, then writes over it.
  Deliberately a re-read, not a blind overwrite: the token has to come from the
  server or the next save conflicts again for the same reason.
- **Load the newer version** — copies the local writing to the clipboard
  *first*, then replaces the entry.
- **Copy my writing** — clipboard only, nothing changes.

No automatic merge. There is no structured rich-text merge here, and pretending
to have one would silently interleave two days of thought.

Verified in a browser: a second client wrote the day, the first typed, got the
dialog with its local text still on screen, chose Keep what I wrote, and the
server ended holding it.
