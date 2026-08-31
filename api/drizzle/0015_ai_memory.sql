-- Personal Memory: what Life OS knows about the person, not about their work.
--
-- Purely additive and idempotent. Two new tables and nothing else — no column
-- is altered, no row is read, no existing behaviour depends on either table
-- being present, so an older container running against a migrated database
-- keeps working unchanged.

CREATE TABLE IF NOT EXISTS ai_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category text NOT NULL DEFAULT 'other',
  fact text NOT NULL,
  confidence real NOT NULL DEFAULT 0.6,
  source text NOT NULL DEFAULT 'assistant',
  is_pinned boolean NOT NULL DEFAULT false,
  -- Superseded rather than deleted, so "you used to say mornings" is
  -- answerable and a wrong replacement can be traced. Nothing superseded is
  -- ever read into a prompt.
  superseded_by_id uuid,
  superseded_at timestamptz,
  source_ref_type text,
  source_ref_id uuid,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_memories_category CHECK (category IN
    ('profile','preferences','people','places','routines','work_style',
     'communication','defaults','interests','other')),
  CONSTRAINT ai_memories_source CHECK (source IN ('user','assistant','derived','import'))
);

CREATE INDEX IF NOT EXISTS ai_memories_owner_idx ON ai_memories (workspace_id, user_id);
-- The live set is the only set anything reads, so the superseded marker is
-- part of the index rather than a filter applied after the fact.
CREATE INDEX IF NOT EXISTS ai_memories_live_idx
  ON ai_memories (workspace_id, user_id, superseded_at);

-- Something a model noticed, not yet believed. A model that wrote straight
-- into memory would write whatever it misheard, and a wrong durable fact is
-- worse than a wrong answer because it repeats.
CREATE TABLE IF NOT EXISTS ai_memory_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category text NOT NULL DEFAULT 'other',
  fact text NOT NULL,
  confidence real NOT NULL DEFAULT 0.5,
  status text NOT NULL DEFAULT 'pending',
  supersedes_id uuid,
  memory_id uuid,
  -- Short, and only for review. Never a whole transcript.
  evidence text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT ai_memory_candidates_status CHECK (status IN ('pending','accepted','rejected'))
);

CREATE INDEX IF NOT EXISTS ai_memory_candidates_owner_idx
  ON ai_memory_candidates (workspace_id, user_id, status);
