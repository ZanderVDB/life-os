/**
 * Sample Library content — STAGING ONLY, TEMPORARY.
 *
 * Exists so the Book can be reviewed against real structure without importing
 * a single row of Legacy content. Delete this file and its route block when
 * Library has real content.
 *
 * Safety, following the D4.3 lesson — real reminders were nearly deleted
 * because synthetic rows shared a flag with real ones: every sample row carries
 * `legacy_id` beginning `sample:f1:`, and cleanup matches ONLY that prefix.
 * Never a title, never a date, never "created recently" — each of which can
 * also describe something the user made.
 *
 * The content is written to exercise the system: an empty page, a long one,
 * headings, both list kinds, a quote, a link, an odd page count, and words that
 * appear in exactly one place so search results can be checked.
 */
import { and, eq, like } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { libraryItems, libraryBooks, bookSections, bookPages } from '../db/schema.js';
import { docToText, type Block, type Doc } from './book-doc.js';

export const SAMPLE_PREFIX = 'sample:f1:';
const GAP = 1000;

/** Never in production. Same guard the Projects sample tooling uses. */
export const isLibrarySampleAllowed = (nodeEnv: string) => nodeEnv !== 'production';

/* ── Document builders ───────────────────────────────────────────────── */
const p = (text: string): Block => ({
  type: 'paragraph', content: text ? [{ type: 'text', text }] : [],
});
const h = (level: 2 | 3, text: string): Block => ({
  type: 'heading', attrs: { level }, content: [{ type: 'text', text }],
});
const bullets = (items: string[]): Block => ({
  type: 'bulletList',
  content: items.map((t) => ({ type: 'listItem', content: [p(t)] })),
});
const numbered = (items: string[]): Block => ({
  type: 'orderedList',
  content: items.map((t) => ({ type: 'listItem', content: [p(t)] })),
});
const quote = (text: string): Block => ({ type: 'blockquote', content: [p(text)] });
const linked = (before: string, label: string, href: string, after: string): Block => ({
  type: 'paragraph',
  content: [
    ...(before ? [{ type: 'text' as const, text: before }] : []),
    { type: 'text' as const, text: label, marks: [{ type: 'link' as const, attrs: { href } }] },
    ...(after ? [{ type: 'text' as const, text: after }] : []),
  ],
});
const doc = (...blocks: Block[]): Doc => ({ type: 'doc', content: blocks });

/* ── The sample book ─────────────────────────────────────────────────── */

const BOOK = {
  title: 'Life OS Field Notes',
  subtitle: 'Working notes on building the thing',
  author: 'Zander',
  sections: [
    {
      title: 'Ideas',
      accent: 'peach' as const,
      pages: [
        {
          title: 'First principles',
          content: doc(
            h(2, 'What Life OS is for'),
            p('One place that answers "what am I doing?" without me having to '
              + 'assemble the answer from four apps and a notebook.'),
            p('Everything else is in service of that. A feature that does not '
              + 'help answer it is a feature that makes it harder to.'),
            quote('If it needs a legend, it is not finished.'),
          ),
        },
        {
          title: 'Open questions',
          content: doc(
            p('Things I have not decided yet:'),
            bullets([
              'Should a Board card be able to hold a Task, or only reference one?',
              'Does Brain need its own timeline, or is that Diary?',
              'How much of the Calendar should be writable before it stops being safe?',
            ]),
            p('None of these are urgent. Writing them down is most of the work.'),
          ),
        },
        // Deliberately empty — the editor must handle a page with nothing on it.
        { title: null, content: doc() },
      ],
    },
    {
      title: 'Research',
      accent: 'sage' as const,
      pages: [
        {
          title: 'Ordered checklists',
          content: doc(
            h(2, 'Sequence beats a checklist'),
            p('A flat checklist tells you what is left. An ordered sequence tells '
              + 'you what to do. The difference matters most when you are tired, '
              + 'which is exactly when a list is being consulted.'),
            h(3, 'What that implies'),
            numbered([
              'One step is current; the rest wait.',
              'The next one is visible, so you know what is coming.',
              'Finishing the last step is not the same as finishing the task.',
            ]),
            p('The last point is the one everything else hangs on. A task with '
              + 'every step ticked is ready to finish, not finished — the decision '
              + 'stays with the person.'),
            linked('Background reading: ', 'the original checklist manifesto argument',
              'https://example.com/checklists', '. Worth revisiting.'),
          ),
        },
        {
          title: 'Typography notes',
          content: doc(
            p('Playfair for the wordmark and book covers. Inter for everything '
              + 'that has to be read quickly.'),
            p('The handwriting face on ruled pages is doing real work: it says '
              + '"this is yours" in a way a UI font cannot. It is also the only '
              + 'place in the app where legibility is allowed to lose to '
              + 'character, and only slightly.'),
            bullets(['Playfair — wordmark, book cover', 'Inter — application UI',
              'Kalam — book pages only']),
          ),
        },
      ],
    },
    {
      title: 'Plans',
      accent: 'lavender' as const,
      pages: [
        {
          title: 'After Library',
          content: doc(
            h(2, 'Order of work'),
            numbered([
              'Library — durable resources, and the Book engine.',
              'Diary — reuses the Book engine, owns none of the resources.',
              'Brain — Growth items, referencing Library.',
              'Boards — a canvas that references everything above.',
            ]),
            p('Boards last, deliberately. A canvas that references Tasks, Library '
              + 'items and Diary entries cannot be built before those exist '
              + 'without inventing its own copies of them.'),
          ),
        },
        {
          title: 'The migration question',
          content: doc(
            p('Legacy migration is cancelled for Projects. The book design comes '
              + 'across; the data does not.'),
            p('That is the right call. The Legacy data model entangles layout '
              + 'with content — pages hold a fixed array of cells indexed by '
              + 'layout — and importing it would import that entanglement along '
              + 'with the words.'),
            quote('Take the design. Leave the shape.'),
          ),
        },
        // A third page, so this section has an odd count and the spread has to
        // render a blank companion.
        {
          title: 'Loose ends',
          content: doc(
            p('Uploads. Mobile refinement. Step reordering. Boards.'),
            p('None of them blocking, all of them written down so they stop '
              + 'occupying the part of my head that should be doing the work.'),
          ),
        },
      ],
    },
  ],
};

