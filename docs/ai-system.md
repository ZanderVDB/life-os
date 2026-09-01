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
  │
  ├─ FAST PATH ────── an obvious command, parsed deterministically. No model.
  ├─ AMEND ────────── a correction to a proposal still on the table.
  └─ PLAN ─────────── everything else:
       → CONTEXT ENGINE   level 1 surface · level 2 targeted + traversal · level 3 broad
       → PLANNER          capabilities and rules from the registry, sources, memory
       → CONSISTENCY      deterministic: does the card say what the payload does
  │
  → PROPOSAL SET       actions, assumptions, warnings, confidence
  → USER EDITS         switch off, change a field, answer a question
  → CONFIRMATION       counted, and important actions accepted one at a time
  → EXECUTOR           validates each payload, resolves each capability
  → APPLICATION SERVICES   the same functions the UI calls
  → DOMAIN STATE + RELATIONSHIPS
```

**The three routes differ only in how the actions are arrived at.** All of them
resolve through the registry, pass the capability's own schema, take their risk
level from the server, are written into the same proposal row, and run only
through the same confirmation. Nothing downstream knows which route produced a
proposal — which is what makes "the fast path is as safe as the planner" a
structural claim rather than a promise.

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
  available: (ctx) => {
    enabled: boolean;              // can this module be READ at all
    reason?: string;               // said to the user when it cannot
    canMutate?: boolean;           // defaults to `enabled`
    mutateReason?: string;         // said to the user when writes are off
  };
  capabilities: Capability[];
};

type Capability = {
  id: string;                      // 'task.create' — stable; appears in proposals
  module: string;
  kind: 'search' | 'read' | 'traverse' | 'mutate';
  label: string;
  description: string;             // written for a planner to read
  input: ZodType;                  // what the PLANNER may propose
  confirmed?: ZodType;             // what the EXECUTOR runs, if preview replaced it
  risk: 'safe' | 'confirm' | 'important' | 'external';
  run?:     (ctx, input) => Promise<ContextSource[]>;   // reads
  preview?: (ctx, input) => Promise<{ summary, warnings, handle, carry }>; // plan-time
  execute?: (ctx, input) => Promise<ActionResult>;      // writes, after confirmation
};
```

**Availability is asked, not assumed.** Calendar is registered on every
deployment and unavailable until a Google account is connected. Two workspaces
get different answers from the same registry.

**Read and write availability are separate.** Calendar has three states, not
two: not connected, connected with a read-only grant, connected and writable.
The middle one used to collapse into "off" — and a workspace whose grant could
not write was also told it could not SEE its own calendar, so the assistant
answered *"I cannot find that meeting"* about a meeting it had already
retrieved. Now `enabled` governs the module and `canMutate` governs its writes:
the reads stay, the writes go, and `describe().readOnly` tells the planner
which is which so *"I can see it, I just cannot change it"* is reachable.

**A previewing capability has two input shapes.** Calendar's plan-time input is
a whole draft; its preview writes that draft into the mutation ledger and hands
back a requestId, and what gets confirmed is the requestId. Without `confirmed`
the executor checked the handle against the schema for a full draft, refused a
payload that was exactly right, and every assistant calendar write failed
*after* the user had agreed to it. `carry` is the small, preview-validated
extra a confirmed payload may keep beside the handle — a task id, so an event
made for a task ends up linked to it.

**Availability is asked once per request, not once per question.** `available()`
for Calendar is a database read and a turn asks the registry five times;
`forRequest(db, request)` memoises it for the life of the request and never
beyond it.

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
do", and it is the only answer. It reports `modules` (with `writable`),
`capabilities`, `plannable`, `unavailable` (module off, with the reason) and
`readOnly` (module readable, writes off, with the reason).

**`registry.explain(ctx, id)`** says WHY, not just no. Three situations reach
the user as the same silence otherwise: Life OS has never had that; the module
is not connected; the module is connected and cannot write. Only the third
makes *"I can see it, I just cannot change it"* the true thing to say, and only
the registry knows which is which.

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

### 5a. Searching hard before saying no

The most damaging thing this system can do is say *"that does not exist"* about
something that does. Four things stop it.

**The query is not the sentence.** Search is `ILIKE '%…%'`, which matches a
substring, and a phrase almost never is one: *"reconciling against the bank"*
appears in no title, while `reconcile` and `bank` both do. So the interpreter's
phrases are expanded into distinctive words, then into:

- **crude stems** — a prefix of any word of six letters or more, so `pricing`
  finds *Price three options*. A real stemmer is a dependency and a vocabulary;
  this catches the English inflections that actually come up;
- **singular and plural** — `invoices` finds *Invoice*, `invoice` finds
  *Invoices*.

Casing never mattered: `ILIKE` is case-insensitive.

A wrong extra hit costs one row in a ranked list. A miss costs the whole
action.

**Structural expansion.** A project's own tasks are a FOREIGN KEY, not an
`item_links` edge, so traversal never reaches them and neither does a text
search that does not happen to share a word. The best few hits are therefore
read IN FULL — which is what a person would have clicked. Without it the
assistant finds the project the question is about and then says it would need
to read it, which is both true and useless.

**The low-result fallback.** A request that acts on something asserts that the
something exists. If a targeted pass found almost nothing (fewer than three
sources) for a request that implies an existing entity, retrieval escalates to
level 3 and expands again before anything concludes it is absent. One more
round of reads is the difference between *"I could not find it"* and finding
it. `metrics.broadened` records when it happened.

**Nothing is fabricated to fill the gap.** If retrieval still cannot identify
something, the planner has no id for it, `validate.ts` refuses any payload that
invents one, and the honest answer — *"I could not find that after searching
your workspace"* — is what remains.

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

### 5c. Concurrency

Searches within a level, traversals from the chosen seeds, and the whole query
set are all run with `Promise.all`. They are independent reads against
different tables with no shared state, and running them in series made a turn
wait for the sum of a dozen round trips to learn what the slowest one alone
would have told it. Correctness is unchanged: deduplication and ranking happen
after everything is in.

**Failures are recorded, never swallowed.** A capability whose read throws is
caught so one bad module cannot fail a turn — but it lands in
`GatherResult.failed` and in `metrics.retrievalFailures`. That catch used to be
silent, and it hid a bad array binding that made task search return nothing for
every task belonging to a project. The only symptom was an assistant that could
not find things.

---

## 6. The turn

`api/src/ai/turn.ts`. One request, in order:

```
fast path   an obvious command? then none of the below runs at all
interpret   what is this about, which modules, what words to search for
gather      surface → targeted search → relationship traversal
fallback    a second, broader pass when the first found suspiciously little
rank        24 of ~200 rows, by signals Life OS already has (§5b)
memory      the durable facts that are relevant, not all of them
plan        capabilities and rules FROM THE REGISTRY, sources, memory
validate    deterministic: does the card say what the payload does (§6c)
preview     calendar actions go through the mutation ledger, here
persist     the proposal set is written down; the client gets its id
```

### 6a. The fast path

`api/src/ai/fastpath.ts`. *"Add milk"* does not need a model. It needs four
words parsed and one task proposed, and two model round trips between the
sentence and the card cost several seconds to reach the answer anybody would
have written down immediately.

It recognises **four shapes**, and no more:

| | |
|---|---|
| create a task | "Add milk", "Add a task called Send invoice" |
| create a reminder | "Remind me Friday to call Oscar" |
| complete something | "Complete Morning walk", "Mark Pay the deposit done" |
| move a task | "Move this to This Week" |

**It is not an attempt to replace the planner with regular expressions.** That
approach fails the same way every time: the patterns grow, they start matching
sentences they only half understand, and the failure is silent — a confidently
wrong action instead of a slower right one.

So every uncertainty **fails closed**, returning a reason and running the
normal planner:

- a question mark, or an interrogative opening;
- a conjunction or a comma, which usually means two requests;
- an amendment marker, or any pending proposal at all;
- a date word it cannot resolve *exactly* — "next month" falls through;
- an entity name matching zero things, or more than one;
- a bare "add" carrying a date, because deadline-or-intention is a judgement;
- anything the registry will not resolve, or any payload the capability's
  schema refuses.

An exact title match beats several partial ones: "add milk" should not reach a
reasoning chain because a task called "buy oat milk" also exists.

**Entity resolution goes through the registry's own search capabilities**, so
removing a module removes the fast-path shapes that depended on it, with no
list here to keep in step.

