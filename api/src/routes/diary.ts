/**
 * Diary API.
 *
 * Diary is the chronological record: one entry per workspace per LOCAL calendar
 * day. It shares the Library editor's document grammar and shares nothing else.
 *
 * Four ideas run through the file.
 *
 * 1. THE CIVIL DATE COMES FROM THE CLIENT. The server never derives one. It
 *    does not reliably know the user's zone, and inventing one from the request
 *    would be worse than trusting the browser that is about to render the
 *    result — the same reasoning as `today/arrange-claim`. The date is
 *    validated as a real day and then only ever compared.
 *
 * 2. READING A DATE NEVER CREATES A ROW. Opening a day you did not write on
 *    must leave no trace, or the calendar fills with days that hold nothing and
 *    stops meaning "here is where I wrote".
 *
 * 3. AN ENTRY IS MEANINGFUL OR IT IS NOT WRITTEN. `isMeaningfulEntry` decides,
 *    in one place, and an empty editor's `<p><br></p>` does not qualify.
 *
 * 4. AN ARCHIVED ENTRY STILL HOLDS ITS DATE. Writing on a date that has one is
 *    refused with a restore offer rather than quietly creating a second row.
 */
import type { AppInstance, Guards } from '../types.js';
import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { diaryEntries, DIARY_MOODS, DIARY_ENERGIES } from '../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { docToText, validateDoc } from '../lib/book-doc.js';
import {
  isMeaningfulEntry, isValidCivilDate, ISO_DATE, addDays, monthBounds,
} from '../lib/diary-entry.js';
import {
  validateReflection, reflectionToText, type Reflection,
} from '../lib/diary-reflection.js';
import {
  seedSampleDiary, removeSampleDiary, sampleDiaryFootprint, isDiarySampleAllowed,
} from '../lib/sample-diary.js';

const civilDate = z.string().regex(ISO_DATE, 'A date must be YYYY-MM-DD')
  .refine(isValidCivilDate, 'That is not a real date.');

const uuid = z.string().uuid();

/** Everything a person can put on a day, beside the document. */
const Fields = z.object({
  title: z.string().max(300).nullish(),
  mood: z.enum(DIARY_MOODS).nullish(),
  energy: z.enum(DIARY_ENERGIES).nullish(),
  weatherNote: z.string().max(300).nullish(),
  locationNote: z.string().max(300).nullish(),
  daySummary: z.string().max(2000).nullish(),
});

