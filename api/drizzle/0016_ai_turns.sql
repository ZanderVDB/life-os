-- Assistant turns and conversations: the server-held proposal.
--
-- Purely additive and idempotent. Two new tables; nothing existing is altered
-- and no row is read, so an older container running against a migrated
-- database keeps working unchanged.

CREATE TABLE IF NOT EXISTS ai_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- A bounded structured summary, never a transcript. A conversation that
  -- resends everything forever gets more expensive and less accurate with
  -- every turn.
  summary text,
  last_turn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_conversations_owner_idx
  ON ai_conversations (workspace_id, user_id, last_turn_at);

CREATE TABLE IF NOT EXISTS ai_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  request text NOT NULL,
  understood text,
  answer text,
  status text NOT NULL DEFAULT 'planning',
  -- The authoritative proposal set. The client renders a copy; only this one
  -- is ever executed.
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Bumped on every accepted edit. A confirmation naming an old version is
  -- refused: the person agreed to a set that no longer exists.
  version integer NOT NULL DEFAULT 1,
  -- Entity refs only. Never their content.
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Present exactly once. Its presence is what makes a replayed confirm a
  -- no-op rather than a second set of writes.
  results jsonb,
  executed_at timestamptz,
  metrics jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_turns_status CHECK (status IN
    ('planning','proposed','answered','executed','failed','cancelled'))
);

CREATE INDEX IF NOT EXISTS ai_turns_conversation_idx ON ai_turns (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS ai_turns_owner_idx ON ai_turns (workspace_id, user_id, created_at);
