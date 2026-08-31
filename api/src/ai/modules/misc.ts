/**
 * Habits, Areas, Diary and Library.
 *
 * Four small modules in one file because each is a handful of capabilities and
 * a rule or two; splitting them would be four files of imports. They are still
 * four independent registrations — removing any one is deleting its `const`
 * and its line in `modules/index.ts`, exactly as it would be for Calendar.
 *
 * Each is read-heavy on purpose. This phase registers a mutation only where an
 * application service already exists to carry it, because a capability without
 * one would have to grow its own rules — which is precisely the split the
 * architecture is designed to prevent. What is missing and why is in
 * docs/ai-system.md §19.
 */
import { and, desc, eq, ilike, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  habits, habitEntries, areas, diaryEntries,
  libraryItems, libraryBooks, bookSections, bookPages,
} from '../../db/schema.js';
import { checkHabit, HabitCheckInput } from '../../lib/actions/habits.js';
import type { AiModule } from '../registry.js';
import type { ContextSource } from '../types.js';

const uuid = z.string().uuid();
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/* ══ Habits ══════════════════════════════════════════════════════════════ */

export const habitsModule: AiModule = {
  id: 'habits',
  name: 'Habits',
  entities: ['habit'],
  rules: [
    'A habit is a recurring intention ticked per DAY. Ticking twice is a counter reaching '
      + 'two, not two records.',
    'Streaks and history counts are derived. Never write them.',
    'Writing a diary entry counts as the system Diary habit. It is computed from the entry, '
      + 'not stored, so it cannot be ticked directly.',
  ],
  available: () => ({ enabled: true }),
  capabilities: [
    {
      id: 'habit.list',
      module: 'habits',
      kind: 'read',
      label: 'List habits',
      description: 'The active habits, with how many times each has been done today.',
      input: z.object({ date: z.string().regex(ISO_DATE).optional() }).strict(),
      risk: 'safe',
      async run(ctx, input: { date?: string }) {
        const ws = ctx.request.workspaceId;
        const day = input.date ?? ctx.request.today;
        const rows = await ctx.db.select().from(habits).where(and(
          eq(habits.workspaceId, ws), isNull(habits.archivedAt), eq(habits.isActive, true),
        ));
        const entries = await ctx.db.select().from(habitEntries).where(and(
          eq(habitEntries.workspaceId, ws), eq(habitEntries.entryDate, day),
        ));
        const byHabit = new Map(entries.map((e) => [e.habitId, e.completedCount]));
        return rows.map<ContextSource>((h) => ({
          ref: { type: 'habit', id: h.id },
          module: 'habits',
          title: h.name,
          summary: `${byHabit.get(h.id) ?? 0}/${h.targetCount} on ${day}`,
          data: {
            targetCount: h.targetCount,
            doneToday: byHabit.get(h.id) ?? 0,
            frequencyType: h.frequencyType,
            areaId: h.areaId,
          },
          via: 'direct',
          level: 2,
        }));
      },
    },
    {
      id: 'habit.check',
      module: 'habits',
      kind: 'mutate',
      label: 'Tick a habit',
      description: 'Record a habit as done for a day. Omit count to add one to whatever is '
        + 'already recorded; send 0 to undo.',
      input: z.object({ id: uuid }).and(HabitCheckInput),
      risk: 'confirm',
      async execute(ctx, input: { id: string; date?: string; count?: number }) {
        const { id, ...rest } = input;
        const r = await checkHabit(ctx.db, ctx.request.workspaceId, id, rest);
        return {
          status: 'done' as const,
          ref: { type: 'habit' as const, id },
          message: r.completedCount > 0
            ? `Marked done for ${r.date}.` : `Cleared for ${r.date}.`,
        };
      },
    },
  ],
};

/* ══ Areas ═══════════════════════════════════════════════════════════════ */

