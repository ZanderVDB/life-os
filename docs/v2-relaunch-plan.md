# Life OS v2 — clean relaunch plan

## The decision

We are not migrating the legacy app. We are building a clean v2 baseline on
Railway and relaunching from it. The legacy app keeps running, untouched, until
v2 is genuinely better.

This replaces the earlier system-by-system migration plan. That plan assumed we
had to carry the existing architecture forward. We don't — the data that
actually matters is small, and the verified v242 export is a complete,
independent copy of it.

## What "clean" means here

| | Legacy | v2 |
|---|---|---|
| Storage | Firestore, one document per profile, 1 MiB ceiling | Postgres, one row per record |
| Data boundary | Personal / Business profile switch | One workspace per user; Areas divide life |
| Client | 18k-line single-file `index.html` | `/web` shell against a real API |
| Trust | Client writes straight to the database | Server validates, authorises, then writes |
| Auth | Firebase, wired into everything | Firebase at the edge only, swappable |

The last row is the important one. `users.external_uid` is the only place
Firebase appears in the data model. Tokens are verified against Google's public
JWKS — there is no service-account key anywhere. Replacing Firebase later means
writing one new verifier and backfilling one column.

## What exists today

**Backend** (`/api`) — Node + TypeScript + Fastify + Zod + Drizzle + Pino.

- 9 tables, one generated migration (`api/drizzle/0000_baseline.sql`)
- Firebase ID-token verification via JWKS
- `/health`, `/ready`, `/health/version`, `/api/v1/me`
- Full Task API: CRUD, complete/uncomplete, archive, move, steps
- Areas API with case- and whitespace-insensitive uniqueness
- Import **preview** endpoint — counts only, writes nothing
- 55 tests against real Postgres (PGlite)

**Web** (`/web`) — Today shell, import preview page, locked design language.

- Four buckets: Today / This Week / This Month / Future
- Create, edit, complete, archive, delete, reorder, move between buckets
- Task detail panel with steps, notes, priority, area, due date
- Drag **and** a Move menu **and** keyboard shortcuts — all one endpoint
- Import preview reads a verified v242 export and reports counts only

**Not built yet, on purpose:** Calendar, Projects, Library, Brain, AI, file
uploads, and the import *write* path.

## Movement is not drag

Legacy movement was drag-only, which is why it never worked on a phone. In v2
every path — dragging a card, the Move menu, `Alt+←/→` between buckets,
`Alt+↑/↓` within one — calls the same `POST /tasks/:id/move`. Drag is an
enhancement layered on top, never the only route. On touch and narrow screens
the drag handle is hidden and the Move button becomes a 44px target.

Ordering uses sparse integer positions with a gap of 1000, so a move rewrites
one row rather than renumbering the list.

## Data direction

One primary workspace per user, enforced by a partial unique index. There is no
workspace switcher and `/api/v1/me` deliberately returns no workspace *list* —
a test asserts that, so a switcher cannot creep back in by accident.

Areas replace the Personal/Business profile split. Two are seeded: **Personal**
and **Work**. Deleting an Area sets `tasks.area_id` to null rather than
cascading — losing an Area must never lose the work inside it.

`tasks.project_id` exists and is nullable, so Projects can arrive later without
a migration on the tasks table.

## Legacy data

The verified v242 export is the source. Only the **Personal** profile is read,
chosen by name and never by position — a test proves Business is excluded even
when it is listed first.

`legacy_id` is unique per workspace, so a real import can run twice without
duplicating anything.

The import is **preview-only**. There is no write path in the code. The
sequence is: look at the numbers, agree they are right, then build the writer.

## Order of work from here

1. **You provision staging** — see [staging-setup.md](staging-setup.md).
2. **Confirm the preview numbers** against a real export.
3. **Build the import writer** once those numbers look right.
4. **Live alongside** — use v2 Today daily while legacy still runs.
5. **Then, and only then**, build Calendar → Projects → Library → Brain → AI.
6. **Retire legacy** when nothing depends on it.

Nothing in step 6 happens automatically. The legacy app and its Firestore data
stay exactly as they are until you decide otherwise.

## What is deliberately not decided yet

- Where `/web` is hosted (Railway static, Cloudflare Pages, or the existing
  Railway service) — it is plain static files, so any of them works.
- Whether the v2 shell becomes a PWA with a service worker. The legacy app's
  `sw.js` cache-bumping ritual is a recurring source of stale-deploy bugs, and
  the baseline is better off without one until it is actually needed.
- Whether Firebase Auth stays. The design assumes it might not.

---

## Status 2026-07-31 — staging is live

| | |
|---|---|
| Web | `https://life-os-v2-web-staging-v2-staging.up.railway.app` |
| API | `https://life-os-v2-api-staging-v2-staging.up.railway.app` |
| Database | `life-os-v2-postgres-staging` — 9 tables, 29 indexes |
| Environment | Railway `v2-staging`, isolated from Legacy's `production` |
| Tests | 78 passing |

Sign-in, workspace provisioning, Area seeding and task operations are all
verified against real Railway Postgres from a real browser. Legacy is untouched
and still serving `v244`.

The import preview has been run against the real verified v242 export: **71
tasks, Personal only, nothing written.** Details in
[legacy-data-decision.md](legacy-data-decision.md) and
[build-progress.md](build-progress.md).

**Step 3 of the order of work — building the import writer — is blocked on
Zander approving those counts.** That gate is deliberate.

One correction to the plan above: the excluded profile is named **Trifusion**,
not Business. Selection was never affected — Personal is identified positively.