**Instrumentation, internal only.** `metrics.route` is `fast` | `amend` |
`planner`; `metrics.shape` names the shape that matched; `metrics.fastPathMiss`
records why the cheap route declined. None of it is shown to the user — a
proposal card is not the place for a diagnostic.

### 6a2. Dates — one resolver, and the model is not it

`api/src/lib/civil-date.ts`. Every relative date in Life OS is resolved here,
by the fast path, by the consistency pass, and — crucially — BEFORE the planner
runs, so the planner is handed the answer rather than asked for it.

**The bug this ended.** The planner was told `Today is 2026-09-01.` and asked
to turn "Saturday" into a date. To do that it must first work out that
2026-09-01 is a Tuesday, then count forward: calendar arithmetic in a language
model's head. The same sentence produced 5 September in one run and 6 September
in the next, and nothing downstream could tell them apart because both are
valid ISO dates. There were effectively two resolvers — a correct one in the
fast path, and the model — and the wrong one was on the path that mattered.

**What the planner gets now** is the next fortnight, resolved:

```
TODAY IS Tuesday, 1 September 2026 (2026-09-01).

TODAY'S CALENDAR. Take dates from this table; never calculate one:
  2026-09-01  tuesday  <- today
  2026-09-02  wednesday  <- tomorrow
  2026-09-03  thursday
  2026-09-04  friday
  2026-09-05  saturday
  ...
```

"Saturday" stops being a computation and becomes a lookup.

**The rules, stated once and the same everywhere.**

| phrase | meaning |
|---|---|
| `today`, `tonight` | today |
| `tomorrow`, `yesterday` | one day either way |
| `in N days`, `in N weeks` | exactly that |
| `Friday`, `on Friday`, `this Friday` | the NEXT Friday, **never today**. Somebody saying "remind me Friday" on a Friday means the one that has not happened yet |
| `next Friday` | seven days later than that. The one genuinely contested reading in English; Life OS picks the later one, says so on the card, and lets the user correct it there |
| `this weekend` | the coming Saturday. A date field holds one day, and that is the earlier one |
| an ISO date | itself |
| anything else | **not resolved**. The fast path falls through to the planner; the planner is told to ask |

**A civil date is not an instant.** `2026-09-05` is a day on a wall calendar:
no time, no zone. Every function anchors it at UTC midnight purely as a stable
frame for counting days and returns a bare label again — nothing produced ever
carries a time or an offset, so a civil date cannot shift under conversion. Day
arithmetic means month, year, leap-day and DST boundaries need no special
handling: 31 December + 1 is 1 January.

**"Today" is the user's day, not the server's.** `todayIn(timeZone)` asks
`Intl`; `new Date().toISOString().slice(0, 10)` is the UTC day, which is
already tomorrow for anyone east of Greenwich after midnight. The client sends
its own civil date and that is preferred; the zone is the fallback; UTC is the
fallback's fallback. The same rule reaches the services the assistant calls —
a reminder with no date defaults to the user's today, and a habit is ticked on
the user's day.

**Everything downstream uses the same resolver.** A pending amendment is an
edit to a payload, so it is the same field validated the same way; `dueDate`
and `scheduledAt` stay distinct facts and neither is written from the other;
and a calendar draft is resolved before it reaches `proposeCreateEvent`, so
Calendar never sees a phrase.

**The semantic check.** `date_missing` asks whether the payload carries a date
the words promised — and that passes for a card saying "Saturday" with the
assumption "Saturday means 2026-09-06" over a payload of 2026-09-06.
Self-consistent, valid, and wrong. So `weekday_mismatch` asks the one question
about prose that has exactly one right answer: **if the words name a weekday,
the payload's date must fall on it.** A card that fails it never reaches the
user — the repair pass gets one attempt with the calendar row quoted back at
it, and what still disagrees is withheld.

### 6a3. What the date MEANS — deadline or doing

`api/src/lib/timing-intent.ts`. A separate problem from §6a2, and the one that
survived it: getting the date right and the FIELD wrong is still wrong.

|  |  |
|---|---|
| `dueDate` | when it must be **finished**. A day, never a moment. |
| `scheduledAt` | when the user intends to **do** it. An instant. |

They are facts about different moments. Writing one from the other is how
*"finish the report by Friday"* becomes a Friday afternoon that was never free.

**The bug this ended.** *"I need a haircut Saturday"* produced a task with
`dueDate` and a card reading "Saturday as the deadline". Nothing caught it, and
the reason matters: the consistency pass compares the card's words with the
card's payload, and here they agreed perfectly. The model said deadline and
wrote a deadline. The disagreement was with the **user**, who had said neither.

That is the same shape as the weekday bug — self-consistent and wrong — and it
gets the same answer: read it deterministically from the user's own words, hand
the planner the reading, and check the payload against it afterwards.

**The readings.**

| reading | wording | field |
|---|---|---|
| `deadline` | "by Friday", "due", "deadline", "before", "needs to be done", "hand in", "no later than" | `dueDate` |
| `scheduled` | "work on", "I'll do", "sit down", "start on", "spend an hour", "do it" | `scheduledAt` |
| `scheduled` + `block` | "block out", "put an hour aside", "book me", "schedule", "find me an hour", "in my calendar" | `scheduledAt`, or a **calendar** action — the planner chooses from live capabilities, not from the wording |
| `reminder` | "remind me", "don't let me forget" | neither; a reminder |
| `none` | no date at all | neither |
| `ambiguous` | a date, and nothing saying which — *"I need a haircut Saturday"* | **ask** |

**Two rules that fall out of the schema rather than a word list.** A clock time
can never be a deadline, because `dueDate` holds a day — so "Saturday at 10" is
always a plan. And the check only fires where the two fields genuinely
**compete**: a reminder's `dueDate` is when it fires and has no rival, a diary
date is the day it belongs to. The choice is real only when one capability
offers both, which the schema knows and no list has to remember.

**Ambiguous means ask.** Not a quiet default, and not a default dressed up as an
assumption. The turn returns a clarification — *"What does Saturday mean for the
haircut?"* → **Do it then** / **Have it done by then** — and no action for that
part; everything unambiguous in the same request is still proposed alongside it.
Answering settles it: the chosen option maps back to a reading, so the
continuation is no longer ambiguous and does not ask again. A wrong deadline
nags early; a wrong plan goes silently past. Neither is a small call to make on
somebody's behalf.

**Explicit words beat learned preferences.** Memory can inform a default; it can
never turn an ambiguous date into a deadline, and it never decides this field.

**A named day that the date is not gets corrected, not refused.** If the words
name exactly one weekday and the payload holds exactly one date, the resolved
date is applied — keeping any time of day — and the card shows it before
anything is confirmed. Asking the model again was tried first: told in plain
words that Friday is the 4th, it produced the 5th a second time, and the user
got a note instead of a task. There is one right answer and the resolver knows
it. Two weekdays or two dates have no single right answer, so nothing is
touched and the finding stands.

**One reading per sentence.** The fast path asks the same classifier rather than
holding an opinion of its own: anything other than "no date at all" goes to the
planner. `timing_ambiguous`, `due_vs_scheduled` and `scheduled_vs_due` are
findings like any other — one repair attempt with the specific complaint, then
withheld and named.

**Where it applies:** new tasks, task edits, pending amendments, the schedule
and calendar flows, the planner route and the fast path. Reminders are exempt by
construction, because their date has no rival.

### 6b. Conversation, pending proposals and follow-up

`ai_conversations` holds a thread; `ai_turns` holds each turn.

**A pending proposal is conversation state.** It has been proposed and not
confirmed, so it does not exist in the workspace: searching for it finds
nothing. The assistant used to hear *"actually Saturday"*, search for a haircut
task, find none, and report that the thing did not exist.

So the planner is given the pending set **as a field, with its payloads** — not
appended to the request text as a list of titles, because an amendment has to
name a field to change and a title list cannot say what the fields are. It may
then return `amend` instead of `actions`:

```json
{ "amend": [{ "actionId": "a2", "fields": { "dueDate": "2026-09-05" } }] }
{ "amend": [{ "actionId": "a1", "enabled": false }] }
```

These cover *"actually Saturday"*, *"change the time to 4"*, *"don't add milk
after all"* and *"only make the first two changes"*.

**An amendment is an edit, not a new proposal.** It goes through `editTurn` —
the same validated path the card's own edit control uses: every field checked
against the capability's schema, the version bumped, the confirmation gate
untouched. Saying a correction has exactly the power of typing one, and no
more. The pending row is amended in place, so one question never produces two
things the user could confirm by accident.

