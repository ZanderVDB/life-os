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

**Status: Phase 2 complete.** The assistant is real: a model plans, the server
holds the proposal, and confirmed actions run through application services.
§20 says exactly what was built and what was not.

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

**What Life OS knows about you is a screen you can edit.** Settings → AI &
personalisation. Not a hidden profile. §11.

### Where the assistant lives

**Desktop: a panel above the composer, not a page.** The composer bar at the
bottom of every screen is now a real input, and the conversation grows upwards
from it *over the page you are on*. That is not decoration — the assistant's job
is to act on what you are looking at, and navigating away to a chat transcript
throws away the one piece of context that makes "move this to Friday"
answerable. The surface is sent with every turn.

**Phone: the lotus screen**, unchanged in look. Speak or type, watch the orb,
get the same cards. Speech recognition remains an enhancement — it does not
exist in Firefox — so typing is always there, and fixed transcripts stand in for
a microphone during development. They produce text that goes to the same server
turn a spoken sentence would.

Speech goes **in** only. The assistant does not speak, and reading a response
aloud is planned rather than built — see §18.

**One card renderer for both.** `assistant-cards.js`. Two implementations would
drift, and the one that drifted would be the one somebody trusted.

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

### 5b. Ranking

`api/src/ai/ranking.ts`. Phase 1 retrieved with a bare `ILIKE` and no ordering,
which is adequate for a demo and useless for a real question.

**Not vectors, and deliberately.** The question this system gets is not "find
something semantically near this sentence" — it is *"what do I need before the
Trifusion meeting"*, and the answer is reached by walking one edge from a title
that matched exactly. An embedding index answers the easy half of that and none
of the hard half, alongside a relationship graph that already answers the hard
half precisely. `score()` is the single place vectors would be added when
recall-by-meaning is genuinely needed.

Signals, each bounded so none can dominate:

| Signal | Weight | Why it exists |
|---|---|---|
| exact title | 10 | a thing named in the request is what the request is about |
| title prefix / contains | 6 / 4 | partial names |
| token overlap | ≤5 | scaled by coverage **and** by how distinctive the word is |
| current surface | 12 | what the user is looking at beats what they are not |
| one relationship hop | 5 | the task nobody named, linked to the meeting they did |
| two hops | 2.5 | |
| open lifecycle | 1.5 | "what do I still need" means what is open |
| due soon | ≤2 | decays over a fortnight either side of today |
| recency | ≤3 | half-life of a fortnight |
| same project / area | 2 / 1 | applied in a **second pass**, from what the first ranked |

Token weight is inverse-frequency over the candidate set: a rare word is
evidence, a common one is noise. Without it, "meeting" pulls every event in the
workspace into a question about one meeting.

**Traversal is the heaviest structural signal**, which is the whole reason the
relationship layer was built. A test asserts that a linked task with no matching
words outranks six rows that merely contain the search term.

**Memory is ranked separately**: pinned, then confidence, then keyword overlap.
Relevance is last on purpose — "prefers afternoon meetings" often shares no word
with the request it should influence.

---

## 6. The turn

`api/src/ai/turn.ts`. One request, in order:

```
interpret   what is this about, which modules, what words to search for
gather      surface → targeted search → relationship traversal
rank        24 of ~200 rows, by signals Life OS already has (§5b)
memory      a bounded, ranked set of durable facts
plan        capabilities and rules FROM THE REGISTRY, sources, memory
preview     calendar actions go through the mutation ledger, here
persist     the proposal set is written down; the client gets its id
```

The model appears once, in the middle, and is handed data. Everything before it
decides what it may see; everything after it decides what may happen.

**Three turn types, and a request is not forced into one.** A question is
answered in `answer`; changes become `actions`; a request that is both gets
both, kept separate. *"What do I still need before Friday, and move John to 3"*
is one turn with an answer and one proposal.

