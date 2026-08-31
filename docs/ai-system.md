# The Life OS AI system

The canonical document for the assistant: what it is for, how it is built, and
what is actually true of the code today. Kept current in every AI phase.

> `ai-contract.md` remains authoritative for the **client-side** proposal
> contract — the proposal shapes the UI renders, the edit operations, the
> counting, and the confirmation gate. This document is the system around it,
> and repeats it only where the server had to mirror something.
>
> `relationships.md` is authoritative for the relationship graph.
> `ai-surface-map.md` is the map of what exists to reason about.

**Status: Phase 1 (foundation) complete.** There is no planner and no model
configured. §20 says exactly what was built and what was not.

---

## 1. Product vision

Not "a chatbot inside a productivity app". The assistant is meant to be the
intelligence layer across a life: it hears a sentence, understands which of
the user's systems it touches, retrieves only what matters, proposes changes
the user can edit, and — after an explicit yes — carries them out through the
same services the buttons use.

The load-bearing sentence:

> **Life OS does not become a place where AI lives. AI becomes a way of using
> Life OS.**

Everything below follows from it. The assistant owns no data, defines no
business rule, and has no capability the application does not already have.
If the assistant were deleted tomorrow, nothing about Life OS would break —
which is the test of whether it has been built in the right place.

---

## 2. User experience

**Capture is one gesture.** Speak or type into the composer. Nothing about
what happens next depends on the user having phrased it well.

**The reply is a set of cards, not a paragraph.** One card per change, each
saying what it will do, in the user's own terms, with the assumptions made on
their behalf written on it. A misheard item is switched off or edited; it is
never a reason to start again.

**Nothing happens until it is confirmed.** The button says how many changes it
will make, and that number is part of the agreement — see §8.

**An answer names what it read.** "Because the meeting is linked to that
task" beats an assertion the user has to take on trust.

**What Life OS knows about you is a screen you can edit.** Not a hidden
profile. §11.

### The path a request takes

```
USER
  → voice or text, plus the surface they were on
  → CONTEXT ENGINE     level 1 surface · level 2 targeted + traversal · level 3 broad
  → PLANNER            capabilities and rules from the registry, sources, memory
  → PROPOSAL SET       actions, assumptions, warnings, confidence
  → USER EDITS         switch off, change a field, ask a question back
  → CONFIRMATION       counted, and important actions accepted one at a time
  → EXECUTOR           validates each payload, resolves each capability
  → APPLICATION SERVICES   the same functions the UI calls
  → DOMAIN STATE + RELATIONSHIPS
```

There is no arrow from listening to writing.

---

## 3. Architecture

```
api/src/ai/
  types.ts            every shared contract. Imports no table and no model.
  registry.ts         the Capability Registry. What can be done, right now.
  modules/            one file per domain; each declares its own capabilities
    tasks.ts  projects.ts  calendar.ts  reminders.ts  relationships.ts
    misc.ts   (habits, areas, diary, library)
    index.ts  ← THE list. Adding a module is a line here.
  context.ts          the Context Engine: three retrieval levels
  executor.ts         the only thing that changes anything
  memory.ts           Personal Memory + candidates
  provider.ts         provider abstraction and job router
  index.ts            composition

api/src/lib/actions/  application services — the business rules, callable by anything
  tasks.ts  reminders.ts  habits.ts  projects.ts  index.ts

api/src/routes/ai.ts  thin: parse, authorise, hand over
```

Two rules hold the shape:

1. **A capability is an adapter, not a rule.** It validates its input and calls
   a service. When one grows a rule, that rule now applies to the assistant and
   not to the person using the app — which is the split this design exists to
   prevent.
2. **The executor has no path to a table.** No schema import, no `db.insert`,
   no per-module branch. Enforced by a test that reads the file.

---

## 4. Capability Registry

The heart of it. `api/src/ai/registry.ts`.

