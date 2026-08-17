-- The unified Book system.
--
-- Books stop being "a notebook in Library" and become the information model for
-- the whole application: pages gain a layout, bookmarks become real rows,
-- Projects gain a Book, and the existing polymorphic edge table learns where
-- inside a target an edge lands.
--
-- Everything here is ADDITIVE. No existing column changes type, no existing row
-- is rewritten except by the two backfills at the bottom, and both of those are
-- idempotent — this file can be applied to a database that has already seen it
-- without producing a second Book for anything.

-- ── Pages gain a layout ──────────────────────────────────────────────────
-- Everything already stored is a page of ruled notes, so the default IS the
-- backfill and no UPDATE is needed.
ALTER TABLE book_pages ADD COLUMN IF NOT EXISTS layout text NOT NULL DEFAULT 'notes';
ALTER TABLE book_pages ADD COLUMN IF NOT EXISTS spans_spread boolean NOT NULL DEFAULT false;

DO $$ BEGIN
  ALTER TABLE book_pages ADD CONSTRAINT book_pages_layout_check CHECK (
    layout IN ('notes','blank','two_columns','quad','checklist',
               'ideas','research','learning','comparison','meeting','pinboard'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS book_pages_title_idx ON book_pages (workspace_id, title);

-- ── Bookmarks ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS book_bookmarks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  book_id uuid NOT NULL REFERENCES library_books(id) ON DELETE CASCADE,
  page_id uuid NOT NULL REFERENCES book_pages(id) ON DELETE CASCADE,
  block_id text,
  label text NOT NULL,
  accent text NOT NULL DEFAULT 'gold',
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT book_bookmarks_accent_check
    CHECK (accent IN ('peach','sage','lavender','gold','blue','rose'))
);
CREATE INDEX IF NOT EXISTS book_bookmarks_book_idx ON book_bookmarks (book_id, position);
-- Two PARTIAL unique indexes rather than one with NULLS NOT DISTINCT.
--
-- The intent is that bookmarking the same page twice is a duplicate rather than
-- a pair, and NULL block_id has to collide with NULL block_id for that to hold.
-- `NULLS NOT DISTINCT` says exactly that in one line — and needs Postgres 15.
-- The split below is portable to 11 and means the same thing, which matters
-- because the database this has to run against is not the one the tests use.
CREATE UNIQUE INDEX IF NOT EXISTS book_bookmarks_page_idx
  ON book_bookmarks (book_id, page_id) WHERE block_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS book_bookmarks_block_idx
  ON book_bookmarks (book_id, page_id, block_id) WHERE block_id IS NOT NULL;

-- ── Project ↔ Book ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  book_id uuid NOT NULL REFERENCES library_books(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'primary',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_books_role_check CHECK (role IN ('primary','research','reference'))
);
CREATE INDEX IF NOT EXISTS project_books_project_idx ON project_books (workspace_id, project_id);
-- A Book belongs to at most one Project, and a Project has at most one Book per
-- role. Together these are what make the backfill below safe to run twice.
CREATE UNIQUE INDEX IF NOT EXISTS project_books_book_idx ON project_books (book_id);
CREATE UNIQUE INDEX IF NOT EXISTS project_books_role_idx ON project_books (project_id, role);

-- ── Edges learn an address ───────────────────────────────────────────────
ALTER TABLE item_links ADD COLUMN IF NOT EXISTS metadata jsonb;
ALTER TABLE item_links ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- ── Backfill: a Primary Book for every Project that has none ─────────────
--
-- Row by row, in PL/pgSQL, because each Book has to be correlated back to the
-- Project that caused it. The set-based version would have to re-find the new
-- item by (workspace, title), and two Projects are allowed to share a title —
-- which is exactly the case where a title join hands the same Book to both.
--
-- Idempotent by its loop condition: a Project that already has a row in
-- project_books is not selected, so re-running this migration creates nothing.
--
-- The Book is an ordinary Library item — same ownership, same archive rules,
-- and it sits on the shelf like any other. Only the join row makes it a Project
-- Book, which is what stops this from being a second content engine.
--
-- Archived Projects still get a live Book. Where a Project Book APPEARS is
-- computed from the Project's lifecycle at read time; nothing is moved or
-- hidden in storage, so reopening a Project needs no write to the Book at all.
DO $$
DECLARE
  p          RECORD;
  new_item   uuid;
  new_book   uuid;
  new_sect   uuid;
BEGIN
  FOR p IN
    SELECT pr.id, pr.workspace_id, pr.title
    FROM projects pr
    WHERE NOT EXISTS (SELECT 1 FROM project_books pb WHERE pb.project_id = pr.id)
    ORDER BY pr.created_at
  LOOP
    INSERT INTO library_items (workspace_id, type, title, status)
    VALUES (p.workspace_id, 'book', p.title, 'active')
    RETURNING id INTO new_item;

    INSERT INTO library_books (workspace_id, library_item_id, author_label)
    VALUES (p.workspace_id, new_item, 'Project')
    RETURNING id INTO new_book;

    INSERT INTO project_books (workspace_id, project_id, book_id, role)
    VALUES (p.workspace_id, p.id, new_book, 'primary');

    -- A Book with no section cannot be opened to, and a section with no pages
    -- has nothing to show. Two pages, so the first thing seen is a spread.
    INSERT INTO book_sections (workspace_id, book_id, title, accent, position)
    VALUES (p.workspace_id, new_book, 'Notes', 'peach', 0)
    RETURNING id INTO new_sect;

    INSERT INTO book_pages (workspace_id, section_id, position, layout)
    VALUES (p.workspace_id, new_sect, 0, 'notes'),
           (p.workspace_id, new_sect, 1000, 'notes');
  END LOOP;
END $$;
