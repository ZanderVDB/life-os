/**
 * Library writing.
 *
 * ── Why appending is not "add a string to a field" ───────────────────────
 *
 * A page's body is a document with a grammar, and WHICH grammar depends on the
 * page's layout. A pinboard is not a list of paragraphs that happen to be laid
 * out differently — it is items with positions, groups and connections, and a
 * paragraph appended to one has nowhere to go. `validatePageContent` already
 * knows this; the job here is to refuse the cases it would silently drop
 * rather than to push a string at it and hope.
 *
 * So: flowed layouts take an append. A pinboard does not, and says so, with a
 * suggestion the assistant can turn into a different proposal. That refusal is
 * the feature — a note the user believes they wrote and which is not there is
 * worse than being told it could not be written.
 *
 * ── Never overwrite ──────────────────────────────────────────────────────
 *
 * Everything here APPENDS. There is no "set the page content" service and
 * there will not be one for the assistant: replacing a page the user wrote,
 * because a sentence was ambiguous, is not recoverable from the UI.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import {
  bookPages, bookSections, libraryBooks, libraryItems, projectBooks,
  PAGE_LAYOUTS, PAGE_PURPOSES,
} from '../../db/schema.js';
import {
  validatePageContent, pageToText, starterContent, paragraph, type Doc,
} from '../book-doc.js';
import { syncPageRefs } from '../book-links.js';
import { badRequest, notFound } from '../errors.js';

/** Sparse spacing so one insert rewrites one row. Matches library.ts. */
const GAP = 1000;

/** Layouts whose body is a flowed document and can therefore take a paragraph. */
const FLOWED = new Set(['notes', 'blank', 'two_columns', 'quad', 'comparison']);

export const PageAppendInput = z.object({
  pageId: z.string().uuid(),
  /** Plain text. One paragraph per blank line. */
  text: z.string().trim().min(1).max(8000),
}).strict();

export const PageCreateInput = z.object({
  sectionId: z.string().uuid(),
  title: z.string().trim().max(200).nullish(),
  layout: z.enum(PAGE_LAYOUTS).default('notes'),
  purpose: z.enum(PAGE_PURPOSES).nullish(),
  /** Optional first content, appended after the starter. */
  text: z.string().trim().max(8000).nullish(),
}).strict();

export type Actor = { userId: string | null };

/** The book a section belongs to, and the project owning that book if any. */
async function bookContext(db: Db, ws: string, sectionId: string) {
  const [section] = await db.select().from(bookSections)
    .where(and(eq(bookSections.workspaceId, ws), eq(bookSections.id, sectionId))).limit(1);
  if (!section) throw notFound('That section does not exist.');
  if (section.archivedAt) throw badRequest('That section is archived.');
  const [pb] = await db.select({ projectId: projectBooks.projectId }).from(projectBooks)
    .where(eq(projectBooks.bookId, section.bookId)).limit(1);
  return { section, projectId: pb?.projectId ?? null };
}

const toBlocks = (text: string) => text
  .split(/\n{2,}/).map((s) => s.trim()).filter(Boolean).map(paragraph);

/**
 * Add text to the end of a page.
 *
 * Refuses a layout whose grammar cannot hold a paragraph, and says which one
 * it is, so the assistant can propose a page that can instead of failing after
 * the user has already agreed.
 */
