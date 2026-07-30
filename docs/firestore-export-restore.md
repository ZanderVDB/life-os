# Life OS — Firestore Export & Restore

**Created 2026-07-31 · Phase A3 · app version v241**

> **The export exists. No restore tool exists, and none runs automatically.**
> This document specifies exactly how a restore *would* be performed if it were
> ever needed. It is deliberately a procedure, not a button.

---

## 1. What the export is (and is not)

**It is** a complete, verified, point-in-time snapshot of everything this
account holds in Firestore, saved to the user's own device. It is the
**rollback floor** for the v2 migration.

**It is not** the future storage architecture, and not a user-facing backup
feature. Real database backups and user-facing exports are separate things
designed in `backend-architecture-v2.md` §14.

**Firestore remains the source of truth.** Nothing has been migrated.

---

## 2. Creating an export

Two entry points, both deliberately outside the normal product UI:

| Method | How |
|---|---|
| **Console** | open the app, sign in, run `losExport()` |
| **URL** | open the app with `?export=1` → a guarded panel with one button |

The flow is: fresh **server** reads → build in memory → verify → download →
show a counts-only summary.

**Where the file goes:** the browser's normal Downloads folder, as a
user-triggered download. Nothing is uploaded, and the app never keeps a copy.

**Filename:** `life-os-export_YYYYMMDD-HHMM_vNNN_<8-char-fingerprint>.json`
e.g. `life-os-export_20260731-0100_v241_deadbeef.json`
The fingerprint is the first 8 characters of a SHA-256 of the user id — **no
email address and no raw user id** appear in the filename.

---

## 3. Format

```jsonc
{
  "exportFormat": "life-os-firestore-export",
  "exportVersion": 1,
  "createdAt": "2026-07-31T01:00:00.000Z",
  "appVersion": "v241",
  "firebaseProjectId": "…",
  "userId": "…",                 // full uid — required to restore
  "userIdFingerprint": "…",      // sha256(uid), used in the filename
  "activeProfileId": "main",
  "profiles": [ { "id": "main", "name": "Personal", "mode": "personal", "createdAt": {…} } ],
  "documentCount": 4,
  "documents": {
    "<docId>": {
      "path": "users/<uid>/data/<docId>",
      "fieldCount": 1234,
      "approxBytes": 84213,
      "fingerprint": "<sha256 of the canonical serialisation>",
      "updatedAt": { "__t": "timestamp", … },
      "schemaVersion": 3,
      "topLevelFieldNames": ["aiHistory", "…"],
      "data": { /* the full document, serialised */ }
    }
  },
  "verification": { "ok": true, "failed": [], "checks": [ … ] }
}
```

### Reversible value encoding

Anything JSON cannot represent unambiguously is **boxed**, so a restore can
rebuild it exactly rather than guessing:

| Original | Encoded as |
|---|---|
| Firestore Timestamp | `{"__t":"timestamp","seconds":…,"nanoseconds":…,"iso":"…"}` |
| `Date` | `{"__t":"date","iso":"…"}` |
| `undefined` | `{"__t":"undefined"}` — **the key is kept** |
| `NaN` / `±Infinity` | `{"__t":"number","v":"NaN"}` |
| `BigInt` | `{"__t":"bigint","v":"…"}` |
| GeoPoint | `{"__t":"geopoint","latitude":…,"longitude":…}` |
| DocumentReference | `{"__t":"ref","path":"…"}` |
| Bytes | `{"__t":"bytes","b64":"…"}` |
| circular reference | `{"__t":"circular"}` (verification fails if present) |
| anything else | `{"__t":"unsupported","repr":"…"}` (verification fails if present) |

**Object keys are sorted** during serialisation. This is intentional — it makes
the fingerprint stable. Key order carries no meaning in Firestore.

**Unknown fields are preserved verbatim.** The export reads whole documents and
whole subcollections; it never filters against the app's known field list, so
legacy fields the app forgot about and future fields it doesn't understand yet
both survive.

---

## 4. Restore procedures

> **None of this is automated. Every step is manual and deliberate.**
> A restore overwrites live data and must never be reachable by accident.

### Before any restore
1. **Take a fresh export first.** Restoring destroys the current state; you
   want a way back from the way back.
2. **Verify the export you intend to restore** — `verification.ok` must be
   `true`, and the JSON must parse.
3. **Check identity.** `userId` in the file must match the account you are
   restoring into (see §5).
4. Decide **overwrite vs merge** (see §4c).

### 4a. Restore ALL profiles to the same user
For each entry in `documents`:
1. Decode the values (invert the table in §3). `{"__t":"timestamp"}` becomes a
   real `Timestamp`; `{"__t":"undefined"}` means **omit the field**.
2. Write to `users/<userId>/data/<docId>`.
3. Write `_index` **last**, so the profile catalogue never points at documents
   that do not exist yet.
4. Re-read every document and compare fingerprints against the export.

### 4b. Restore ONE profile only
Restore just `documents["<profileId>"]` and leave `_index` alone — unless the
profile is missing from the catalogue, in which case add only that entry.
This is the expected shape of a rollback: one profile, one document.

