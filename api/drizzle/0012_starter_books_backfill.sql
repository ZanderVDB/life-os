-- The starter Books, for accounts that already existed.
--
-- `seedStarterBooks` runs at workspace creation, so it only ever reaches NEW
-- accounts. Every account that existed before it was written has an empty
-- Library and no way to get these — which is most of them, including the only
-- one that matters today.
--
-- A migration is exactly the right shape for "once, for everyone, ever": it is
-- recorded as applied, so it cannot run twice however many times the service
-- restarts or redeploys. That is the whole reason this is not a startup hook.
--
-- Two guards, so it is safe even if that record were somehow lost:
--   · a workspace that already has a Book with the same title is skipped for
--     that title — a real "Notes" you wrote is never duplicated or touched
--   · the inserts are keyed off what is missing, not off a run counter
--
-- The text is a snapshot of src/lib/starter-library.ts as at this migration.
-- They are allowed to drift afterwards: this is a one-time backfill, not a
-- second definition of the starter set.
DO $$
DECLARE
  w         RECORD;
  s         RECORD;
  new_item  uuid;
  new_book  uuid;
  new_sect  uuid;
  doc       jsonb;
BEGIN
  FOR w IN SELECT id FROM workspaces WHERE deleted_at IS NULL LOOP
    FOR s IN
      SELECT * FROM (VALUES
        ('Notes', 'Anything not filed yet', 'Notes', 'peach', NULL,
         'Whatever you have not decided where to put. Things move out of here once they turn out to belong somewhere — that is what this Book is for, not a failure to organise it.'),
        ('Ideas', 'Things you might do one day', 'Ideas', 'lavender', 'ideas',
         'Somewhere to put a thought so it stops taking up room. An idea that turns into work becomes a Project; the rest are allowed to just sit here.'),
        ('Reference', 'The things you look up', 'Reference', 'blue', NULL,
         'Policy numbers, sizes, account details, the wifi password — what you look up rather than think about. In practice this becomes the most-opened Book you own.'),
        ('How I do things', 'Steps you would otherwise work out twice', 'How to', 'sage', NULL,
         'The procedures you re-derive from scratch every time — filing a return, setting up a machine, the yearly admin. Write it down the second time you have to work it out.')
      ) AS t(title, subtitle, section, accent, purpose, opening)
    LOOP
      -- Already has a Book by this name? Leave it entirely alone.
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM library_items li
        WHERE li.workspace_id = w.id AND li.type = 'book' AND li.title = s.title);

      INSERT INTO library_items (workspace_id, type, title, status)
      VALUES (w.id, 'book', s.title, 'active')
      RETURNING id INTO new_item;

      INSERT INTO library_books (workspace_id, library_item_id, subtitle, author_label)
      VALUES (w.id, new_item, s.subtitle, 'Life OS')
      RETURNING id INTO new_book;

      INSERT INTO book_sections (workspace_id, book_id, title, accent, position)
      VALUES (w.id, new_book, s.section, s.accent, 0)
      RETURNING id INTO new_sect;

      doc := jsonb_build_object(
        'type', 'doc',
        'content', jsonb_build_array(jsonb_build_object(
          'type', 'paragraph',
          'attrs', jsonb_build_object('id', 'b' || replace(gen_random_uuid()::text, '-', '')),
          'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', s.opening)))));

      -- First page says what the Book is for; second is blank, so the opening
      -- spread is a page you can read and a page you can write on.
      INSERT INTO book_pages (workspace_id, section_id, position, layout, purpose, content, content_text)
      VALUES (w.id, new_sect, 0, 'notes', s.purpose, doc, s.opening);
      INSERT INTO book_pages (workspace_id, section_id, position, layout)
      VALUES (w.id, new_sect, 1000, 'notes');
    END LOOP;
  END LOOP;
END $$;
