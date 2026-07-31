# Google Calendar — staging setup (read-only)

Phase D4.1. This connects a real Google account to **v2 staging only**, with
**read-only** access. Life OS cannot create, change or delete anything in
Google Calendar at this stage, and the code path to do so does not exist.

## Exact values

These must match character for character. A redirect URI that differs by a
trailing slash, a scheme or a capital letter is rejected by Google with
`redirect_uri_mismatch`.

| What | Value |
|---|---|
| **Authorised redirect URI** | `https://life-os-v2-api-staging-v2-staging.up.railway.app/api/v1/integrations/google-calendar/callback` |
| **Scope** | `https://www.googleapis.com/auth/calendar.readonly` |
| **OAuth client type** | Web application |
| **Return URL after connecting** | `https://life-os-v2-web-staging-v2-staging.up.railway.app/#calendar` |

No **authorised JavaScript origin** is needed. The browser never talks to Google
directly — it asks the Life OS API for an authorize URL and follows it, and the
code exchange happens server-to-server. Adding an origin would grant a capability
the design does not use.

## Google Cloud steps

Done one at a time, with confirmation between each.

1. Create or select a Google Cloud project for staging. A dedicated project is
   preferred so staging cannot affect a production OAuth app.
2. Enable the **Google Calendar API** in that project.
3. Configure the OAuth consent screen (Google Auth Platform → Branding).
4. Set the audience to **External**, publishing status **Testing**.
5. Add the Life OS account as a **test user**. In Testing mode only listed test
   users can complete the flow, and refresh tokens expire after 7 days — see
   Limitations.
6. Add the single scope above. Nothing else.
7. Create an OAuth client: **Web application**.
8. Add the authorised redirect URI exactly as written above.
9. Copy the client ID and client secret into Railway (next section) — **not**
   into chat, the repository, or any frontend file.

## Railway variables

Set on the **`life-os-v2-api-staging`** service, in the **`v2-staging`**
environment. Names only; values never appear in the repository.

| Variable | Where it comes from | Exposed to browser |
|---|---|---|
| `GOOGLE_CALENDAR_CLIENT_ID` | Google Cloud OAuth client | no |
| `GOOGLE_CALENDAR_CLIENT_SECRET` | Google Cloud OAuth client | **never** |
| `GOOGLE_CALENDAR_REDIRECT_URI` | the exact URI above | no |
| `GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY` | generated, ≥32 characters | **never** |
| `GOOGLE_CALENDAR_POST_CONNECT_URL` | the return URL above | no |

None are read by the web service, none appear in `/version`, and none are
returned by any API response. The client secret and the encryption key are used
only inside the API process.

## Token handling

- The **access token** is encrypted at rest and refreshed server-side. It never
  reaches the browser.
- The **refresh token** is encrypted with AES-256-GCM and never leaves the
  server, never appears in a response, and never appears in a log.
- `redactTokens()` strips anything token-shaped from an object before it can be
  logged, as a second line of defence.
- **Disconnect** revokes the grant with Google where possible, deletes the
  stored credentials, and removes the Google calendar projections. Life OS
  tasks, habits, reminders and schedule blocks are never touched.

## Sync

- First sync: calendar list, then events in a window of −90 to +365 days.
- After that: incremental, using a per-calendar sync token.
- Recurring events are expanded into instances (`singleEvents=true`) while
  keeping `recurringEventId` and `originalStartTime`, so series identity
  survives.
- Cancelled instances are removed during incremental sync.
- A `410` from Google means the sync token expired: a full resync runs, without
  deleting first, so the calendar is never briefly empty.
- All upserts key on `(calendar, provider event id)`, so a re-run or a reconnect
  cannot duplicate.

## Limitations, stated plainly

- **Testing-mode refresh tokens expire after 7 days.** Until the consent screen
  is published, reconnecting weekly is expected. This is a Google policy, not a
  Life OS bug.
- **Read-only.** No create, edit, delete, attendee change, or Meet creation.
  Write access needs a broader scope and a separate approval.
- **One key, no rotation.** See `technical-debt.md`.
- **Single instance.** Pending OAuth state is in-process. See `technical-debt.md`.
- Google's own **birthday and holiday** calendars appear if the account has them
  and they are readable.