The obvious alternative is a large system prompt listing everything the app can
do plus a switch statement that carries it out. Both halves rot the same way:
the prompt keeps advertising a feature after it is removed, and the switch
grows a branch per module until the assistant is where the business logic
lives.

So **capability is declared by the module that owns it.**

```ts
type AiModule = {
  id: string;
  name: string;
  entities: EntityType[];          // relationship types it owns
  rules: string[];                 // planning constraints, in plain words
  available: (ctx) => { enabled: boolean; reason?: string };
  capabilities: Capability[];
};

type Capability = {
  id: string;                      // 'task.create' — stable; appears in proposals
  module: string;
  kind: 'search' | 'read' | 'traverse' | 'mutate';
  label: string;
  description: string;             // written for a planner to read
  input: ZodType;                  // the only accepted shape
  risk: 'safe' | 'confirm' | 'important' | 'external';
  run?:     (ctx, input) => Promise<ContextSource[]>;   // reads
  preview?: (ctx, input) => Promise<{ summary, warnings, handle }>; // plan-time
  execute?: (ctx, input) => Promise<ActionResult>;      // writes, after confirmation
};
```

**Availability is asked, not assumed.** Calendar is registered on every
deployment and unavailable until a Google account is connected with write
scope. Two workspaces get different answers from the same registry.

**Removing a module removes its capabilities everywhere.** Not just from the
listing — `registry.resolve()` returns null for a capability whose module is
absent or disabled, and the executor treats that as a failed action with a
reason. A proposal made before Calendar was disconnected cannot run after.

Construction is validated: a duplicate module id, a capability claiming a
module it was not registered by, a `mutate` with no `execute` or a read with no
`run` all throw at boot rather than at the first request.

**Adding Finance later** is `modules/finance.ts` plus one line in
`modules/index.ts`. No planner change, no prompt change, no executor change, no
new proposal kind.

**`GET /ai/capabilities`** is the answer to "what can the assistant currently
do", and it is the only answer.

---

## 5. Context Engine

`api/src/ai/context.ts`. The thing it exists to avoid is putting the user's
whole Life OS into every model call — expensive, slow, and *worse at
answering*, because a model given four hundred rows finds the wrong one
confidently.

**Level 1 — current surface.** What the user was looking at. "Move this to
Friday" is unanswerable without it and unambiguous with it. One read.

**Level 2 — targeted retrieval, then traversal.** Search the modules the
request concerns, then walk relationships out from the best few hits. This is
the level that answers *"what do I need before the Trifusion meeting?"* — find
the event, walk to its linked preparation task, walk to the page that task
uses. Text search would return every mention of the word and miss the task that
prepares for it, because nobody wrote the client's name in its title.

**Level 3 — broad.** For "what has been taking most of my attention lately".
Queries several modules, is expected to be expensive, and is opt-in rather than
a fallback.

Results are deduplicated keeping the *lowest* level of each entity: something
found on the current surface is a better description of itself than the same
thing found again by a broad search. A ceiling stops a well-connected object
flooding the context, and `truncated` says when it did.

`POST /ai/context` exposes the whole thing without a model, which is how the
levels are exercised and how a wrong answer is traced back to what was read.

---

## 6. Planner

**Not built in Phase 1**, deliberately. A planner needs a model; wiring one in
before the contracts around it were settled is how the model ends up holding
the business logic.

What exists for it:

- `PlanInput` in `provider.ts` — the exact shape a planner receives:
  the request, the **capabilities from the registry** (never a static list),
  the **module rules**, the retrieved sources, and the user's memory.
- `registry.describe(ctx)` builds that capability and rule list per request.
- `ProposalSet` is the required output shape.

The planner will never be given a database handle. It returns a description;
the executor is what acts.

---

## 7. Proposal system

`ProposalSet` → many `ProposalAction`. A single utterance is often several
unrelated changes — *"I finished the website, I need a haircut tomorrow, add
milk and chicken to groceries and move my meeting with John from 2 to 3"* is
four — so each action stands or falls alone.

