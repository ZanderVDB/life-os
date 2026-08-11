-- Phase L3 — "Recently opened" needs an opened time.
--
-- ONE nullable column, and the justification L3 §2 asks for before any schema
-- change: `updated_at` is an EDIT time. It moves when you rename a Book, when
-- autosave writes a page, when a background job touches a row — and it does
-- NOT move when you open something and read it. Labelling that column
-- "recently opened" would be a lie told by the UI about data it has, which is
-- the exact failure §12 names ("do not introduce fake behavioural tracking").
--
-- Nullable on purpose. NULL means "never opened since this shipped", which is
-- true of every existing row and must not be backfilled to `updated_at` — a
-- backfill would invent an opening that never happened. Readers fall back to
-- `updated_at` for ordering only, and the UI says "edited" rather than
-- "opened" when that fallback is what it is showing.
--
-- No index. The recent list is small (3–6), the workspace item count is small,
-- and `library_items_live_idx` already narrows to the live rows. An index
-- earns its place when a query is slow, not when a column is added.
ALTER TABLE library_items
  ADD COLUMN last_opened_at timestamptz;