**Every action the model returns is re-resolved through the registry** and
re-validated against the capability's own schema before it becomes a card. A
capability the model invented, or one belonging to a module that is off, is
rejected at plan time and recorded in `metrics.rejectedDetail` — not at
execution time, where it would have failed *after* the user agreed to it.

**The server decides risk.** `important` comes from the capability's `risk`,
never from the model. A model that classified its own permission level could
lower it.

### 6b. Conversation and follow-up

`ai_conversations` holds a thread; `ai_turns` holds each turn. A follow-up is
given the **pending actions by id and title** — a few hundred bytes — so
*"actually make it Saturday"* has something to be about. It is not given a
transcript: resending everything forever gets more expensive and less accurate
with every turn, and a test asserts the follow-up prompt stays under 600
characters.

Only a turn still `proposed` is pending. One already executed is history, and
"make it Saturday" about it is a new request.

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

### The proposal is the server's

Phase 1 let the client hand the executor a set. Safe — every action still had to
name a registered capability and pass its schema — but it meant the client could
confirm a set the planner never produced. Now:

```
POST   /ai/turn              plans, WRITES the set, returns id + version
GET    /ai/turn/:id          read it back; a refresh costs no planning
PATCH  /ai/turn/:id          edit, validated against the capability's schema
POST   /ai/turn/:id/confirm  names id + version + accepted important ids
POST   /ai/turn/:id/discard  throw it away
```

The confirm body has no field through which an action or a payload could arrive,
and the schema is `.strict()` so an attempt is a 400 rather than a silent extra.

| Protection | How |
|---|---|
| stale | the version confirmed must equal the version stored |
| fabricated | actions come from the row, never the request |
| replay | an executed turn returns its original result unchanged |
| concurrent | the status moves to `executed` in the statement that claims it |
| post-confirmation edit | editing a non-`proposed` turn is refused |
| partial | one action failing leaves the others done, and says so |

An **edited** action drops its assumptions: the value is now the user's
statement, not the model's guess.

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

### What the user sees afterwards

In the same language the cards used, and honest in both directions:

```
Done — 3 changes.            2 completed, 1 needs attention.
✓ Added "Haircut".           ✓ Added "Milk".
✓ Reminder set: "…".         ✓ Added "Chicken".
✓ Added to 31 Aug 2026.      ⚠ Task not found.
```

Three of four succeeding is three things that happened; it is never reported as
a failure, and a failure is never reported as a success. Confirming twice
returns the first result rather than doing the work again.

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
name an entity so the answer is a choice rather than more prose. The options
render as buttons; pressing one sends its label as the next turn **in the same
conversation**, so the server still has everything from the first.

Both conditions must hold before asking: low confidence **and** a consequence
worth a turn. The planner is told this explicitly — *"an editable card absorbs
ordinary uncertainty; a question costs the user a turn"* — and told that
everything unambiguous in the same request should still be proposed alongside
the question.

---

## 13. Provider and model abstraction

`api/src/ai/provider.ts` is the contract; `api/src/ai/providers/anthropic.ts` is
the **only file in Life OS that knows a model vendor exists**.

Five jobs, and a router picks a provider per job:

| Job | Model | Character |
|---|---|---|
| `interpret` | `AI_MODEL_FAST` | which modules, what words to search for. Every turn. |
| `plan` | `AI_MODEL_PLAN` | request + context → actions. The expensive one. |
| `answer` | `AI_MODEL_ANSWER` | answer from sources, with citations. |
| `summarise` | *deterministic* | trimming a string does not need a model. |
| `extractMemory` | `AI_MODEL_FAST` | notice durable facts. Runs after the answer. |

Defaults: **Sonnet 4.5** for `plan` and `answer`, **Haiku 4.5** for the cheap
jobs. Overridden by environment, never by editing code.

**Configuration.** `ANTHROPIC_API_KEY` is the only required variable. With none
the app still boots, every read still works, and the assistant says *"not
connected to a model yet"* — `GET /ai/capabilities` reports
`planner.available: false` with the reason, rather than leaving it to be
inferred from an absence.