**A short correction skips retrieval entirely.** What it refers to is in the
proposal, not in the workspace, so there is nothing to search for. That is most
of the latency of a follow-up.

It is still not a transcript: what a follow-up needs is the last thing proposed
and the last thing asked, and resending everything forever gets more expensive
and less accurate with every turn.

### 6c. Plan / payload consistency

`api/src/ai/validate.ts`. A plan can be perfectly valid and still be a lie. The
schema is satisfied, the capability exists, the id resolves — and the card says
*"Schedule the haircut Saturday"* over a payload with no date in it. The user
reads the sentence, agrees to the sentence, and gets the payload.

Schema validation cannot see this: both halves are individually fine and it is
the RELATIONSHIP between them that is wrong. Nor can the planner be asked to
check its own work — a model that produced an inconsistency is the least
reliable judge of whether it did. So this is a **deterministic pass**, between
planning and the user seeing anything.

| check | what it catches |
|---|---|
| `date_missing` | the card names a date the payload does not contain |
| `date_not_supported` | the card names a date the capability cannot hold |
| `time_missing` | "move it to 3pm" over a payload that still says 2 |
| `due_vs_scheduled` | a deadline written into `scheduledAt`, or the reverse |
| `kind_mismatch` | "move the meeting" proposed as a `create` |
| `unknown_id` | a uuid that was never in the retrieved context |
| `ends_before_starts`, `time_without_date`, `empty_change` | impossible on their face |

It is **schema-aware**: `fieldsOf()` reads the capability's own Zod shape,
including inside `changes` and `draft`, so "the card promises a date and this
capability has nowhere to put one" is a different finding from "it has a date
field and left it empty".

It is **conservative on purpose**. Every check fires only on a definite
disagreement, and only against the action's OWN words — never the turn's
overall answer, which may be describing a different action in the same request.
A validator that cries wolf gets the whole stage disabled.

**One repair, then withhold.** A repairable finding earns exactly one more
planner call, carrying the specific complaint. The retry is kept only if it is
actually better; a repair that trades one inconsistency for another is not a
repair. What still disagrees is withheld and named in the turn's note, in words
about the request rather than about the check. An `unknown_id` is not repairable
at all: the id is absent because the thing was not retrieved, and asking again
cannot conjure it truthfully.

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


Only a turn still `proposed` is pending. One already executed is history, and
"make it Saturday" about it is a new request.

---

### 6d. What a turn costs

Measured against the real model over a real workspace, median of three runs.
Absolute numbers move with the machine and the network; the SHAPE is the
point.

| | median | why |
|---|---|---|
| obvious command — *"Add milk"* | **~5 ms** | no model, no retrieval, no planning |
| simple read — *"What is on my Today board?"* | ~6 s | one cheap interpretation, one plan |
| retrieval-heavy — *"What still needs to happen for X?"* | ~8.5 s | plus traversal and structural expansion |
| four changes in one sentence | ~13 s | the plan itself is longer |

**The same command, both ways.** `"Add milk"` takes the fast path;
`"Please add milk"` does not, because the shape requires the sentence to start
with the verb — so it does exactly the work the fast path replaced, against the
same data on the same machine. Same result, same card:

| | median |
|---|---|
| `Add milk` | **4 ms** |
| `Please add milk` | **6,244 ms** |

That is the honest before-and-after: the fast path did not exist before this
pass, so its "before" is the planner doing the same job.

**Where the time goes.** Almost all of it is the model. Retrieval against a
workspace of this size is tens of milliseconds; the two model calls are
seconds. That is why the fast path is worth having and why micro-optimising
the database would not be.

**What was done about it.**

- The **fast path** removes both model calls for the commands people repeat
  most: capture, complete, move, remind. It is the difference between five
  milliseconds and several seconds for the same result.
- **Retrieval runs concurrently** — a dozen searches, five traversals, the
  surface read. Wall clock is the slowest, not the sum.
- **A short amendment skips retrieval entirely.** What it refers to is in the
  proposal, not the workspace.
- **Availability is asked once per request** rather than once per question.
- **Query building spends its budget on distinct meanings**, not on spellings
  of the same one — which made retrieval both broader and cheaper.

**What was deliberately not done.** Streaming, caching plans, or a smaller
model for planning. The first is a real improvement and a real piece of work
(§19); the second trades correctness for speed on a system whose whole value
is being right about your own data; the third was tried in Phase 2 and the
cheap model plans badly.

The target is not "fast". It is: **the things people do constantly feel
instant, and the things that are genuinely hard are allowed to take a moment.**

---

## 6e. Composite requests and dependent actions

*"I need to prepare for the client call Thursday. Add a task to WebAnchor,
schedule 45 minutes Wednesday afternoon, and link the task to the call and the
handover notes."*

That is one sentence and four changes, and three of them need an id the first
one has not created yet. Until Phase 4 the executor ran a proposal as a flat
list of independent agreements, which is exactly right for six unrelated
groceries and cannot express this at all.

### The dependency is read, never declared

The obvious design gives each action a `dependsOn: ["a1"]` field beside its
payload. That is two statements about one fact, and this codebase has met that
shape repeatedly under the name **self-consistent but wrong**: the two agree
with each other and disagree with reality. An action could declare a dependency
it does not have, or omit one it does, and both look fine on the card.

So there is one statement. The planner writes a **placeholder** where an id it
cannot know yet belongs:

```json
{"capability": "task.create",  "payload": {"title": "Get moving quotes"}}
{"capability": "task.schedule","payload": {"id": "{{a1.id}}", "start": "..."}}
```

`{{a1.id}}` means *the id of the first action in this plan*. The dependency
**is** the reference, because referencing is the only way to say it.
`api/src/ai/depends.ts` reads them back out.

### What happens at each stage

| stage | what it does |
|---|---|
| **plan time** | The payload is validated through a **probe** — each placeholder replaced by a distinct well-formed uuid — so a uuid field holding `{{a1.id}}` is checked as the id it will become rather than rejected as the text it currently is. The probe is then discarded and the placeholders put back. What is stored is what was proposed. |
| **plan time** | The graph is checked. A loop, a self-reference, or a reference to an action that was rejected cannot be carried out, so the dependent is dropped with a reason — repeatedly, because dropping one orphans anything that depended on *it*. The independent actions survive. |
| **execution** | Actions run in dependency order. Each finished action's produced ref is recorded, placeholders are substituted **before** validation, and the real id is what the service receives. |
| **reporting** | Results come back in the order the **cards** were shown, not the order they ran. Execution order is an implementation detail; a result list that reshuffles itself cannot be checked against what was agreed to. |

### Action ids are the planner's own numbering

`{{a2.id}}` means the second action the model wrote. Ids are therefore assigned
from the raw index, not from how many survived validation — otherwise rejecting
the first action shuffles everything up and that reference silently becomes a
reference to something else. Gaps in the numbering are harmless; the ids are
opaque handles everywhere they are used.

### Partial failure, with dependencies

The existing philosophy is preserved and extended:

- **Independent actions stay independent.** One failing does not stop another.
- **A dependent whose dependency failed is `skipped`**, never attempted, and
  never reported as done. Running it anyway would write a link pointing at a
  task that does not exist — the one outcome worse than doing nothing.
- **A break propagates down the chain**, and the report blames the action that
  actually broke rather than the one immediately above it.
- Nothing says *"Done"* for an action that did not happen.

Only data flow creates a dependency. If B merely ought to follow A but needs
nothing from it, they are independent and both run — sequencing them would let
A's failure cancel a change that would have succeeded.

---

## 6f. Universal entity resolution

Phase 3 taught the fast path to find *"the Fitzgerald report"* among tasks.
Phase 4 needs the same skill for projects, habits, books, pages, diary days and
calendar events — and if each capability grows its own title matching they will
disagree. One will treat an exact title as decisive and another will not; one
will pick the first of three and another will ask. The user meets all of them
and experiences an assistant with no consistent idea of what *"the client
call"* means.

`api/src/ai/resolve.ts` is the single answer, and it goes through the
**registry's own search capabilities** — so a module registered tomorrow is
resolvable with nothing edited here. The fast path calls it too; there is no
second implementation.

### Three answers, and ambiguity is one of them

| answer | when | what the caller must do |
|---|---|---|
| `resolved` | one candidate is clearly strongest | use its id |
| `ambiguous` | several are genuinely plausible | **ask** — this is a real answer, not a failure |
| `none` | nothing matched | say so. There is no id in this result to invent one from |

### What makes a candidate stronger

