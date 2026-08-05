/**
 * Diary sample data — STAGING ONLY.
 *
 * Enough days to review history, search, archive and a long entry, and not one
 * word of anything real. No private information, no copyrighted text: every
 * entry below is invented for this purpose.
 *
 * ── How cleanup stays safe ───────────────────────────────────────────────
 *
 * Every sample entry's `timezone` begins with the exact prefix `sample:d1:`,
 * and removal deletes ONLY rows carrying it. Not a LIKE on the title, not a
 * date range, not "everything written today" — a real entry that happens to be
 * called "A quiet Sunday" on the same day as a sample one is untouched.
 *
 * The marker lives on `timezone` rather than on `daySummary` because
 * `daySummary` is DISPLAYED — in the history list, in search results and in
 * previews. A marker there showed up on screen as "sample:d1: An ordinary
 * Tuesday", which is a debugging artefact leaking into the product. `timezone`
 * is metadata about the write, never rendered and never typed by a person, and
 * a value beginning `sample:d1:` is unmistakably not a zone.
 *
 * The dates are relative to a civil date the CLIENT supplies. The server does
 * not know the user's day, and sample data that lands on the wrong day is
 * sample data that cannot demonstrate "today".
 */
import { and, eq, like } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { diaryEntries } from '../db/schema.js';
import { docToText, type Doc } from './book-doc.js';
import { addDays } from './diary-entry.js';

/** The exact marker. Cleanup matches this and nothing else. */
export const SAMPLE_PREFIX = 'sample:d1:';

/** Never in production. The route checks this before doing anything. */
export const isDiarySampleAllowed = (nodeEnv: string) => nodeEnv !== 'production';

const p = (text: string) =>
  ({ type: 'paragraph', content: [{ type: 'text', text }] });
const h = (text: string, level = 2) =>
  ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
