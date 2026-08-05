-- Phase D2 — the diary spread: guided prompts and the quick check-in.
--
-- ONE column, not eleven.
--
-- The right page collects a feeling, a social reading, a highlight, a
-- challenge, a gratitude and a win; the left page collects five guided prompt
-- answers. Every one of those is a set that will change as the product learns
-- what people actually answer, and a schema migration per question is a tax on
-- finding that out.
--
-- `mood` and `energy` stay as their own columns: history and search already
-- read them, and moving them would break both to gain tidiness.
--
-- Defaulted to an empty object rather than null so every read gets the same
-- shape and no caller has to remember the difference.
ALTER TABLE diary_entries
  ADD COLUMN reflection jsonb NOT NULL DEFAULT '{}'::jsonb;