export const areasModule: AiModule = {
  id: 'areas',
  name: 'Areas',
  entities: ['area'],
  rules: [
    'An area is a label on a part of a life, not a container. Tasks, projects, habits and '
      + 'reminders each carry at most one, and deleting an area never deletes work.',
    'Areas are configuration. Creating or removing one is a settings decision, not something '
      + 'to infer from a sentence, so neither is offered.',
  ],
  available: () => ({ enabled: true }),
  capabilities: [
    {
      id: 'area.list',
      module: 'areas',
      kind: 'read',
      label: 'List areas',
      description: 'The areas that exist, so anything filed into one uses a real id.',
      input: z.object({}).strict(),
      risk: 'safe',
      async run(ctx) {
        const rows = await ctx.db.select().from(areas).where(and(
          eq(areas.workspaceId, ctx.request.workspaceId), isNull(areas.deletedAt),
        ));
        return rows.map<ContextSource>((a) => ({
          ref: { type: 'area', id: a.id },
          module: 'areas',
          title: a.name,
          summary: a.isSystem ? 'built in' : null,
          data: { isSystem: a.isSystem },
          via: 'direct',
          level: 2,
        }));
      },
    },
  ],
};

/* ══ Diary ═══════════════════════════════════════════════════════════════ */

export const diaryModule: AiModule = {
  id: 'diary',
  name: 'Diary',
  entities: ['diary'],
  rules: [
    'One entry per date; the date is the key, so there is never a question of which entry.',
    'The diary is what the user wrote. Reading it to answer a question is fine; writing to '
      + 'it on their behalf is not offered, because a diary somebody else wrote in is not a diary.',
  ],
  available: () => ({ enabled: true }),
  capabilities: [
    {
      id: 'diary.read',
      module: 'diary',
      kind: 'read',
      label: 'Read a day',
      description: 'The diary entry for one date, with its check-in fields.',
      input: z.object({ date: z.string().regex(ISO_DATE) }).strict(),
      risk: 'safe',
      async run(ctx, input: { date: string }) {
        const [row] = await ctx.db.select().from(diaryEntries).where(and(
          eq(diaryEntries.workspaceId, ctx.request.workspaceId),
          eq(diaryEntries.entryDate, input.date),
          isNull(diaryEntries.archivedAt),
        )).limit(1);
        if (!row) return [];
        return [{
          ref: { type: 'diary', id: row.id },
          module: 'diary',
          title: row.title || row.entryDate,
          summary: (row.documentText ?? '').slice(0, 240) || null,
          data: {
            entryDate: row.entryDate,
            mood: row.mood,
            energy: row.energy,
            daySummary: row.daySummary,
          },
          via: 'direct',
          level: 1,
        }];
      },
    },
    {
      id: 'diary.search',
      module: 'diary',
      kind: 'search',
      label: 'Search the diary',
      description: 'Find diary days containing words. Returns a short extract, never the '
        + 'whole entry.',
      input: z.object({
        query: z.string().trim().min(2).max(200),
        limit: z.number().int().min(1).max(15).default(8),
      }).strict(),
      risk: 'safe',
      async run(ctx, input: { query: string; limit: number }) {
        const rows = await ctx.db.select().from(diaryEntries).where(and(
          eq(diaryEntries.workspaceId, ctx.request.workspaceId),
          isNull(diaryEntries.archivedAt),
          ilike(diaryEntries.documentText, `%${input.query}%`),
        )).orderBy(desc(diaryEntries.entryDate)).limit(input.limit);
        return rows.map<ContextSource>((row) => ({
          ref: { type: 'diary', id: row.id },
          module: 'diary',
          title: row.title || row.entryDate,
          summary: (row.documentText ?? '').slice(0, 240) || null,
          data: { entryDate: row.entryDate, mood: row.mood },
          via: 'direct',
          level: 2,
        }));
      },
    },
  ],
};

/* ══ Library ═════════════════════════════════════════════════════════════ */

