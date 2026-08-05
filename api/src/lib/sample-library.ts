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

/** The non-book sample resources, one of each remaining type. */
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
];

export type SampleResult = {
  itemsCreated: number; booksCreated: number;
  sectionsCreated: number; pagesCreated: number; alreadyPresent: number;
};

export async function seedSampleLibrary(db: Db, workspaceId: string): Promise<SampleResult> {
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

  // ── The other resource types ──
  for (const spec of OTHER_ITEMS) {
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
