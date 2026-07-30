# Life OS — Backend Architecture v2

**Status: DESIGN ONLY. Nothing here has been built or provisioned.**
**Created 2026-07-31 · app version at writing: v239**

> **Architecture decision recorded:** Life OS v2 will move toward a
> Railway-hosted backend with **Railway PostgreSQL** for structured data and
> **Cloudflare R2** for binary files and exports. **Firebase Auth and Firestore
> remain temporarily** during a controlled, reversible migration.
> Firestore has **not** been removed. The migration has **not** started.

## ✅ LOCKED DECISIONS (approved 2026-07-31)

**Phase 0.5 is accepted: the backend and data foundation are completed BEFORE
the Today and Task Detail redesign.**

| Area | Locked choice |
|---|---|
| **Stack** | Node.js · **TypeScript** · Fastify · Zod · **Drizzle ORM + Drizzle migrations** · PostgreSQL · Pino |
| **ORM** | **Drizzle only** — Kysely is *not* installed. One query layer. |
| **Build step** | The TypeScript build step is **accepted**; Life OS is becoming a relational, multi-system application. |
| **Structured data** | **Railway PostgreSQL** — never one JSON blob column |
| **Files/objects** | **Cloudflare R2** — never the primary structured database |
| **Source** | GitHub · **Deploy** Railway |
| **Auth** | Firebase Auth **temporarily**, verified server-side |
| **Legacy** | Firestore **temporarily** as legacy source + rollback copy |
| **Anthropic** | **One platform-level key**, Railway env var only. The browser must stop storing/calling Anthropic with a user key. **Not migrated yet.** |
| **Quota** | **5 GB soft per profile**, configurable; warn at **70 / 85 / 95 %**. General max file size **100 MB**, with future per-type limits. **Not provisioned or enforced yet.** |
| **R2 delivery** | **Hybrid** — signed URLs for attachments/large files/downloads/video; short-lived signed URLs may initially serve private inline images; leave room for a backend thumbnail/transform layer. **Do not stream all large objects through Railway.** Buckets private; permanent credentials never reach the browser. |
| **Malware scanning** | **Deferred** while private and single-user. Extension, MIME, size, safe-name, ownership, object-path and private-access validation are still **required**. Risky files are delivered as attachments, never executed inline. **Mandatory before user-to-user sharing.** |
| **Mobile** | **First-class.** Every core Task interaction needs a touch-first method, a **non-drag Move action**, a keyboard method and an accessible method. HTML5 desktop drag may **not** be the only movement mechanism. |
| **Migration** | System-by-system. Today/Task Detail UI is built **against the new Task API**, never shipped against the old Firestore object and rewritten later. |

### AI capabilities to design for (not built yet)
Usage tracking · per-profile/per-user budgets · rate limiting · model
configuration · **provider abstraction** · safe error logging.

### Legacy data — provisional decisions (nothing deleted)
| Data | Decision |
|---|---|
| `dayNotes` | **Needs live-data inspection.** Export/inspect before deciding. |
| People | **Archive or export, then remove from the active product** — unless inspection reveals an important future use. |
| Board | Verify whether it holds unique stored data. Page code may be removed later, **but not before its data is classified.** |
| Old Habits page | Unreachable **UI** may be removed later. **Valid habit data must remain.** |
| `learning` | Inspect for unique content; migrate anything useful before removal. |
| `customEvents` | **Investigate carefully — current behaviour may already be destructive.** Make no further destructive changes. |

> **Deleting an unused page and deleting its data are separate decisions.**

---

## 1. Current deployment state — corrected

The previous audit under-described this. Here is the accurate picture.

| Layer | Today | Notes |
|---|---|---|
| **Source control** | **GitHub** — `ZanderVDB/life-os` | already correct |
| **Frontend hosting** | **Railway** | already correct |
| **Backend runtime** | **Railway (Node ≥18)** — but it is only `server.js`, a ~50-line **static file server** | **there is no application backend** |
| **Structured data** | **Firestore**, written **directly from the browser** | one record per profile |
| **File / object storage** | **none** | no attachments anywhere |
| **Authentication** | **Firebase Auth** (Google sign-in only) | client-side session |
| **AI** | **Anthropic, called directly from the browser** | user's key in the browser *and* in Firestore |
| **Calendar** | **Google Calendar / Tasks** direct from browser; Outlook built but dormant | OAuth tokens in browser storage |

