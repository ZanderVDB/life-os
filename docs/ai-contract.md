# The assistant contract

*Written before the assistant existed, on purpose.*

> **Status: historical, and still accurate about the interface.**
>
> This document describes the client-side proposal contract as it was designed
> in Phase 1, before any model existed. The shapes it defines are still what
> the browser renders — but the assistant is now real, and several sentences
> below describe a world that has moved on. Where this document and
> [`ai-system.md`](ai-system.md) disagree, **`ai-system.md` is the current
> one.** In particular:
>
> - the proposal set is authored and held by the SERVER, not by a provider in
>   the browser. The client renders a copy and asks the server to change it;
> - `assistant-mock.js` is not the provider any more. It survives only as fixed
>   transcripts standing in for a microphone during development;
> - the action layer described at the end IS built: `api/src/ai/executor.ts`,
>   behind `api/src/ai/confirm.ts`;
> - there are AI tables, a model provider and a real API, all server-side.
>
> It is kept because the reasoning is still the reasoning: the rules about what
> an assistant may do were settled before a model could argue with them, and
> that is why they held.

The shape of what an assistant is allowed to do is a product decision. It is
not something to be discovered after a model has been wired in and has already
moved somebody's meeting. So the interface, the proposal format and the
confirmation gate are built first, and the model arrives behind them.

Code: `web/assistant-contract.js`. The prototype provider: `web/assistant-mock.js`.
The surface: `web/assistant.js`. The visuals: `web/assistant-orb.js`.

---

## The flow

```
VOICE or TEXT
      │
      ▼
TRANSCRIPT            live, on screen, above the orb
      │
      ▼
provider.propose()    the only method a provider has
      │
      ▼
PROPOSAL              structured, itemised, and readable as English
      │
      ▼
USER EDITS            change a field, switch an item off, drop a card
      │
      ▼
CONFIRM n CHANGES     the number is derived from the list, never typed
      │
      ▼
ACTION LAYER          not built yet. This is where it plugs in.
```

There is **no arrow from listening to writing**. That is the whole design.

## Why not just execute?

Speech recognition mishears. A model misreads intent. Both will happen, and
neither is a reason not to build this — they are the reason the interface is
shaped like this.

A proposal that is wrong is a card you correct or switch off. A silent write
that is wrong is a deleted meeting other people were invited to. The cost of
being wrong is what decides the interaction, not the confidence of the model.

## The provider interface

```js
provider = {
  id: 'mock' | 'llm' | …,
  label: string,                       // said out loud on the surface
  propose({ text, context }) -> Promise<AssistantResponse>
}
```

A provider has **one method**, and it returns a description. It is handed no
API client, no workspace id, no token. A provider that wanted to write could
not — the capability is absent rather than merely unused.

`context` is read-only and is what makes proposals specific rather than
generic: the areas that exist, the projects, today's counts, what is next. It
never contains credentials.

## The response

```js
AssistantResponse {
  id:         string
  transcript: string
  understood: string          // the heading above the cards
  reply:      string | null   // for a question, rather than a change
  proposals:  Proposal[]
}

Proposal {
  id:      string
  kind:    keyof KINDS        // 'task.create', 'event.update', 'answer', …
  title:   string             // "Haircut"
  summary: string             // rebuilt from fields; never stored stale
  context: string | null      // the quiet line — "3:00–4:00 is free"
  enabled: boolean
  fields:  Field[]            // editable
  items:   SubItem[]          // each individually toggleable
  target:  object | null      // ids the executor will need
}

Field  { key, label, type: 'text'|'date'|'time'|'duration'|'choice'|'note',
         value, options? }
SubItem { id, label, enabled }
```

An unknown `kind` is **dropped with a note**, not rendered. An assistant that
half-understands a suggestion should say so rather than showing something the
app cannot actually do.

## Counting

`changeCount(proposals)` is the number on the button. Sub-items count
individually — three groceries is three changes — because that is what the
person is agreeing to. A proposal switched off contributes nothing, and an
`answer` contributes nothing, because agreeing with an answer is not an action.

The number on the button and the list on the screen must always agree. If they
ever disagree, the number is the thing to fix.

## The gate

```js
assertConfirmable(proposals, { confirmed: true, count })
```

Called by the executor before it touches anything. It throws — deliberately
blunt, because a confirmation that is merely recommended is one that somebody
eventually ships around. The **count is part of the confirmation**: if the list
changed between the button being drawn and being pressed, the person agreed to
a different set of changes than the one about to run.

`isImportant(kind)` marks the changes that must never be committed on the
strength of a voice command however confident the model is — a calendar move,
a deletion, a project's state, a completion. These are the ones where being
wrong destroys something that cannot be recovered by pressing undo.

## Replacing the mock

1. Write a provider with `id`, `label` and `propose`.
2. Change one line in `web/assistant.js`:
   ```js
   const provider = mockProvider;   // ← this
   ```
3. Delete `web/assistant-mock.js`.

Nothing else moves. Every proposal shape, every edit operation, the counting,
the confirmation gate and the whole surface are built against the contract, not
against the mock.

## The action layer, when it is built

It receives `(proposals, confirmation)` and it must:

- call `assertConfirmable` first, and let it throw;
- execute only proposals where `enabled` is true;
- execute only sub-items where `enabled` is true;
- treat each proposal as its own transaction — one failure must not silently
  half-apply a batch of six;
- report what it did in the same language the cards used, so somebody can
  check the result against what they agreed to.

## What was deliberately not here — and what arrived

At the time of writing: no LLM API, no model provider, no embeddings, no AI
tables. That phase was the mobile experience and the assistant's *interaction*,
and the mock was labelled as a prototype on every surface it appeared on —
because a fake that writes real rows is indistinguishable from a working
assistant right up until somebody trusts it.

Since then, and documented in [`ai-system.md`](ai-system.md):

| then | now |
|---|---|
| no model provider | `api/src/ai/providers/anthropic.ts`, behind a job router (§13) |
| no AI tables | `ai_memories`, `ai_memory_candidates`, `ai_conversations`, `ai_turns` |
| the action layer "not built yet" | `executor.ts` and `confirm.ts`, with the gate this document specified |
| the provider ran in the browser | the browser holds a turn id and a version; the proposal set lives on the server |
| no embeddings | still none, and §5b says why that is a decision rather than an omission |

The requirements this document set for the action layer — assert confirmable
first and let it throw, run only what is enabled, one transaction per action,
report in the same language the cards used — were implemented exactly, and are
tested.
