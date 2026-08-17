/**
 * The relationships between Books and the rest of Life OS.
 *
 * Two jobs live here, and they are together because they answer the same
 * question from opposite ends: what does this page point at, and what points at
 * this Book.
 *
 * ── Why references are mirrored ────────────────────────────────────────
 *
 * A reference is written INSIDE the page document, because that is where the
 * editor needs it — a Task card sits in the middle of a paragraph of notes, and
 * pulling it out into a side table would mean the page could not render itself.
 *
 * But a reference that exists only inside a JSON document cannot be QUERIED.
 * "Which pages mention this Task?" would mean loading every document in the
 * workspace and walking it, which is exactly the thing the content_text column
 * already exists to avoid for search.
 *
 * So every save mirrors the document's references into `item_links` — the one
 * polymorphic edge table this application has. The document stays the place
 * references are authored; the edge table is the place they are asked about.
 * They are kept in step by `syncPageRefs`, on every write, in the same
 * transaction as the write itself.
 *
 * The mirror is a DIFF, not a rewrite. Re-saving a page that has not changed
 * its references touches no rows, so `created_at` on an edge keeps meaning the
 * moment the link was made rather than the moment the page was last typed in.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  itemLinks, libraryItems, libraryBooks, bookSections, bookPages, projectBooks,
} from '../db/schema.js';
import { extractRefs, starterContent, pageToText, type PageRef } from './book-doc.js';

/** Sparse spacing, so one move rewrites one row. Matches library.ts. */
const GAP = 1000;

/**
 * The edge kind for a reference found in a page body.
 *
 * `context` for everything today. §12 keeps the door open for `supports`,
 * `decision`, `research` and the rest — those are a property of the EDGE, so
 * they belong here rather than in the block, and adding one later does not
 * touch a single stored document.
 */
export const DEFAULT_LINK_KIND = 'context';

/** Reference block type → the `item_links` source type it becomes. */
const SOURCE_TYPE: Record<string, string> = {
  task: 'task', project: 'project', book: 'library', page: 'book_page', resource: 'library',
};

export const PAGE_TARGET = 'book_page';

/**
 * Brings `item_links` into line with what a page body actually references.
 *
 * @param tx        the transaction doing the page write — never a bare db, or a
 *                  failed write leaves edges to content that was rolled back
 * @param ws        workspace
 * @param page      the page row (id, sectionId)
 * @param bookId    the book, carried in metadata so a backlink can navigate
 *                  without a second query
 */
export async function syncPageRefs(
  tx: any, ws: string, page: { id: string; sectionId: string },
  bookId: string, layout: string, content: unknown,
  extra: { projectId?: string | null; userId?: string | null } = {},
) {
  const refs: PageRef[] = extractRefs(layout, content);

  const existing = await tx.select().from(itemLinks)
    .where(and(
      eq(itemLinks.workspaceId, ws),
      eq(itemLinks.targetType, PAGE_TARGET),
      eq(itemLinks.targetId, page.id),
    ));

  const wanted = new Map<string, PageRef>();
  for (const r of refs) {
    const source = SOURCE_TYPE[r.type];
    if (!source) continue;
    wanted.set(`${source}:${r.id}`, r);
  }

  // Gone from the document → gone from the edge table. A reference the user
  // deleted is not a relationship any more.
  const stale = existing.filter((e: any) => !wanted.has(`${e.sourceType}:${e.sourceId}`));
  if (stale.length) {
    await tx.delete(itemLinks).where(inArray(itemLinks.id, stale.map((s: any) => s.id)));
  }

  const have = new Set(existing.map((e: any) => `${e.sourceType}:${e.sourceId}`));
  const fresh = [...wanted.entries()].filter(([key]) => !have.has(key));
  if (fresh.length) {
    await tx.insert(itemLinks).values(fresh.map(([, r]) => ({
      workspaceId: ws,
      kind: DEFAULT_LINK_KIND,
      sourceType: SOURCE_TYPE[r.type]!,
      sourceId: r.id,
      targetType: PAGE_TARGET,
      targetId: page.id,
      /* The address, not the facts. Enough to open the page the link points at
       * without first searching for which book it belongs to. */
      metadata: {
        bookId, sectionId: page.sectionId, blockId: r.blockId,
        ...(extra.projectId ? { projectId: extra.projectId } : {}),
      },
      createdBy: extra.userId ?? null,
    }))).onConflictDoNothing();
  }
  return { added: fresh.length, removed: stale.length };
}

/**
 * The Primary Book for a Project, created if it does not exist.
 *
 * Idempotent by the unique index on `project_books.project_id, role` — two
 * concurrent calls cannot produce two Books, and a caller that does not know
 * whether one exists can simply ask.
 *
 * The Book is an ordinary Library item. It archives like one, is renamed like
 * one and appears on the shelf like one; only the join row makes it a Project
 * Book. That is the whole point of §6: there is no second content engine.
 */