Each action carries:

| Field | Why |
|---|---|
| `id`, `capability`, `module` | names a capability, never a table or a function |
| `title`, `summary` | what the card says |
| `payload` | validated against the capability's own schema before it runs |
| `target`, `result` | what it acts on; what it produced |
| `confidence` | §12 |
| `assumptions` | interpretations made on the user's behalf, in plain words |
| `warnings` | true and unwelcome: a clash, a read-only calendar |
| `requiresConfirmation`, `important` | §8 |
| `editable` | fields the card may offer, and their types |
| `enabled` | off means "do not run this one" |
| `sources` | what it was based on |

A set can also carry an `answer` (a question answered rather than a change) and
a `clarification` (§12).

The full proposal *UI* is not rebuilt in this phase; the existing composer is
untouched. `web/assistant-contract.js` remains the client-side contract and its
shapes line up with these.

---

## 8. Confirmation model

`assertConfirmable` in `executor.ts`. Deliberately blunt: it throws. A
confirmation that is merely recommended is a confirmation somebody eventually
ships around.

1. **There must be an explicit confirmation.** No confirmation, no execution.
2. **The count is part of the agreement.** If the list changed between the
   button being drawn and being pressed, the person agreed to a different set
   of changes from the one about to run.
3. **Important actions need their own yes.** The batch confirmation does not
   cover them. A meeting other people were invited to, a completed task, a
   project's state, a removed relationship — each is accepted individually,
   however confident the model was.

Risk levels map to this: `safe` and `confirm` are covered by the batch;
`important` needs its own acceptance; `external` needs its own acceptance *and*
passes through the target system's own gate (§16).

---

## 9. Executor and action services

**The executor** (`ai/executor.ts`) may do exactly five things: check the
confirmation, resolve the capability, validate the input, call it, record the
result. It has no db import, no table import, no domain knowledge, and no
per-capability branch. A test reads the file and fails if that changes.

Each action is **its own transaction**. A batch of six is six independent
agreements: one failing must not roll back the five that worked, because "I
added the milk but not the chicken" is a true and useful report and "the whole
thing failed" is neither.

**Application services** are the rules, callable by anything:

| Service | Functions | Used by |
|---|---|---|
| `lib/actions/tasks.ts` | `createTask` `updateTask` `setTaskDone` `scheduleTask` | task routes **and** the AI |
| `lib/actions/reminders.ts` | `createReminder` | reminder route **and** the AI |
| `lib/actions/habits.ts` | `checkHabit` | habit route **and** the AI |
| `lib/actions/projects.ts` | `updateProject` (+ `loadProject`, `assertFresh`) | project route **and** the AI |
| `lib/relationships.ts` | existing service, unchanged | every Related section **and** the AI |
| `lib/calendar-mutations.ts` | existing service, unchanged | calendar routes **and** the AI |

The extraction was behaviour-neutral: the route handlers now parse, authorise
and hand over, and the whole suite passed unchanged. A rule tightened for the
UI is now tightened for the AI on the same line of code.

**Not extracted, and therefore not offered:** task ordering and steps (driven
by a pointer against a rendered list; meaningless in a sentence), project
creation and completion (completion has to ask about open tasks — a
conversation, not a field change), library page writes (§19).

---

## 10. Relationship traversal

The assistant uses `item_links` through `lib/relationships.ts` — the same
service every Related section calls. **There is no AI-specific relationship
store, and there will not be one.** A link the assistant creates appears on
both objects immediately, because it is the same row the UI would have written.

| Capability | Does |
|---|---|
| `link.inspect` | what one thing is connected to, both directions, correct wording per end |
| `link.traverse` | walk out up to 3 hops, breadth-first, cycle-safe |
| `link.create` | propose a relationship; refuses the coupled kind |
| `link.remove` | remove an edge; *important* — it destroys a judgement |