/**
 * The rest of the shelf (L3 §37).
 *
 * `BOOK` above is the deep one — real sections, an empty page, an odd page
 * count — and it stays the book the EDITOR is reviewed against. These are
 * shallow by design: one section and two pages each, because what they exist to
 * exercise is the SHELF, and eleven deep books would make seeding slow and the
 * cleanup harder to reason about for no extra coverage.
 *
 * Deliberately varied, because a shelf of similar titles proves nothing:
 * one-word titles next to titles that must truncate, some with subtitles and
 * some without, and every accent in the palette represented.
 */
const SHELF_BOOKS = [
  { key: 'atlas', title: 'Atlas', subtitle: null, accent: 'blue' as const,
    description: 'Places, routes and the reasons for going.' },
  { key: 'systems', title: 'Systems That Survive Contact With A Tuesday',
    subtitle: 'Notes on routines that do not need me to be at my best',
    accent: 'sage' as const,
    description: 'A long title, on purpose: the shelf has to cope with one.' },
  { key: 'recipes', title: 'Recipes', subtitle: 'Things worth cooking twice',
    accent: 'peach' as const, description: null },
  { key: 'reading', title: 'Reading Log', subtitle: null, accent: 'gold' as const,
    description: 'What I read, and whether it was worth it.' },
  { key: 'money', title: 'Money', subtitle: 'Plain arithmetic, written down',
    accent: 'rose' as const, description: null },
  { key: 'garden', title: 'The Garden Book', subtitle: 'Seasons, failures, one success',
    accent: 'sage' as const, description: 'Mostly failures. The success was rocket.' },
  { key: 'letters', title: 'Letters I Did Not Send', subtitle: null,
    accent: 'lavender' as const, description: null },
  { key: 'training', title: 'Training', subtitle: 'Sets, weeks, and honest numbers',
    accent: 'blue' as const, description: null },
  { key: 'house', title: 'House Notes', subtitle: null, accent: 'peach' as const,
    description: 'Where the stopcock is, and eleven other things I forget.' },
  { key: 'quotes', title: 'Kept Lines', subtitle: 'Sentences I wanted to keep',
    accent: 'gold' as const, description: null },
  { key: 'archive-book', title: 'Old Project Notes', subtitle: 'Finished, kept',
    accent: 'rose' as const, archived: true,
    description: 'Archived on purpose, so the archived state has something in it.' },
];

/** One section, two pages. Enough that every sample Book actually opens. */
const shelfBookPages = (title: string): { title: string | null; content: Doc }[] => ([
  {
    title: 'Beginning',
    content: doc(
      h(2, title),
      p('A sample Book, seeded so the shelf can be judged with something on it.'),
      p('Nothing here is real. It exists to be looked at, scrolled past, '
        + 'searched for and then removed.'),
    ),
  },
  {
    title: null,
    content: doc(
      p('The second page, so this Book opens onto a spread rather than a '
        + 'page and a blank.'),
    ),
  },
]);