An **exact normalised title beats everything**. *"Add milk"* against *"Milk"*
and *"Buy oat milk for the weekend"* is not ambiguous — one of them **is** the
thing named. Two rows with identical titles genuinely are ambiguous, and no
scoring fixes that.

Below that, evidence accumulates through `ranking.ts` (which is not
reimplemented): word overlap, the type the caller asked for, the entity on
screen, the project and area the rest of the request is about, and a nudge for
anything named earlier in this conversation.

The decision is deliberately **not** "highest score wins". Two candidates a
whisker apart are the ambiguous case, and a resolver that always returns its
favourite hides that. `MARGIN` (1.35×) is what stops it; `FLOOR` stops a weak
best match from counting as a match at all.

### A pronoun is not a name

`"it"`, `"that"`, `"the task"` and friends never reach the scorer. Resolving
them against every title in the workspace finds *something*, and what it finds
is arbitrary — the exact fabrication the resolver exists to prevent.
Conversation references answer those first; reaching the resolver with one
means there was no antecedent, and the honest answer is that nothing was named.

---

## 6g. Conversation references — what "it" means

> *"Open the WebAnchor project."*
> *"What is still outstanding?"*
> *"Add a task to it called Send final credentials."*
> *"Make that urgent."*
> *"Actually put it in Work."*

The obvious implementation sends the previous messages and lets the model work
out the antecedent from the prose. That fails in a specific and expensive way:
the model re-derives an **entity** from a **title** it remembers, and a second
guess at something already known exactly is the guess that picks the wrong
project. Worse, it fails silently — the card says *WebAnchor* and the payload
carries a different project's id.

So references resolve to the **stable ids the previous turns actually used**.
`api/src/ai/references.ts` reads them out of the turn table, which already
records exactly what is needed and no content:

| source | meaning | strength |
|---|---|---|
| `results[].ref` | what a turn **created** | strongest |
| `actions[].target` | what a turn **changed** | middle |
| `sources[]` | what a turn **read** | weakest |

Six turns back, twelve entities at most, most recent first. A thing the
assistant created outranks one it merely read at the same distance: *"add a
task to it"* after creating a project means that project, even if three others
were listed on the way.

**Titles are read from the canonical rows at the moment they are needed**,
never stored here. A cached title goes stale the first time somebody renames
something, and the assistant then refers to a project by a name it no longer
has. An entity that has since been deleted simply drops out of the list — a
reference to a thing that is gone is not a reference, and offering it would let
the planner name a dead id.

### Where the list is used

1. **Seeded into retrieval**, when the sentence actually refers back — narrowed
   to the type when the words say which. A sentence leaning on *"it"* gives
   retrieval nothing to search for, so without this the assistant answers about
   the right thing having read nothing about it.
2. **Given to the planner** with ids, under an instruction to reuse the id
   rather than search for the name again.
3. **Added to the known-id set**, so the consistency pass does not reject the
   one id that is certainly right.

`referenceCue()` decides only whether a sentence contains a reference and what
**type** of thing it points at. It is not an attempt to parse English; choosing
**which** one is the reference list's job.

---

## 6h. Relationship inference

The assistant should notice connections. When the user says

> *"The client call on Thursday is where we're going to discuss the annual
> returns."*

both entities can be resolved, and the useful response is to propose:

```
LINK   Client call  ↔  TriFusion annual returns      kind: discussed_in
```

**An inferred relationship is a mutation.** It goes through the same
proposal → confirmation → execution path as everything else, and appears on a
card before it exists. Graph edges are never written silently, however obvious
the connection looks.

When confidence is insufficient, the assistant **asks**. *"Link the call to the
project"* with three plausible calls is a clarification, not a coin toss — the
resolver returns `ambiguous` and the turn asks which is meant.

Both ends must be things that actually exist, with real ids, and the kind is
chosen from what the user said: `discussed_in` for a conversation about
something, `preparation` for work done beforehand, `resource` for something
used, `result` for what came out of it, `related` when nothing more specific is
true. `scheduled_as` is never available to `link.create` — it is created by
scheduling, and it is the one coupled kind.

These rules live in the relationships **module**, not in the planner prompt.

---

## 6i. Routing — what kind of thing should this become?

Every request that creates something must first answer *"what kind of thing is
this?"* A useful starting hierarchy:

| the request is… | it becomes |
|---|---|
| an action to be done, once | **Task** |
| an outcome needing several steps | **Project** |
| a commitment occupying real time | **Calendar event** |
| wanting to be told at a time | **Reminder** |
| a behaviour meant to repeat | **Habit** |
| a personal record of a day | **Diary entry** |
| reference, research, notes | **Library book / page** |
| how a part of life is classified | **Area** |
| a connection between existing things | **item_link** |

**That table is not in the planner prompt.** Written there, it would keep
offering Habits after the Habits module is removed — the exact rot the registry
exists to prevent, in the one place it would be least visible.

Instead each module declares `routing: string[]` — one or more lines saying
when it is the right home, in the user's terms. The prompt section is assembled
from whatever is **registered and currently available**. Remove Habits and its
routing line goes with it; switch Library off for a workspace and nothing
routes there. Adding a future module means writing one sentence in that
module's own file.

**Guidance, never a classifier.** *"Call John Friday"* fits a task due Friday, a
scheduled task, a calendar event and a reminder. Context decides, and where
meaning is genuinely ambiguous the assistant asks rather than taking the first
match. Where the *date* is the ambiguous part, `lib/timing-intent.ts` already
handles it (§6a3).

---

---

## 6j. Voice input — speech becomes text, and nothing else

**An input adapter, not an AI mode.** Speech goes in, ordinary text comes out,
and it is handed to the same composer typing would have filled. There is no
voice message, no audio conversation, no parallel endpoint. By the time
anything reaches the server it is indistinguishable from something typed —
which is the point: one canonical path, one set of rules, one place where
timing, resolution and confirmation are decided.

```
speech → SpeechRecognition → transcript → the composer → the ordinary turn
```

Speaking the assistant's answer BACK is a different capability and is **not
implemented** — see §18.

### One controller, both surfaces

`web/voice-input.js` owns every piece of recognition logic. The mobile orb
(`assistant.js`) and the desktop composer (`assistant-panel.js`) both use it;
neither constructs a recogniser. Two copies of a browser compatibility check is
how two surfaces come to disagree about which browsers work.

States: `idle → starting → listening → stopping → idle`, plus `cancelled`,
`error` and `unavailable`.

### Audio level is not transcription

Two subsystems, deliberately separate:

| | what it is | where it lives |
|---|---|---|
| **audio level** | `getUserMedia` + an AnalyserNode, driving the orb | `assistant-orb.js` |
| **transcription** | the Web Speech API, producing words | `voice-input.js` |

Either can fail alone, and **a moving waveform is never evidence that anything
is being transcribed**. That confusion was the bug: the orb danced to a voice
that nothing was listening to.

### The two causes of the mobile bug

1. **Nothing handled `end`.** `continuous = true` is advisory — mobile Chrome
   and Safari end a recognition after a pause regardless. There was no `end`
   handler at all, so the first phrase was the only phrase, and the microphone
   stream went on reacting to the voice as though all were well. The controller
   now restarts while the user still intends to be listened to, keeping what
   was already heard in `committed` so a restart can neither lose it nor repeat
   it. A recogniser that ends instantly and repeatedly is given up on rather
   than spun forever.

2. **`start()` was called after `await getUserMedia`.** iOS Safari only permits
   `SpeechRecognition.start()` while the user's tap is still being handled, and
   that await spends it. So on an iPhone the level meter came up — that await
   is what starts it — and recognition never began. `startListening()` is no
   longer `async`: speech starts synchronously, the meter follows.

### Behaviour

- **The existing draft is preserved.** Composer holds *"Remind me"*, you say
  *"Friday to phone Oscar"*, you get *"Remind me Friday to phone Oscar"*.
- **Interim words show and are replaced exactly once.** Chrome re-reports a
  final whose text it has refined; the transcript is rebuilt from the result
  list rather than appended to, so it cannot stutter.
- **A second session does not repeat the first.**
- **Nothing auto-submits.** Desktop leaves the words in the composer to be
  reviewed and sent. Mobile keeps its existing designed behaviour: Done ends
  listening and asks.
- **Stopping releases everything** — stop, cancel, navigation, unmount, page
  hide, error, and a re-render of the shell.

### Errors, in words