export async function appendToPage(
  db: Db, ws: string, actor: Actor, input: z.infer<typeof PageAppendInput>,
) {
  const [page] = await db.select().from(bookPages)
    .where(and(eq(bookPages.workspaceId, ws), eq(bookPages.id, input.pageId))).limit(1);
  if (!page) throw notFound('That page does not exist.');
  if (page.archivedAt) throw badRequest('That page is archived.');
  if (!FLOWED.has(page.layout)) {
    throw badRequest(
      `A ${page.layout.replace('_', ' ')} page holds items rather than paragraphs, so text cannot be added to it. Add a Notes page instead.`,
    );
  }

  const existing = validatePageContent(page.layout, page.content) as Doc;
  const next: Doc = { type: 'doc', content: [...existing.content, ...toBlocks(input.text)] };
  const validated = validatePageContent(page.layout, next);

  const [section] = await db.select({ bookId: bookSections.bookId }).from(bookSections)
    .where(eq(bookSections.id, page.sectionId)).limit(1);
  const [pb] = section
    ? await db.select({ projectId: projectBooks.projectId }).from(projectBooks)
      .where(eq(projectBooks.bookId, section.bookId)).limit(1)
    : [];

  return db.transaction(async (tx) => {
    const [row] = await tx.update(bookPages).set({
      content: validated as any,
      contentText: pageToText(page.layout, validated),
      updatedAt: new Date(),
    }).where(and(eq(bookPages.workspaceId, ws), eq(bookPages.id, page.id))).returning();

    /* The edge table follows the document in the SAME transaction, exactly as
       the editor's save does. A page whose links did not save is a page whose
       backlinks lie until the next edit. */
    if (section) {
      await syncPageRefs(tx, ws, page, section.bookId, page.layout, validated, {
        projectId: pb?.projectId ?? null,
        userId: actor.userId,
      });
    }
    return row!;
  });
}

/** Add a page to a section, optionally with its first paragraphs. */
export async function createPage(
  db: Db, ws: string, actor: Actor, input: z.infer<typeof PageCreateInput>,
) {
  const { section, projectId } = await bookContext(db, ws, input.sectionId);
  /* A pinboard IS the spread — one page occupying both halves. The route makes
     the same decision; repeating it here rather than importing it keeps this
     service independent of a route. */
  const isSpread = input.layout === 'pinboard';

  const [max] = await db.select({ m: sql<number>`coalesce(max(${bookPages.position}), 0)` })
    .from(bookPages).where(eq(bookPages.sectionId, input.sectionId));

  let content = starterContent(input.layout, input.purpose ?? null);
  if (input.text && FLOWED.has(input.layout)) {
    const doc = content as Doc;
    content = { type: 'doc', content: [...doc.content, ...toBlocks(input.text)] } as Doc;
  } else if (input.text) {
    throw badRequest(
      `A ${input.layout.replace('_', ' ')} page cannot be created with text in it.`,
    );
  }
  const validated = validatePageContent(input.layout, content);

  return db.transaction(async (tx) => {
    const [row] = await tx.insert(bookPages).values({
      workspaceId: ws,
      sectionId: input.sectionId,
      position: Number(max?.m ?? 0) + GAP,
      layout: input.layout,
      purpose: input.purpose ?? null,
      spansSpread: isSpread,
      title: input.title ?? null,
      content: validated as any,
      contentText: pageToText(input.layout, validated),
    }).returning();

    await syncPageRefs(tx, ws, row!, section.bookId, input.layout, validated, {
      projectId, userId: actor.userId,
    });
    return row!;
  });
}

/**
 * The sections of a book, so a request naming one ("put it under Research")
 * can be resolved to an id before anything is proposed.
 */
export async function sectionsOfBook(db: Db, ws: string, bookId: string) {
  return db.select({
    id: bookSections.id, title: bookSections.title, bookId: bookSections.bookId,
  }).from(bookSections)
    .where(and(eq(bookSections.workspaceId, ws), eq(bookSections.bookId, bookId)))
    .orderBy(asc(bookSections.position));
}

/** A project's own Book, which is where "the project book" means. */
export async function bookForProject(db: Db, ws: string, projectId: string) {
  const [row] = await db.select({
    bookId: projectBooks.bookId,
    itemId: libraryBooks.libraryItemId,
    title: libraryItems.title,
  }).from(projectBooks)
    .innerJoin(libraryBooks, eq(libraryBooks.id, projectBooks.bookId))
    .innerJoin(libraryItems, eq(libraryItems.id, libraryBooks.libraryItemId))
    .where(and(eq(projectBooks.workspaceId, ws), eq(projectBooks.projectId, projectId)))
    .limit(1);
  return row ?? null;
}
