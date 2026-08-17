/**
 * The Books a new account starts with.
 *
 * An empty Library is a correct empty Library and a bad first impression: it
 * asks you to invent a filing system before you have anything to file. These
 * four are the ones that fill up regardless of who you are.
 *
 * ── Why four and not seven ──────────────────────────────────────────────
 *
 * Seven untouched covers on day one reads as the app promising things it has
 * not earned, and an empty Book is worse than no Book — it is a shelf of
 * unanswered invitations. These four are the ones that earn their place
 * immediately; the rest (Reading, Health, This year) are better offered when
 * the Library is already in use than forced at the start.
 *
 * ── What they are NOT ───────────────────────────────────────────────────
 *
 * Not system objects. Each one is an ordinary Book: renameable, archivable,
 * deletable, with nothing marking it as special. A preset you cannot get rid
 * of is clutter with permission.
 *
 * Each opens on a page that says what the Book is for, in the same voice the
 * empty states use — what is missing and what to do, never "Nothing here".
 */
import type { Db } from '../db/client.js';
import { libraryItems, libraryBooks, bookSections, bookPages } from '../db/schema.js';
import { paragraph, docToText, type Doc } from './book-doc.js';

/** Sparse spacing, so one move rewrites one row. Matches library.ts. */
const GAP = 1000;

type Starter = {
  title: string;
  subtitle: string;
  section: string;
  accent: 'peach' | 'sage' | 'lavender' | 'gold' | 'blue' | 'rose';
  purpose?: 'ideas' | 'research' | 'learning' | 'meeting' | 'checklist';
  opening: string;
};

export const STARTER_BOOKS: Starter[] = [
  {
    title: 'Notes',
    subtitle: 'Anything not filed yet',
    section: 'Notes',
    accent: 'peach',
    opening: 'Whatever you have not decided where to put. Things move out of '
      + 'here once they turn out to belong somewhere — that is what this Book '
      + 'is for, not a failure to organise it.',
  },
  {
    title: 'Ideas',
    subtitle: 'Things you might do one day',
    section: 'Ideas',
    accent: 'lavender',
    purpose: 'ideas',
    opening: 'Somewhere to put a thought so it stops taking up room. An idea '
      + 'that turns into work becomes a Project; the rest are allowed to just '
      + 'sit here.',
  },
  {
    title: 'Reference',
    subtitle: 'The things you look up',
    section: 'Reference',
    accent: 'blue',
    opening: 'Policy numbers, sizes, account details, the wifi password — what '
      + 'you look up rather than think about. In practice this becomes the '
      + 'most-opened Book you own.',
  },
  {
    title: 'How I do things',
    subtitle: 'Steps you would otherwise work out twice',
    section: 'How to',
    accent: 'sage',
    opening: 'The procedures you re-derive from scratch every time — filing a '
      + 'return, setting up a machine, the yearly admin. Write it down the '
      + 'second time you have to work it out.',
  },
];

/**
 * Creates the starter Books for a brand-new workspace.
 *
 * Called from bootstrap INSIDE the workspace-creation branch, so it runs
 * exactly once and needs no idempotence guard of its own. It takes the
 * transaction rather than the db: a half-seeded Library on a failed signup is
 * worse than none.
 */
export async function seedStarterBooks(tx: any, workspaceId: string) {
  for (const [i, s] of STARTER_BOOKS.entries()) {
    const [item] = await tx.insert(libraryItems).values({
      workspaceId, type: 'book', title: s.title, status: 'active',
    }).returning();

    const [book] = await tx.insert(libraryBooks).values({
      workspaceId, libraryItemId: item!.id, subtitle: s.subtitle,
      authorLabel: 'Life OS',
    }).returning();

    const [section] = await tx.insert(bookSections).values({
      workspaceId, bookId: book!.id, title: s.section, accent: s.accent, position: 0,
    }).returning();

    /* The first page says what the Book is for; the second is blank, so the
     * opening spread is a page you can read and a page you can write on. */
    const doc: Doc = { type: 'doc', content: [paragraph(s.opening)] };
    await tx.insert(bookPages).values([
      {
        workspaceId, sectionId: section!.id, position: 0,
        layout: 'notes', purpose: s.purpose ?? null,
        content: doc, contentText: docToText(doc),
      },
      { workspaceId, sectionId: section!.id, position: GAP, layout: 'notes' },
    ]);
    void i;
  }
  return STARTER_BOOKS.length;
}
