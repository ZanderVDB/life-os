/**
 * What makes a diary entry MEANINGFUL.
 *
 * This is the rule the whole of Diary hangs on, so it lives in one place and
 * both the write path and the history path use it.
 *
 * The problem it solves: an editor cannot help producing something. Open a page
 * and a contenteditable already contains `<p><br></p>`; focus it and blur and
 * you may get a stray space. If any of that counted as an entry, simply LOOKING
 * at a date would mark it written-on — and a month grid would fill with days
 * that hold nothing. The calendar would stop meaning "here is where I wrote".
 *
 * So: an entry is meaningful when a person put something in it. Not when the
 * browser did.
 */
import type { Doc } from './book-doc.js';
import { docToText } from './book-doc.js';
import { reflectionHasContent, type Reflection } from './diary-reflection.js';

/** The fields a person can fill in, beside the document itself. */
export type EntryFields = {
  title?: string | null;
  mood?: string | null;
  energy?: string | null;
  weatherNote?: string | null;
  locationNote?: string | null;
  daySummary?: string | null;
  /** The guided prompts and the quick check-in — D2. */
  reflection?: Reflection | null;
};

/** Text with nothing in it but whitespace — including the zero-width kinds. */
const blank = (s: string | null | undefined) =>
  !s || s.replace(/[\s​ ]+/g, '') === '';

/**
 * Does this document contain anything a person wrote?
 *
 * Node COUNT is not the test. `{content:[{type:'paragraph'}]}` is what an empty
 * editor round-trips to, and it has a node. What matters is whether any text
 * survives, or whether a node exists that carries meaning without text — a list
 * with items, or a node type from a newer build that this one cannot read but
 * must not declare empty.
 */
export function documentHasContent(doc: Doc | null | undefined): boolean {
  if (!doc || !Array.isArray(doc.content) || doc.content.length === 0) return false;
  if (!blank(docToText(doc))) return true;
  // Textless but real: an unknown node from a newer client. Refusing to count
  // it would let a future entry be treated as an empty day and hidden from the
  // person's own history.
  return doc.content.some((n) => n && typeof n.type === 'string'
    && !['paragraph', 'heading', 'blockquote'].includes(n.type));
}

/**
 * Is there anything here worth calling an entry?
 *
 * Any ONE of these is enough. Someone who recorded only "mood: low" on a hard
 * day has written an entry, and their calendar should say so.
 */
export function isMeaningfulEntry(
  doc: Doc | null | undefined, fields: EntryFields = {},
): boolean {
  if (documentHasContent(doc)) return true;
  if (!blank(fields.title)) return true;
  if (fields.mood) return true;
  if (fields.energy) return true;
  if (!blank(fields.weatherNote)) return true;
  if (!blank(fields.locationNote)) return true;
  if (!blank(fields.daySummary)) return true;
  /* A day recorded only as "felt: rough, grateful for: the walk" is a day
   * somebody wrote. The check-in is a way of writing, not decoration on top of
   * writing, so it counts on its own. */
  if (reflectionHasContent(fields.reflection)) return true;
  return false;
}

/**
 * A civil date: YYYY-MM-DD, and a real one.
 *
 * `2026-02-30` matches the shape and is not a day. Round-tripping through Date
 * is the cheapest way to reject it without a calendar table.
 */
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidCivilDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m! < 1 || m! > 12 || d! < 1 || d! > 31) return false;
  // Built at NOON UTC so no offset can push it into a neighbouring day — the
  // same guard the habits routes use.
  const probe = new Date(Date.UTC(y!, m! - 1, d!, 12));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m! - 1
    && probe.getUTCDate() === d;
}

/** Civil date arithmetic that never touches a timezone. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const probe = new Date(Date.UTC(y!, m! - 1, d! + days, 12));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${probe.getUTCFullYear()}-${p(probe.getUTCMonth() + 1)}-${p(probe.getUTCDate())}`;
}

/** The first and last civil dates of the month containing `date`. */
export function monthBounds(date: string): { from: string; to: string } {
  const [y, m] = date.split('-').map(Number);
  const p = (n: number) => String(n).padStart(2, '0');
  const last = new Date(Date.UTC(y!, m!, 0, 12)).getUTCDate();
  return { from: `${y}-${p(m!)}-01`, to: `${y}-${p(m!)}-${p(last)}` };
}