export const libraryModule: AiModule = {
  id: 'library',
  name: 'Library',
  entities: ['library', 'book_page'],
  rules: [
    'A resource exists once and is pointed at from everywhere else. Book to Section to Page '
      + 'is ownership and is structural; it is never an item_link.',
    'A Book is addressed by its library_books id; a library item has its own id. They are '
      + 'different and are not interchangeable.',
    'Writing into a page is not offered yet: page documents are saved through an editor with '
      + 'its own conflict model, and there is no application service for a blind append.',
  ],
  available: () => ({ enabled: true }),
  capabilities: [
    {
      id: 'library.search',
      module: 'library',
      kind: 'search',
      label: 'Search the Library',
      description: 'Find book pages and library items by title or page text.',
      input: z.object({
        query: z.string().trim().min(2).max(200),
        limit: z.number().int().min(1).max(20).default(10),
      }).strict(),
      risk: 'safe',
      async run(ctx, input: { query: string; limit: number }) {
        const ws = ctx.request.workspaceId;
        const like = `%${input.query}%`;
        const items = await ctx.db.select().from(libraryItems).where(and(
          eq(libraryItems.workspaceId, ws), isNull(libraryItems.archivedAt),
          ilike(libraryItems.title, like),
        )).limit(input.limit);
        const pages = await ctx.db.select({
          id: bookPages.id, title: bookPages.title, text: bookPages.contentText,
          bookTitle: libraryItems.title, itemId: libraryItems.id,
        }).from(bookPages)
          .innerJoin(bookSections, eq(bookSections.id, bookPages.sectionId))
          .innerJoin(libraryBooks, eq(libraryBooks.id, bookSections.bookId))
          .innerJoin(libraryItems, eq(libraryItems.id, libraryBooks.libraryItemId))
          .where(and(
            eq(bookPages.workspaceId, ws),
            sql`(${bookPages.title} ilike ${like} or ${bookPages.contentText} ilike ${like})`,
          )).limit(input.limit);

        const out: ContextSource[] = items.map((i) => ({
          ref: { type: 'library', id: i.id },
          module: 'library',
          title: i.title,
          summary: i.type,
          data: { type: i.type, description: i.description },
          via: 'direct',
          level: 2,
        }));
        for (const p of pages) {
          out.push({
            ref: { type: 'book_page', id: p.id },
            module: 'library',
            title: p.title || 'Untitled page',
            summary: (p.text ?? '').slice(0, 240) || p.bookTitle,
            data: { book: p.bookTitle, libraryItemId: p.itemId },
            via: 'direct',
            level: 2,
          });
        }
        return out;
      },
    },
    {
      id: 'library.readPage',
      module: 'library',
      kind: 'read',
      label: 'Read a page',
      description: 'The text of one book page, with the book it belongs to.',
      input: z.object({ id: uuid }).strict(),
      risk: 'safe',
      async run(ctx, input: { id: string }) {
        const [p] = await ctx.db.select({
          id: bookPages.id, title: bookPages.title, text: bookPages.contentText,
          bookTitle: libraryItems.title, itemId: libraryItems.id,
        }).from(bookPages)
          .innerJoin(bookSections, eq(bookSections.id, bookPages.sectionId))
          .innerJoin(libraryBooks, eq(libraryBooks.id, bookSections.bookId))
          .innerJoin(libraryItems, eq(libraryItems.id, libraryBooks.libraryItemId))
          .where(and(eq(bookPages.workspaceId, ctx.request.workspaceId), eq(bookPages.id, input.id)))
          .limit(1);
        if (!p) return [];
        return [{
          ref: { type: 'book_page', id: p.id },
          module: 'library',
          title: p.title || 'Untitled page',
          /* Bounded. A whole book in a prompt is expensive and mostly noise;
             a page's opening is enough to decide whether to read further. */
          summary: (p.text ?? '').slice(0, 2000) || null,
          data: { book: p.bookTitle, libraryItemId: p.itemId },
          via: 'direct',
          level: 1,
        }];
      },
    },
  ],
};