`not-allowed` → *"Microphone access is blocked. Allow microphone access in your
browser settings to use voice input."* · `no-speech` → *"I didn't catch
anything. Try again."* · no recogniser → *"Voice input isn't supported by this
browser."* · anything else → *"Voice input stopped unexpectedly. Try again."*

Raw codes go to `console.debug` and are never shown. `no-speech` is not fatal —
it arrives every time somebody draws breath.

Where the browser has no recogniser at all (Firefox), the desktop button is not
rendered rather than shown and then apologising.

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
and the service decides. A model that wrote directly would write whatever it
misheard, and a wrong durable fact is worse than a wrong answer because it
repeats.

| outcome | when |
|---|---|
| `duplicate` | already believed. No new row; the existing one's `last_used_at` is refreshed |
| `queued` | already waiting. Extraction runs every turn, so the same observation arrives repeatedly and the review screen must not become a list of one sentence |
| `conflict` | it contradicts something already believed |
| `pending` | genuinely new. Waits for a yes or no |

**Contradictions are detected, and that is what protects a pin.** Two facts in
the same category sharing most of their distinctive words are almost always a
change of mind rather than two beliefs: *"prefers morning meetings"* and
*"prefers afternoon meetings"* share every word but one. A contradiction is
routed at the memory it replaces, which turns accepting it into a **supersede**
— and supersede refuses to touch a pinned memory. Without this the
contradiction would arrive as an unrelated new memory, both would sit in the
list, and the assistant would hold two opposite beliefs with no way to choose.

A stated `supersedesId` is trusted only if it names something live; the model
can be wrong about ids here as anywhere else. The Settings row says what a
candidate would replace, and refuses rather than fails when the target is
pinned.

### Only what is relevant reaches the model

Sending every known fact on every turn is how a memory system stops helping. It
costs tokens linearly in how much the assistant knows, and it dilutes: a model
given fourteen facts about somebody, two of which matter, reasons about the
wrong two often enough to notice.

So a memory is included when it is one of three things:

- **pinned** — the user said it is right, so it is always context;
- **standing** — a preference, default, routine, work style or communication
  note. These apply without being named: *"prefers afternoon meetings"* should
  shape *"find me time with John"* though they share no word. Capped at four,
  so thirty recorded preferences cannot push out the fact the request is about;
- **relevant** — it shares a distinctive word with the request.

A profile fact about a person the request does not mention is none of those and
stays out. What is used is marked `last_used_at`, so the memories that earn
their place stay near the top.

### Retention

`memory.housekeeping()`, run behind an already-answered turn, at most once every
six hours per workspace. There is no scheduler in Life OS and adding one for a
few seconds of deletes would be the wrong shape of solution; a failure is silent
because nothing depends on it having run.

| removed | after |
|---|---|
| rejected candidates | 30 days |
| pending candidates nobody ever answered | 120 days |
| finished turns — executed, answered, failed, cancelled, clarifying | 90 days |

**Never removed:** any memory, pinned or not, superseded or not — that is the
user's own record of what Life OS knows about them and it is theirs to delete;
an accepted candidate, which is the provenance of a live memory; and a turn
still awaiting confirmation, however old, because deleting one would silently
discard something the user was in the middle of.

Finished statuses are listed explicitly rather than by negating `proposed`, so
a status added later is kept by default rather than deleted by accident.
Aggressively pruning a personal system is how somebody discovers that something
they cared about is gone, and there is no version of that story where the
storage saved was worth it.

### The screen

**Settings → AI & personalisation.** Every live memory in the user's own words,
grouped by category, each editable in place, pinnable and deletable, with
pending candidates offered for a yes or no. `GET /ai/memory` is the query
behind it.

Confidence and provenance are deliberately NOT on the row. They are honest and
they are internal; a list of sentences each carrying "0.6 · assistant" reads
like a database, and the person is here to check what is believed about them
rather than to audit how sure it is.

A candidate that would REPLACE something says so on a second line, and one that
contradicts a pinned memory says that instead and disables its own Remember
button — the accept would refuse, and a row that explains itself is better than
a button that fails when pressed.

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

### Clarification names entities, not labels

The pattern this replaces:

> Assistant: *"Which John meeting?"*
> User taps **"John — Tuesday 14:00"**
> Client sends the string `"John — Tuesday 14:00"` as a new request
> Planner searches for it, finds two again, asks again

The wrong thing there is not the loop. It is that the system KNEW which meeting
each button stood for, threw that away, and asked a language model to work it
out a second time from a shorter and worse description. Every disambiguation is
exactly the case where the id is already in hand.

So (`api/src/ai/clarify.ts`):

- an option carries `{ id, label, detail, ref }` — a stable option id, what to
  show, a distinguishing line, and the entity it stands for;
- the set is stored **server-side** on the turn (`ai_turns.clarification`,
  status `clarifying`);
- the client sends back `POST /ai/turn/:id/clarify { optionId }` and nothing
  else;
- the **original request** is re-run with that entity seeded into retrieval and
  named to the planner by id;
- a question can be answered once. A second choice is refused rather than
  producing a second proposal from one question.

**Refs are verified, never trusted.** The planner may supply `"type:id"`; if it
names nothing that was actually retrieved it is dropped, exactly as an invented
payload id would be. Where the planner supplies none, option labels are matched
back against what retrieval produced — a search over twenty rows, not a guess.

**An option with no ref is legitimate.** *"Leave them open"* and *"Cancel
them"* are real answers that are not entities, and forcing a ref onto them
would be inventing one. Those continue with the chosen words, which is the old
behaviour correctly reserved for the case where there is nothing to name.

`detail` is built from what the source already carries — a date, a project, a
status — so it costs nothing and it is what lets somebody tell two tasks called
*Invoice* apart. The UI is a row of ordinary buttons with a second line: this is
a correctness change, not an interface one.

Both conditions must hold before asking: low confidence **and** a consequence
worth a turn. The planner is told this explicitly — *"an editable card absorbs
ordinary uncertainty; a question costs the user a turn"* — and told that
everything unambiguous in the same request should still be proposed alongside
the question.

---

### 12b. Saying why, not just no

An assistant is going to be unable to do things. What separates one that feels
intelligent from one that feels broken is almost never capability — it is
whether the refusal is a sentence or a status.

| never | instead |
|---|---|
| "Capability unavailable" | "I can see that meeting, but calendar changes aren't available right now." |
| "Something went wrong" | "That changed after you saw it. Reload and check the list again." |
| "No results" | "I couldn't find that after searching your workspace." |
| silence, then a guess | "I found two tasks called Invoice. Which one did you mean?" |
| "Error: invalid payload" | "*Complete Price three options* — no id was given." |
| "Something went wrong" (a provider failure) | "The assistant is rate limited. Try again shortly." |
| "The assistant could not be reached" (out of credit) | "The assistant could not run: your credit balance is too low…" |

**A provider having a bad minute is not an internal error.** `AiProviderError`
lives in the provider CONTRACT rather than in a vendor file, so the turn can
recognise one without importing an adapter: `shape` (the model answered and
could not be made to answer correctly) becomes a 400, everything else a 503 —
which says "expected to pass" where 500 says "broken". Left to fall through, a
rate limit reached the user as "Something went wrong", which is the one
sentence this section exists to forbid.

**A 400 from the provider is about the ACCOUNT, and says so.** Out of credit, a
model not enabled, a plan that does not allow the request — none of them is a
network problem, and calling one "could not be reached" sends whoever is fixing
it to look at the wrong thing. This is the single case where the provider's own
sentence is passed through: it is written for the account owner and carries
none of the request.

**The sentence comes from the server**, because the server is the only thing
that knows which situation this is. `registry.explain()` distinguishes three
that reach the user identically otherwise: Life OS has never had that; the
module is not connected; the module is connected and cannot write. Only the
third makes "I can see it, I just cannot change it" true.

A card whose capability has gone away since the plan was made still shows what
was meant — marked unavailable, carrying the reason, and without a button that
would fail.

**Three of four succeeding is three things that happened.** It is never
reported as a failure, a failure is never reported as a success, and the
headline counts both: *"3 completed, 1 needs attention."*

**What could not be prepared is always accounted for.** Four things asked,
three cards shown, and a note naming the fourth — never three cards and
silence.

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

### What an answer may look like

The assistant writes prose, and the surface renders a **fixed, tiny subset**:
paragraphs, `**bold**`, and hyphen or numbered lists. Nothing else — headings,
tables, links and code fences have their markers stripped and their words kept.

