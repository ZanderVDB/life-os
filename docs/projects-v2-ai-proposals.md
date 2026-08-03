# AI proposals and approval — the rule (not built)

**No AI exists in E2.** No chat, no composer action, no write path, no tables,
no browser call to any model. The composer remains visibly disabled.

This document locks the rule that everything later has to obey, because it is
much easier to build an approval step in from the start than to retrofit one
onto a system that already writes.

---

## The rule

> **AI may interpret and propose freely. AI may not silently create anything
> meaningful or anything external.**

Interpretation is cheap and reversible. A write is neither.

---

## The flow

```
1. brain-dump          the user types or speaks, unstructured
2. interpret           AI works out possible destinations
3. clarify             AI asks focused questions ONLY where genuinely ambiguous
4. propose             a change set: n discrete, editable proposals
5. review              the user edits, removes or approves each one individually
6. execute             only what was approved, and nothing else
```

Step 5 is not a confirmation dialog. It is a list the user can edit. "Approve
all" may exist as a convenience; it may never be the only option.

### Possible destinations

Current project note · current project task · another project · a new project ·
calendar event · scheduled task block · reminder · brain idea · diary entry ·
library item.

**Context is a hint, never an assumption.** Having a project open does not make
every sentence belong to it. If the destination is ambiguous, ask — one focused
question, not a form.

---

## Explicit approval is mandatory before

- any Google Calendar write;
- scheduling work;
- creating a recurring reminder;
- creating or moving a Project;
- changing a Task's Project;
- adding a Diary entry;
- moving content into Brain;
- creating a Library item;
- completing, archiving or deleting anything.

The list is deliberately long. The common thread: each one is either **visible
to someone else**, **destructive**, or **hard to notice and undo**. Those are
the three things an interpretation is not allowed to do on its own.

---

## The proposal record

When built, a proposal should carry:

| Field | Why |
|---|---|
| `action_type` | create_task, schedule_block, create_event, … |
| `destination` | which system, which record |
| `source_context` | what the user actually said, verbatim |
| `reason` | one concise practical sentence |
| `payload` | the editable change itself |
| `approval_state` | pending / approved / rejected / edited |
| `execution_result` | what happened |
| `error` / `rollback` | what did not, and what was undone |

**`reason` is a sentence, not a rationale.** Good: *"Suggested as a calendar
event because you named a fixed meeting time."* That is checkable — the user can
see the time in what they said and agree or disagree in a second.

**No chain-of-thought is stored or shown.** It is long, it is not
user-checkable, it invites trust the output has not earned, and storing it means
storing a verbose restatement of private content.

---

## Google Calendar specifically

Google stays **read-only** until a phase explicitly approves otherwise, and even
then every write — AI-proposed or user-initiated — passes through the review
step above. A calendar event is visible to other people; it is the clearest case
in the app of a change that must never be a side effect.

---

## What E2 did to prepare

Nothing, deliberately. No AI tables were added, because a table with no reader
is a migration that has to be undone.

What E2 *did* provide is the thing that makes proposals implementable: **every
meaningful Project mutation is already a discrete, named, validated endpoint**
with an explicit body — create, complete, archive, restore, assign task, change
area, set next action. A proposal executor calls exactly the same endpoints a
person does, which means the approval step cannot be bypassed by an AI path that
writes to the database directly.
