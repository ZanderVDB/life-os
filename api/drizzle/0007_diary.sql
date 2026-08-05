-- Phase D1 — Diary foundation.
--
-- One table. Diary is chronological and personal: one entry per workspace per
-- local calendar day, holding the same structured document the Library editor
-- writes and nothing that belongs to a Book.
--
-- Diary entries are NOT library_items. Library holds durable resources a person
-- returns to; Diary holds dated records of a life. Putting an entry on the
-- Library shelf would mean every diary day competing with a saved link for the
-- same attention, and would make "archive this resource" and "archive this day"
-- the same action. They share an editor, not a table.

CREATE TABLE diary_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- A `date`, not a timestamp. "Which day is this?" is a civil question and the
  -- civil day belongs to the person, not to UTC. The client sends the date it
  -- is showing; the server validates the shape and never derives one. Storing
  -- an instant would mean re-deriving a date in a timezone the server does not
  -- reliably know, which is exactly how an entry written at 01:00 in
  -- Johannesburg ends up filed under yesterday.
  entry_date date NOT NULL,

  -- What the browser believed its zone was when the entry was first written.
  -- Recorded, never used for arithmetic: it exists so a future "your entries
  -- moved zone" question has an answer, not so the server can recompute dates.
  timezone text,

  -- Optional. A null title means "show the date", and the date is NOT copied
  -- into this column — a formatted date stored as a title is a title the user
  -- did not write, and it would then be searchable as if they had.
  title text,

  -- The same node grammar as book_pages.content, so one editor serves both.
  document jsonb NOT NULL DEFAULT '{"type":"doc","content":[]}'::jsonb,
  -- The plain text of `document`, maintained on write, so search is one indexed
  -- query rather than parsing every entry in the workspace.
  document_text text NOT NULL DEFAULT '',

  -- Optional daily context. All nullable, none required to write. Stored as
  -- labels rather than numbers: "good" is what the person chose, and a 4/5
  -- would invite arithmetic on something that is not a measurement.
  mood text,
  energy text,
  weather_note text,
  location_note text,

  -- A short overview, separate from the entry. Useful in history and search
  -- previews, and the natural input for a future assisted recap.
  day_summary text,

  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT diary_entries_mood_check
    CHECK (mood IS NULL OR mood IN ('very_low','low','neutral','good','very_good')),
  CONSTRAINT diary_entries_energy_check
    CHECK (energy IS NULL OR energy IN ('very_low','low','medium','high','very_high'))
);

--> statement-breakpoint

-- One entry per day, INCLUDING archived ones.
--
-- Deliberately not a partial index on `archived_at IS NULL`. If an archived
-- entry did not occupy its date, writing on that date again would create a
-- second row and the original would become unreachable — the person would have
-- archived a day and then silently started a new one on top of it. Occupying
-- the date is what lets the API say "there is an archived entry here, restore
-- it?" instead of quietly duplicating.
CREATE UNIQUE INDEX diary_entries_unique_day ON diary_entries (workspace_id, entry_date);

--> statement-breakpoint

-- History reads a month at a time, newest first.
CREATE INDEX diary_entries_ws_date_idx ON diary_entries (workspace_id, entry_date DESC);
