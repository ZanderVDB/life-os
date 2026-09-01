/**
 * Diary writing.
 *
 * ── One rule above all others ────────────────────────────────────────────
 *
 * NEVER overwrite what the person wrote. A diary is the one place in Life OS
 * where the content IS the value, where there is no version history, and where
 * a wrong write destroys something that cannot be reconstructed. So the
 * assistant may APPEND a paragraph and it may set the structured check-in
 * fields; there is no service here that replaces a document, and adding one
 * would be a mistake however convenient it looked.
 *
 * ── Why appending is still safe ──────────────────────────────────────────
 *
 * A paragraph added to the end is visible, obviously not the user's own voice
 * if it is wrong, and removable with one edit. That is the whole difference
 * between "add to today's diary that the call went well" being a reasonable
 * thing to let an assistant do, and "write my diary" not being one.
 */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { diaryEntries, DIARY_MOODS, DIARY_ENERGIES } from '../../db/schema.js';
import { validateDoc, docToText, paragraph, type Doc } from '../book-doc.js';
import { badRequest } from '../errors.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const DiaryAppendInput = z.object({
  /** The day being written to. The date is the key; there is no ambiguity. */
  date: z.string().regex(ISO_DATE),
  /** Plain text. One paragraph per blank line. */
  text: z.string().trim().min(1).max(4000),
}).strict();

export const DiaryCheckInInput = z.object({
  date: z.string().regex(ISO_DATE),
  mood: z.enum(DIARY_MOODS).nullish(),
  energy: z.enum(DIARY_ENERGIES).nullish(),
  daySummary: z.string().max(2000).nullish(),
}).strict();

const toBlocks = (text: string) => text
  .split(/\n{2,}/).map((s) => s.trim()).filter(Boolean).map(paragraph);

/**
 * Add paragraphs to the end of a day's entry, creating the day if needed.
 *
 * The existing document is read, extended and written back in one statement.
 * Two callers appending at once would have the later one win on the read it
 * did — which is why this is scoped to an assistant action a person just
 * confirmed, and not offered as a general-purpose write.
 */
export async function appendToDiary(
  db: Db, ws: string, input: z.infer<typeof DiaryAppendInput>,
) {
  const [existing] = await db.select().from(diaryEntries).where(and(
    eq(diaryEntries.workspaceId, ws), eq(diaryEntries.entryDate, input.date),
  )).limit(1);

  if (existing?.archivedAt) {
    throw badRequest('That day has an archived entry. Restore it before writing to it.');
  }

  const added = toBlocks(input.text);
  if (!added.length) throw badRequest('There was nothing to add.');

  if (!existing) {
    const doc: Doc = { type: 'doc', content: added };
    const [row] = await db.insert(diaryEntries).values({
      workspaceId: ws,
      entryDate: input.date,
      document: doc,
      documentText: docToText(doc),
      reflection: {},
    }).returning();
    return { entry: row!, created: true };
  }

  const current = validateDoc(existing.document);
  const next: Doc = { type: 'doc', content: [...current.content, ...added] };
  const [row] = await db.update(diaryEntries).set({
    document: next,
    documentText: docToText(next),
    updatedAt: new Date(),
  }).where(eq(diaryEntries.id, existing.id)).returning();
  return { entry: row!, created: false };
}

/**
 * Set the structured check-in fields for a day.
 *
 * Separate from appending because these are FIELDS rather than prose: setting
 * mood does not touch a word of what was written, and writing a sentence does
 * not change how the day felt. Only what was named is set — an omitted field
 * is left alone rather than cleared.
 */
export async function setDiaryCheckIn(
  db: Db, ws: string, input: z.infer<typeof DiaryCheckInInput>,
) {
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.mood !== undefined) patch['mood'] = input.mood ?? null;
  if (input.energy !== undefined) patch['energy'] = input.energy ?? null;
  if (input.daySummary !== undefined) patch['daySummary'] = input.daySummary ?? null;
  if (Object.keys(patch).length === 1) throw badRequest('Nothing to set.');

  const [existing] = await db.select().from(diaryEntries).where(and(
    eq(diaryEntries.workspaceId, ws), eq(diaryEntries.entryDate, input.date),
  )).limit(1);

  if (!existing) {
    const [row] = await db.insert(diaryEntries).values({
      workspaceId: ws,
      entryDate: input.date,
      document: { type: 'doc', content: [] },
      documentText: '',
      reflection: {},
      mood: input.mood ?? null,
      energy: input.energy ?? null,
      daySummary: input.daySummary ?? null,
    }).returning();
    return { entry: row!, created: true };
  }
  if (existing.archivedAt) {
    throw badRequest('That day has an archived entry. Restore it first.');
  }
  const [row] = await db.update(diaryEntries).set(patch)
    .where(eq(diaryEntries.id, existing.id)).returning();
  return { entry: row!, created: false };
}
