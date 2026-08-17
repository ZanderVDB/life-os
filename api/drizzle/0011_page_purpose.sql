-- Shape and purpose are two different questions.
--
-- The first version answered both with one `layout` column, and it did not
-- survive contact with a user: Lined notes, Checklist, Ideas, Research,
-- Learning and Meeting notes are the SAME PAGE. They differ only in the
-- headings they start with. Calling that a layout — and making it exclusive
-- with Two columns — meant you could not have a research page in two columns,
-- and that six of the eleven "layouts" were indistinguishable once you had
-- typed anything.
--
-- So:
--   layout   HOW the page is divided   notes | blank | two_columns | quad
--                                      | comparison | pinboard
--   purpose  WHAT the page is for      null | checklist | ideas | research
--                                      | learning | meeting
--
-- They are now independent. A Research page can be two columns. A checklist
-- can be a pinboard. The purpose is a LABEL plus a starter, never a structure.

ALTER TABLE book_pages ADD COLUMN IF NOT EXISTS purpose text;

-- Existing pages keep exactly what they had, re-filed under the right column.
-- A page created as `research` was a page of notes for research, and that is
-- now literally what it says.
UPDATE book_pages
   SET purpose = layout, layout = 'notes'
 WHERE layout IN ('checklist', 'ideas', 'research', 'learning', 'meeting');

-- The layout check narrows to the six shapes that genuinely differ.
ALTER TABLE book_pages DROP CONSTRAINT IF EXISTS book_pages_layout_check;
DO $$ BEGIN
  ALTER TABLE book_pages ADD CONSTRAINT book_pages_layout_check CHECK (
    layout IN ('notes','blank','two_columns','quad','comparison','pinboard'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE book_pages ADD CONSTRAINT book_pages_purpose_check CHECK (
    purpose IS NULL OR purpose IN ('checklist','ideas','research','learning','meeting'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Purpose is a thing you filter and search by — "my research pages" — so it
-- earns an index the moment it exists.
CREATE INDEX IF NOT EXISTS book_pages_purpose_idx
  ON book_pages (workspace_id, purpose) WHERE purpose IS NOT NULL;