**The browser never sees a key and never calls a provider.** A test asserts that
no web file references a vendor, an API host or a key prefix. A key in a browser
is a public key.

**Speech is not a sixth job.** When text-to-speech arrives (§18) it renders a
result that is already finished; it does not reason, so it does not belong in
this router alongside `plan` and `answer`. It gets its own small seam. Adding
`speak` here would quietly make the voice part of the assistant's thinking
rather than a way of presenting it.

### Structured output is not optional

A model asked for JSON returns JSON *usually*. The failure that matters is not a
parse error — it is a plausible object with a subtly wrong field: a capability
id that does not exist, a date as "next Friday", a payload missing the one
property the service requires.

So every response is parsed against a Zod schema, and a schema failure is
**retried with the error handed back to the model**, bounded at three attempts.
A model told twice exactly which field was wrong will not be fixed by a fourth
try. JSON is brace-matched out of the reply, so a fence or a sentence of preamble
does not cost a round trip.

Accepting a malformed plan would push the problem to the executor, where it
becomes an action that fails *after* the user confirmed it.

## 14. Source, citation and traceability

Every retrieved fact is a `ContextSource` carrying `ref` (a real entity type
and id), the `module` that produced it, `via` (`surface` | `direct` |
`relationship`), the relationship `path` when it was traversed, and the
retrieval `level`. An answer that cannot name what it read is an answer nobody
can check, and a wrong answer nobody can check is worse than no answer.

`Trace` records one turn: which modules were enabled, which capabilities were
offered, which sources were retrieved (as refs), what was planned, what was
executed, and which provider answered which job.

**A turn is persisted; its content is not.** `ai_turns` stores the request (the
user wrote it), what was understood, the answer, the proposal actions, and
`sources` as **entity refs only** — `{type, id}` with a title, never the
retrieved text. A test asserts no `data` field survives into the row. Storing
retrieved content would make this table a second copy of the user's diary.

`metrics` carries operating information and no content: elapsed ms, how many
rows were retrieved and ranked, how many actions were produced and rejected,
how many memories were used, which capabilities ran, and which model answered.
That is enough to answer "why was this slow" and "why did it propose that"
without keeping anything sensitive.

The UI shows sources as a quiet row of clickable chips under an answer — not a
citation report. Asking *"where did you get that?"* is answerable because the
refs are on the turn.

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
10. **Turns carry refs, not content.** §14.
11. **The browser never talks to a model.** No key, no vendor host, no direct
    call — asserted by a test over the whole web bundle.
12. **The client is not the authority on what exists.** It asks
    `GET /ai/capabilities`; its presentation table is labels and icons only.
13. **The model does not set its own permission level.** `important` comes from
    the capability's `risk`.
14. **A confirmed turn is immutable.** Editing one is refused; replaying a
    confirmation returns the original result.

---

## 17. Currently registered modules

Nine modules, **53 capabilities**, 34 of them mutations. Every mutation is a
thin adapter over an application service that the UI routes call too.

| Module | Available when | Capabilities |
|---|---|---|
| **tasks** | always | `search` `read` `create` `update` `complete`\* `schedule` `move` `archive`\* `addStep` `updateStep` `removeStep`\* |
| **projects** | always | `search` `read` `create` `update`\* `complete`\* `archive`\* |
| **calendar** | Google connected **with write scope** | `event.search` `event.read` `calendar.availability` `calendar.list` `event.create` `event.update` `event.delete` — creates/edits/deletes are *external* |
| **reminders** | always | `search` `create` `update` `complete` `setPaused` `delete`\* |
| **habits** | always | `list` `check` `create` `update` `archive`\* |
| **areas** | always | `list` `create` `update` `delete`\* |
| **diary** | always | `read` `search` `append` `checkIn` |
| **library** | always | `search` `readPage` `sections` `projectBook` `appendPage` `createPage` |
| **relationships** | always | `link.inspect` `link.traverse` `link.create` `link.remove`\* |