`web/assistant-prose.js`, used by both surfaces. It is not a Markdown library
and deliberately not: the surface wants three things, and a library would bring
raw-HTML passthrough and a sanitiser to undo it again. The security argument is
one sentence — **everything is escaped first**, and tags are produced only by
that file, from a fixed set, after the text can no longer contain any. There is
no path by which model output becomes an element, and a test enumerates the
tags that appear.

Before this, an answer was escaped and inserted as one string, so `**Urgent**`
reached the reader as four asterisks. Telling the model not to use them helped
and did not hold; a slip should look like a bold word rather than like a bug.

**No count without a list.** The model is told never to state a number it does
not then enumerate, and never to write a placeholder bullet — *"Two more
without a priority set: - (no other tasks visible)"* is a list it could not
fill. An empty list item is dropped by the renderer as well, because the two
halves of that failure are worth closing separately.

**The chips are labelled CONTEXT, and that is what they are.** They show what
retrieval put in front of the assistant, ranked — which on a broad question
includes rows the answer did not draw on. They were labelled "Used", which
claimed an attribution nothing computes. The `answer` job returns a
`cited` list; the `plan` job does not, so a turn that produced actions has no
narrower set to show. Making the chips exactly what informed the sentence is a
real improvement and is not built (§19).

---

## 15. Adding and removing modules

**To add one:** write `modules/<name>.ts` exporting an `AiModule`, add it to
the array in `modules/index.ts`. That is the whole procedure. Its capabilities
appear in `GET /ai/capabilities`, in what the planner is told it may do, and in
what the executor will resolve.

**To remove one:** delete the line. Its capabilities disappear from all three,
including — the part that matters — from `registry.resolve()`, so an action
proposed before the removal fails with a reason instead of running.

**What a module declares, in full.** Each of these is a thing that would
otherwise have to be written into the central planner prompt, where it would
keep being true after the module stopped existing:

| field | what it is for |
|---|---|
| `id`, `name` | identity |
| `entities` | which relationship entity types it owns, so traversal can route |
| `rules` | constraints the planner must respect, in plain words |
| `routing` | **when this module is the right home for a request** (§6i) |
| `available()` | asked per request; read and write answered separately |
| `capabilities[]` | what can actually be done, each with its own schema and risk |

A capability may additionally set `always: true` — retrieve it on every turn.
Strictly for the small, bounded vocabularies a request is *classified against*
rather than searched within. `area.list` is the only one today, and it is why
*"put it in Work"* can name the Work area: nothing in that sentence would make
a substring search return it, so before Phase 4 areas reached the planner only
on a broad pass — missing exactly when they were being used.

**To disable one per workspace:** return `{ enabled: false, reason }` from
`available()`. Identical effect, decided per request.

### The checklist for a new AI-compatible module

Everything below is registered in one file. Nothing central changes.

| what | how | why it matters |
|---|---|---|
| **read surfaces** | a `read` capability taking `{ id }`, named `<module>.read` | the context engine seeds level 1 from it, and structural expansion reads the top hits in full through it |
| **searchable entities** | a `search` capability taking `{ query }` | this is the only way words become ids. A module without one cannot be named — habits had no search, and *"complete Morning walk"* found nothing |
| **actions** | one `mutate` per distinct verb | each is an adapter: validate, call the service, return a result |
| **schemas** | `input`, plus `confirmed` when `preview` replaces the payload | the plan-time shape and the execution-time shape are not always the same |
| **confirmation policy** | `risk` on each capability | the server assigns `important` from this. The model never classifies its own permission level |
| **relationships** | list owned types in `entities` | routes traversal, and lets `moduleForEntity` find the read capability for a ref |
| **availability** | `available(ctx)`, with `canMutate` where reads and writes can differ | a module present in the build and unusable in this workspace is normal |
| **planning constraints** | `rules: string[]` | the sentences that stop a plausible plan from being wrong. They belong to the module because the module is what would be damaged by ignoring them |

Requirements: capability ids are `<module>.<verb>`; every `mutate` calls an
application service and contains **no rules of its own**; `description` is
written for a planner to read and states the limits.

**This is tested, not asserted.** `ai-beta.test.ts` builds a small module
inside the test file, registers it through the normal array, and confirms it
reaches `GET /ai/capabilities`, the planner's capability list, the planner's
rules, and the executor — with no other file edited. The same suite removes
Habits and confirms its capabilities vanish from all three, and puts Calendar
into its read-only state and confirms the reads survive while the writes do
not.

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
15. **A card that contradicts its own payload never reaches the user.** §6c.
    Agreeing to a sentence has to mean agreeing to what will happen.
16. **A clarification is answered by option id.** The client cannot name an
    entity; it names a choice the server offered, and the server knows what
    that choice was.
17. **The fast path has no privileges.** Its actions go through the registry,
    the schema, the server's risk assignment and the same confirmation. If it
    cannot produce something that survives all four, the planner runs instead.

### What is machine-enforced, and what is only said

A rule that lives only in a prompt is a rule the model can decide not to follow
at three in the morning. A rule that lives only in code produces a refusal the
model cannot explain. So the ones that would corrupt data if broken are
**both**: enforced where they cannot be argued with, and repeated to the model
so the plan is usually right the first time rather than merely rejected
correctly.

| rule | enforced by | also said |
|---|---|---|
| only these capabilities exist | `registry.resolve` — an unlisted id returns null | yes |
| this module can be read but not written | `available().canMutate`, and `resolve` refuses its mutations | yes, as `readOnly` |
| the payload has this shape | the capability's own Zod schema, at plan time and again at execution | as field names in the description |
| ids must be real | `validate.ts` refuses a uuid absent from retrieved context | yes |
| the card must match the payload | `validate.ts`, deterministically | yes |
| `dueDate` ≠ `scheduledAt` | separate columns, separate schema fields, `due_vs_scheduled` check, and the task service | yes, as a module rule |
| create versus change | `kind_mismatch` check, plus `.create` capabilities that take no id | yes |
| this needs its own confirmation | the capability's `risk`, assigned server-side | no — the model is never asked |
| this write leaves Life OS | `risk: 'external'` plus the calendar ledger | yes, as a module rule |
| valid relationship kinds | `LINK_KIND_IDS` enum in the capability schema; `scheduled_as` refused by the service | yes |
| a habit cannot be deleted, only archived | no delete capability exists | yes |

**What is deliberately NOT moved into code.** Tone, brevity, British English,
"do not repeat the question back", when an assumption is worth writing down.
These are judgements about writing, they have no failure mode worse than a
clumsy sentence, and encoding them would produce a worse assistant and a larger
codebase.

---

## 17. Currently registered modules

Nine modules, **61 capabilities**, 37 of them mutations. Every mutation is a
thin adapter over an application service that the UI routes call too.

| Module | Available when | Capabilities |
|---|---|---|
| **tasks** | always | `search` `list` `read` `create` `update` `complete`\* `schedule` `move` `archive`\* `addStep` `updateStep` `removeStep`\* |
| **projects** | always | `search` `list` `read` `create` `update`\* `complete`\* `archive`\* |
| **calendar** | reads: Google connected · writes: **and** the grant covers writing | `event.search` `event.read` `calendar.availability` `calendar.list` `event.create` `event.update` `event.delete` — creates/edits/deletes are *external* |
| **reminders** | always | `search` `list` `create` `update` `complete` `setPaused` `delete`\* |
| **habits** | always | `list` `search` `check` `create` `update` `archive`\* |
| **areas** | always | `list` `create` `update` `delete`\* |
| **diary** | always | `read` `range` `search` `append` `checkIn` |
| **library** | always | `search` `readPage` `sections` `projectBook` `appendPage` `createPage` `createBook` `createSection` `retitlePage` |
| **relationships** | always | `link.inspect` `link.traverse` `link.create` `link.remove`\* |

\* *important* — needs its own confirmation, not just the batch's.

Three answers from one registry, which is the whole architecture in one line:

| workspace | capabilities | what is missing |
|---|---|---|
| Google connected, writable | **61** | nothing |
| Google connected, read-only grant | **58** | the three `event.*` writes; the four calendar reads remain |
| no Google account | **54** | all seven calendar capabilities, with the reason stated |

Nothing was edited to produce those differences. `available()` is asked per
request and the numbers follow.

**`event.create` takes an optional `taskId`.** That is how *"put an hour in on
Thursday for the client handover"* ends with the event and the task linked, so
each is visible from the other on its Related section. Life OS has always made
that link when the UI schedules a task; the assistant could create the event
and not the link, which left a scheduled task that did not know it had been
scheduled.

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

### The gap audit

What the app can do, against what the assistant can do, sorted by whether beta
depends on it.