`server.js` serves files and nothing else: no routes, no database access, no
secrets, no validation. Deployment is Nixpacks auto-detect via
`package.json → "start": "node server.js"`; there is no `railway.json`.

**So the change is not "move hosting to Railway" — that is already true.**
The change is **introducing a backend tier that does not exist today**, and
moving trust out of the browser.

### Target

```
Browser / future mobile client
      │  (Firebase ID token in an Authorization header)
      ▼
Railway backend API  ── the only trusted layer ──────────────
      ├─► Railway PostgreSQL      structured data
      ├─► Cloudflare R2           files, images, exports (signed URLs only)
      ├─► Anthropic               AI (server-held key)
      ├─► Google / Microsoft      calendar (server-held refresh tokens)
      └─► Firestore (temporary)   legacy read + rollback copy
```

**The client will hold no private keys, will never connect to PostgreSQL, and
will eventually stop talking to Firestore and Anthropic directly.**

---

## 2. Database ownership — Railway PostgreSQL vs Cloudflare D1

The user's preference is Railway PostgreSQL. The audit **independently
supports that**, and the reasoning is not "because Railway is already used".

| Criterion | Railway PostgreSQL | Cloudflare D1 (SQLite) |
|---|---|---|
| **Backend proximity** | Same platform, same private network as the API — single-digit-ms | D1 is bound to Cloudflare Workers. A Railway backend would reach it over HTTP, adding latency and a second platform |
| **Relational queries** | Full SQL: CTEs, window functions, `LATERAL`, partial + expression indexes | SQLite subset; adequate but weaker |
| **Transactions** | True multi-statement transactions, `SERIALIZABLE` available | Limited; no interactive transactions over HTTP |
| **Gantt / dependency queries** | **Recursive CTEs** — the natural way to walk a dependency graph and detect cycles | Recursive CTEs exist in SQLite, but combined with the HTTP boundary this becomes awkward |
| **Migrations** | Mature tooling, transactional DDL | Workable but thinner |
| **Local development** | Docker Postgres = identical engine locally | Local emulation diverges from production |
| **Backups** | Managed snapshots + standard `pg_dump` | Time Travel (30 days), less portable |
| **Future collaboration** | Row-level ownership, concurrent writers, real locking | Weaker under concurrent writers |
| **Cost at this scale** | A few $/month | Effectively free at small scale |
| **Operational complexity** | One managed add-on | Adds a second platform + Workers runtime |
| **Vendor coupling** | Standard Postgres — portable anywhere | D1 is Cloudflare-only |

**Recommendation: Railway PostgreSQL.** The decisive factors are *backend
proximity* (the API lives on Railway), *real transactions* (AI batches must be
all-or-nothing — see D5 in `technical-debt.md`), and *recursive CTEs* for the
planned dependency/Gantt work. D1's advantages are cost and edge latency,
neither of which matters for a single-user app whose API is already on Railway.

**R2 for files is a genuinely good fit** and is *not* the same decision: object
storage with zero egress fees, S3-compatible, and no relational requirements.
Using R2 while using Railway Postgres is coherent, not contradictory.

---

## 3. Language and framework

The repo today is plain Node (no dependencies, no build step, `engines: node >=18`).

**Recommendation: Node.js + TypeScript + Fastify.**

| Choice | Why |
|---|---|
| **Node.js** | The team already runs Node on Railway; no new runtime to learn |
| **TypeScript** | The whole point of this migration is *typed, validated structure*. A 26-table relational model without types will regress into the same untyped soup we are escaping. |
| **Fastify** | Fast, small, first-class schema validation, good plugin/encapsulation model. Express is acceptable if familiarity matters more. |
| **Zod** | One schema definition reused for runtime validation **and** TypeScript types |
| **Drizzle ORM** (LOCKED — not Kysely) | Typed SQL that stays close to SQL. Avoid heavy ORMs — the query shapes here (Gantt, recursive dependencies) are SQL-shaped. |
| **node-postgres (`pg`)** | Connection pooling underneath Drizzle |
| **Pino** | Structured JSON logging, Fastify-native |
| **Vitest** | Tests, including migration tests |

**Trade-off (accepted 2026-07-31):** TypeScript introduces a build step this project has never had. The lighter alternative is **plain JavaScript with JSDoc types + Zod**,
which keeps zero-build simplicity and still validates at runtime. If the build
step feels like too much change at once, that is a legitimate choice — but for a
relational backend I recommend TypeScript.