export function registerDiaryRoutes(
  app: AppInstance, db: Db, guards: Guards, env: { NODE_ENV: string },
) {
  const pre = { preHandler: [guards.authenticate, guards.resolveWorkspace] };
  const base = '/api/v1/workspaces/:workspaceId';
  const wsId = (req: any) => req.workspaceId as string;

  /** Trims a string to null, so "   " never becomes a stored title. */
  const clean = (v: string | null | undefined) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const t = v.trim();
    return t === '' ? null : t;
  };

  async function entryOn(ws: string, date: string) {
    const [row] = await db.select().from(diaryEntries)
      .where(and(eq(diaryEntries.workspaceId, ws), eq(diaryEntries.entryDate, date)))
      .limit(1);
    return row ?? null;
  }

  /* ── One day ───────────────────────────────────────────────────────── */

  /**
   * The entry for a date, or an honest "nothing here".
   *
   * Returns 200 with `entry: null` rather than 404: the DATE always exists, and
   * a day you have not written on is a normal, expected answer — not a missing
   * resource. A 404 would make every blank day look like an error.
   */
  app.get(`${base}/diary/entries/:date`, pre, async (req) => {
    const ws = wsId(req);
    const { date } = z.object({ date: civilDate }).parse(req.params);
    const row = await entryOn(ws, date);
    return {
      date,
      entry: row && !row.archivedAt ? row : null,
      /* Surfaced separately, so the client can offer to restore instead of
       * writing a second entry it will not be allowed to create. */
      archivedEntry: row?.archivedAt ? row : null,
    };
  });

  /**
   * Writes a date.
   *
   * Creates on first meaningful content and updates thereafter. Nothing is
   * created for an empty payload — the client calls this on the first real
   * keystroke, and an autosave that fires on a blank page must not leave a row.
   */
  app.put(`${base}/diary/entries/:date`, pre, async (req, reply) => {
    const ws = wsId(req);
    const { date } = z.object({ date: civilDate }).parse(req.params);
    const body = z.object({
      document: z.any().optional(),
      reflection: z.any().optional(),
      timezone: z.string().max(64).nullish(),
      /* The version this write is based on. A mismatch is a 409 and the caller
       * re-reads — it never silently overwrites. */
      expectedUpdatedAt: z.string().datetime().optional(),
    }).merge(Fields).strict().parse(req.body ?? {});

    const existing = await entryOn(ws, date);

    if (existing?.archivedAt) {
      throw conflict(
        'That day has an archived entry. Restore it to keep writing on this date.',
      );
    }

    const doc = body.document === undefined ? undefined : validateDoc(body.document);
    const refl = body.reflection === undefined
      ? undefined : validateReflection(body.reflection);
    const fields = {
      title: clean(body.title),
      mood: body.mood ?? undefined,
      energy: body.energy ?? undefined,
      weatherNote: clean(body.weatherNote),
      locationNote: clean(body.locationNote),
      daySummary: clean(body.daySummary),
    };

    if (!existing) {
      /* Nothing here yet. Only a MEANINGFUL payload brings a row into being —
       * this is the guard that stops opening a date from creating one. */
      const meaningful = isMeaningfulEntry(doc ?? null, {
        title: fields.title,
        mood: fields.mood ?? null,
        energy: fields.energy ?? null,
        weatherNote: fields.weatherNote,
        locationNote: fields.locationNote,
        daySummary: fields.daySummary,
        reflection: refl ?? null,
      });
      if (!meaningful) return { date, entry: null, created: false };

      const [row] = await db.insert(diaryEntries).values({
        workspaceId: ws,
        entryDate: date,
        timezone: body.timezone ?? null,
        title: fields.title ?? null,
        document: doc ?? { type: 'doc', content: [] },
        documentText: searchText(doc, refl),
        reflection: refl ?? {},
        mood: fields.mood ?? null,
        energy: fields.energy ?? null,
        weatherNote: fields.weatherNote ?? null,
        locationNote: fields.locationNote ?? null,
        daySummary: fields.daySummary ?? null,
      }).returning();
      reply.code(201);
      return { date, entry: row!, created: true };
    }

    if (body.expectedUpdatedAt
      && new Date(body.expectedUpdatedAt).getTime() !== existing.updatedAt.getTime()) {
      throw conflict(
        'This entry changed somewhere else. Reopen it to see the newer version.',
      );
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (refl !== undefined) patch.reflection = refl;
    /* The search text is rebuilt whenever EITHER half changes, because it is
     * the union of both. Rebuilding it only when the document changed would
     * make an answer typed into "What felt difficult?" invisible to search
     * until the next time the prose happened to be edited. */
    if (doc !== undefined || refl !== undefined) {
      const nextDoc = doc ?? (existing.document as any);
      const nextRefl = refl ?? (existing.reflection as Reflection);
      patch.document = nextDoc;
      patch.documentText = searchText(nextDoc, nextRefl);
    }
    if (body.title !== undefined) patch.title = fields.title;
    if (body.mood !== undefined) patch.mood = body.mood ?? null;
    if (body.energy !== undefined) patch.energy = body.energy ?? null;
    if (body.weatherNote !== undefined) patch.weatherNote = fields.weatherNote;
    if (body.locationNote !== undefined) patch.locationNote = fields.locationNote;
    if (body.daySummary !== undefined) patch.daySummary = fields.daySummary;

    const [row] = await db.update(diaryEntries).set(patch)
      .where(eq(diaryEntries.id, existing.id)).returning();
    return { date, entry: row!, created: false };
  });

  app.post(`${base}/diary/entries/:id/archive`, pre, async (req) => {
    const ws = wsId(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const [row] = await db.update(diaryEntries).set({ archivedAt: new Date() })
      .where(and(eq(diaryEntries.workspaceId, ws), eq(diaryEntries.id, id)))
      .returning();
    if (!row) throw notFound('That entry does not exist.');
    return { entry: row };
  });

  app.post(`${base}/diary/entries/:id/restore`, pre, async (req) => {
    const ws = wsId(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const [row] = await db.update(diaryEntries).set({ archivedAt: null })
      .where(and(eq(diaryEntries.workspaceId, ws), eq(diaryEntries.id, id)))
      .returning();
    if (!row) throw notFound('That entry does not exist.');
    return { entry: row };
  });

  /* ── History ───────────────────────────────────────────────────────── */

  /**
   * Which days in a range have an entry.
   *
   * Deliberately thin: the month grid needs presence and a label, not whole
   * documents. Sending every entry's full text to draw thirty dots would make
   * a calendar as expensive as reading a month of writing.
   */
  app.get(`${base}/diary/days`, pre, async (req) => {
    const ws = wsId(req);
    const q = z.object({
      from: civilDate.optional(),
      to: civilDate.optional(),
      month: civilDate.optional(),
    }).parse(req.query ?? {});

    let { from, to } = q;
    if (q.month) ({ from, to } = monthBounds(q.month));
    if (!from || !to) throw badRequest('A month, or a from and to date, is required.');
    if (from > to) throw badRequest('The range starts after it ends.');

    const rows = await db.select({
      id: diaryEntries.id,
      date: diaryEntries.entryDate,
      title: diaryEntries.title,
      daySummary: diaryEntries.daySummary,
      mood: diaryEntries.mood,
      /* Length, not content: enough to show "a long day" without shipping it. */
      length: sql<number>`length(${diaryEntries.documentText})`,
      updatedAt: diaryEntries.updatedAt,
    }).from(diaryEntries)
      .where(and(
        eq(diaryEntries.workspaceId, ws),
        isNull(diaryEntries.archivedAt),
        gte(diaryEntries.entryDate, from),
        lte(diaryEntries.entryDate, to),
      ))
      .orderBy(asc(diaryEntries.entryDate));

    return { from, to, days: rows };
  });

  /** The most recently written days, for the history panel. */
  app.get(`${base}/diary/recent`, pre, async (req) => {
    const ws = wsId(req);
    const { limit } = z.object({
      limit: z.coerce.number().int().min(1).max(50).default(10),
    }).parse(req.query ?? {});

    const rows = await db.select({
      id: diaryEntries.id,
      date: diaryEntries.entryDate,
      title: diaryEntries.title,
      daySummary: diaryEntries.daySummary,
      mood: diaryEntries.mood,
      excerpt: sql<string>`left(${diaryEntries.documentText}, 220)`,
      updatedAt: diaryEntries.updatedAt,
    }).from(diaryEntries)
      .where(and(eq(diaryEntries.workspaceId, ws), isNull(diaryEntries.archivedAt)))
      .orderBy(desc(diaryEntries.entryDate))
      .limit(limit);

    return { entries: rows };
  });

  /**
   * The nearest day BEFORE or AFTER this one that actually has an entry.
   *
   * This is what makes "previous entry" different from "previous day", and it
   * has to be a query: the client cannot know where the gaps are without
   * fetching every month between here and the answer.
   */
  app.get(`${base}/diary/adjacent`, pre, async (req) => {
    const ws = wsId(req);
    const { date, direction } = z.object({
      date: civilDate,
      direction: z.enum(['prev', 'next']),
    }).parse(req.query ?? {});

    const where = and(
      eq(diaryEntries.workspaceId, ws),
      isNull(diaryEntries.archivedAt),
      direction === 'prev'
        ? lte(diaryEntries.entryDate, addDays(date, -1))
        : gte(diaryEntries.entryDate, addDays(date, 1)),
    );
    const [row] = await db.select({
      date: diaryEntries.entryDate, title: diaryEntries.title,
    }).from(diaryEntries).where(where)
      .orderBy(direction === 'prev'
        ? desc(diaryEntries.entryDate) : asc(diaryEntries.entryDate))
      .limit(1);

    return { date: row?.date ?? null, title: row?.title ?? null };
  });

  /**
   * The current run of consecutive written days, ending today or yesterday.
   *
   * A fact, not a scoreboard. It counts back from today (or from yesterday, so
   * a streak is not "broken" at one minute past midnight before you have had
   * the day) and stops at the first gap. Nothing is stored: a stored streak is
   * a number that can be wrong, and this one is cheap to derive.
   */
  app.get(`${base}/diary/streak`, pre, async (req) => {
    const ws = wsId(req);
    const { today } = z.object({ today: civilDate }).parse(req.query ?? {});

    // 400 days is a year and a bit — enough to answer honestly, bounded enough
    // that the query cannot grow with the diary.
    const rows = await db.select({
      date: diaryEntries.entryDate,
      document: diaryEntries.document,
      title: diaryEntries.title,
      mood: diaryEntries.mood,
      energy: diaryEntries.energy,
      weatherNote: diaryEntries.weatherNote,
      locationNote: diaryEntries.locationNote,
      daySummary: diaryEntries.daySummary,
      reflection: diaryEntries.reflection,
    }).from(diaryEntries)
      .where(and(
        eq(diaryEntries.workspaceId, ws),
        isNull(diaryEntries.archivedAt),
        lte(diaryEntries.entryDate, today),
        gte(diaryEntries.entryDate, addDays(today, -400)),
      ))
      .orderBy(desc(diaryEntries.entryDate));

    /* MEANINGFUL rows, not merely existing ones, and decided by the SAME rule
     * the write path uses. A row survives having its content cleared — that is
     * what makes `restore` possible — so counting rows said somebody had
     * written on a day they had just emptied, and Today's computed habit stayed
     * complete. Re-implementing the rule in SQL would give the question two
     * answers; filtering here gives it one. */
    const have = new Set(rows
      .filter((r) => isMeaningfulEntry(r.document as any, {
        title: r.title, mood: r.mood, energy: r.energy,
        weatherNote: r.weatherNote, locationNote: r.locationNote,
        daySummary: r.daySummary, reflection: r.reflection as any,
      }))
      .map((r) => r.date));
    const wroteToday = have.has(today);
    let cursor = wroteToday ? today : addDays(today, -1);
    let current = 0;
    while (have.has(cursor)) { current += 1; cursor = addDays(cursor, -1); }

    return { current, wroteToday, daysInWindow: rows.length };
  });

  /* ── Search ────────────────────────────────────────────────────────── */

  app.get(`${base}/diary/search`, pre, async (req) => {
    const ws = wsId(req);
    const { q } = z.object({ q: z.string().trim().min(1).max(200) })
      .parse(req.query ?? {});
    const needle = `%${q.toLowerCase()}%`;

    const rows = await db.select({
      id: diaryEntries.id,
      date: diaryEntries.entryDate,
      title: diaryEntries.title,
      daySummary: diaryEntries.daySummary,
      text: diaryEntries.documentText,
      locationNote: diaryEntries.locationNote,
      weatherNote: diaryEntries.weatherNote,
    }).from(diaryEntries)
      .where(and(
        eq(diaryEntries.workspaceId, ws),
        isNull(diaryEntries.archivedAt),
        sql`(lower(${diaryEntries.documentText}) like ${needle}
          or lower(coalesce(${diaryEntries.title}, '')) like ${needle}
          or lower(coalesce(${diaryEntries.daySummary}, '')) like ${needle}
          or lower(coalesce(${diaryEntries.locationNote}, '')) like ${needle}
          or lower(coalesce(${diaryEntries.weatherNote}, '')) like ${needle})`,
      ))
      .orderBy(desc(diaryEntries.entryDate))
      .limit(40);

    return {
      query: q,
      // An excerpt AROUND the match, so a result is readable without opening it.
      results: rows.map((r) => ({ ...r, excerpt: excerpt(r, q) })),
    };
  });

  /* ── Sample data — staging only ────────────────────────────────────── */

  app.get(`${base}/diary/sample`, pre, async (req) => ({
    ...(await sampleDiaryFootprint(db, wsId(req))),
    allowed: isDiarySampleAllowed(env.NODE_ENV),
  }));

  app.post(`${base}/diary/sample`, pre, async (req) => {
    if (!isDiarySampleAllowed(env.NODE_ENV)) {
      throw forbidden('Sample data is not available in production.');
    }
    const { today } = z.object({ today: civilDate }).parse(req.body ?? {});
    return seedSampleDiary(db, wsId(req), today);
  });

  app.post(`${base}/diary/sample/remove`, pre, async (req) => {
    if (!isDiarySampleAllowed(env.NODE_ENV)) {
      throw forbidden('Sample data is not available in production.');
    }
    return removeSampleDiary(db, wsId(req));
  });
}

/**
 * Everything on a day that a search should be able to find.
 *
 * The prose AND the answers. Half of what a person writes in D2 goes into the
 * prompts and the check-in, and a search that could not see it would be lying
 * about having looked.
 */
function searchText(doc: any, refl: Reflection | null | undefined): string {
  return [doc ? docToText(doc) : '', reflectionToText(refl)]
    .filter(Boolean).join(' ').trim();
}

/** A window around the first match, so the result reads without being opened. */
function excerpt(
  row: { text: string; title: string | null; daySummary: string | null }, q: string,
): string {
  const hay = row.text || row.daySummary || row.title || '';
  const at = hay.toLowerCase().indexOf(q.toLowerCase());
  if (at === -1) return hay.slice(0, 160) + (hay.length > 160 ? '…' : '');
  const start = Math.max(0, at - 60);
  const end = Math.min(hay.length, at + q.length + 100);
  return `${start > 0 ? '…' : ''}${hay.slice(start, end)}${end < hay.length ? '…' : ''}`;
}