\* *important* — needs its own confirmation, not just the batch's.

In a workspace with no Google account, `GET /ai/capabilities` returns **46**;
Calendar's seven are absent with the reason stated. That difference is the
registry working.

### Rules the new writes obey

- **Diary text is only ever APPENDED.** There is no service that replaces a
  document, and there will not be one: a diary has no version history, and a
  wrong write destroys something that cannot be reconstructed. `mood`, `energy`
  and the day summary are separate fields that touch no prose.
- **Library pages refuse what they cannot hold.** A pinboard is positioned
  items, not paragraphs; `appendToPage` says so and suggests a Notes page rather
  than dropping the text. Page edges are re-synced in the same transaction as
  the write, exactly as the editor's save does.
- **Completing a project with open tasks is a decision, not a guess.** The
  service throws `OpenTasksRemain`; the capability turns that into a sentence
  asking whether to leave or cancel them.
- **Archiving, not deleting**, wherever the reversible verb is what people mean:
  tasks and habits archive, and a habit has no delete at all because a streak
  that took months is not something to lose on an ambiguous sentence.
- **Built-in areas cannot be removed.** Settings has always promised this and
  enforced it by hiding a button; the rule now lives in the service, so it holds
  for the assistant too.

## 18. Future modules

Registerable without touching the planner, the executor or the proposal model:
**Finance**, **Food**, **Groceries**, **Email**, **Goals**, **Circles**.

None is built and none should be started as part of an AI phase — the point of
the registry is that they do not have to be.

**Brain is cancelled** as a product area. Its knowledge-storage role was
absorbed into Library; what remains of the idea *is* this system.

### Spoken responses (text-to-speech) — planned, not built

**Nothing below exists yet.** No provider is chosen, no code is written, and
the assistant is silent today. This records the intended shape so that when it
is built it is built in the right place.

**The direction.** Life OS should eventually be able to speak an assistant
response aloud.

**Where it belongs, and where it must not.** TTS is a PRESENTATION LAYER over a
finished result. It is not a module, it registers no capabilities, and it takes
no part in reasoning, planning, retrieval, capability execution or
confirmation. Concretely:

- The canonical result stays exactly what it is now — structured text plus
  actions. Speech is a rendering of that, never a second source of truth.
- Nothing in `turn.ts`, `executor.ts`, `confirm.ts` or the registry should
  need to know speech exists.
- It must be removable and swappable without touching the assistant. If
  deleting the speech layer changes what the assistant decides or does, it was
  built in the wrong place.
- **Speech is never a confirmation.** Hearing a proposal read aloud is not
  agreeing to it; the gate in §8 is unchanged and unaffected.

**Intended behaviour.**

| | |
|---|---|
| Voice-originated turns | may speak the response automatically, if the user wants that |
| Typed turns | silent by default — somebody typing in a meeting did not ask for noise |
| Any response | can be played, and replayed, on demand |
| While speaking | must be interruptible: stop is a first-class control, not a pause |

**Long answers need a speech form, not the screen read out.** A proposal set is
cards, fields, assumptions and warnings — reading every one aloud produces a
minute of listening for something that takes five seconds to look at. What
should be spoken is a concise summary written for the ear: what was understood,
how many changes there are, and what the notable one is. That summary is
another rendering of the same result, and it is the part most likely to be got
wrong by generating it from the UI rather than from the structured turn.

**Provider is deliberately undecided.** Browser `SpeechSynthesis` costs nothing
and sounds like it; a hosted voice sounds better and is a second vendor, a
second key and an audio round trip. That choice belongs to whoever builds this,
against a `SpeechProvider`-shaped seam in the same spirit as §13 — one small
interface, one place a vendor is named, and a deployment with none configured
that simply does not speak.

**Open questions to settle first**, none of which need answering now: whether
speech is a per-user preference or a per-turn choice; what happens on a phone
with the screen locked; whether it stops when the user starts a new turn (it
almost certainly should); and whether the speech summary is generated by a
model job or composed deterministically from the turn — the latter is cheaper,
more predictable, and probably right.

