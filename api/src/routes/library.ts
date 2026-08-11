/**
 * Library API.
 *
 * Library is the durable home for information: books, documents, images,
 * videos, links and files. One row per resource; a Book gets a second row
 * carrying what only a book has.
 *
 * Three ideas run through the file.
 *
 * 1. THE TYPE IS STORED, never inferred from a MIME string. "This is a Book"
 *    is a product decision — a Document and a File can share `text/plain` and
 *    be entirely different things to the person who saved them.
 *
 * 2. PAGE CONTENT IS A DOCUMENT, not HTML. What arrives is validated against a
 *    small node grammar and rejected if it does not fit. Storing whatever the
 *    browser's editor produced is how Legacy ended up with font-colour wrappers
 *    that made text invisible on a dark theme.
 *
 * 3. NOTHING IS DESTROYED BY A SINGLE CLICK. Items, sections and pages archive;
 *    permanent deletion is not exposed. A book represents work nobody wants to
 *    lose to a misclick.
 */
import type { AppInstance, Guards } from '../types.js';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  libraryItems, libraryBooks, bookSections, bookPages,
  LIBRARY_TYPES, SECTION_ACCENTS,
} from '../db/schema.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { docToText, validateDoc } from '../lib/book-doc.js';
import {
  seedSampleLibrary, removeSampleLibrary, sampleLibraryFootprint, isLibrarySampleAllowed,
} from '../lib/sample-library.js';

/** Sparse spacing, so one move rewrites one row. */
const GAP = 1000;

const uuid = z.string().uuid();

const ItemCreate = z.object({
  type: z.enum(LIBRARY_TYPES),
  title: z.string().trim().min(1, 'A title is required.').max(300),
  description: z.string().max(4000).nullish(),
  sourceUrl: z.string().url('That is not a valid URL.').max(2000).nullish(),
  mimeType: z.string().max(255).nullish(),
  sizeBytes: z.number().int().nonnegative().nullish(),
  metadata: z.record(z.any()).nullish(),
}).strict();

const ItemUpdate = ItemCreate.omit({ type: true }).partial().strict();