const quote = (text: string) =>
  ({ type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const bullets = (items: string[]) => ({
  type: 'bulletList',
  content: items.map((t) => ({
    type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
  })),
});
const linked = (before: string, label: string, href: string) => ({
  type: 'paragraph',
  content: [
    { type: 'text', text: before },
    { type: 'text', text: label, marks: [{ type: 'link', attrs: { href } }] },
  ],
});

const doc = (content: unknown[]): Doc => ({ type: 'doc', content } as Doc);

/**
 * The set, described by what each one is FOR.
 *
 * `offset` is days back from the client's today.
 */
function sampleSet(today: string) {
  const monthAgo = (() => {
    const [y, m, d] = today.split('-').map(Number);
    const pad = (n: number) => String(n).padStart(2, '0');
    const prevMonth = m! === 1 ? 12 : m! - 1;
    const year = m! === 1 ? y! - 1 : y!;
    // The 12th of last month — a day that exists in every month.
    return `${year}-${pad(prevMonth)}-12`;
  })();

  return [
    {
      // Today: a rich entry, so the default screen has something to read.
      date: today,
      title: null,
      summary: 'Rebuilt the shelf, then walked until the noise stopped.',
      mood: 'good', energy: 'medium',
      weatherNote: 'Clear, cold wind after four', locationNote: 'Home, then the long route',
      document: doc([
        p('Started the morning by clearing the desk, which is the only reliable way I know of clearing my head. Two hours of real work before anyone needed anything.'),
        h('What actually moved'),
        bullets([
          'The shelf finally reads like a shelf rather than a list.',
          'Wrote down the argument for keeping one thing in one place, so I stop relitigating it.',
          'Left the hardest decision until tomorrow on purpose.',
        ]),
        p('The afternoon went sideways, as afternoons do. I am learning not to treat that as a failure of planning.'),
        quote('Nothing was urgent. Everything felt urgent. Those are different problems and they need different answers.'),
        p('Walked the long route home. The wind picked up around four and I stayed out in it anyway.'),
      ]),
    },
    {
      // Yesterday: a titled entry with full context, for the history preview.
      date: addDays(today, -1),
      title: 'A difficult conversation',
      summary: 'Said the thing I had been avoiding for three weeks.',
      mood: 'low', energy: 'low',
      weatherNote: 'Grey all day', locationNote: 'The office, then the car for a while',
      document: doc([
        p('I had been rehearsing it for three weeks and in the end it took four minutes. That is usually how it goes.'),
        p('It went better than the version in my head, which was never going to be a high bar. Nobody shouted. Nobody was pleased either.'),
        quote('The waiting was the expensive part. The conversation was almost cheap by comparison.'),
        p('Sat in the car afterwards for twenty minutes before driving anywhere. Not upset exactly. Just needed the engine off.'),
      ]),
    },
    {
      // Earlier this month: an ordinary short day, so the month grid has gaps
      // AND clusters rather than one solid block.
      date: addDays(today, -9),
      title: null,
      summary: 'An ordinary Tuesday, recorded mostly so it exists.',
      mood: 'neutral', energy: 'medium',
      weatherNote: null, locationNote: 'Home',
      document: doc([
        p('Not much to report. Worked, ate, read forty pages, slept badly.'),
        p('Writing it down anyway, because the months I stopped writing are the months I cannot remember at all.'),
      ]),
    },
    {
      // Last month: proves the month navigator moves between months.
      date: monthAgo,
      title: 'First day in the new office',
      summary: 'New desk, wrong chair, unexpectedly good light.',
      mood: 'good', energy: 'high',
      weatherNote: 'Bright, almost too warm', locationNote: 'The new office',
      document: doc([
        p('The light is the thing nobody mentions when they describe a workplace, and it turns out to be the thing I notice most.'),
        h('First impressions', 3),
        bullets([
          'The chair is wrong and I will be fixing that within the week.',
          'The kettle is good. This matters more than it should.',
          'Everyone was kind in the slightly effortful way of a first day.',
        ]),
        p('Came home more tired than the work explains. New places cost something even when they go well.'),
      ]),
    },
    {
      // A long one: for scroll behaviour, and for a search hit deep in the text.
      date: addDays(today, -16),
      title: 'The long version',
      summary: 'A longer entry, written in one sitting without stopping to edit.',
      mood: 'very_good', energy: 'high',
      weatherNote: 'Rain, then not', locationNote: 'The kitchen table',
      document: doc([
        h('Morning'),
        p('Woke before the alarm for the first time in months and lay there deciding whether that was a gift or a warning. Got up. Made coffee properly instead of quickly.'),
        p('There is a particular quality to a morning nobody else is awake for. It is not productivity. It is closer to privacy.'),
        h('The middle of the day'),
        p('Worked through the thing I had been circling since last week. The trick, as usual, was to stop trying to design it and start writing the smallest version that could possibly be wrong.'),
        bullets([
          'Wrote the smallest version.',
          'It was wrong in an interesting way.',
          'The interesting way was the actual answer.',
        ]),
        p('I keep relearning this and I keep writing it down, which suggests the learning is not sticking as well as I would like.'),
        quote('Every problem I have solved twice, I solved the second time by admitting I had not understood it the first time.'),
        h('Evening'),
        p('Rain came in around six and stopped almost immediately, which felt like being interrupted by someone who then changed their mind.'),
        p('Read at the kitchen table until the light went. Did not turn a lamp on, which meant stopping earlier than I wanted, which was probably correct.'),
        p('A good day. Recording it partly so that on a worse one I have evidence they exist.'),
      ]),
    },
    {
      // Every block type at once, including a link, for the editor round trip.
      date: addDays(today, -4),
      title: 'Everything, all at once',
      summary: 'A deliberately mixed entry: heading, list, quote and a link.',
      mood: 'neutral', energy: 'medium',
      weatherNote: null, locationNote: null,
      document: doc([
        p('A body paragraph, first, so the page starts the way most pages do.'),
        h('A heading'),
        p('Body again, directly beneath it.'),
        h('A subheading', 3),
        bullets(['One thing.', 'Another thing that runs on a little longer so it wraps.']),
        quote('A quotation, kept because the shape of it was useful.'),
        linked('And a link, for the round trip: ', 'the documentation', 'https://example.com/docs'),
        p('A final paragraph.'),
      ]),
    },
    {
      // Archived: proves history and search exclude it, and that its date is
      // still held so writing there offers a restore.
      date: addDays(today, -23),
      title: 'A day I put away',
      summary: 'Archived on purpose, to show archive and restore.',
      mood: 'low', energy: 'low',
      weatherNote: null, locationNote: null,
      archived: true,
      document: doc([
        p('This entry is archived. It should not appear in normal history or in search results, and its date should still be held — writing on that day offers to restore this rather than starting a second entry on top of it.'),
      ]),
    },
  ];
}

export type SampleDiaryResult = {
  entriesCreated: number;
  archivedCreated: number;
  alreadyPresent: number;
  dates: string[];
};

/**
 * Seeds the set, skipping any date that already holds an entry.
 *
 * Skipping rather than overwriting, deliberately: on a staging workspace with
 * real writing in it, seeding must never replace a day somebody actually wrote.
 */
export async function seedSampleDiary(
  db: Db, workspaceId: string, today: string,
): Promise<SampleDiaryResult> {
  const set = sampleSet(today);
  const existing = await db.select({ date: diaryEntries.entryDate })
    .from(diaryEntries).where(eq(diaryEntries.workspaceId, workspaceId));
  const taken = new Set(existing.map((r) => r.date));

  const rows = set.filter((s) => !taken.has(s.date)).map((s) => ({
    workspaceId,
    entryDate: s.date,
    title: s.title,
    document: s.document as any,
    documentText: docToText(s.document),
    mood: s.mood,
    energy: s.energy,
    weatherNote: s.weatherNote,
    locationNote: s.locationNote,
    daySummary: s.summary,
    // THE MARKER. Cleanup matches this exact prefix and nothing else. On
    // `timezone` because it is never shown to anyone — see the note above.
    timezone: `${SAMPLE_PREFIX}Africa/Johannesburg`,
    archivedAt: s.archived ? new Date() : null,
  }));

  if (rows.length) await db.insert(diaryEntries).values(rows);

  return {
    entriesCreated: rows.filter((r) => !r.archivedAt).length,
    archivedCreated: rows.filter((r) => r.archivedAt).length,
    alreadyPresent: set.length - rows.length,
    dates: rows.map((r) => r.entryDate),
  };
}

export async function sampleDiaryFootprint(db: Db, workspaceId: string) {
  const rows = await db.select({
    date: diaryEntries.entryDate, title: diaryEntries.title,
    archivedAt: diaryEntries.archivedAt,
  }).from(diaryEntries).where(and(
    eq(diaryEntries.workspaceId, workspaceId),
    like(diaryEntries.timezone, `${SAMPLE_PREFIX}%`),
  ));
  return {
    entries: rows.length,
    dates: rows.map((r) => r.date),
    archived: rows.filter((r) => r.archivedAt).length,
  };
}

/**
 * Removes exactly what was seeded.
 *
 * `like 'sample:d1:%'` on `timezone` — a field nobody types into and nothing
 * displays. Not the title, which somebody might genuinely reuse; not the day
 * summary, which is shown on screen; not a date range, which would take real
 * days with it.
 */
export async function removeSampleDiary(db: Db, workspaceId: string) {
  const deleted = await db.delete(diaryEntries).where(and(
    eq(diaryEntries.workspaceId, workspaceId),
    like(diaryEntries.timezone, `${SAMPLE_PREFIX}%`),
  )).returning({ date: diaryEntries.entryDate });
  return { removed: deleted.length, dates: deleted.map((d) => d.date) };
}
