# Life OS — Integration Map

**Audit date 2026-07-31 · version v239.** Every external service the app talks to.

| Service | Used for | State |
|---|---|---|
| **Firebase Auth** | sign-in (Google only) | live |
| **Cloud Firestore** | all data storage | live |
| **Google Calendar** | events, two-way | live |
| **Google Tasks** | the "Reminder" event type | live |
| **Anthropic API** | every AI feature | live, user-supplied key |
| **Microsoft Graph / Outlook** | calendar | **built but dormant** |
| **Google Fonts** | typefaces | live |
| **Railway** | hosting | live |

No analytics, error reporting, payment, email or push service is connected.

---

## 1. Authentication

- **Google sign-in only.** No email/password path exists anywhere.
- Requests calendar + tasks permission at sign-in, forcing the consent screen.
- Popup first; falls back to redirect if the popup is blocked.
- The session is stored in the browser; a cached user id makes the app wait on
  the splash rather than flashing the login screen.
- Multiple safety nets on a slow start (6 s, 15 s, 45 s prompts).
- **Deleting your data does not delete your sign-in identity** — deliberate.

**Where authorisation actually lives:** every database path is built from the
signed-in user's id, but the real enforcement is **Firestore security rules,
which are not in this repository**. They cannot be audited from the code and
must be checked in the Firebase console.

---

## 2. Firestore (storage)

```
users/{uid}/data/{profileId}   ← ALL of a profile's data, one record
users/{uid}/data/_index        ← profile list + which is active
users/{uid}/data/presence      ← which device is currently active
```

- Every save writes **the entire profile record**.
- Offline support is on (the app works without a connection and flushes later),
  but **multi-tab mode is not enabled**, so a second tab loses offline storage.
- Startup races a direct server read against a live listener, with a careful
  cache-fallback that refuses to accept cached data if the server looks newer —
  and refuses to write at all until the first real load lands.
- **Risk:** one record has a hard 1 MB ceiling. See `technical-debt.md` D3.

---

## 3. Google Calendar (two-way)

**Read:** events for the visible month (plus a small buffer), fully expanded so
each occurrence of a repeating event arrives separately. Capped at 250 per
calendar with **no paging**.

**Write:** create, update, delete — including a this-event / this-and-following
/ whole-series choice for repeats.

**Tokens:** a second Google sign-in layer runs alongside Firebase purely to get
a silently-refreshable token. Tokens live in browser storage, one slot per
profile. A refresh is scheduled shortly before expiry, but **no refresh happens
on load** (deliberate — it used to pop the account picker on Android), so the
first draw after a long gap can come back empty until a 401 triggers recovery.

**On failure:** one silent-refresh-and-retry; a second failure clears the token
and raises the banner. If the token layer errors, it **disables itself for
seven days** and can only be revived by typing a command in the browser console.

**Known behaviours to be aware of**
- New events **always go to the primary calendar**, ignoring the picker.
- Times are shown in the **event's own timezone**, never converted.
- New events are written with a hard-coded `Africa/Johannesburg` default.
- Writing repeats supports only five simple patterns — no interval, count or end date.

---

## 4. Google Tasks

Imported read-mostly and shown as 🔔 chips. The event modal's "Reminder" type
creates a Google Task (always all-day). **Editing one deletes and recreates it**,
so it gets a new identity. This is entirely separate from Life OS reminders.

---

## 5. Outlook / Microsoft Graph — built, dormant

Complete read and write code exists, gated behind a client id that **is not
configured**, so Settings shows "Not configured".

Even once configured, it is **incomplete**:
- An Outlook-only user **cannot create or edit any event** — the save path
  requires a Google token.
- The "Google Calendar isn't connected" banner would show permanently.
- Repeat rules are **silently dropped** on write.
- "This and following" is unsupported (falls back to the whole series).
- Multiple reminders collapse to one.
- Times are requested in **UTC and displayed unconverted**.
- There is no Outlook calendar-visibility UI.

---

## 6. Anthropic (all AI features)