**Do not** split into microservices. One modular service, organised by domain.

---

## 4. REST vs RPC

**Recommendation: a hybrid — REST for resources, RPC-style for actions.**

Pure REST forces awkward verbs onto real operations ("complete a task",
"apply an AI batch", "reorder a bucket"). Pure RPC loses the cache and
convention benefits of resource URLs.

```
REST for CRUD:
  GET    /api/v1/profiles/:profileId/tasks
  POST   /api/v1/profiles/:profileId/tasks
  PATCH  /api/v1/profiles/:profileId/tasks/:taskId
  DELETE /api/v1/profiles/:profileId/tasks/:taskId

RPC for actions (POST, verb in the path, explicit and auditable):
  POST /api/v1/profiles/:profileId/tasks/:taskId:complete
  POST /api/v1/profiles/:profileId/tasks:reorder
  POST /api/v1/profiles/:profileId/ai/commands          → returns a PREVIEW
  POST /api/v1/profiles/:profileId/ai/commands/:id:apply
  POST /api/v1/profiles/:profileId/exports
```

Everything is versioned under `/api/v1/`. Every data route is scoped by
`profileId` in the path, which makes the ownership check uniform and impossible
to forget.

---

## 5. Route structure

```
/health                                  liveness  (no auth)
/health/ready                            readiness — DB + R2 reachable
/api/v1/me                               current user + profiles
/api/v1/profiles                         list / create
/api/v1/profiles/:profileId              get / update / delete

  …/tasks                                CRUD, filter by bucket/status
  …/tasks:reorder                        bulk order within a bucket
  …/tasks/:id:complete  :uncomplete
  …/tasks/:id/steps                      subtasks
  …/tasks/:id/dependencies
  …/tasks/:id/activity

  …/projects                             CRUD
  …/projects/:id/milestones
  …/projects/:id/dependencies
  …/projects/:id/activity
  …/projects/:id/tasks                   tasks belonging to a project

  …/areas                                (was "workProjects")
  …/habits            …/habits/:id/entries
  …/reminders         …/reminders/:id:complete
  …/books             …/books/:id/sections   …/sections/:id/pages
  …/diary-entries                        by date
  …/brain-items       …/brain-items/:id/links
  …/attachments:presign-upload           → signed R2 PUT URL
  …/attachments/:id:presign-download     → signed R2 GET URL
  …/attachments/:id                      metadata / delete
  …/exports                              create + poll + download
  …/preferences
  …/ai/commands                          create → preview
  …/ai/commands/:id:apply                apply reviewed operations
  …/ai/commands/:id:cancel
  …/ai/memory
  …/calendar/connections                 OAuth connect / disconnect
  …/calendar/events                      proxied provider reads/writes

/api/v1/admin/migrations                 run / status  (owner-only)
```

---

## 6. Authentication — the transitional design

**Firebase Auth stays for now.** This is deliberate: migrating storage *and*
identity at once would combine two risky changes.

**Flow**
1. The browser signs in with Firebase exactly as today.
2. The browser attaches the Firebase **ID token** on every API call:
   `Authorization: Bearer <firebase-id-token>`.
3. The backend **verifies the token server-side** with the Firebase Admin SDK
   (signature, expiry, issuer, audience). It never trusts client-side claims.
4. The backend looks up `users.firebase_uid` → internal `users.id` (a UUID),
   creating the row on first sight (just-in-time provisioning).
5. **Every** data route then re-checks that the requested `profileId` belongs to
   that user, via `profile_memberships`. A valid token for user A can never
   touch user B's profile.

**Why this survives replacing Firebase later:** the internal `users.id` UUID is
the only identifier the rest of the schema references. `firebase_uid` is just
one nullable external-identity column. Adding e.g. email/password or Apple
sign-in later means adding a row to an `user_identities` table (or a second
column) and issuing our own session — **no data-model rewrite**.

```
users
  id            uuid  PK      ← everything references this
  firebase_uid  text  UNIQUE NULL   ← removable later
  email         citext UNIQUE
```

**Rules**
- The backend never accepts a user id from the client body or query.
- Ownership is enforced in middleware, not per-handler.
- Tokens are verified on every request (with a short in-process JWKS cache).
- **Do not remove Firebase Auth in this phase.**

