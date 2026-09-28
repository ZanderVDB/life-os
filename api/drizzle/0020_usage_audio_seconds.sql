-- How much audio a transcription call carried.
--
-- Additive and nullable: every existing row is a text call and stays exactly
-- as it is, and rolling back is dropping a column nothing else reads.
ALTER TABLE ai_usage_events
  ADD COLUMN IF NOT EXISTS audio_seconds integer;