/** The non-book sample resources — several of each remaining type (§37). */
const OTHER_ITEMS = [
  {
    key: 'link-1', type: 'link' as const,
    title: 'Refactoring UI — visual hierarchy',
    description: 'The section on emphasis by de-emphasis. Referenced twice already.',
    sourceUrl: 'https://example.com/refactoring-ui/hierarchy',
    metadata: { domain: 'example.com' },
  },
  {
    key: 'doc-1', type: 'document' as const,
    title: 'Life OS — one-page brief',
    description: 'What it is, who it is for, and what it deliberately is not.',
  },
  {
    key: 'image-1', type: 'image' as const,
    title: 'Notebook spread — approved reference',
    description: 'The Legacy book, kept as the visual baseline.',
    mimeType: 'image/png', sizeBytes: 486_112,
    metadata: { width: 2048, height: 1330 },
  },
  {
    key: 'video-1', type: 'video' as const,
    title: 'Walkthrough — Today and Projects',
    description: 'Screen recording from the E2 review.',
    mimeType: 'video/mp4', sizeBytes: 41_884_160,
    metadata: { durationSeconds: 372 },
  },
  {
    key: 'file-1', type: 'file' as const,
    title: 'Colour tokens export',
    description: 'The v2 palette, for reference outside the app.',
    mimeType: 'application/json', sizeBytes: 8_412,
  },

  /* ── The rest of the shelf ──────────────────────────────────────────── */

  {
    key: 'doc-2', type: 'document' as const,
    title: 'Weekly review — the four questions',
    description: 'What moved, what stalled, what I am pretending about, what is next.',
  },
  {
    key: 'doc-3', type: 'document' as const,
    title: 'Moving checklist',
    description: 'Meters, keys, redirects, and the box that always gets lost.',
  },
  {
    key: 'doc-4', type: 'document' as const,
    title: 'Interview notes — platform role',
    description: null,
  },
  {
    key: 'doc-5', type: 'document' as const,
    title: 'A Very Long Document Title That Exists To Prove Truncation Behaves',
    description: 'If this wraps to four lines the folio is wrong.',
  },
  {
    key: 'doc-6', type: 'document' as const,
    title: 'Warranty details',
    description: 'Dates and reference numbers, kept where I can find them.',
  },
  {
    key: 'doc-7', type: 'document' as const,
    title: 'Sourdough',
    description: 'Timings that actually worked, after eleven that did not.',
  },

  {
    key: 'image-2', type: 'image' as const,
    title: 'Shelf study — spine spacing',
    description: 'Pencil, then measured.',
    mimeType: 'image/jpeg', sizeBytes: 1_204_880,
    metadata: { width: 1600, height: 1200 },
  },
  {
    key: 'image-3', type: 'image' as const,
    title: 'Panorama — long and thin',
    description: 'An extreme aspect ratio, so the frame has to cope.',
    mimeType: 'image/jpeg', sizeBytes: 2_930_112,
    metadata: { width: 4000, height: 900 },
  },
  {
    /* No dimensions, no thumbnail: §38 asks for a missing thumbnail, and this
     * is what one actually looks like — an image row that knows nothing about
     * how the image is shaped. The frame must not collapse. */
    key: 'image-4', type: 'image' as const,
    title: 'Scan with no preview',
    description: 'Deliberately missing its thumbnail and its dimensions.',
    mimeType: 'image/png', sizeBytes: 331_004,
  },
  {
    /* §38 asks for a BROKEN external preview. `.invalid` is reserved by RFC
     * 2606 and can never resolve, so this tests the failure path without
     * pointing a load at somebody else's server. */
    key: 'image-5', type: 'image' as const,
    title: 'Remote image that will not load',
    description: 'Points at a host that cannot exist. The fallback has to hold.',
    sourceUrl: 'https://never.invalid/photo.jpg',
    mimeType: 'image/jpeg',
    metadata: { width: 1200, height: 800 },
  },

  {
    key: 'video-2', type: 'video' as const,
    title: 'Bench test — scroll performance',
    description: null,
    mimeType: 'video/mp4', sizeBytes: 18_446_848,
    metadata: { durationSeconds: 96 },
  },
  {
    key: 'video-3', type: 'video' as const,
    title: 'Long recording — full design review',
    description: 'Over an hour. The duration badge has to cope with three parts.',
    mimeType: 'video/mp4', sizeBytes: 512_000_000,
    metadata: { durationSeconds: 4_517 },
  },
  {
    key: 'video-4', type: 'video' as const,
    title: 'Clip with no duration recorded',
    description: 'Metadata missing on purpose.',
    mimeType: 'video/quicktime', sizeBytes: 7_340_032,
  },

  {
    key: 'link-2', type: 'link' as const,
    title: 'Container queries — the part I keep forgetting',
    description: 'Sizing against the container, not the window.',
    sourceUrl: 'https://example.com/css/container-queries',
    metadata: { domain: 'example.com' },
  },
  {
    key: 'link-3', type: 'link' as const,
    title: 'Scroll snap without fighting momentum',
    description: 'Proximity, not mandatory.',
    sourceUrl: 'https://example.org/articles/scroll-snap-proximity',
    metadata: { domain: 'example.org' },
  },
  {
    key: 'link-4', type: 'link' as const,
    title: 'A deep link with a very long path indeed',
    description: null,
    sourceUrl: 'https://example.net/2026/03/notes/on/the/design/of/everyday/shelves',
    metadata: { domain: 'example.net' },
  },
  {
    key: 'link-5', type: 'link' as const,
    title: 'Kerning',
    description: 'One word, so the short case is covered too.',
    sourceUrl: 'https://example.com/type/kerning',
    metadata: { domain: 'example.com' },
  },
  {
    /* The distinctive word §38 wants for search: `quokka` appears in exactly
     * one place in the whole sample, so a search for it has exactly one
     * correct answer and a wrong result set is unmissable. */
    key: 'link-6', type: 'link' as const,
    title: 'Quokka — the search needle',
    description: 'This word appears nowhere else in the sample.',
    sourceUrl: 'https://example.org/wildlife/quokka',
    metadata: { domain: 'example.org' },
  },

  {
    key: 'file-2', type: 'file' as const,
    title: 'Lease agreement',
    description: null,
    mimeType: 'application/pdf', sizeBytes: 2_216_960,
  },
  {
    key: 'file-3', type: 'file' as const,
    title: 'Budget workbook',
    description: 'Numbers I revisit every month.',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    sizeBytes: 96_540,
  },
  {
    /* 1.8 GB, not 3: `library_items.size_bytes` is an `integer`, so 2,147,483,647
     * is the largest size the column can hold and a 3 GB sample fails to insert.
     * Recorded in technical-debt.md — no real row can hit it yet because uploads
     * are not built, and widening the column is not L3's business. This value
     * still exercises the gigabyte branch of the formatter, which is the point. */
    key: 'file-4', type: 'file' as const,
    title: 'Backup archive',
    description: 'Large, so the size formatter has to reach gigabytes.',
    mimeType: 'application/zip', sizeBytes: 1_932_735_283,
  },
  {
    key: 'file-5', type: 'file' as const,
    title: 'Font licence',
    description: null,
    mimeType: 'text/plain', sizeBytes: 3_104,
  },
];

