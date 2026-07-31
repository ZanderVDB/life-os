# Staging setup — exact manual actions

**Status: PROVISIONED AND VERIFIED — 2026-07-31.** Everything below has been
done. It is kept as the record of how staging was built and how to rebuild it.

| Resource | Name |
|---|---|
| Environment | `v2-staging` (Railway project `life-os`) |
| Database | `life-os-v2-postgres-staging` |
| API | `life-os-v2-api-staging` — `https://life-os-v2-api-staging-v2-staging.up.railway.app` |
| Web | `life-os-v2-web-staging` — `https://life-os-v2-web-staging-v2-staging.up.railway.app` |

Legacy's `production` environment and its `life-os` service were not modified.

**Two things differ from the instructions below, learned by doing it:**

1. **Root Directory cannot be set from the Railway CLI** — it is a dashboard-only
   setting, and it is the step most easily missed. Miss it and the service
   builds from the repo root and silently runs the *legacy* `server.js`.
2. **`railway redeploy` alone does not pick up new variables** — it replays the
   existing deployment. Use `railway redeploy --from-source`.

The code is complete and tested without any of it. You can run the whole stack
locally today — see [Run it locally right now](#run-it-locally-right-now).

---

## Why you have to do this and not me

Provisioning a Railway service, attaching a Postgres instance and setting
secrets all act on your account and cost money. Creating a Firebase Web App
registration does too. I stopped before any of it, as instructed.

I also did not invent any credential. `web/config.js` ships with the literal
string `FILL_ME_IN` in every Firebase field and fails loudly with a
"Configuration needed" card until you replace them. There are no secrets in the
repository and none in the chat.

---

## Run it locally right now

No account, no database, no cloud. Two terminals:

```bash
cd api && npm install && npm run dev:local
```

```bash
npx serve web -l 5173
```

Then open <http://localhost:5173> and run this once in the browser console:

```javascript
localStorage.setItem('los2_api','http://localhost:8080'); localStorage.setItem('los2_dev_token','local-dev-token'); location.reload()
```

`npm run dev:local` boots the real API against PGlite — genuine Postgres
compiled to WebAssembly — and applies the same migration files Railway will
run. The database is in memory and is **discarded when you stop the process**.
It is a scratch pad, never a place to keep anything.

The dev token only works because `dev:local` sets `DEV_AUTH_BYPASS`. `loadEnv()`
**refuses to read that variable when `NODE_ENV` is `staging` or `production`**,
so this door cannot be opened on a deployed service even by mistake.

---

## Step 1 — Create the staging Postgres database

1. Railway → your project → **New** → **Database** → **Add PostgreSQL**.
2. Rename it to `life-os-v2-staging-db` so it is never confused with anything
   the legacy app touches.
3. Open the service → **Variables** → copy `DATABASE_URL`.

**Use a fresh database.** Do not point this at anything the current live app
uses. The legacy app does not use Postgres at all today, so there is nothing to
collide with — keep it that way.

## Step 2 — Create the staging API service

1. Railway → **New** → **GitHub Repo** → `ZanderVDB/life-os`.
2. Name it `life-os-v2-api-staging`.
3. **Settings → Root Directory:** `api`
4. **Settings → Build Command:** `npm ci && npm run build`
5. **Settings → Start Command:** `npm run db:migrate && npm start`
6. **Settings → Networking → Generate Domain.** Note the URL.

Migrations run on start. They are the generated SQL in `api/drizzle/`, applied
in filename order, each recorded so it never runs twice.

## Step 3 — Set the staging environment variables

On `life-os-v2-api-staging` → **Variables**:

| Variable | Value |
|---|---|
| `NODE_ENV` | `staging` |
| `PORT` | `8080` |
| `LOG_LEVEL` | `info` |
| `DATABASE_URL` | paste from Step 1 (or use Railway's variable reference) |
| `FIREBASE_PROJECT_ID` | your Firebase project id, e.g. `life-os-a25bc` |
| `CORS_ORIGINS` | the URL where you will serve `/web`, comma-separated |

Do **not** set `DEV_AUTH_BYPASS`. With `NODE_ENV=staging` the app refuses to
start if it is present — that check is deliberate.

There is **no Firebase service-account key**, and there must never be one.
Tokens are verified against Google's public JWKS endpoint. That is the whole
reason this design has no private key to leak.

## Step 4 — Get the Firebase web config

1. Firebase console → your project → **Project settings** → **General**.
2. Under **Your apps**, use the existing Web App or **Add app → Web**.
3. Copy the `firebaseConfig` values.
4. Paste `apiKey`, `authDomain`, `projectId` and `appId` into `web/config.js`,
   replacing every `FILL_ME_IN`.
5. **Authentication → Settings → Authorised domains:** add the domain where you
   will serve `/web`. Sign-in fails silently without this.

This block is public by design — it identifies the project, it does not
authorise anything. The real gate is the API verifying the ID token. Committing
it is fine; a service-account key would not be.

## Step 5 — Point the web shell at staging

Either edit `apiBaseUrl` in `web/config.js`, or leave it and run this once in
the browser:

```javascript
localStorage.setItem('los2_api','https://your-staging-api.up.railway.app'); location.reload()
```

## Step 6 — Verify

```bash
curl https://your-staging-api.up.railway.app/health
```

Expect `{"status":"ok","service":"life-os-v2-api"}`.

```bash
curl https://your-staging-api.up.railway.app/ready
```

Expect `checks.database: "ok"`. If that fails, `DATABASE_URL` is wrong or the
migration did not run — check the deploy logs.

Then open the web shell, sign in with Google, and confirm you land on Today
with two Areas (Personal and Work) and no workspace switcher.

---

## What is deliberately NOT set up

- **No production service.** Staging only, as instructed.
- **No Cloudflare R2.** Nothing uploads files yet.
- **No Anthropic key.** No AI in this baseline.
- **No custom domain.** The generated Railway domain is enough for staging.
- **No legacy data import.** The import path is preview-only; there is no write
  path in the code at all.
- **Nothing touching the live app or Firestore.** The legacy app is untouched
  and still running.

---

## Cost

A Railway Postgres instance plus a small always-on API service. Both sit in
Railway's usage-based billing. If you want to avoid paying for staging while
it is idle, delete the two services when you are not using them — the schema is
in version control and rebuilds from `api/drizzle/` in seconds.

---

## Import writer deployed — 2026-07-31

New staging endpoints on `life-os-v2-api-staging`:

| Endpoint | Purpose |
|---|---|
| `POST …/import/legacy/preview` | dry run, counts only, writes nothing |
| `POST …/import/legacy/execute` | the irreversible one — requires approved counts and the typed phrase |
| `GET …/import/legacy/runs` | import history, counts and status only |
| `GET …/staging/cleanup/preview` | lists non-imported tasks |
| `POST …/staging/cleanup` | deletes only named, non-imported tasks |

The cleanup endpoints do not exist in production: `isStagingCleanupAllowed()`
returns false for `NODE_ENV=production`, asserted directly by a test rather than
inferred from an HTTP response (in production the request would be stopped by
authentication first, so a non-200 would prove nothing).

**Note on redeploys:** `railway redeploy` replays the existing deployment and
does not pick up new variables or new commits. Use `railway redeploy --from-source`.