export async function ensureProjectBook(
  tx: any, ws: string, project: { id: string; title: string },
): Promise<{ bookId: string; itemId: string; created: boolean }> {
  const [existing] = await tx.select({ bookId: projectBooks.bookId, itemId: libraryBooks.libraryItemId })
    .from(projectBooks)
    .innerJoin(libraryBooks, eq(libraryBooks.id, projectBooks.bookId))
    .where(and(eq(projectBooks.workspaceId, ws), eq(projectBooks.projectId, project.id),
      eq(projectBooks.role, 'primary')))
    .limit(1);
  if (existing) return { bookId: existing.bookId, itemId: existing.itemId, created: false };

  const [item] = await tx.insert(libraryItems).values({
    workspaceId: ws, type: 'book', title: project.title, status: 'active',
  }).returning();
  const [book] = await tx.insert(libraryBooks).values({
    workspaceId: ws, libraryItemId: item!.id, authorLabel: 'Project',
  }).returning();
  await tx.insert(projectBooks).values({
    workspaceId: ws, projectId: project.id, bookId: book!.id, role: 'primary',
  });

  // A Book with no section cannot be opened to; a section with no pages has
  // nothing to show. Two pages, so the first thing seen is a spread.
  const [section] = await tx.insert(bookSections).values({
    workspaceId: ws, bookId: book!.id, title: 'Notes', accent: 'peach', position: 0,
  }).returning();
  const doc = starterContent('notes');
  await tx.insert(bookPages).values([
    { workspaceId: ws, sectionId: section!.id, position: 0, layout: 'notes', content: doc, contentText: pageToText('notes', doc) },
    { workspaceId: ws, sectionId: section!.id, position: GAP, layout: 'notes', content: doc, contentText: pageToText('notes', doc) },
  ]);

  return { bookId: book!.id, itemId: item!.id, created: true };
}

/**
 * Which Project each of these Books belongs to.
 *
 * Used to compute the Project shelves. §16 is explicit that a Book is never
 * MOVED because its Project changed state — the shelf is derived at read time
 * from the Project's lifecycle, so reopening a completed Project needs no write
 * to the Book at all.
 */
export async function projectBookIndex(db: Db, ws: string) {
  const rows = await db.select({
    bookId: projectBooks.bookId,
    itemId: libraryBooks.libraryItemId,
    projectId: projectBooks.projectId,
    role: projectBooks.role,
  }).from(projectBooks)
    .innerJoin(libraryBooks, eq(libraryBooks.id, projectBooks.bookId))
    .where(eq(projectBooks.workspaceId, ws));

  const byItem = new Map<string, { bookId: string; projectId: string; role: string }>();
  const byProject = new Map<string, { bookId: string; itemId: string; role: string }>();
  for (const r of rows) {
    byItem.set(r.itemId, { bookId: r.bookId, projectId: r.projectId, role: r.role });
    if (r.role === 'primary') byProject.set(r.projectId, { bookId: r.bookId, itemId: r.itemId, role: r.role });
  }
  return { byItem, byProject };
}

/**
 * Everything that points AT these pages, and where it points from.
 *
 * The generic half of §21. It takes targets rather than a single id so a Book's
 * whole backlink picture is one query instead of one per page.
 */
export async function linksToPages(db: Db, ws: string, pageIds: string[]) {
  if (!pageIds.length) return [];
  return db.select().from(itemLinks).where(and(
    eq(itemLinks.workspaceId, ws),
    eq(itemLinks.targetType, PAGE_TARGET),
    inArray(itemLinks.targetId, pageIds),
  ));
}

/** Everything a given source (a Task, usually) is linked to. */
export async function linksFrom(db: Db, ws: string, sourceType: string, sourceIds: string[]) {
  if (!sourceIds.length) return [];
  return db.select().from(itemLinks).where(and(
    eq(itemLinks.workspaceId, ws),
    eq(itemLinks.sourceType, sourceType),
    inArray(itemLinks.sourceId, sourceIds),
    eq(itemLinks.targetType, PAGE_TARGET),
  ));
}

/**
 * The readable address of a page — "Payments → Contractor Deposit".
 *
 * This is what a backlink shows and what a future AI citation will quote, so it
 * is built from stored titles and never from a position. "page 12" stops being
 * true the moment a page is inserted in front of it.
 */
export function pageLabel(sectionTitle: string, pageTitle: string | null, index: number) {
  return `${sectionTitle} → ${pageTitle?.trim() || `Page ${index + 1}`}`;
}

export const bookPageColumns = {
  id: bookPages.id, sectionId: bookPages.sectionId, title: bookPages.title,
  layout: bookPages.layout, position: bookPages.position,
};

export const sqlNow = () => sql`now()`;