export function registerLibraryRoutes(
  app: AppInstance, db: Db, guards: Guards, env: { NODE_ENV: string },
) {
  const pre = { preHandler: [guards.authenticate, guards.resolveWorkspace] };
  const base = '/api/v1/workspaces/:workspaceId';
  const wsId = (req: any) => req.workspaceId as string;

  /** An item in this workspace, or 404. Never crosses a workspace. */
  async function loadItem(ws: string, id: string) {
    const [row] = await db.select().from(libraryItems)
      .where(and(eq(libraryItems.workspaceId, ws), eq(libraryItems.id, id))).limit(1);
    if (!row) throw notFound('That Library item does not exist.');
    return row;
  }

  /** A book by its OWN id, with the item it belongs to. */
  async function loadBook(ws: string, bookId: string) {
    const [row] = await db.select().from(libraryBooks)
      .where(and(eq(libraryBooks.workspaceId, ws), eq(libraryBooks.id, bookId))).limit(1);
    if (!row) throw notFound('That book does not exist.');
    const item = await loadItem(ws, row.libraryItemId);
    return { book: row, item };
  }

  /**
   * The next free position at the end of a list.
   *
   * `max(...)` and then the arithmetic in JS, deliberately. Writing
   * `coalesce(max(x), -${GAP})` interpolates GAP as an untyped bind parameter,
   * and Postgres cannot resolve `- $1` — "operator is not unique: - unknown".
   * Doing the sum here is both unambiguous and easier to read.
   */
  async function nextPosition(column: any, table: any, whereClause: any) {
    const [r] = await db.select({ max: sql<number | null>`max(${column})` })
      .from(table).where(whereClause);
    return r?.max == null ? 0 : Number(r.max) + GAP;
  }

  /* ── Items ─────────────────────────────────────────────────────────── */

  app.get(`${base}/library/items`, pre, async (req) => {
    const ws = wsId(req);
    const q = z.object({
      type: z.enum(LIBRARY_TYPES).optional(),
      includeArchived: z.enum(['true', 'false']).optional(),
      search: z.string().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).parse(req.query ?? {});

    const where = [eq(libraryItems.workspaceId, ws)];
    if (q.type) where.push(eq(libraryItems.type, q.type));
    if (q.includeArchived !== 'true') where.push(isNull(libraryItems.archivedAt));
    if (q.search) {
      const needle = `%${q.search.toLowerCase()}%`;
      where.push(sql`(lower(${libraryItems.title}) like ${needle}
        or lower(coalesce(${libraryItems.description}, '')) like ${needle})`);
    }

    const rows = await db.select().from(libraryItems).where(and(...where))
      .orderBy(desc(libraryItems.updatedAt)).limit(q.limit);

    /* Books carry their own id and a section/page count, so a Library card can
     * say "3 sections · 8 pages" without a request per card. */
    const bookRows = rows.some((r) => r.type === 'book')
      ? await db.select().from(libraryBooks)
        .where(and(eq(libraryBooks.workspaceId, ws),
          inArray(libraryBooks.libraryItemId, rows.filter((r) => r.type === 'book').map((r) => r.id))))
      : [];
    const counts = bookRows.length
      ? await db.select({
        bookId: bookSections.bookId,
        sections: sql<number>`count(distinct ${bookSections.id})::int`,
        pages: sql<number>`count(${bookPages.id})::int`,
        /* The FIRST section's accent, which is the colour the book actually
         * opens onto. L3 §8 requires the cover on the shelf to correspond to
         * the book that opens; deriving a colour from the id instead would be
         * stable but arbitrary, and would disagree with the book itself. */
        accent: sql<string | null>`(array_agg(${bookSections.accent}
          order by ${bookSections.position}, ${bookSections.id}))[1]`,
      }).from(bookSections)
        .leftJoin(bookPages, and(eq(bookPages.sectionId, bookSections.id),
          isNull(bookPages.archivedAt)))
        .where(and(inArray(bookSections.bookId, bookRows.map((b) => b.id)),
          isNull(bookSections.archivedAt)))
        .groupBy(bookSections.bookId)
      : [];
    const countBy = new Map(counts.map((c) => [c.bookId, c]));
    const bookByItem = new Map(bookRows.map((b) => [b.libraryItemId, b]));

    return {
      items: rows.map((r) => {
        const book = bookByItem.get(r.id);
        if (!book) return r;
        const c = countBy.get(book.id);
        return {
          ...r,
          book: {
            id: book.id, subtitle: book.subtitle, authorLabel: book.authorLabel,
            coverStyle: book.coverStyle, pageStyle: book.pageStyle,
            sectionCount: c?.sections ?? 0, pageCount: c?.pages ?? 0,
            accent: c?.accent ?? null,
          },
        };
      }),
    };
  });

  app.get(`${base}/library/items/:id`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return { item: await loadItem(wsId(req), id) };
  });

  app.post(`${base}/library/items`, pre, async (req, reply) => {
    const ws = wsId(req);
    const body = ItemCreate.parse(req.body);
    /* A Book is not created here. It needs a book row, a first section and its
     * opening pages, all in one transaction — see POST /library/books. Letting
     * this route make a type:'book' item would produce a book with no pages
     * and no way to reach them. */
    if (body.type === 'book') {
      throw badRequest('Create a book with POST …/library/books.');
    }
    if (body.type === 'link' && !body.sourceUrl) {
      throw badRequest('A link needs a URL.');
    }
    const [row] = await db.insert(libraryItems).values({
      workspaceId: ws,
      type: body.type,
      title: body.title,
      description: body.description ?? null,
      sourceUrl: body.sourceUrl ?? null,
      mimeType: body.mimeType ?? null,
      sizeBytes: body.sizeBytes ?? null,
      metadata: body.metadata ?? null,
    }).returning();
    reply.code(201);
    return { item: row };
  });

  app.patch(`${base}/library/items/:id`, pre, async (req) => {
    const ws = wsId(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = ItemUpdate.parse(req.body);
    if (Object.keys(body).length === 0) throw badRequest('No fields to update.');
    await loadItem(ws, id);
    const [row] = await db.update(libraryItems)
      .set({ ...body, updatedAt: new Date() })
      .where(and(eq(libraryItems.workspaceId, ws), eq(libraryItems.id, id))).returning();
    return { item: row };
  });

  /* Archive, not delete.
   *
   * Idempotent, so a double click cannot produce a second archive timestamp
   * and lose when it actually happened. Permanent deletion is deliberately not
   * exposed in F1 — see library-v2-product-model.md on retention. */
  app.post(`${base}/library/items/:id/archive`, pre, async (req) => {
    const ws = wsId(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const existing = await loadItem(ws, id);
    if (existing.archivedAt) return { item: existing };
    const [row] = await db.update(libraryItems)
      .set({ archivedAt: new Date(), status: 'archived', updatedAt: new Date() })
      .where(and(eq(libraryItems.workspaceId, ws), eq(libraryItems.id, id))).returning();
    return { item: row };
  });

  app.post(`${base}/library/items/:id/restore`, pre, async (req) => {
    const ws = wsId(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const existing = await loadItem(ws, id);
    if (!existing.archivedAt) return { item: existing };
    const [row] = await db.update(libraryItems)
      .set({ archivedAt: null, status: 'active', updatedAt: new Date() })
      .where(and(eq(libraryItems.workspaceId, ws), eq(libraryItems.id, id))).returning();
    return { item: row };
  });

  /**
   * "I opened this" (L3 §12).
   *
   * Deliberately does NOT touch `updated_at`. Opening a Book is not editing it,
   * and if reading moved the edit time then "Recently opened" and "recently
   * changed" would collapse into one number that answers neither question. That
   * separation is the whole reason the column exists.
   *
   * Returns the timestamp rather than the row: the caller is a fire-and-forget
   * call made while a Book is opening, and it must not be able to cause a
   * re-render by handing back a fresher copy of an item the client is already
   * animating. A failure here is silent by design — losing a recency mark is
   * not worth interrupting somebody who is trying to read.
   */
  app.post(`${base}/library/items/:id/opened`, pre, async (req) => {
    const ws = wsId(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await loadItem(ws, id);
    const at = new Date();
    await db.update(libraryItems).set({ lastOpenedAt: at })
      .where(and(eq(libraryItems.workspaceId, ws), eq(libraryItems.id, id)));
    return { lastOpenedAt: at.toISOString() };
  });

  /* ── Books ─────────────────────────────────────────────────────────── */

  /**
   * A new book arrives ready to write in.
   *
   * Item, book, one section and TWO pages, in one transaction. A book that
   * opens to nothing forces its first act to be administration; a spread needs
   * two pages to be a spread. Everything or nothing — a book with an item row
   * and no section is unreachable.
   */
  app.post(`${base}/library/books`, pre, async (req, reply) => {
    const ws = wsId(req);
    const body = z.object({
      title: z.string().trim().min(1, 'A title is required.').max(300),
      subtitle: z.string().max(300).nullish(),
      authorLabel: z.string().max(120).nullish(),
      description: z.string().max(4000).nullish(),
      firstSection: z.string().trim().min(1).max(120).default('Notes'),
    }).strict().parse(req.body ?? {});

    const created = await db.transaction(async (tx) => {
      const [item] = await tx.insert(libraryItems).values({
        workspaceId: ws, type: 'book', title: body.title,
        description: body.description ?? null,
      }).returning();
      const [book] = await tx.insert(libraryBooks).values({
        workspaceId: ws, libraryItemId: item!.id,
        subtitle: body.subtitle ?? null, authorLabel: body.authorLabel ?? null,
      }).returning();
      const [section] = await tx.insert(bookSections).values({
        workspaceId: ws, bookId: book!.id, title: body.firstSection,
        accent: 'peach', position: 0,
      }).returning();
      await tx.insert(bookPages).values([
        { workspaceId: ws, sectionId: section!.id, position: 0 },
        { workspaceId: ws, sectionId: section!.id, position: GAP },
      ]);
      return { item: item!, book: book!, section: section! };
    });
    reply.code(201);
    return created;
  });

  /** The whole book: sections in order, each with its pages in order. */
  app.get(`${base}/library/books/:id`, pre, async (req) => {
    const ws = wsId(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { book, item } = await loadBook(ws, id);

    const sections = await db.select().from(bookSections)
      .where(and(eq(bookSections.bookId, book.id), isNull(bookSections.archivedAt)))
      .orderBy(asc(bookSections.position), asc(bookSections.createdAt));

    const pages = sections.length
      ? await db.select().from(bookPages)
        .where(and(inArray(bookPages.sectionId, sections.map((s) => s.id)),
          isNull(bookPages.archivedAt)))
        .orderBy(asc(bookPages.position), asc(bookPages.createdAt))
      : [];
    const bySection = new Map<string, typeof pages>();
    for (const p of pages) {
      const list = bySection.get(p.sectionId) ?? [];
      list.push(p); bySection.set(p.sectionId, list);
    }

    return {
      item, book,
      sections: sections.map((s) => ({ ...s, pages: bySection.get(s.id) ?? [] })),
    };
  });

  app.patch(`${base}/library/books/:id`, pre, async (req) => {
    const ws = wsId(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({
      title: z.string().trim().min(1).max(300).optional(),
      subtitle: z.string().max(300).nullish(),
      authorLabel: z.string().max(120).nullish(),
      coverStyle: z.enum(['classic', 'plain']).optional(),
      pageStyle: z.enum(['ruled', 'plain']).optional(),
    }).strict().parse(req.body ?? {});
    const { book } = await loadBook(ws, id);

    // The title lives on the ITEM — it is what Library lists — so a rename has
    // to reach both rows or the shelf and the cover disagree.
    if (body.title !== undefined) {
      await db.update(libraryItems).set({ title: body.title, updatedAt: new Date() })
        .where(eq(libraryItems.id, book.libraryItemId));
    }
    const bookFields = { ...body };
    delete (bookFields as any).title;
    const [row] = Object.keys(bookFields).length
      ? await db.update(libraryBooks).set({ ...bookFields, updatedAt: new Date() })
        .where(eq(libraryBooks.id, book.id)).returning()
      : [book];
    return { book: row };
  });

  /* ── Sections ──────────────────────────────────────────────────────── */

  app.post(`${base}/library/books/:id/sections`, pre, async (req, reply) => {
    const ws = wsId(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({
      title: z.string().trim().min(1).max(120),
      accent: z.enum(SECTION_ACCENTS).default('peach'),
    }).strict().parse(req.body ?? {});
    const { book } = await loadBook(ws, id);

    const position = await nextPosition(bookSections.position, bookSections,
      eq(bookSections.bookId, book.id));
    const created = await db.transaction(async (tx) => {
      const [section] = await tx.insert(bookSections).values({
        workspaceId: ws, bookId: book.id, title: body.title, accent: body.accent, position,
      }).returning();
      // A section with no page cannot be opened to.
      await tx.insert(bookPages).values([
        { workspaceId: ws, sectionId: section!.id, position: 0 },
        { workspaceId: ws, sectionId: section!.id, position: GAP },
      ]);
      return section!;
    });
    reply.code(201);
    return { section: created };
  });

  app.patch(`${base}/library/sections/:id`, pre, async (req) => {
    const ws = wsId(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({
      title: z.string().trim().min(1).max(120).optional(),
      accent: z.enum(SECTION_ACCENTS).optional(),
      position: z.number().int().optional(),
    }).strict().parse(req.body ?? {});
    if (Object.keys(body).length === 0) throw badRequest('No fields to update.');
    const [row] = await db.update(bookSections)
      .set({ ...body, updatedAt: new Date() })
      .where(and(eq(bookSections.workspaceId, ws), eq(bookSections.id, id))).returning();
    if (!row) throw notFound('That section does not exist.');
    return { section: row };
  });

  /**
   * Archiving a section takes its pages with it.
   *
   * And it refuses to take the LAST one: a book with no sections has nowhere
   * to put a page and no way to reach its own content. The caller is told to
   * archive the book instead, which is the thing they actually meant.
   */
  app.post(`${base}/library/sections/:id/archive`, pre, async (req) => {
    const ws = wsId(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const [section] = await db.select().from(bookSections)
      .where(and(eq(bookSections.workspaceId, ws), eq(bookSections.id, id))).limit(1);
    if (!section) throw notFound('That section does not exist.');
    if (section.archivedAt) return { section };

    const live = await db.select({ id: bookSections.id }).from(bookSections)
      .where(and(eq(bookSections.bookId, section.bookId), isNull(bookSections.archivedAt)));
    if (live.length <= 1) {
      throw badRequest('This is the book’s only section. Archive the book instead.');
    }

    const [row] = await db.transaction(async (tx) => {
      await tx.update(bookPages).set({ archivedAt: new Date() })
        .where(and(eq(bookPages.sectionId, id), isNull(bookPages.archivedAt)));
      return tx.update(bookSections).set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(eq(bookSections.id, id)).returning();
    });
    return { section: row };
  });

  /* ── Pages ─────────────────────────────────────────────────────────── */

  /**
   * Adding pages is DELIBERATE, and adds them in a pair.
   *
   * Never on navigation: turning forward must not write. A spread shows two
   * pages, so adding one at a time would leave every other addition looking
   * like a mistake.
   */
  app.post(`${base}/library/sections/:id/pages`, pre, async (req, reply) => {
    const ws = wsId(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({
      count: z.number().int().min(1).max(2).default(2),
    }).strict().parse(req.body ?? {});

    const [section] = await db.select().from(bookSections)
      .where(and(eq(bookSections.workspaceId, ws), eq(bookSections.id, id))).limit(1);
    if (!section) throw notFound('That section does not exist.');
    if (section.archivedAt) throw badRequest('That section is archived.');

    const start = await nextPosition(bookPages.position, bookPages, eq(bookPages.sectionId, id));
    const created = await db.transaction(async (tx) => {
      return tx.insert(bookPages).values(
        Array.from({ length: body.count }, (_, i) => ({
          workspaceId: ws, sectionId: id, position: start + i * GAP,
        })),
      ).returning();
    });
    reply.code(201);
    return { pages: created };
  });

  /**
   * Saving a page.
   *
   * `expectedUpdatedAt` is the guard against a stale write: two tabs, or a slow
   * response arriving after a newer one, would otherwise let older content win.
   * A mismatch is a 409 and the caller re-reads — it never silently overwrites.
   */
  app.patch(`${base}/library/pages/:id`, pre, async (req) => {
    const ws = wsId(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({
      title: z.string().max(200).nullish(),
      content: z.any().optional(),
      expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
    }).strict().parse(req.body ?? {});

    const [existing] = await db.select().from(bookPages)
      .where(and(eq(bookPages.workspaceId, ws), eq(bookPages.id, id))).limit(1);
    if (!existing) throw notFound('That page does not exist.');

    if (body.expectedUpdatedAt
      && new Date(body.expectedUpdatedAt).getTime() !== existing.updatedAt.getTime()) {
      throw conflictError();
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.title !== undefined) patch['title'] = body.title ?? null;
    if (body.content !== undefined) {
      // Validated against the node grammar, never trusted as-is. An unknown
      // node type is a rejection, not something to store and hope about.
      const doc = validateDoc(body.content);
      patch['content'] = doc;
      patch['contentText'] = docToText(doc);
    }
    const [row] = await db.update(bookPages).set(patch)
      .where(and(eq(bookPages.workspaceId, ws), eq(bookPages.id, id))).returning();

    // The book's shelf entry should show when it was last written in.
    const [section] = await db.select({ bookId: bookSections.bookId }).from(bookSections)
      .where(eq(bookSections.id, existing.sectionId)).limit(1);
    if (section) {
      const [b] = await db.select({ itemId: libraryBooks.libraryItemId }).from(libraryBooks)
        .where(eq(libraryBooks.id, section.bookId)).limit(1);
      if (b) {
        await db.update(libraryItems).set({ updatedAt: new Date() })
          .where(eq(libraryItems.id, b.itemId));
      }
    }
    return { page: row };
  });

  /** Archiving a page refuses to empty its section. */
  app.post(`${base}/library/pages/:id/archive`, pre, async (req) => {
    const ws = wsId(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const [page] = await db.select().from(bookPages)
      .where(and(eq(bookPages.workspaceId, ws), eq(bookPages.id, id))).limit(1);
    if (!page) throw notFound('That page does not exist.');
    if (page.archivedAt) return { page };

    const live = await db.select({ id: bookPages.id }).from(bookPages)
      .where(and(eq(bookPages.sectionId, page.sectionId), isNull(bookPages.archivedAt)));
    if (live.length <= 1) {
      throw badRequest('This is the section’s only page. Archive the section instead.');
    }
    const [row] = await db.update(bookPages)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(bookPages.id, id)).returning();
    return { page: row };
  });

  /** Undo for an archived page. */
  app.post(`${base}/library/pages/:id/restore`, pre, async (req) => {
    const ws = wsId(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const [row] = await db.update(bookPages)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(and(eq(bookPages.workspaceId, ws), eq(bookPages.id, id))).returning();
    if (!row) throw notFound('That page does not exist.');
    return { page: row };
  });

  /* ── Search ────────────────────────────────────────────────────────── */

  /**
   * GET …/library/search?q=
   *
   * Two kinds of hit, in one response: Library items by title/description, and
   * book pages by section title, page title or content.
   *
   * Content is matched against `content_text`, maintained on write — not by
   * parsing every stored document. Plain and reliable; semantic search is not
   * this phase.
   */
  app.get(`${base}/library/search`, pre, async (req) => {
    const ws = wsId(req);
    const { q, bookId } = z.object({
      q: z.string().trim().min(1).max(200),
      bookId: uuid.optional(),
    }).parse(req.query ?? {});
    const needle = `%${q.toLowerCase()}%`;

    const items = bookId ? [] : await db.select().from(libraryItems)
      .where(and(
        eq(libraryItems.workspaceId, ws),
        isNull(libraryItems.archivedAt),
        sql`(lower(${libraryItems.title}) like ${needle}
          or lower(coalesce(${libraryItems.description}, '')) like ${needle})`,
      )).orderBy(desc(libraryItems.updatedAt)).limit(20);

    const pageWhere = [
      eq(bookPages.workspaceId, ws),
      isNull(bookPages.archivedAt),
      isNull(bookSections.archivedAt),
      sql`(lower(${bookPages.contentText}) like ${needle}
        or lower(coalesce(${bookPages.title}, '')) like ${needle}
        or lower(${bookSections.title}) like ${needle})`,
    ];
    if (bookId) pageWhere.push(eq(bookSections.bookId, bookId));

    const pageRows = await db.select({
      pageId: bookPages.id, pageTitle: bookPages.title, text: bookPages.contentText,
      position: bookPages.position,
      sectionId: bookSections.id, sectionTitle: bookSections.title,
      accent: bookSections.accent, sectionPosition: bookSections.position,
      bookId: bookSections.bookId, itemId: libraryBooks.libraryItemId,
      bookTitle: libraryItems.title,
    }).from(bookPages)
      .innerJoin(bookSections, eq(bookPages.sectionId, bookSections.id))
      .innerJoin(libraryBooks, eq(bookSections.bookId, libraryBooks.id))
      .innerJoin(libraryItems, eq(libraryBooks.libraryItemId, libraryItems.id))
      .where(and(...pageWhere))
      .orderBy(asc(bookSections.position), asc(bookPages.position))
      .limit(40);

    return {
      query: q,
      items,
      // An excerpt AROUND the match, so a result is readable without opening it.
      pages: pageRows.map((r) => ({ ...r, excerpt: excerpt(r.text, q) })),
    };
  });

  /* ── Sample data — staging only ────────────────────────────────────── */

  app.get(`${base}/library/sample`, pre, async (req) => ({
    ...(await sampleLibraryFootprint(db, wsId(req))),
    allowed: isLibrarySampleAllowed(env.NODE_ENV),
  }));

  /* `size` picks how much shelf to seed — solo / small / full (L3 §38). One
   * sample system with a dial, not three: every size writes the same prefix
   * and is removed by the same cleanup. Defaults to the full collection, so an
   * existing caller that sends no body is unchanged. */
  app.post(`${base}/library/sample`, pre, async (req) => {
    if (!isLibrarySampleAllowed(env.NODE_ENV)) {
      throw forbidden('Sample data is not available in production.');
    }
    const { size } = z.object({
      size: z.enum(['solo', 'small', 'full']).default('full'),
    }).parse(req.body ?? {});
    return seedSampleLibrary(db, wsId(req), size);
  });

  app.post(`${base}/library/sample/remove`, pre, async (req) => {
    if (!isLibrarySampleAllowed(env.NODE_ENV)) {
      throw forbidden('Sample data is not available in production.');
    }
    return removeSampleLibrary(db, wsId(req));
  });
}

/** 409, so a stale save is rejected rather than silently winning. */
function conflictError() {
  const e = new Error('This page changed somewhere else. Reopen it to see the newer version.') as any;
  e.statusCode = 409;
  return e;
}

/**
 * ~140 characters around the first match, on word boundaries where it can
 * manage it. A result that shows the wrong part of a page is barely a result.
 */
function excerpt(text: string, q: string): string {
  if (!text) return '';
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at === -1) return text.slice(0, 140);
  const start = Math.max(0, at - 55);
  const end = Math.min(text.length, at + q.length + 85);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}