**Beta blockers — closed in this pass.** A user will expect these because the
app so obviously supports them.

| gap | closed by |
|---|---|
| "What is on my Today board?" retrieved nothing at all | `task.list`, `reminder.list`, `project.list` — reads that answer with no search term |
| naming a habit found nothing | `habit.search` |
| an event created for a task left the two unlinked | `taskId` on `event.create` |
| every calendar write would have failed at confirmation | `Capability.confirmed` (§4) |
| ticking a habit was impossible | the `habit.check` schema (§20) |

**Useful later — deliberately not built.** Each is real, none is a sentence
somebody is going to say in their first week.

- Restore and un-archive, for projects, tasks and library items. All exist in
  the app; none is phrased as a request.
- Reordering anything. Pointer-driven against a rendered list; no sentence maps
  onto "put this between those two".
- Creating library items, books and sections. Pages can be written and created;
  the container is a structural decision made once and rarely.
- Calendar settings, the default target calendar, and watch management.
  Configuration, not work.
- `project.nextAction`, `project.area`, and the Today arrangement lock. Board
  mechanics rather than intentions.

**Deliberately excluded, and staying that way.**

- **Deleting a task, a project or a habit.** Archive is the reversible verb and
  it is what "get rid of it" almost always means. A streak that took months is
  not something to lose on an ambiguous sentence.
- **Rewriting a diary entry.** Append only. There is no version history and a
  wrong write destroys something that cannot be reconstructed.
- **Importing legacy data, staging cleanup, sample seeding.** Operator tools.
  They are destructive at a scale no confirmation dialog can meaningfully
  describe.
- **Editing attendee emails on an event.** The draft the assistant may propose
  is narrower than the UI's on purpose: adding somebody to a meeting is a
  message to a person, not a change to a record.
- **Changing what the assistant may do.** No capability grants capabilities.

## 17a. Current capability matrix

**As of Phase 4: nine modules, 61 capabilities, 37 of them mutations.**

Read left to right: what the assistant can do to each thing that exists in Life
OS today. ✅ supported · ⛔ deliberately not supported, with the reason below.

| Entity | Read | Search | Create | Update | Complete | Archive | Delete | Link |
|---|---|---|---|---|---|---|---|---|
| **Task** | ✅ `task.read` `task.list` | ✅ | ✅ | ✅ title, area, priority, dueDate, scheduledAt, project, notes, bucket | ✅ `task.complete` (also reopens) | ✅ | ⛔ archive instead | ✅ |
| **Task step** | ✅ via `task.read` | — | ✅ `addStep` | ✅ `updateStep` incl. completion | ✅ via `updateStep` | — | ✅ `removeStep` | ⛔ not an entity |
| **Project** | ✅ with open/done counts, `nextTaskId` | ✅ | ✅ | ✅ title, outcome, description, notes, targetDate, **status**, **focus** | ✅ `project.complete` | ✅ | ⛔ archive instead | ✅ |
| **Area** | ✅ `area.list` (**every turn**) | ✅ via list | ✅ | ✅ rename editable areas | — | — | ✅ with reassignment | ✅ |
| **Habit** | ✅ schedule, target, streak state | ✅ | ✅ | ✅ configuration | ✅ `habit.check` per civil day | ✅ | ⛔ archive instead | ✅ |
| **Habit completion** | ✅ via `habit.list` | — | ✅ `habit.check` | ✅ count per day | — | — | ⛔ see below | ⛔ not an entity |
| **Reminder** | ✅ | ✅ | ✅ | ✅ incl. reschedule | ✅ | — | ✅ | ✅ |
| **Calendar event** | ✅ `event.read` `calendar.list` `calendar.availability` | ✅ | ✅ *external* | ✅ move/edit *external* | — | — | ✅ *external* | ✅ `scheduled_as` via scheduling |
| **Diary entry** | ✅ `diary.read` by date · `diary.range` over a period | ✅ | ✅ **only when explicitly asked** | ✅ append text; mood/energy/summary via `checkIn` | — | — | ⛔ see below | ✅ |
| **Library book** | ✅ via search | ✅ | ✅ `createBook` | ⛔ see below | — | — | ⛔ | ✅ |
| **Book section** | ✅ `library.sections` | ✅ via book | ✅ `createSection` | ⛔ see below | — | — | ⛔ | ⛔ structural |
| **Book page** | ✅ `readPage` | ✅ incl. full text | ✅ `createPage` | ✅ `appendPage`, `retitlePage` | — | — | ⛔ | ✅ |
| **item_link** | ✅ `link.inspect` `link.traverse` | — | ✅ `link.create` | — | — | — | ✅ `link.remove` | — |
| **Personal Memory** | ✅ injected into every turn | ✅ ranked per request | ✅ candidates the user accepts | ✅ in Settings | — | — | ✅ in Settings | ⛔ not a graph entity |

### Deliberate exclusions, with reasons

Every ⛔ above is a decision, not an omission:

- **Deleting a task, project or habit.** The product archives; archiving is
  reversible and deleting is not. The assistant offers what the product offers.
- **Replacing a page or diary body.** Both APPEND only. There is no version
  history for either, so an assistant that misread a sentence could destroy
  writing with no way back. Renaming a page is offered because a title is one
  short string, visible on the card before it applies.
- **Editing book and section titles.** Not yet exposed; low value against the
  same risk class as above. Creating them is supported.
- **Un-ticking a habit for a day.** `habit.check` sets a count and the count
  can be set again; there is no separate "undo today" service to adapt, and
  inventing one in the AI layer would put a product rule in the wrong place.
- **Deleting a diary entry.** A dated life record. The UI archives; the
  assistant does not offer it at all.
- **Structural relationships as links.** A page belonging to a section, a task
  belonging to a project, a project having its Book — these are ownership and
  are stored as such. Expressing them as `item_links` would create a second,
  disagreeing account of the same fact.
- **Memory as a graph entity.** Memory is what Life OS knows about the person,
  not an object in their workspace. It is used by every turn and managed in
  Settings.

### Whole-app operations the assistant still has no capability for

Unchanged from Phase 3, and listed here so the gap is visible rather than
mysterious: reordering anything, board column configuration, import/export,
sharing, workspace membership, calendar connection management, and preference
changes. All are pointer-driven or account-level; none maps cleanly onto a
sentence.

---

## 18. Future modules

Registerable without touching the planner, the executor or the proposal model:
**Finance**, **Food**, **Groceries**, **Email**, **Goals**, **Circles**.

None is built and none should be started as part of an AI phase — the point of
the registry is that they do not have to be.

**Brain is cancelled** as a product area. Its knowledge-storage role was
absorbed into Library; what remains of the idea *is* this system.

### Spoken responses (text-to-speech) — planned, not built

**Voice INPUT exists and is not this** — see §6j. Speech reaching the composer
is an input adapter; speaking an answer aloud is an output one, and they share
nothing but the word "voice".

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

**Closed by Phase 4:** actions could not depend on one another; each capability
resolved names its own way; *"it"* was left to the model's memory of prose;
routing lived nowhere; Library had no service boundary for books, sections or
page titles; Areas were not reliably in context.

**Still open:**

0. **Real-model verification of Phase 4 is outstanding.** The architecture is
   covered by 24 focused tests against a real database, and every previous
   phase found faults that only appeared when real sentences met the real
   model. The Anthropic account was out of credit when Phase 4 was built, so
   the staging turns in §15 of the Phase 4 brief have **not** been run. Treat
   the phase as unverified in that specific sense until they are.
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
   *"Actually make it 4"* about a pending calendar action therefore re-plans
   rather than amending, which is right and is slower than the task case.
6. **Reordering is still not offered** — tasks, steps, projects or habits.
   Pointer-driven against a rendered list; no sentence maps onto "put this
   between those two".
7. **No project restore, no task un-archive, no library archive/restore** from
   the assistant. All exist in the app; none is a sentence anyone says.
8. **Conversation state is the pending proposal plus the request.** No running
   summary is generated, so a long thread loses its early context. The column
   exists (`ai_conversations.summary`) and nothing writes it.
9. **The fast path covers four shapes.** Deliberately: it is the set where a
   cheap reading is safe, and every candidate for a fifth has to survive the
   question "what does this do when it is wrong". Anything else is a planner
   turn, which is correct and slower.
10. **The consistency pass reads English.** Its date and time detection covers
    what English actually says; a phrasing it does not recognise produces no
    finding rather than a wrong one. Failing open is the right direction for a
    check that withholds work, but it means the pass is a floor, not a ceiling.