---

## 19. Known gaps

1. **No streaming.** A turn is one request and the user waits for the whole
   plan. Planning a four-action sentence takes seconds; a token stream would
   make that feel faster without being faster.
2. **No voice output.** Speech in, text out. The intended design for spoken
   responses — a removable presentation layer, never part of reasoning or
   confirmation — is recorded in §18. It is not built.
3. **Retrieval is keyword plus graph, with no embeddings.** §5b explains why
   that is a decision rather than an omission — but it will not recall by
   meaning where no word is shared, and a vague question ("what have I been
   avoiding") will answer poorly.
4. **Level 3 (broad) retrieval is unranked across modules.** It reads the
   parameterless reads of every module and ranks the union, which is adequate
   for "what is taking my attention" and crude for anything subtler.
5. **A calendar action cannot be edited on its card.** After preview the payload
   is a ledger handle, and editing it would mean editing a proposal Google was
   already told about. The way to change one is to say so, which re-plans and
   re-previews. Correct, and worth making obvious in the UI.
6. **Reordering is still not offered** — tasks, steps, projects or habits.
   Pointer-driven against a rendered list; no sentence maps onto "put this
   between those two".
7. **No project restore, no task un-archive, no library archive/restore** from
   the assistant. All exist in the app; none is a sentence anyone says.
8. **Memory has no decay or size limit.** Bounded at 12 per prompt and ranked,
   but nothing prunes. A year of accepted candidates will need a policy.
9. **The clarification flow answers by sending the option's label as text.**
   It works and reads naturally; a structured answer carrying the chosen ref
   would be more precise.
10. **Conversation state is the pending actions plus the request.** No running
    summary is generated yet, so a long thread loses its early context. The
    column exists (`ai_conversations.summary`) and nothing writes it.

## 20. Implementation status and changelog

### Phase 2 — the real assistant (this pass)

**Built and tested:**

- **Anthropic provider** implementing all five jobs, schema-validated with
  bounded retries, two model tiers, environment-configured.
- **The turn**: interpret → gather → rank → memory → plan → preview → persist.
- **Ranking** (`ranking.ts`) over eight signals with a second affinity pass.
- **Server-held proposals**: plan, read, edit, confirm, discard, with stale,
  replay, concurrency and post-confirmation protection.
- **Calendar preview at plan time**, through the existing mutation ledger.
- **24 new capabilities** (29 → 53) and **six new application services**
  (library, diary, areas, plus extensions to tasks, projects, reminders,
  habits). Nine route handlers now delegate to them.
- **Memory in the loop**: ranked into the plan, extracted into candidates after.
- **Settings → AI & personalisation**: view, edit, pin, forget, and accept or
  reject what was noticed.
- **Desktop panel** above the composer; **mobile** wired to the same server.
- 17 turn tests, 11 client tests, plus the Phase-1 suite.

**Database:** `ai_conversations`, `ai_turns` (migration `0016_ai_turns.sql`).
Additive and idempotent; nothing existing altered.

**Three tests changed rather than deleted.** Two asserted Phase-1 truths this
phase reverses — the composer being inert, the mock provider being
deterministic — and now assert what outlived them. One allowed `Forget` as a
destructive verb.

### Phase 1 — foundation

**Built and tested:**

- Capability Registry, with per-request availability and resolution.
- Nine modules, declared by the domains that own them.
- Four application services; four route handlers refactored to call them.
- Executor with the confirmation gate, per-action transactions, payload
  validation, and no path to a table.
- Context Engine with three retrieval levels and provenance on every source.
- Personal Memory: two tables, migration `0015_ai_memory.sql`, full service.
- Provider abstraction with a job router and a deterministic provider.
- Routes: capabilities, context, memory CRUD and candidates.
- 24 focused tests in `api/tests/ai-foundation.test.ts`.