export type SampleResult = {
  itemsCreated: number; booksCreated: number;
  sectionsCreated: number; pagesCreated: number; alreadyPresent: number;
};

/**
 * How much shelf to seed (L3 §38).
 *
 * The phase asks the design to be judged at one Book, at three, and at many,
 * and those are three different screens: one Book must not look like a mistake,
 * three must not hug the far left, and many must scroll well. A collection of
 * "many" cannot demonstrate any of the first two, so the seeder takes a size.
 *
 * All three sizes write the SAME `sample:f1:` prefix and are removed by the
 * same cleanup. This is one sample system with a dial on it, not three.
 */
export type SampleSize = 'solo' | 'small' | 'full';

/** Which shelf books each size includes. `full` is everything. */
const SIZE_BOOKS: Record<SampleSize, number> = { solo: 0, small: 2, full: SHELF_BOOKS.length };
/** How many non-Book resources each size includes. */
const SIZE_OTHERS: Record<SampleSize, number> = { solo: 0, small: 3, full: OTHER_ITEMS.length };

export async function seedSampleLibrary(
  db: Db, workspaceId: string, size: SampleSize = 'full',
): Promise<SampleResult> {
  const existing = await db.select({ legacyId: libraryItems.legacyId }).from(libraryItems)
    .where(and(eq(libraryItems.workspaceId, workspaceId),
      like(libraryItems.legacyId, `${SAMPLE_PREFIX}%`)));
  const have = new Set(existing.map((r) => r.legacyId));

  const out: SampleResult = {
    itemsCreated: 0, booksCreated: 0, sectionsCreated: 0, pagesCreated: 0,
    alreadyPresent: have.size,
  };

  // ── The book ──
  const bookLegacyId = `${SAMPLE_PREFIX}book:field-notes`;
  if (!have.has(bookLegacyId)) {
    await db.transaction(async (tx) => {
      const [item] = await tx.insert(libraryItems).values({
        workspaceId, type: 'book', title: BOOK.title,
        description: 'Sample content for reviewing the Book experience.',
        legacyId: bookLegacyId,
      }).returning();
      const [book] = await tx.insert(libraryBooks).values({
        workspaceId, libraryItemId: item!.id,
        subtitle: BOOK.subtitle, authorLabel: BOOK.author,
      }).returning();
      out.itemsCreated++; out.booksCreated++;

      for (const [si, sec] of BOOK.sections.entries()) {
        const [section] = await tx.insert(bookSections).values({
          workspaceId, bookId: book!.id, title: sec.title,
          accent: sec.accent, position: si * GAP,
        }).returning();
        out.sectionsCreated++;

        for (const [pi, page] of sec.pages.entries()) {
          await tx.insert(bookPages).values({
            workspaceId, sectionId: section!.id,
            title: page.title ?? null,
            content: page.content,
            contentText: docToText(page.content),
            position: pi * GAP,
          });
          out.pagesCreated++;
        }
      }
    });
  }

  // ── The rest of the shelf ──
  for (const spec of SHELF_BOOKS.slice(0, SIZE_BOOKS[size])) {
    const legacyId = `${SAMPLE_PREFIX}book:${spec.key}`;
    if (have.has(legacyId)) continue;
    await db.transaction(async (tx) => {
      const [item] = await tx.insert(libraryItems).values({
        workspaceId, type: 'book', title: spec.title,
        description: spec.description ?? null,
        legacyId,
        /* §38 wants an archived item on the shelf. Seeded archived rather than
         * archived afterwards, so the state is reproducible and the archived
         * view is never empty during a review. */
        ...(spec.archived
          ? { status: 'archived', archivedAt: new Date() }
          : {}),
      }).returning();
      const [book] = await tx.insert(libraryBooks).values({
        workspaceId, libraryItemId: item!.id, subtitle: spec.subtitle ?? null,
        authorLabel: BOOK.author,
      }).returning();
      out.itemsCreated++; out.booksCreated++;

      const [section] = await tx.insert(bookSections).values({
        workspaceId, bookId: book!.id, title: 'Notes',
        accent: spec.accent, position: 0,
      }).returning();
      out.sectionsCreated++;

      for (const [pi, page] of shelfBookPages(spec.title).entries()) {
        await tx.insert(bookPages).values({
          workspaceId, sectionId: section!.id,
          title: page.title ?? null,
          content: page.content,
          contentText: docToText(page.content),
          position: pi * GAP,
        });
        out.pagesCreated++;
      }
    });
  }

  // ── The other resource types ──
  for (const spec of OTHER_ITEMS.slice(0, SIZE_OTHERS[size])) {
    const legacyId = `${SAMPLE_PREFIX}${spec.key}`;
    if (have.has(legacyId)) continue;
    await db.insert(libraryItems).values({
      workspaceId, type: spec.type, title: spec.title,
      description: spec.description ?? null,
      sourceUrl: (spec as any).sourceUrl ?? null,
      mimeType: (spec as any).mimeType ?? null,
      sizeBytes: (spec as any).sizeBytes ?? null,
      metadata: (spec as any).metadata ?? null,
      legacyId,
    });
    out.itemsCreated++;
  }

  return out;
}

/** What cleanup would remove. Counts only — run it before deleting anything. */
export async function sampleLibraryFootprint(db: Db, workspaceId: string) {
  const rows = await db.select({ id: libraryItems.id, title: libraryItems.title })
    .from(libraryItems)
    .where(and(eq(libraryItems.workspaceId, workspaceId),
      like(libraryItems.legacyId, `${SAMPLE_PREFIX}%`)));
  return { items: rows.length, titles: rows.map((r) => r.title) };
}

/**
 * Removes ONLY rows carrying the exact sample prefix.
 *
 * Sections and pages are not matched by prefix — they carry none. They go
 * because the item cascades: library_items -> library_books -> book_sections
 * -> book_pages, every FK `ON DELETE CASCADE`. Deleting by prefix at the top
 * and letting the database do the rest is what makes it impossible for this to
 * reach a page the user wrote.
 */
export async function removeSampleLibrary(db: Db, workspaceId: string) {
  const removed = await db.delete(libraryItems)
    .where(and(eq(libraryItems.workspaceId, workspaceId),
      like(libraryItems.legacyId, `${SAMPLE_PREFIX}%`)))
    .returning({ id: libraryItems.id });
  return { removed: removed.length };
}