11. **Turn history is deleted at 90 days, not archived.** Nobody has asked to
    read a four-month-old proposal, and keeping them would need a retention
    story of its own. If that changes, the sweep is one function.
12. **Source chips are what was retrieved, not what was cited.** On a broad
    question the row includes rows the answer never used — which is why they
    are labelled CONTEXT rather than "Used". §14.
13. **Nothing measures the assistant over time.** `metrics` on each turn says
    what happened in that turn; there is no aggregation, so "is retrieval
    getting worse" is not a question anything can currently answer.

## 20. Implementation status and changelog

### Phase 4 — full Life OS control (this pass)

**The gap this closed.** Phases 1-3 built an assistant that understood Life OS
and could make one change at a time. Phase 4 is about operating the whole of
it: several changes that depend on each other, across modules, referring to
things established earlier in the conversation.

**Built:**

- **Dependent actions** (§6e). `ai/depends.ts`: placeholders, graph ordering,
  cycle and dangling-reference detection, probe/unprobe validation. The
  executor runs in dependency order, substitutes real ids, skips dependents of
  failures, and reports in card order. Action ids now follow the planner's own
  numbering so a rejected action cannot silently redirect a reference.
- **One entity resolver** (§6f). `ai/resolve.ts`, through the registry's search
  capabilities. The fast path now calls it instead of matching titles itself,
  so there is one answer to "which one did they mean" rather than two.
- **Conversation references** (§6g). `ai/references.ts`: stable ids read from
  the turn table, titles read fresh, dead entities dropped. Seeded into
  retrieval, given to the planner, and added to the known-id set.
- **Module-declared routing** (§6i). `AiModule.routing`, assembled per request
  from what is registered and available.
- **`Capability.always`** — vocabulary reads retrieved on every turn. `area.list`
  is the first, and it fixes *"put it in Work"*.
- **Library service boundaries.** `createBook`, `createSection`, `retitlePage`
  in `lib/actions/library.ts`; the routes now call them rather than keeping a
  second copy of the same transaction.
- **Four new capabilities**: `diary.range`, `library.createBook`,
  `library.createSection`, `library.retitlePage`. 57 → **61**.
- **Relationship inference rules** in the relationships module, and a diary
  rule that separates *being told about a day* from *being asked to record it*.
- 24 tests in `api/tests/ai-phase4.test.ts`. Full suite: **1,634 passing**.

**Two faults found while building, both from reading the code rather than
running it:**

- **`library.search` never exposed a book id.** A Book is two rows with two
  ids, and search returned only the shelf one — so `library.sections` had
  required a `bookId` that nothing in the system could produce. Adding
  `createSection` would have shipped the same dead end. Fixed by exposing the
  book id from search, and then by making the services accept **either** id,
  which retires the module rule that previously had to warn about it. A rule
  the assistant must be told is strictly worse than a rule made unnecessary.
- **Rejected actions renumbered the survivors.** Ids were assigned by position
  in the surviving list, so if the planner's first action failed validation,
  `{{a2.id}}` would have pointed at whatever moved into that slot. Found before
  any dependency could be written; ids are now keyed to the planner's index.

**Not done, and why:** the real-model staging turns (§0 of Known gaps above).
The provider account had no credit; nothing was faked in their place.

### Phase 3 — beta readiness

**Nine faults that no test had, found by building against the real thing.**
Every one was found by running real sentences through the real model over a
real workspace, and none of them would have been found any other way:

- **`event.create` could never execute.** Preview replaces the payload with a
  ledger handle, and the executor validated that handle against the PLAN-time
  schema — a strict object demanding a `calendarId` and a `draft`. Every
  assistant calendar write would have failed *after* the user agreed to it.
  Capabilities that preview now declare `confirmed`, a second execution-time
  shape. No test had caught it because no test could confirm a calendar action
  without a Google connection.
- **`habit.check` could never run.** Its input was `z.object({id}).and(
  HabitCheckInput)`, and an intersection runs both halves over the whole
  payload — so the strict half rejected the `id` the other half declared.
- **Habits were not searchable at all.** `habit.list` answers "what am I
  tracking", which is not "which of these is Morning walk". Naming a habit
  found nothing, so *"complete Morning walk"* was answered as though the habit
  did not exist.
- **A read-only Google grant switched Calendar off entirely**, and the
  assistant then reported that it could not SEE a calendar sitting in front of
  it. Availability now answers two questions rather than one.
- ***"What is on my Today board?"* retrieved nothing at all.** It contains no
  word that appears in any title, every search came back empty, and the answer
  was "I cannot see your Today board" — about the most ordinary question a
  command centre gets. Search answers "which of these is X"; nothing answered
  "what is there". Now `task.list`, `reminder.list` and `project.list` do, and
  the low-result fallback widens on any thin result rather than only on
  requests containing a change verb.
- ***"I finished pricing three options"* could not find *Price three
  options*.** Query building spent a fixed budget on several spellings of the
  same word, and the stems fell off the end of the list. Since `ILIKE` is
  substring matching, the shortest form is the broadest one — so each word now
  contributes one query in its broadest safe form and any query containing
  another is dropped as redundant.
- **`task.complete` kept arriving with no id.** The planner was given a
  capability's description and never its schema, so it inferred field names
  from an English sentence. That works for `title` and fails for `id`, which no
  description mentions. Capabilities now carry a payload signature generated
  from their own Zod schema.
- **An amended card kept prose about the old value** — "Saturday 5 September"
  above a date field the amendment had moved to the 7th. The consistency pass
  runs before the user sees anything and an amendment happens after, so it was
  the one door left unwatched.
- ***"Add chicken to the Today list"* was refused** as a card promising a date
  its payload would not set. "Today" is a board COLUMN as well as a day; the
  check now counts `bucket` and reads the parsed payload, so schema defaults
  are part of what it validates.
- **A contradicting memory was not recognised as one.** "Prefers afternoon
  meetings, and no meetings before 10" against "prefers morning meetings, and
  no meetings after 3" shares exactly two distinctive words, which fell under
  the threshold — so the reversal arrived as unrelated news and the list held
  both. The threshold moved, and contradiction detection is now restricted to
  the categories where a fact is a single standing value, because two people
  can both be the contact on a project.

**Built and tested:**

- **Fast path** (§6a) — four deterministic shapes, failing closed into the
  planner with a recorded reason. No model, no reasoning chain, same gate.
- **Amendment path** (§6b) — a correction to a pending proposal is an EDIT to
  it, through the same validated path the card's own controls use. *"Actually
  Saturday"* no longer produces a second haircut or a report that the first
  does not exist.
- **Consistency validation** (§6c) — a deterministic, schema-aware pass
  between planning and the user, with one repair attempt and a withhold.
- **Structured clarification** (§12) — options carry entity refs and a
  distinguishing line; the client answers with an option id; the ORIGINAL
  request continues with that entity seeded.
- **Retrieval** (§5a) — stems and plurals, structural expansion, a low-result
  fallback that goes broad before concluding absence, concurrent gathering, and
  recorded rather than swallowed failures.
- **Read/write availability split** (§4), and `registry.explain` so a refusal
  is a sentence rather than a status.
- **`event.create` takes a `taskId`**, so scheduling a task onto the calendar
  leaves the two linked and visible from each other.
- **Memory** (§11) — relevance-gated injection, contradiction detection routed
  into supersede (which protects a pin), candidate dedupe, and retention that
  never touches a memory or an unconfirmed proposal.
- **`registry.explain`** and the planner being told WHY a module is absent, so
  a disconnected calendar produces "No Google Calendar account is connected"
  rather than "I could not find that meeting".
- **29 new tests** in `ai-beta.test.ts`.

**Database:** `ai_turns.clarification`, and `clarifying` added to the status
CHECK (migration `0017_ai_beta.sql`). Additive; nothing existing rewritten.

**Operations:** `/health/version` now reports whether a model is configured in
THIS environment, and for which jobs. A boolean and job names — no key, no
vendor host, no model id, because that endpoint is public and unauthenticated.
Before it, the only way to find out whether staging had a key was to sign in
and ask the assistant, and the answer to "why is it not working" was a shrug.

**Two tests changed rather than deleted.** One asserted that the pending set
reached the planner appended to the request text; it is a field now, carrying
payloads rather than titles, and the assertion followed it. One relied on an
invented uuid failing at execution; invented ids are refused at planning now,
so the test names something real and deletes it between the agreement and the
run — which is what it was always about.

### Phase 2 — the real assistant

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
