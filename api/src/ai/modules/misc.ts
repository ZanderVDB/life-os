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
import {
  checkHabit, createHabit, updateHabit, archiveHabit,
  HabitCheckInput, HabitCreateInput, HabitUpdateInput,
} from '../../lib/actions/habits.js';
import {
  createArea, updateArea, deleteArea, AreaCreateInput, AreaUpdateInput,
} from '../../lib/actions/areas.js';
import {
  appendToDiary, setDiaryCheckIn, DiaryAppendInput, DiaryCheckInInput,
} from '../../lib/actions/diary.js';
import {
  appendToPage, createPage, sectionsOfBook, bookForProject,
  PageAppendInput, PageCreateInput,
} from '../../lib/actions/library.js';
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
      /**
       * Habits were the one module with no search at all.
       *
       * `habit.list` answers "what am I tracking", which is not the same
       * question as "which of these is Morning walk". Without this, naming a
       * habit found nothing: retrieval had no way to turn the words into an
       * id, so "complete Morning walk" reached the planner with no habit in
       * context and was answered as though the habit did not exist.
       */
      id: 'habit.search',
      module: 'habits',
      kind: 'search',
      label: 'Find habits',
      description: 'Find habits by words in their name, with how many times each has been '
        + 'done today.',
      input: z.object({
        query: z.string().trim().min(2).max(200),
        limit: z.number().int().min(1).max(20).default(10),
      }).strict(),
      risk: 'safe',
      async run(ctx, input: { query: string; limit: number }) {
        const ws = ctx.request.workspaceId;
        const rows = await ctx.db.select().from(habits).where(and(
          eq(habits.workspaceId, ws), isNull(habits.archivedAt),
          ilike(habits.name, `%${input.query}%`),
        )).limit(input.limit);
        if (!rows.length) return [];
        const entries = await ctx.db.select().from(habitEntries).where(and(
          eq(habitEntries.workspaceId, ws), eq(habitEntries.entryDate, ctx.request.today),
        ));
        const byHabit = new Map(entries.map((e) => [e.habitId, e.completedCount]));
        return rows.map<ContextSource>((h) => ({
          ref: { type: 'habit', id: h.id },
          module: 'habits',
          title: h.name,
          summary: `${byHabit.get(h.id) ?? 0}/${h.targetCount} today`,
          data: {
            targetCount: h.targetCount,
            doneToday: byHabit.get(h.id) ?? 0,
            isActive: h.isActive,
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
      /* `.extend`, not `.and`. An intersection runs BOTH schemas over the whole
         payload, and `HabitCheckInput` is strict — so `{ id }` was rejected as
         an unknown key by the half that did not declare it, and this
         capability refused every payload it was ever given. Extending keeps
         the strictness and adds the field. */
      input: HabitCheckInput.extend({ id: uuid }),
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
    {
      id: 'habit.create',
      module: 'habits',
      kind: 'mutate',
      label: 'Add a habit',
      description: 'Start tracking a recurring intention. targetCount above 1 makes it a '
        + 'counter rather than a checkbox.',
      input: HabitCreateInput,
      risk: 'confirm',
      async execute(ctx, input) {
        const row = await createHabit(ctx.db, ctx.request.workspaceId, input as any);
        return {
          status: 'done' as const,
          ref: { type: 'habit' as const, id: row.id },
          message: `Now tracking "${row.name}".`,
        };
      },
    },
    {
      id: 'habit.update',
      module: 'habits',
      kind: 'mutate',
      label: 'Change a habit',
      description: 'Rename a habit or change how often it is expected. Changing frequency does '
        + 'not alter what has already been recorded.',
      input: z.object({ id: uuid, changes: HabitUpdateInput }).strict(),
      risk: 'confirm',
      async execute(ctx, input: { id: string; changes: any }) {
        const row = await updateHabit(ctx.db, ctx.request.workspaceId, input.id, input.changes);
        return {
          status: 'done' as const,
          ref: { type: 'habit' as const, id: row.id },
          message: `Updated "${row.name}".`,
        };
      },
    },
    {
      id: 'habit.archive',
      module: 'habits',
      kind: 'mutate',
      label: 'Archive a habit',
      description: 'Take a habit off Today, keeping its whole history. There is no delete - a '
        + 'streak that took months is not something to throw away on an ambiguous sentence.',
      input: z.object({ id: uuid }).strict(),
      risk: 'important',
      async execute(ctx, input: { id: string }) {
        const row = await archiveHabit(ctx.db, ctx.request.workspaceId, input.id);
        return {
          status: 'done' as const,
          ref: { type: 'habit' as const, id: row.id },
          message: `Archived "${row.name}". Its history is kept.`,
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
    'Built-in areas cannot be renamed away or removed - they are part of how Life OS files '
      + 'things.',
    'Removing an area never deletes the work inside it. The work loses the label, and can be '
      + 'reassigned to another area instead.',
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
    {
      id: 'area.create',
      module: 'areas',
      kind: 'mutate',
      label: 'Add an area',
      description: 'Create a new area. Check area.list first - a duplicate name is refused.',
      input: AreaCreateInput,
      risk: 'confirm',
      async execute(ctx, input) {
        const row = await createArea(ctx.db, ctx.request.workspaceId, input as any);
        return {
          status: 'done' as const,
          ref: { type: 'area' as const, id: row.id },
          message: `Added the "${row.name}" area.`,
        };
      },
    },
    {
      id: 'area.update',
      module: 'areas',
      kind: 'mutate',
      label: 'Rename an area',
      description: 'Rename a custom area or change its colour.',
      input: z.object({ id: uuid, changes: AreaUpdateInput }).strict(),
      risk: 'confirm',
      async execute(ctx, input: { id: string; changes: any }) {
        const row = await updateArea(ctx.db, ctx.request.workspaceId, input.id, input.changes);
        return {
          status: 'done' as const,
          ref: { type: 'area' as const, id: row.id },
          message: `Renamed to "${row.name}".`,
        };
      },
    },
    {
      id: 'area.delete',
      module: 'areas',
      kind: 'mutate',
      label: 'Remove an area',
      description: 'Remove a custom area. Its tasks are kept and simply lose the label, or are '
        + 'reassigned if reassignToAreaId is given. Built-in areas cannot be removed.',
      input: z.object({ id: uuid, reassignToAreaId: uuid.nullish() }).strict(),
      risk: 'important',
      async execute(ctx, input: { id: string; reassignToAreaId?: string | null }) {
        const r = await deleteArea(
          ctx.db, ctx.request.workspaceId, input.id, input.reassignToAreaId ?? null,
        );
        return {
          status: 'done' as const,
          ref: null,
          message: r.reassignedTasks
            ? `Area removed. ${r.reassignedTasks} task${r.reassignedTasks === 1 ? '' : 's'} kept.`
            : 'Area removed.',
        };
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
    'The diary is what the user wrote. Text is only ever APPENDED - never replace or rewrite '
      + 'what is there, because there is no version history and no way back.',
    'Write in the user\u2019s own words where they gave them. Do not embellish an entry on their '
      + 'behalf; a diary somebody else wrote is not a diary.',
    'mood, energy and the day summary are FIELDS, not prose. Setting them touches nothing that '
      + 'was written.',
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
    {
      id: 'diary.append',
      module: 'diary',
      kind: 'mutate',
      label: 'Add to the diary',
      description: 'Add paragraphs to the end of a day\u2019s entry, creating the day if there is '
        + 'nothing there yet. Never replaces anything already written.',
      input: DiaryAppendInput,
      risk: 'confirm',
      async execute(ctx, input) {
        const r = await appendToDiary(ctx.db, ctx.request.workspaceId, input as any);
        return {
          status: 'done' as const,
          ref: { type: 'diary' as const, id: r.entry.id },
          message: r.created
            ? `Started the diary for ${r.entry.entryDate}.`
            : `Added to ${r.entry.entryDate}.`,
        };
      },
    },
    {
      id: 'diary.checkIn',
      module: 'diary',
      kind: 'mutate',
      label: 'Record how the day was',
      description: 'Set mood, energy or the day summary for a date. Only what is named is set; '
        + 'nothing written is touched.',
      input: DiaryCheckInInput,
      risk: 'confirm',
      async execute(ctx, input) {
        const r = await setDiaryCheckIn(ctx.db, ctx.request.workspaceId, input as any);
        return {
          status: 'done' as const,
          ref: { type: 'diary' as const, id: r.entry.id },
          message: `Recorded for ${r.entry.entryDate}.`,
        };
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
    'Text is APPENDED to a page, never substituted for what is there.',
    'Only flowed layouts (notes, blank, two_columns, quad, comparison) can hold paragraphs. A '
      + 'pinboard holds positioned items and will refuse text - propose a Notes page instead.',
    'A page belongs to a SECTION. Use library.sections to find the right one before creating a '
      + 'page, and library.projectBook to find a project\u2019s own book.',
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
    {
      id: 'library.sections',
      module: 'library',
      kind: 'read',
      label: 'Sections of a book',
      description: 'The sections in one book, so a request naming one ("under Research") can '
        + 'be resolved to an id before a page is proposed.',
      input: z.object({ bookId: uuid }).strict(),
      risk: 'safe',
      async run(ctx, input: { bookId: string }) {
        const rows = await sectionsOfBook(ctx.db, ctx.request.workspaceId, input.bookId);
        return rows.map<ContextSource>((r) => ({
          ref: { type: 'library', id: r.id },
          module: 'library',
          title: r.title,
          summary: 'section',
          data: { sectionId: r.id, bookId: r.bookId },
          via: 'direct',
          level: 2,
        }));
      },
    },
    {
      id: 'library.projectBook',
      module: 'library',
      kind: 'read',
      label: 'A project\u2019s book',
      description: 'The Book belonging to a project, with its sections. This is what "the '
        + 'project book" means.',
      input: z.object({ projectId: uuid }).strict(),
      risk: 'safe',
      async run(ctx, input: { projectId: string }) {
        const ws = ctx.request.workspaceId;
        const book = await bookForProject(ctx.db, ws, input.projectId);
        if (!book) return [];
        const sections = await sectionsOfBook(ctx.db, ws, book.bookId);
        const out: ContextSource[] = [{
          ref: { type: 'library', id: book.itemId },
          module: 'library',
          title: book.title,
          summary: 'the project book',
          data: { bookId: book.bookId, libraryItemId: book.itemId },
          via: 'relationship',
          path: [{
            from: { type: 'project', id: input.projectId },
            kind: 'structural',
            label: 'Book of',
          }],
          level: 2,
        }];
        for (const sct of sections) {
          out.push({
            ref: { type: 'library', id: sct.id },
            module: 'library',
            title: sct.title,
            summary: `section of ${book.title}`,
            data: { sectionId: sct.id, bookId: book.bookId },
            via: 'direct',
            level: 2,
          });
        }
        return out;
      },
    },
    {
      id: 'library.appendPage',
      module: 'library',
      kind: 'mutate',
      label: 'Write to a page',
      description: 'Add paragraphs to the end of an existing page. Refuses a layout that '
        + 'cannot hold paragraphs rather than dropping the text.',
      input: PageAppendInput,
      risk: 'confirm',
      async execute(ctx, input) {
        const row = await appendToPage(
          ctx.db, ctx.request.workspaceId, { userId: ctx.request.userId }, input as any,
        );
        return {
          status: 'done' as const,
          ref: { type: 'book_page' as const, id: row.id },
          message: `Added to "${row.title || 'the page'}".`,
        };
      },
    },
    {
      id: 'library.createPage',
      module: 'library',
      kind: 'mutate',
      label: 'Add a page',
      description: 'Add a page to a section, optionally with its first paragraphs. Needs a '
        + 'sectionId - find one with library.sections or library.projectBook.',
      input: PageCreateInput,
      risk: 'confirm',
      async execute(ctx, input) {
        const row = await createPage(
          ctx.db, ctx.request.workspaceId, { userId: ctx.request.userId }, input as any,
        );
        return {
          status: 'done' as const,
          ref: { type: 'book_page' as const, id: row.id },
          message: `Added the page "${row.title || 'Untitled'}".`,
        };
      },
    },
  ],
};