### 4c. Overwrite vs merge
| Mode | Call | Use when |
|---|---|---|
| **Overwrite** (recommended) | `set(data)` — **no** `{merge:true}` | You want the document to exactly equal the export. Fields added since the export are removed. |
| **Merge** | `set(data,{merge:true})` | You only want to restore specific fields and keep everything else. |

**Merge cannot delete.** Firestore's merge deep-merges maps and never removes
absent keys — this is exactly why the diary writes `''` rather than deleting
keys. So if the goal is *"make it look like the export"*, **merge is wrong**;
only a full overwrite achieves that.

### 4d. If a document already exists
It always will. Decide explicitly:
- **Rollback** → overwrite.
- **Recover one lost item** → do not restore the document at all. Read the
  value out of the export and re-enter it through the app. Safer than any
  document-level write.

### 4e. Restore into a TEST Firebase project
This is the **recommended rehearsal**, and how a restore should be proven
before ever touching production.
1. Create a separate Firebase project.
2. Point a local build at it via `config.js`.
3. Sign in — this creates a *different* uid.
4. Restore under **that** uid (the path is `users/<newUid>/data/...`), keeping
   document ids and contents identical.
5. Open the app and confirm the data looks right.

Note the uid differs, so `userId` in the file will not match the target. That
is expected **only** in this rehearsal case and must be an explicit override.

---

## 5. Preventing cross-user restoration

The single most dangerous failure would be writing one account's data into
another. Required guards:

1. **Compare `export.userId` with the signed-in uid. Abort on mismatch** unless
   an explicit `allowDifferentUser` flag is set (test-project rehearsal only).
2. **Compare `firebaseProjectId`.** A mismatch means you are pointed at a
   different backend — stop.
3. **Never derive the target path from the file.** Build it from the *currently
   signed-in* uid, and use the file only for document ids and contents.
4. **Require typing a confirmation phrase** (as the existing delete-all-data
   flow does).
5. **Log** what was restored: document ids, field counts, fingerprints — never
   content.

---

## 6. Schema-version compatibility

- `exportVersion` describes the **file format** (currently `1`). A future
  reader must refuse a format version it does not understand.
- `documents.<id>.schemaVersion` is the **app's** per-profile migration
  high-water mark, captured as-is.
- Restoring an older `schemaVersion` means the app will re-run the migrations
  between that version and the current one on next load. That is expected and
  is why the field is exported rather than normalised.
- **The export never rewrites `schemaVersion`.** It is a photograph, not an
  upgrade.

---

## 7. Rollback procedure (the real scenario)

If a future migration step damages a profile:

1. **Stop writes** — sign out on every device, or disable the write path.
2. Identify the last good export (`createdAt`, `appVersion`).
3. Verify it (§4 "Before any restore").
4. Restore **that one profile** (§4b), overwrite mode.
5. Re-read and compare fingerprints.
6. Open the app and check counts against the export's `fieldCount` values.
7. Record what happened in `docs/build-progress.md`.

**Rollback window:** Firestore stays authoritative and writable until Phase F
cutover, and the export is retained for at least 30 days beyond that.

---

## 8. Limitations (honest list)

1. **A restore tool does not exist.** A restore today means writing a
   deliberate one-off script against the documented format.
2. **The export is a point-in-time snapshot.** Changes made after it are not
   in it. Take a fresh one before risky work.
3. **Not encrypted at rest.** It is a plain JSON file containing everything —
   tasks, diary entries, notebook pages, People records. Treat it like a
   password vault: keep it off shared drives and out of any repository.
4. **Firestore-only.** It does not include Google/Outlook calendar events
   (owned by those providers), OAuth tokens, or anything held only in browser
   storage (theme, notification settings, notebook zoom).
5. **Two reads, not a transaction.** The fingerprint check compares two
   consecutive server reads. If a write from another device lands between
   them, verification fails loudly — which is the desired behaviour, but it
   means an export should be taken while other devices are idle.
6. **`{"__t":"undefined"}` is ambiguous on restore** between "field absent" and
   "field explicitly undefined". Firestore has no `undefined`, so a restore
   should treat it as **absent**.
7. **Large accounts** are held entirely in memory during export. Fine at the
   current scale (the whole account is under Firestore's 1 MB-per-document
   limit anyway), but not a general-purpose bulk tool.

---

## 9. Verification checks performed

Every export runs these before it is offered for download; the results are
embedded in `verification`:

| Check | Meaning |
|---|---|
| `json_parses` | the structure survives a serialise/parse round trip |
| `document_count_matches` | export count equals a second independent read |
| `no_duplicate_documents` | no document exported twice |
| `every_indexed_profile_exported` | every profile in `_index` has a document |
| `no_duplicate_profiles` | the catalogue has no repeated ids |
| `active_profile_present` | the active profile's document was captured |
| `field_counts_match` | per-document field counts match the second read |
| `fingerprints_match_second_read` | content is byte-identical across two reads |
| `no_circular_values` | nothing unserialisable slipped through |
| `no_unsupported_values` | no value was silently degraded |
| `has_restore_identity` | `userId`, `firebaseProjectId`, `exportVersion` present |

If any check fails, the summary reports `verification: FAILED` and names the
failed checks. **A failed export must not be relied on as a rollback floor.**