---

## 7. Middleware chain

```
requestId → logger → cors → bodyLimit → rateLimit
  → authenticate (verify Firebase token → internal user)
  → resolveProfile (:profileId → membership check → 403 if not owned)
  → validate (Zod on params/query/body)
  → handler (inside a DB transaction where it writes)
  → errorHandler
```

**Validation:** one Zod schema per route, generating both runtime validation and
the TypeScript types. Reject unknown fields. Never pass raw client objects into
SQL. Validate at the boundary so handlers can assume clean input.

**Errors:** one shape, always.
```json
{ "error": { "code": "TASK_NOT_FOUND", "message": "Task not found.",
             "details": {}, "requestId": "01J..." } }
```
`code` is a stable machine string; `message` is human-safe; `details` carries
field errors for validation failures. **Never leak stack traces, SQL, or
provider responses to the client** — log those server-side against the
`requestId`.

HTTP: `400` validation · `401` missing/invalid token · `403` not your profile ·
`404` not found · `409` conflict/version mismatch · `422` valid shape but
impossible (e.g. dependency cycle) · `429` rate limited · `500` unexpected.

**Logging:** structured JSON via Pino, one line per request
(`requestId, userId, profileId, route, status, durationMs`). **Redact**
`authorization`, tokens, API keys, and file contents. Log AI prompts only in a
truncated, opt-in form. Errors log the full cause server-side only.

**Rate limiting:** per user, not per IP (one user, many devices).
Suggested: 300 req/min general; **AI command creation 10/min and a daily token
budget** — the audit found *no* rate limit or cost guard today, plus a timer
that calls the AI automatically. Return `429` with `Retry-After`.

---

## 8. Environment variables

None of these exist yet. **All secrets live only on the server.**

```
# Core
NODE_ENV=production
PORT=8080                        # Railway injects
APP_BASE_URL=https://life-os.web-anchor.com
LOG_LEVEL=info

# Database  (Railway PostgreSQL add-on provides this)
DATABASE_URL=postgresql://…
PGSSLMODE=require
DB_POOL_MAX=10

# Firebase Admin (server-side token verification)
FIREBASE_PROJECT_ID=life-os-a25bc
FIREBASE_CLIENT_EMAIL=…@…iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n…"

# Cloudflare R2
R2_ACCOUNT_ID=…
R2_ACCESS_KEY_ID=…
R2_SECRET_ACCESS_KEY=…
R2_BUCKET=life-os-prod
R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com
R2_PRESIGN_UPLOAD_TTL=900        # 15 min
R2_PRESIGN_DOWNLOAD_TTL=300      # 5 min

# AI
ANTHROPIC_API_KEY=sk-ant-…       # MOVES OFF THE CLIENT
AI_MODEL=claude-sonnet-4-6       # one constant, not 9 hardcoded copies
AI_MAX_OUTPUT_TOKENS=4096
AI_DAILY_TOKEN_BUDGET=…

# Calendar integrations (server-held)
GOOGLE_OAUTH_CLIENT_ID=…
GOOGLE_OAUTH_CLIENT_SECRET=…
MICROSOFT_OAUTH_CLIENT_ID=…
MICROSOFT_OAUTH_CLIENT_SECRET=…

# Encryption for stored third-party tokens
TOKEN_ENCRYPTION_KEY=…           # 32-byte key, AES-256-GCM

# Migration / legacy
FIRESTORE_LEGACY_ENABLED=true
MIGRATION_DRY_RUN=true
```

---

## 9. Health checks

- `GET /health` — process is alive. No dependencies, no auth. Railway uses this.
- `GET /health/ready` — checks `SELECT 1` against Postgres and a cheap R2
  `HeadBucket`. Returns `503` with per-dependency status when degraded.
- `GET /health/version` — commit SHA + migration version, for verifying a deploy.

---

## 10. Database migrations

- **Versioned SQL files**, `NNNN_description.sql`, applied in order.
- Applied **automatically on boot before the server accepts traffic**, inside a
  transaction, with an advisory lock so concurrent instances cannot race.
- Every migration recorded in `schema_migrations`.
- **Forward-only** in production; roll forward with a new migration rather than
  down-migrating live data.