Traversal is breadth-first with a visited set, so a cycle terminates and the
path recorded for each node is the **shortest** one — which is the path a
person would give as the explanation. Every traversed source carries that path,
so an answer can say *how* it got somewhere instead of asserting a connection.

`scheduled_as` remains the only coupled kind, and `createLink` refuses it —
including to the assistant. That is the single most important refusal in the
system: a wrong `related` edge is a wrong sentence a person can delete, but
coupling moves real time and reaches a system other people can see.

---

## 11. Personal Memory

Different from ordinary Life OS content, and the line is sharp:

| Belongs in memory | Belongs in Life OS |
|---|---|
| Prefers afternoon meetings | Haircut tomorrow → a task |
| John Mercer works with me on WebAnchor | Call John Friday → a reminder |
| Groceries go in the Groceries list | WebAnchor redesign → a project |
| Prefers concise emails | Notes from today's meeting → diary or a book page |

The test is three words: **durable, useful, personally relevant.** A fact that
will be false next week, or that changes no future answer, is conversational
trivia; storing it makes the memory longer and the assistant worse, because
every future prompt carries it.

### Storage

`ai_memories` — workspace **and** user scoped, because "prefers concise emails"
is about a person and a workspace can have members.

| Column | Notes |
|---|---|
| `category` | profile · preferences · people · places · routines · work_style · communication · defaults · interests · other |
| `fact` | one durable sentence, never a transcript fragment |
| `confidence` | 0–1 |
| `source` | user · assistant · derived · import |
| `is_pinned` | the user said this is right |
| `superseded_by_id`, `superseded_at` | replaced, not deleted |
| `source_ref_type`, `source_ref_id` | provenance, when it came from something with an id |
| `last_used_at` | so the useful ones stay near the top |

**Superseding, not accumulating.** A newer statement of the same belief marks
the old one superseded and points at its replacement, so "you used to say
mornings" is answerable and a wrong replacement can be traced. Nothing
superseded ever reaches a prompt.

**Pinned memory is never superseded automatically.** The user said it is right;
changing it silently is exactly the behaviour that makes a memory system feel
like it is making things up.

**Forgetting really deletes.** "Forget that" has to mean gone, or the control
is a lie.

### Candidates

`ai_memory_candidates`. A model does not write memory — it produces candidates,
and the service decides: near-duplicates (normalised for case and punctuation)
are dropped and merely refresh the existing row's `last_used_at`; everything
else waits to be accepted or rejected. A model that wrote directly would write
whatever it misheard, and a wrong durable fact is worse than a wrong answer
because it repeats.

### The intended UX

A Settings screen — **"What Life OS knows about me"** — listing every live
memory in the user's own words, grouped by category, each editable, pinnable
and deletable, with pending candidates offered for a yes or no. `GET
/ai/memory` is the query behind it. *Not built in Phase 1* — no UI was added,
because none was needed to validate the service and the prompt asked for no
unnecessary UI.

---

## 12. Ambiguity and confidence

Clarification is the **last** resort, not the default. A question back costs
the user a turn; a visible assumption costs them a glance.

| Confidence | Behaviour | Example |
|---|---|---|
| **high** | Propose it. | "Remind me tomorrow to call Dad." |
| **medium** | Propose it **with the assumption written on the card.** | "I need the proposal done Friday." → a task due Friday, and the card says *Read as a deadline, not a working session.* |
| **low**, and the consequence matters | Ask. | "Move my meeting with John." — three meetings match. |

Two conditions must both hold before asking: low confidence **and** a
consequence worth a turn. Low confidence on something cheap and reversible is
still a proposal — that is what the edit controls are for.

`ProposalSet.clarification` carries the question and the options, each able to
name an entity so the answer is a choice rather than more prose.

---

## 13. Provider and model abstraction

`api/src/ai/provider.ts`. The jobs are not alike, so a provider answers **jobs**
and a router picks a provider per job:

