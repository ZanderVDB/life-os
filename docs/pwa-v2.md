# Life OS v2 — PWA and update lifecycle

**Status: implemented and verified on staging — 2026-07-31.**

The legacy app's service worker produced recurring stale-deploy bugs. This
document exists so that class of bug does not come back.

---

## What went wrong in v1, and what v2 does instead

| Legacy | v2 |
|---|---|
| `CACHE` constant bumped by hand, in lockstep with `APP_VERSION` | cache name carries the build id automatically |
| Forgetting the bump served yesterday's app indefinitely | forgetting is impossible — nothing is hand-written |
| Worker took over whenever it liked | worker waits; the user decides when to update |
| Cache-first for app assets | network-first, cache only as an offline fallback |
| No update prompt | explicit "Update available" with a Later option |

The single most important change: **the cache name is derived, not typed.**

---

## The build id

`web/server.js` computes one at boot:

```
RAILWAY_GIT_COMMIT_SHA  →  BUILD_ID  →  first 12 characters
```

Railway sets that variable on every build, so it changes when and only when the
code does. Locally it falls back to `dev-<timestamp>` so a restarted dev server
never silently shares a cache with its previous run.

The build id appears in three places:

1. `life-os-v2-shell-<build>` — the cache name
2. `window.LIFE_OS_BUILD` — shown in **Settings → App → Version**
3. `GET /version` — a plain JSON endpoint for checking a deployment

`sw.js` is generated per request with `__BUILD_ID__` substituted, and served
`no-store`. That substitution is what makes the file differ byte-for-byte
between deployments, which is what makes the browser notice an update at all —
a byte-identical worker is ignored no matter how many times you check.

---

## What is cached, and what is never cached

**Cached** — nine static shell files: `/`, `index.html`, `app.js`, `routes.js`,
`pwa.js`, `config.js`, `manifest.webmanifest`, `icons/icon.svg`, `offline.html`.

**Never cached, enforced in three independent places:**

- `sw.js` returns early for any request to `/api/`, anything carrying an
  `Authorization` header, and anything cross-origin.
- `app.js` sends `cache: 'no-store'` on every API call.
- The shell list contains no API paths.

**Why no offline data.** Caching authenticated responses would write task
titles, notes and eventually diary entries to disk in plaintext, where they
survive sign-out and are readable by anything with filesystem access. Offline
Life OS is a worthwhile feature, but it needs a designed encrypted store — not
a side effect of a performance cache. Until then `offline.html` says so plainly
rather than showing an empty app.

---

## Update lifecycle

```
1. deploy                  new commit → new BUILD_ID → sw.js differs
2. browser checks          on load, on tab focus, or Settings → Check now
3. install                 new worker installs, populates its own cache
4. WAIT                    it does NOT skipWaiting — nothing changes yet
5. prompt                  "Update available"  [Later] [Update]
6a. Later                  dismissed for this browser session only
6b. Update                 page posts SKIP_WAITING → worker activates
7. activate                old life-os-v2-* caches deleted, clients claimed
8. controllerchange        every open tab reloads, exactly once each
```

**Guards, and the bug each prevents:**

| Guard | Prevents |
|---|---|
| `if (reloading) return` before reload | the infinite reload loop |
| `navigator.serviceWorker.controller` must exist before prompting | a first install being announced as an update |
| `isEditing()` defers the prompt by 4s and retries | interrupting someone mid-sentence |
| `updateViaCache: 'none'` on registration | the browser caching the worker script itself |
| cleanup filtered to `life-os-v2-` | deleting caches that belong to something else |

**Multiple tabs.** Only one worker is ever waiting. When any tab accepts the
update, activation fires `controllerchange` in *every* open tab, and each
reloads itself once through its own guarded listener. Tabs do not coordinate
with each other and do not need to.

**Postponing is device-scoped.** It lives in `sessionStorage`, so it lasts for
that browser session and never reaches the account. Someone who postpones on
their laptop is still offered the update on their phone.

---

## Installing

Chrome and Edge fire `beforeinstallprompt`, which is captured so **Settings →
App → Installation** can show a real Install button instead of describing a
browser menu. Safari and Firefox do not fire it; there Settings explains where
to find "Add to Home Screen" or "Install".

**Uninstalling.** No browser exposes an uninstall API, and Settings says so
rather than pretending. It points to the home screen, dock or the browser's app
list.

### Icons

Generated from the Life OS lotus in `web/icons/`:

| File | Purpose |
|---|---|
| `icon-192.png` | installability minimum |
| `icon-512.png` | splash and store listings |
| `maskable-512.png` | Android adaptive icons — safe-zone padded |
| `icon.svg` | favicon and any size |

The maskable variant is a separate drawing, not the same art in a bigger box:
Android crops to a circle, and the standard icon's rounded-square background
would be cropped into an odd shape.

---

## Verification performed

Locally against two successive build ids, in a real browser:

- first install — worker registers, activates, claims, caches exactly 9 files
- API traffic after install — cache still contains exactly those 9, zero API entries
- second build — `reg.update()` finds it, worker installs and **waits**
- prompt appears with Later and Update
- accepting — old cache deleted, no waiting worker, page reloads once, shell intact
- no infinite loop: reload count settled immediately

At 375px: no horizontal overflow, sidebar becomes a drawer, every interactive
control measures at least 44×44 including the tick and title, whose visible size
stays small while their hit area is extended with a transparent overlay.

---

## Known limitations

- **No offline data**, by design. See above.
- **iOS**: `apple-touch-icon` points at a PNG, but iOS ignores `display_override`
  and some manifest fields. Installed behaviour there is Apple's, not ours.
- **Source assertions**: `api/tests/web-shell.test.ts` checks that these rules
  are written down. It cannot prove a browser honours them — the runtime
  behaviour above was verified by hand and is recorded in `build-progress.md`.
- **No content hashing** on `app.js` and friends. Filenames are stable, which is
  why they are served `no-cache`. If the shell grows, hashed filenames become
  worth the build step; today it would be complexity for nothing.
