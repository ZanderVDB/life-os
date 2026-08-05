-- Phase F1 — Library foundation.
--
-- Two parts: the general link table this codebase already half-had, and the
-- Library itself.

-- ── 1. calendar_item_links -> item_links ────────────────────────────────
--
-- The table was already polymorphic — source_type/source_id, target_type/
-- target_id, with a comment naming `library` as a future target. Only the NAME
-- said Calendar. Renaming now, while it has exactly one writer and one reader,
-- is far cheaper than renaming it once Library, Diary, Brain and Boards all
-- reference it — and creating a second general link table beside it would give
-- the codebase two answers to "what relates to what", which is the outcome this
-- is meant to prevent.
--
-- A rename, not a copy: no data moves, no window where both exist.
ALTER TABLE calendar_item_links RENAME TO item_links;
ALTER INDEX cal_links_ws_idx RENAME TO item_links_ws_idx;
ALTER INDEX cal_links_source_idx RENAME TO item_links_source_idx;
ALTER INDEX cal_links_target_idx RENAME TO item_links_target_idx;
ALTER INDEX cal_links_unique_idx RENAME TO item_links_unique_idx;

--> statement-breakpoint

-- ── 2. library_items ────────────────────────────────────────────────────
--
-- One row per durable resource, whatever kind it is. The TYPE is stored, not
-- inferred from a MIME string: "this is a Book" is a product decision, and a
-- Document and a File can share a MIME type while being different things to
-- the user.
CREATE TABLE library_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active',
  source_url text,
  storage_key text,
  mime_type text,
  size_bytes integer,
  thumbnail_key text,
  -- Type-specific facts that do not deserve a column of their own: image
  -- dimensions, video duration, a link's resolved domain. Never used for
  -- anything the application filters or sorts by.
  metadata jsonb,
  legacy_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT library_items_type_check
    CHECK (type IN ('book','document','image','video','link','file')),
  CONSTRAINT library_items_status_check
    CHECK (status IN ('active','archived'))
);

CREATE INDEX library_items_ws_idx ON library_items (workspace_id, type, updated_at DESC);
-- Partial: the default view is never archived, so the common query never walks
-- rows it will discard.
CREATE INDEX library_items_live_idx ON library_items (workspace_id, updated_at DESC)
  WHERE archived_at IS NULL;
CREATE UNIQUE INDEX library_items_legacy_idx ON library_items (workspace_id, legacy_id)
  WHERE legacy_id IS NOT NULL;

--> statement-breakpoint

-- ── 3. library_books ────────────────────────────────────────────────────
--
-- A book's own properties, beside the library_item that represents it. Kept
-- separate rather than as nullable columns on library_items because five of the
-- six types would never use any of them, and a table where most columns are
-- null for most rows stops describing anything.
--
-- ON DELETE CASCADE from the item: deleting the item IS deleting the book.
CREATE TABLE library_books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  library_item_id uuid NOT NULL UNIQUE
    REFERENCES library_items(id) ON DELETE CASCADE,
  subtitle text,
  author_label text,
  cover_style text NOT NULL DEFAULT 'classic',
  page_style text NOT NULL DEFAULT 'ruled',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT library_books_cover_check CHECK (cover_style IN ('classic','plain')),
  CONSTRAINT library_books_page_check CHECK (page_style IN ('ruled','plain'))
);

--> statement-breakpoint

-- ── 4. book_sections ────────────────────────────────────────────────────
CREATE TABLE book_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  book_id uuid NOT NULL REFERENCES library_books(id) ON DELETE CASCADE,
  title text NOT NULL,
  -- The six Legacy section colours. A token, never a hex value: the palette
  -- has to follow the theme, and a stored #hex cannot.
  accent text NOT NULL DEFAULT 'peach',
  position integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT book_sections_accent_check
    CHECK (accent IN ('peach','sage','lavender','gold','blue','rose'))
);
CREATE INDEX book_sections_book_idx ON book_sections (book_id, position);

--> statement-breakpoint

-- ── 5. book_pages ───────────────────────────────────────────────────────
--
-- `content` is a JSON document, not HTML. See library-v2-security-and-save-model.md:
-- storing generated HTML means storing whatever the browser's editor produced,
-- which is how Legacy ended up with <font color="black"> wrappers that made text
-- invisible on a dark theme.
CREATE TABLE book_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  section_id uuid NOT NULL REFERENCES book_sections(id) ON DELETE CASCADE,
  title text,
  content jsonb NOT NULL DEFAULT '{"type":"doc","content":[]}'::jsonb,
  -- Plain text of `content`, maintained on write, so search is one indexed
  -- query rather than parsing every document in the workspace.
  content_text text NOT NULL DEFAULT '',
  position integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX book_pages_section_idx ON book_pages (section_id, position);
CREATE INDEX book_pages_ws_idx ON book_pages (workspace_id);