| Job | Character |
|---|---|
| `interpret` | what is being asked, which modules. Cheap, frequent. |
| `plan` | request + context → proposed actions. The expensive one. |
| `answer` | answer from sources, with citations. |
| `summarise` | condense. |
| `extractMemory` | notice durable facts. Cheap, writes nothing. |

Swapping a model is a line in the router. Adding a strong provider for `plan`
and a cheap one for `interpret` and `extractMemory` is a line in the router.
Neither touches a capability, a service or a route.

**A provider is structurally denied a database handle.** Every job takes plain
data and returns plain data; there is no argument through which one could reach
a table. It cannot write even if it decided to.

`deterministicProvider` ships now and needs no model: it handles `interpret`
(crudely, to narrow retrieval — being wrong costs a wider search, never a wrong
write) and `summarise`. It deliberately does **not** implement `plan`. Guessing
at multi-step intent without a model is exactly the confident wrong answer this
architecture exists to keep away from the database. With no planner,
`GET /ai/capabilities` says so plainly rather than leaving it to be inferred.

---

## 14. Source, citation and traceability

Every retrieved fact is a `ContextSource` carrying `ref` (a real entity type
and id), the `module` that produced it, `via` (`surface` | `direct` |
`relationship`), the relationship `path` when it was traversed, and the
retrieval `level`. An answer that cannot name what it read is an answer nobody
can check, and a wrong answer nobody can check is worse than no answer.

`Trace` records one turn: which modules were enabled, which capabilities were
offered, which sources were retrieved (as refs), what was planned, what was
executed, and which provider answered which job.

**Traces hold ids and names and nothing else** — no transcript, no field
values, no retrieved text — and are **not persisted**. Persisting them is a
privacy decision this phase has not made; a trace that quotes the user's diary
is a second copy of it.

---

## 15. Adding and removing modules

**To add one:** write `modules/<name>.ts` exporting an `AiModule`, add it to
the array in `modules/index.ts`. That is the whole procedure. Its capabilities
appear in `GET /ai/capabilities`, in what the planner is told it may do, and in
what the executor will resolve.

**To remove one:** delete the line. Its capabilities disappear from all three,
including — the part that matters — from `registry.resolve()`, so an action
proposed before the removal fails with a reason instead of running.

**To disable one per workspace:** return `{ enabled: false, reason }` from
`available()`. Identical effect, decided per request.

Requirements on a new module: capability ids are `<module>.<verb>`; every
`mutate` calls an application service and contains no rules; `description` is
written for a planner and states the limits; `rules` are the sentences that
stop a plausible plan from being wrong.

---

## 16. Security and mutation rules

1. **No LLM output reaches the database.** A provider returns a description.
   The executor acts, only after `assertConfirmable`.
2. **Every mutation goes through an application service.** Enforced
   structurally: the executor cannot import the schema.
3. **Every payload is validated against the capability's own schema** before
   the service sees it. A hallucinated field is rejected at the boundary.
4. **Google is never reached without a proposal.** `preview` writes a row into
   the `calendar_mutations` ledger keyed by a `requestId`; `execute` takes only
   that `requestId` — no draft, no calendar, no event id. There is no path from
   an assistant action to Google that the ledger did not record first, and
   `executeMutation` checks the event's `etag` before it writes. **The
   assistant cannot invent an event; it can only confirm one that was
   proposed.**
5. **A recurring occurrence is identified by its local row id**, never by title
   and date. Google is polled with `singleEvents: true`, so each occurrence is
   already its own row with a stable id. Changing one occurrence is not
   changing the series.
6. **A task due date is not a calendar event.** Scheduling a task sets
   `scheduledAt` and creates nothing external. Reserving time is a separate,
   explicit, confirmed action.
7. **`dueDate` ≠ `scheduledAt`, `status` ≠ `focus`.** Stated as module rules,
   enforced by the services, and tested.