**Model:** `claude-sonnet-4-6`, hard-coded in **nine separate places** with no
shared constant and no fallback.

**Key:** the user's own, entered through a raw browser prompt with no
validation, and stored **in plain text both in the browser and in the database**.
Calls go **directly from the browser** to Anthropic.

**Nine call sites:** the command bar · Ask mode · today's plan · "plan my day" ·
weekly review · notebook Refine · project log update · project note tidy-up ·
and a **timer-driven motivational nudge**.

Every call is a single message with no system prompt, no tools, no streaming and
no temperature setting. Responses are expected to be raw JSON; there is no check
for a truncated reply, so hitting the token limit surfaces as a parse error. The
command bar has the **tightest budget (800 tokens)** yet the largest job.

### The journey, from sentence to saved data

1. You type and press Enter (or Update).
2. **Ask mode** → a read-only question, answered from a broad snapshot including
   your last 10 AI actions. Nothing is written.
3. **Do mode** → the app builds a snapshot of your data **limited to what the
   current page is allowed to touch**, plus today's date, upcoming events, your
   standing facts, and page-specific instructions.
4. The model returns one JSON object whose keys are operations
   (`addTasks`, `addEvent`, …). **There is no keyword parsing** — intent
   detection is entirely the model's job.
5. Two corrections are applied: weekday dates are re-checked against your
   wording, and any operation the page isn't allowed to perform is stripped.
6. **If it is unsure**, it returns up to 3 questions and asks you — for a maximum
   of two rounds, then it commits with best guesses. "You decide" skips ahead.
7. **Preview:** shown **only** if confirm-mode is "all", or the change involves
   people. Otherwise changes apply with no preview. In the preview you can edit
   every item (tasks/projects/habits/brain items open their real editors),
   convert one type into another, or remove individual items.
8. **Apply:** changes are written into memory one at a time, **with no
   transaction and no rollback**. Individual failures are silent.
9. One save is triggered.
10. **Calendar operations run afterwards, over the network.** This means: if you
    decline the calendar confirmation, **everything else has already been saved.**

**Safety measures that do exist:** page-scoped permissions; strict (never
partial) text matching when finding what you meant; a preview of exactly which
real calendar events a delete will hit; forced review for anything touching
people; rejection of future dates on habit/routine back-fill; sanitising of AI
HTML before it enters the notebook; and a refusal to write ghost events when
Google is disconnected.

**Limits and gaps:** no rate limiting, no cost guard, no in-flight lock (pressing
Enter twice starts a second run and discards the first conversation), and error
surfaces are inconsistent — sometimes a status line, sometimes a browser alert,
sometimes only the console. Standing facts are described in Settings as being
carried into *every* AI request, but are actually included in only five of nine.

---

## 7. Notifications

Three separate systems, **all configured per-device and none synced**:
1. **OS notifications** at 09:00 and 18:00 — fired by a 60-second timer inside
   the page.
2. **In-app motivational toasts** — the only automatic paid AI calls.
3. **In-app event reminders** — Google only.

**All three require the app to be open.** There is no push service and no
service-worker notification handler, so nothing fires when the tab is closed.

---

## 8. Hosting, offline and deployment

A ~50-line Node server on Railway. `index.html` and `sw.js` are served with
no-store so updates are picked up.

The service worker is **cache-first with network fallback** and never refreshes
its cache in place, so a new version reaches users only when the cache name
changes. **`APP_VERSION` and `CACHE` must be bumped together on every deploy.**
Firebase, Google and Anthropic requests bypass the cache entirely. Only four
files are pre-cached, so offline coverage relies on Firestore's own store.

---

## 9. Background timers

| Every | Does |
|---|---|
| 10 s | presence heartbeat |
| 60 s | calendar banner · scheduled notifications · **AI motivational nudge** · event toasts · next-events refresh |
| 90 s | calendar cache refresh |
| 2 min | service-worker update check |

**Several of these are never stopped on sign-out or profile switch** and keep
running against the new session.
