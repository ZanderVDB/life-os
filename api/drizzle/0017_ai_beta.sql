-- Beta readiness: a clarification that names entities rather than labels.
--
-- Additive. One nullable column and a widened CHECK; nothing existing is
-- rewritten and no row is read, so an older container running against a
-- migrated database keeps working unchanged.

-- The question the assistant asked back, with its options.
--
-- Stored SERVER-SIDE for the same reason the proposal set is: an option the
-- user picks must resolve to a stable entity id, not to the text of a button.
-- "Which John meeting?" answered by sending the label "John — Tuesday" back
-- through the planner is a second guess at something already known exactly.
ALTER TABLE ai_turns ADD COLUMN IF NOT EXISTS clarification jsonb;

-- A turn that asked a question of its own is neither answered nor proposed.
-- Saying so lets a follow-up find it, and lets the client tell "I need an
-- answer from you" apart from "here is your answer".
ALTER TABLE ai_turns DROP CONSTRAINT IF EXISTS ai_turns_status;
ALTER TABLE ai_turns ADD CONSTRAINT ai_turns_status CHECK (status IN
  ('planning','proposed','answered','clarifying','executed','failed','cancelled'));