8. **Relationships go through `item_links`.** No second graph.
9. **Memory is user- and workspace-scoped**, visible, editable and deletable.
10. **Traces carry no content.**

---

## 17. Currently registered modules

| Module | Available when | Capabilities |
|---|---|---|
| **tasks** | always | `task.search` `task.read` `task.create` `task.update` `task.complete` *(important)* `task.schedule` |
| **projects** | always | `project.search` `project.read` `project.update` *(important)* |
| **calendar** | Google connected **with write scope** | `event.search` `event.read` `calendar.availability` `calendar.list` `event.create` `event.update` `event.delete` *(all external)* |
| **reminders** | always | `reminder.search` `reminder.create` |
| **habits** | always | `habit.list` `habit.check` |
| **areas** | always | `area.list` |
| **diary** | always | `diary.read` `diary.search` |
| **library** | always | `library.search` `library.readPage` |
| **relationships** | always | `link.inspect` `link.traverse` `link.create` `link.remove` *(important)* |

Nine modules, **29 capabilities**, 12 of them mutations.

In a workspace with no Google account connected, `GET /ai/capabilities` returns
**22** — Calendar's seven are absent, with the reason stated. That difference
is the registry working, not a bug to reconcile.

---

## 18. Future modules

Registerable without touching the planner, the executor or the proposal model:
**Finance**, **Food**, **Groceries**, **Email**, **Goals**, **Circles**.

None is built and none should be started as part of an AI phase — the point of
the registry is that they do not have to be.

**Brain is cancelled** as a product area. Its knowledge-storage role was
absorbed into Library; what remains of the idea *is* this system.

---

## 19. Known gaps

1. **No planner, and therefore no end-to-end turn.** §6. The pieces are built
   and tested; the turn is Phase 2.
2. **No model provider.** Only `deterministicProvider`. The router and the job
   split exist; nothing is wired to an API.
3. **No library page writes.** Page documents are saved through an editor with
   its own conflict model; there is no application service for a blind append,
   and inventing one inside a capability would put the rule in the wrong place.
   `library.append` is in the *client* contract and has no server capability.
4. **No project creation or completion.** No application service for create;
   completion has to ask about open tasks.
5. **No task steps or reordering.** Pointer-driven, no sentence maps to them.
6. **No diary writing.** A diary somebody else wrote in is not a diary.
7. **Memory UI is designed but not built.** §11.
8. **Traces are not persisted.** §14.
9. **`interpret` is keyword-based** in the deterministic provider. It narrows
   retrieval and nothing else, so being wrong costs a wider search.
10. **Search is `ILIKE`.** No embeddings, no ranking. Adequate for targeted
    retrieval alongside traversal; it will not answer a vague question well.

---

## 20. Implementation status and changelog

### Phase 1 — foundation (this pass)

**Built and tested:**

- Capability Registry, with per-request availability and resolution.
- Nine modules, 29 capabilities, declared by the domains that own them.
- Four new application services; four route handlers refactored to call them.
  Behaviour-neutral — the whole suite passed unchanged.
- Executor with the confirmation gate, per-action transactions, payload
  validation, and no path to a table.
- Context Engine with three retrieval levels, relationship traversal and
  provenance on every source.
- Personal Memory: two tables, migration `0015_ai_memory.sql`, full service
  with superseding, pinning, candidates and deduplication.
- Provider abstraction with a job router and a deterministic provider.
- Typed contracts for context, sources, proposals, execution, memory,
  providers and traces.
- Routes: `GET /ai/capabilities`, `POST /ai/context`, `POST /ai/execute`,
  `POST /ai/preflight`, and `/ai/memory` CRUD plus candidates.
- 24 focused tests in `api/tests/ai-foundation.test.ts`.

**Deliberately not built:** planner, model provider, assistant UI changes,
memory UI, trace persistence, any new product module.

**Database:** `ai_memories`, `ai_memory_candidates`. Additive and idempotent;
no existing column altered, no user data read or rewritten.