- **Data migrations** (moving Firestore → Postgres) are a *separate* mechanism
  from schema migrations — they are jobs, tracked in `migration_runs`
  (see `postgres-data-model-v2.md`), idempotent and restartable.

---

## 11. Deployment

- GitHub → Railway, deploy on push to `main` (as today).
- Two Railway services from one repo: **`web`** (the existing static server, or
  eventually a built frontend) and **`api`** (the new backend). Plus the
  **PostgreSQL** add-on.
- Separate **staging** environment with its own database — required, because
  the migration must be rehearsed on real-shaped data before touching production.
- Deploy sequence: build → run migrations → health check → switch traffic.
- Keep the existing `APP_VERSION` / `sw.js` `CACHE` discipline for the frontend.

## 12. Local development

```bash
docker compose up -d          # postgres:16
cp .env.example .env
npm run db:migrate
npm run dev                   # api on :8080, watch mode
npm run seed                  # optional demo profile
```

- Local Postgres in Docker so the engine matches production exactly.
- R2 can be pointed at a scratch bucket, or MinIO for offline work (both
  S3-compatible).
- Firebase token verification works locally against the same project.
- `MIGRATION_DRY_RUN=true` by default outside production.

---

## 13. AI on the server

Moving Anthropic calls server-side is one of the biggest wins available.

- **The key leaves the browser** (today it is in localStorage *and* in the
  Firestore record — see `technical-debt.md` D10).
- **One model constant** replaces nine hardcoded copies.
- **Preview-first becomes structural:** `POST /ai/commands` returns a stored
  preview (`ai_commands` + `ai_command_operations`) and writes **nothing**.
  A separate `:apply` call executes the *reviewed* operations **inside one
  database transaction** — fixing the non-atomic apply (D5).
- Operations are validated server-side against a schema **and** against the
  caller's scope, so a page-permission bug cannot become a data-loss bug.
- Rate limits and a token budget become enforceable.
- The calendar step still touches the network, so it stays outside the DB
  transaction — but it now runs **before** the transaction commits, or records a
  compensating action, so declining a calendar confirmation no longer leaves
  everything else already written.

---

## 14. Backups vs exports — two different features

These are deliberately separate. One protects **us** from data loss; the other
gives **the user** their data.

### 14a. Database backups (operational)
- **Railway managed PostgreSQL snapshots** — daily, retained ~7–30 days.
- **Own `pg_dump` to R2** on a schedule (nightly), written to a *separate*
  bucket/prefix from user content, so a Railway-side problem is not a single
  point of failure.
- **Pre-migration snapshot before every data-migration run**, recorded in
  `migration_runs.backup_ref`.
- **Restore testing:** restore the latest dump into staging monthly and run a
  row-count + checksum comparison. *A backup that has never been restored is not
  a backup.*
- Retention: daily 7 days · weekly 4 weeks · monthly 6 months.
- Firestore keeps a protected export for the whole rollback window.

### 14b. User exports (a product feature)
The app has **no export at all today** — a real gap for a personal life system.

- `POST /api/v1/profiles/:id/exports` → job → downloadable bundle in R2 via a
  short-lived signed URL.
- Formats:
  - **JSON** — complete, machine-readable, the canonical export.
  - **Markdown / HTML** — for Library books, diary entries and notes; the
    human-readable form worth keeping for decades.
  - **CSV** — tasks, habit entries, reminders (spreadsheet-friendly).
  - **Attachment bundle** — either a zip of R2 objects, or a manifest of signed
    URLs when the bundle is large.
- A **complete profile export** combines all of the above with a `manifest.json`
  describing schema version and counts.
- Exports are user-triggered, logged, and rate-limited.

---

## 15. What this fixes from the audit

| Audit risk | How the backend addresses it |
|---|---|
| D1 profile data leak | Ownership enforced in middleware; a profile's rows are physically separate |
| D3 one 1 MB record | Real tables, no document ceiling |
| D5 AI not atomic | Apply runs in one DB transaction |
| D6 orphaned data | An explicit, reviewed mapping decides what migrates |
| D8 global re-render | The client fetches only what a screen needs |
| D10 keys in plain text | Keys move server-side; third-party tokens stored encrypted |
| No export | A first-class export feature |
| No files | R2 + `attachments` |

**It does not fix:** touch drag-and-drop (D4), timezone handling (D9),
notebook sanitisation (D13), or notifications-when-closed (D14) — those remain
client/product work.
