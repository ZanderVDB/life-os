/**
 * The relationship layer.
 *
 * ── Two kinds of relationship, and they are not interchangeable ──────────
 *
 * STRUCTURAL relationships are foreign keys, and they stay foreign keys. A
 * task belongs to a project; a page belongs to a section; a habit entry
 * belongs to a habit. One side owns the truth, the database enforces it, and
 * deleting the owner has defined consequences. Nothing here replaces any of
 * that, and a generic edge must never be used to express one — two competing
 * answers to "which project is this task in" is worse than either answer.
 *
 * SEMANTIC relationships are what this file is for: an edge between two
 * otherwise independent objects, where neither owns the other and removing
 * the edge removes nothing but the edge. "This page is a resource for that
 * task." "This meeting was discussed in that diary entry."
 *
 * ── Why one table ───────────────────────────────────────────────────────
 *
 * `item_links` is polymorphic on both ends. The alternative — TaskLinks,
 * EventLinks, ProjectLinks — is n² tables, n² queries, and n² places to
 * forget to clean up on delete. There is one edge table, and this module is
 * the only thing that should write to it.
 *
 * ── Direction, and why backlinks are not a second row ────────────────────
 *
 * An edge is stored once, A → B. Asking "what does A link to" and "what links
 * to A" are two queries against two indexes, not two rows. Storing the
 * reverse as well would mean every unlink had to find and delete both, and
 * the first time one was missed the graph would disagree with itself.
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  itemLinks, tasks, projects, areas, habits, reminders, calendarEvents,
  libraryItems, libraryBooks, bookSections, bookPages,
  diaryEntries,
} from '../db/schema.js';
import { badRequest, notFound } from './errors.js';

/* ── What can take part ──────────────────────────────────────────────────
 *
 * Every ACTIVE entity a person can open and would reasonably want to connect
 * to something else. `brain` and `board` were named in the original comment
 * on this table as future targets; neither system was built, no row has ever
 * carried either value, and they are not listed here. If they arrive, they
 * are added here and nowhere else.
 *
 * ── Why `block` is NOT here ──────────────────────────────────────────────
 *
 * A task schedule block is time set aside FOR a task. It has no title of its
 * own, no detail surface, and nothing to open: on the Plan canvas it is a
 * rectangle you drag and resize showing its task's name. There is nowhere a
 * person could go to discover a relationship attached to one, so a link to a
 * block would exist and never be seen from the block's end.
 *
 * The rule this obeys: an entity that can take part in a relationship must be
 * inspectable from its own side. A block is not, so it is not linkable.
 * Nothing is lost — the thing a person means when they point at a block is
 * the TASK, which is linkable and is where the block's identity already comes
 * from. The row stays a first-class domain object with its own table and its
 * own FK to that task; it is simply not a semantic endpoint.
 *
 * `scheduled_as` is unaffected: it couples a task to an EVENT, never a block. */
export const ENTITY_TYPES = [
  'task',
  'project',
  'area',
  'habit',
  'reminder',
  'event',        // a calendar event, usually Google's
  'library',      // any library item — book, document, image, link, file
  'book_page',    // a single page inside a Book
  'diary',        // one day's diary entry
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export const isEntityType = (v: unknown): v is EntityType =>
  typeof v === 'string' && (ENTITY_TYPES as readonly string[]).includes(v);

/* ── What a relationship can MEAN ────────────────────────────────────────
 *
 * Small on purpose. A large ontology is a large vocabulary nobody learns, and
 * the failure mode is ten synonyms for "related" chosen at random by whatever
 * created the edge. Each kind earns its place by being a thing a person would
 * actually say about two objects in this application.
 *
 * `label` reads from the SOURCE looking at the target. `inverse` reads from
 * the target looking back. Both are needed because "preparation for" and
 * "prepared by" are the same edge seen from two ends, and a backlink list
 * that says "preparation for" on the wrong side is simply wrong.
 *
 * `coupled` is the important flag and it is explained in full below. */
export const LINK_KINDS = {
  related: { label: 'Related to', inverse: 'Related to' },
  context: { label: 'Context', inverse: 'Referenced by' },
  resource: { label: 'Resource', inverse: 'Used by' },
  preparation: { label: 'Preparation for', inverse: 'Prepared by' },
  discussed_in: { label: 'Discussed in', inverse: 'Discusses' },
  result: { label: 'Resulted in', inverse: 'Result of' },
  deadline: { label: 'Deadline for', inverse: 'Deadline' },
  follow_up: { label: 'Follow-up', inverse: 'Follows from' },
  supports: { label: 'Supports', inverse: 'Supported by' },
  /* The one COUPLED kind. See `isCoupled`. */
  scheduled_as: { label: 'Scheduled as', inverse: 'Schedules', coupled: true },
} as const;

export type LinkKind = keyof typeof LINK_KINDS;

export const LINK_KIND_IDS = Object.keys(LINK_KINDS) as LinkKind[];

export const isLinkKind = (v: unknown): v is LinkKind =>
  typeof v === 'string' && Object.hasOwn(LINK_KINDS, v);

/**
 * Whether an edge means "these are related" or "these are the same work".
 *
 * EVERY kind except one is informational. A task linked to a page as a
 * resource does not rename the page when the task is renamed, does not move
 * it, and does not delete it. The edge carries meaning for a reader; it
 * carries no behaviour at all.
 *
 * `scheduled_as` is different, and it is the only one. A task and the event
 * that holds its hour are two records describing one piece of work, so the
 * TIME is kept in step between them — that synchronisation already existed
 * before this module and lives in `calendar-mutations.ts`, which is where it
 * belongs, because it has to run inside the Google write path.
 *
 * Even there, only the time syncs. Titles do not. See docs/relationships.md.
 *
 * Kinds are the right home for this because behaviour is a property of what
 * the relationship MEANS, not of the particular pair of rows — and putting a
 * `coupled` boolean on each row would let two edges of the same kind behave
 * differently, which is a bug waiting to be filed.
 */
export const isCoupled = (kind: string) =>
  Boolean((LINK_KINDS as Record<string, { coupled?: boolean }>)[kind]?.coupled);

/* ── Existence ───────────────────────────────────────────────────────────
 *
 * A link to a row that is not there is worse than no link: it renders as a
 * dead chip the user cannot remove without knowing what it pointed at. Both
 * ends are checked before an edge is written, in the caller's workspace. */

type Ref = { type: string; id: string };

const TABLE: Record<EntityType, { table: any; id: any; ws: any }> = {
  task: { table: tasks, id: tasks.id, ws: tasks.workspaceId },
  project: { table: projects, id: projects.id, ws: projects.workspaceId },
  area: { table: areas, id: areas.id, ws: areas.workspaceId },
  habit: { table: habits, id: habits.id, ws: habits.workspaceId },
  reminder: { table: reminders, id: reminders.id, ws: reminders.workspaceId },
  event: { table: calendarEvents, id: calendarEvents.id, ws: calendarEvents.workspaceId },
  library: { table: libraryItems, id: libraryItems.id, ws: libraryItems.workspaceId },
  book_page: { table: bookPages, id: bookPages.id, ws: bookPages.workspaceId },
  diary: { table: diaryEntries, id: diaryEntries.id, ws: diaryEntries.workspaceId },
};

export async function entityExists(db: Db, ws: string, type: EntityType, id: string) {
  const t = TABLE[type];
  const [row] = await db.select({ id: t.id }).from(t.table)
    .where(and(eq(t.ws, ws), eq(t.id, id))).limit(1);
  return Boolean(row);
}

/* ── Summaries ───────────────────────────────────────────────────────────
 *
 * What a link needs in order to be RENDERED and FOLLOWED: a title, a line of
 * context, and wherever the app can open it. Read fresh from the canonical
 * row every time — never copied into the edge, because a copied title is a
 * title that goes stale the first time somebody renames something. */

export type Summary = {
  type: EntityType;
  id: string;
  title: string;
  subtitle?: string | null;
  /**
   * The instant, when the thing has one, as an ISO string.
   *
   * The server formats `subtitle` in UTC because it cannot know where the
   * reader is; the browser can, and re-formats from this. Without it a
   * Related row shows a different hour from the Calendar showing the same
   * event, which is the same class of bug as a stale cached title.
   */
  at?: string | null;
  /**
   * The DAY this is on, as a civil date, when it has one.
   *
   * Not the same as `at`, and needed because most things that have a day do
   * not have an instant: a reminder is due on a date, a diary entry belongs to
   * one, a task is due by one. `subtitle` renders that as "8 Sep 2026", which
   * is right for a person and useless to anything that has to know which
   * weekday it is — the assistant read those labels and invented weekdays for
   * them. This is the machine-readable half of the same fact.
   */
  on?: string | null;
  /** Where the app should navigate. Null when the type has no deep link yet. */
  href?: string | null;
  /** Anything the client needs to open it that is not in the href. */
  open?: Record<string, unknown>;
};

const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));

/** What the Library calls each type on screen. `book` reads oddly lowercase. */
const LIBRARY_LABEL: Record<string, string> = {
  book: 'Book', document: 'Document', image: 'Image',
  video: 'Video', link: 'Link', file: 'File',
};

/**
 * A date a person can read, from the server.
 *
 * Formatted here rather than in the client because every surface that renders
 * a link would otherwise need its own copy, and the first one to forget shows
 * an ISO string in the middle of a sentence. Deliberately coarse — a link's
 * subtitle says WHICH one, not when exactly; the object itself has the time.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function whenLabel(at: Date | null | undefined, date?: string | null) {
  if (date) {
    const [y, m, d] = date.split('-').map(Number);
    return m ? `${d} ${MONTHS[m - 1]} ${y}` : date;
  }
  if (!at) return null;
  const hh = String(at.getUTCHours()).padStart(2, '0');
  const mm = String(at.getUTCMinutes()).padStart(2, '0');
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} · ${hh}:${mm}`;
}

/** Resolves many references of mixed type in one pass, batched per type. */
export async function summarise(db: Db, ws: string, refs: Ref[]): Promise<Map<string, Summary>> {
  const out = new Map<string, Summary>();
  const wanted = new Map<string, Set<string>>();
  for (const r of refs) {
    if (!isEntityType(r.type)) continue;
    if (!wanted.has(r.type)) wanted.set(r.type, new Set());
    wanted.get(r.type)!.add(r.id);
  }
  const ids = (t: string) => [...(wanted.get(t) ?? [])];
  const put = (s: Summary) => out.set(`${s.type}:${s.id}`, s);

  if (ids('task').length) {
    const rows = await db.select({
      id: tasks.id, title: tasks.title, status: tasks.status, dueDate: tasks.dueDate, bucket: tasks.bucket,
      projectId: tasks.projectId,
    }).from(tasks).where(and(eq(tasks.workspaceId, ws), inArray(tasks.id, ids('task'))));
    const pj = byId(await db.select({ id: projects.id, title: projects.title }).from(projects)
      .where(and(eq(projects.workspaceId, ws),
        inArray(projects.id, rows.map((r) => r.projectId).filter(Boolean) as string[]))));
    for (const r of rows) {
      put({
        type: 'task', id: r.id, title: r.title,
        subtitle: r.projectId ? (pj.get(r.projectId)?.title ?? null) : null,
        on: r.dueDate ?? null,
        href: null, open: { kind: 'task', id: r.id, done: r.status === 'done' },
      });
    }
  }

  if (ids('project').length) {
    for (const r of await db.select({ id: projects.id, title: projects.title, status: projects.status })
      .from(projects).where(and(eq(projects.workspaceId, ws), inArray(projects.id, ids('project'))))) {
      put({ type: 'project', id: r.id, title: r.title, subtitle: r.status, href: `#projects/${r.id}` });
    }
  }

  if (ids('area').length) {
    for (const r of await db.select({ id: areas.id, name: areas.name })
      .from(areas).where(and(eq(areas.workspaceId, ws), inArray(areas.id, ids('area'))))) {
      /* An Area has no page of its own — it is a label, and a page for it
         would be a second Today. Its inspector is a modal, so the client is
         told how to open one rather than where to navigate. */
      put({ type: 'area', id: r.id, title: r.name, href: null, open: { kind: 'area', id: r.id } });
    }
  }

  if (ids('habit').length) {
    for (const r of await db.select({ id: habits.id, name: habits.name })
      .from(habits).where(and(eq(habits.workspaceId, ws), inArray(habits.id, ids('habit'))))) {
      put({ type: 'habit', id: r.id, title: r.name, href: null, open: { kind: 'habit', id: r.id } });
    }
  }

  if (ids('reminder').length) {
    for (const r of await db.select({ id: reminders.id, title: reminders.title, dueDate: reminders.dueDate })
      .from(reminders).where(and(eq(reminders.workspaceId, ws), inArray(reminders.id, ids('reminder'))))) {
      put({
        type: 'reminder', id: r.id, title: r.title, subtitle: whenLabel(null, r.dueDate),
        on: r.dueDate ?? null,
        href: '#calendar/reminders', open: { kind: 'reminder', id: r.id },
      });
    }
  }

  if (ids('event').length) {
    for (const r of await db.select({
      id: calendarEvents.id, title: calendarEvents.title,
      startsAt: calendarEvents.startsAt, startDate: calendarEvents.startDate,
    }).from(calendarEvents)
      .where(and(eq(calendarEvents.workspaceId, ws), inArray(calendarEvents.id, ids('event'))))) {
      put({
        type: 'event', id: r.id, title: r.title ?? 'Untitled event',
        subtitle: whenLabel(r.startsAt, r.startDate),
        at: r.startsAt ? r.startsAt.toISOString() : null,
        on: r.startDate ?? (r.startsAt ? r.startsAt.toISOString().slice(0, 10) : null),
        href: '#calendar', open: { kind: 'event', id: r.id },
      });
    }
  }

  if (ids('library').length) {
    /* A Book is addressed by its `library_books` id, NOT by the library item's
       — `#library/book/<libraryItemId>` resolves to nothing. Everything else
       has its own item page. Neither route is the shelf: landing a person on
       the shelf and letting them find it is not following a link. */
    const rows = await db.select({
      id: libraryItems.id, title: libraryItems.title, type: libraryItems.type,
      bookId: libraryBooks.id,
    }).from(libraryItems)
      .leftJoin(libraryBooks, eq(libraryBooks.libraryItemId, libraryItems.id))
      .where(and(eq(libraryItems.workspaceId, ws), inArray(libraryItems.id, ids('library'))));
    for (const r of rows) {
      put({
        type: 'library', id: r.id, title: r.title, subtitle: LIBRARY_LABEL[r.type] ?? r.type,
        href: r.bookId ? `#library/book/${r.bookId}` : `#library/item/${r.id}`,
      });
    }
  }

  if (ids('book_page').length) {
    /* The address a page needs to be followed: which book, which section. A
       page number would be wrong the moment a page is inserted before it. */
    const rows = await db.select({
      id: bookPages.id, title: bookPages.title, sectionId: bookSections.id,
      sectionTitle: bookSections.title, bookId: bookSections.bookId,
      itemId: libraryBooks.libraryItemId, bookTitle: libraryItems.title,
    }).from(bookPages)
      .innerJoin(bookSections, eq(bookSections.id, bookPages.sectionId))
      .innerJoin(libraryBooks, eq(libraryBooks.id, bookSections.bookId))
      .innerJoin(libraryItems, eq(libraryItems.id, libraryBooks.libraryItemId))
      .where(and(eq(bookPages.workspaceId, ws), inArray(bookPages.id, ids('book_page'))));
    for (const r of rows) {
      put({
        type: 'book_page', id: r.id,
        title: r.title || 'Untitled page',
        /* A single-section book usually names its only section after itself,
           and "Notes · Notes" says nothing twice. */
        subtitle: r.sectionTitle && r.sectionTitle !== r.bookTitle
          ? `${r.bookTitle} · ${r.sectionTitle}` : r.bookTitle,
        href: `#library/book/${r.itemId}?p=${r.id}`,
      });
    }
  }

  if (ids('diary').length) {
    for (const r of await db.select({ id: diaryEntries.id, entryDate: diaryEntries.entryDate,
      title: diaryEntries.title }).from(diaryEntries)
      .where(and(eq(diaryEntries.workspaceId, ws), inArray(diaryEntries.id, ids('diary'))))) {
      /* A diary day is usually untitled, so the date IS the name and has to
         read like one. `2026-08-31` is a key, not a day. */
      put({ type: 'diary', id: r.id, title: r.title || whenLabel(null, r.entryDate) || r.entryDate,
        subtitle: r.title ? whenLabel(null, r.entryDate) : null,
        on: r.entryDate, href: `#diary/${r.entryDate}` });
    }
  }

  return out;
}

/* ── The service ─────────────────────────────────────────────────────────
 *
 * Everything below is what a route, a UI action or — later — an assistant
 * action should call. Nothing outside this file should write `item_links`,
 * with the one documented exception of `book-links.ts`, which mirrors
 * references out of page documents inside the page-save transaction. */

export type NewLink = {
  sourceType: EntityType; sourceId: string;
  targetType: EntityType; targetId: string;
  kind: LinkKind;
  note?: string | null;
  metadata?: Record<string, unknown> | null;
  userId?: string | null;
};

/**
 * Creates one edge, or returns the one that is already there.
 *
 * Duplicate protection is BOTH here and in the unique index. The index is the
 * guarantee; this check is what makes a repeated request return the existing
 * edge with its original id and `createdAt` rather than a conflict — pressing
 * "link" twice is not an error, it is the same intent stated twice.
 */
export async function createLink(db: Db, ws: string, input: NewLink) {
  const { sourceType, sourceId, targetType, targetId, kind } = input;

  if (!isEntityType(sourceType)) throw badRequest(`${sourceType} cannot be linked.`);
  if (!isEntityType(targetType)) throw badRequest(`${targetType} cannot be linked.`);
  if (!isLinkKind(kind)) throw badRequest(`${kind} is not a relationship type.`);
  if (sourceType === targetType && sourceId === targetId) {
    throw badRequest('Something cannot be related to itself.');
  }
  /* Coupling is not something a caller may simply assert. `scheduled_as`
     carries behaviour — it moves a task's time when the event moves — and it
     is created by the scheduling flow, which knows how to keep both sides
     honest. Handing it out here would let anything claim two records are the
     same work without any of the machinery that makes that true. */
  if (isCoupled(kind)) {
    throw badRequest('That relationship is created by scheduling, not by linking.');
  }

  if (!await entityExists(db, ws, sourceType, sourceId)) {
    throw notFound('The thing you are linking from is no longer here.');
  }
  if (!await entityExists(db, ws, targetType, targetId)) {
    throw notFound('The thing you are linking to is no longer here.');
  }

  const [existing] = await db.select().from(itemLinks).where(and(
    eq(itemLinks.workspaceId, ws),
    eq(itemLinks.sourceType, sourceType), eq(itemLinks.sourceId, sourceId),
    eq(itemLinks.targetType, targetType), eq(itemLinks.targetId, targetId),
    eq(itemLinks.kind, kind),
  )).limit(1);
  if (existing) return { link: existing, created: false };

  const [row] = await db.insert(itemLinks).values({
    workspaceId: ws,
    kind,
    sourceType,
    sourceId,
    targetType,
    targetId,
    note: input.note ?? null,
    metadata: input.metadata ?? null,
    createdBy: input.userId ?? null,
  }).returning();
  return { link: row!, created: true };
}

/** Removes the edge and nothing else. Neither end is touched. */
export async function removeLink(db: Db, ws: string, id: string) {
  const [row] = await db.select().from(itemLinks)
    .where(and(eq(itemLinks.workspaceId, ws), eq(itemLinks.id, id))).limit(1);
  if (!row) throw notFound('That link is already gone.');
  if (isCoupled(row.kind)) {
    throw badRequest('That is a scheduled time, not a link. Unschedule it instead.');
  }
  await db.delete(itemLinks).where(and(eq(itemLinks.workspaceId, ws), eq(itemLinks.id, id)));
  return { removed: true, link: row };
}

export type RelatedLink = {
  id: string;
  kind: string;
  label: string;
  direction: 'outgoing' | 'incoming';
  coupled: boolean;
  note: string | null;
  /** The thing at the OTHER end, whichever end that is. */
  entity: Summary | null;
  createdAt: Date;
};

/**
 * Everything connected to one entity, both directions, in one shape.
 *
 * The caller asked about ONE thing and wants to know what it is connected to.
 * Whether a given edge happens to point at it or away from it is a storage
 * detail, so both are returned in the same shape with the direction recorded
 * and the label already resolved to the right end of the phrase.
 *
 * This is the query the assistant will need, and it is deliberately the same
 * one the UI uses — a separate "AI query" would be a second answer to the
 * same question, free to drift.
 */
export async function linksFor(db: Db, ws: string, type: EntityType, id: string) {
  const rows = await db.select().from(itemLinks).where(and(
    eq(itemLinks.workspaceId, ws),
    or(
      and(eq(itemLinks.sourceType, type), eq(itemLinks.sourceId, id)),
      and(eq(itemLinks.targetType, type), eq(itemLinks.targetId, id)),
    ),
  ));

  const refs: Ref[] = [];
  for (const r of rows) {
    const outgoing = r.sourceType === type && r.sourceId === id;
    refs.push(outgoing
      ? { type: r.targetType, id: r.targetId }
      : { type: r.sourceType, id: r.sourceId });
  }
  const summaries = await summarise(db, ws, refs);

  const links: RelatedLink[] = rows.map((r) => {
    const outgoing = r.sourceType === type && r.sourceId === id;
    const other = outgoing
      ? { type: r.targetType, id: r.targetId }
      : { type: r.sourceType, id: r.sourceId };
    const spec = (LINK_KINDS as Record<string, { label: string; inverse: string }>)[r.kind];
    return {
      id: r.id,
      kind: r.kind,
      label: spec ? (outgoing ? spec.label : spec.inverse) : 'Related to',
      direction: (outgoing ? 'outgoing' : 'incoming') as 'outgoing' | 'incoming',
      coupled: isCoupled(r.kind),
      note: r.note ?? null,
      entity: summaries.get(`${other.type}:${other.id}`) ?? null,
      createdAt: r.createdAt,
    };
  })
    /* An edge whose other end has been deleted is dropped from the answer
       rather than rendered as a dead chip. `cleanupLinksFor` removes them at
       the source; this is the belt to that pair of braces, because a row
       deleted by a path that forgets to call it must not break a page. */
    .filter((l) => l.entity !== null)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return {
    outgoing: links.filter((l) => l.direction === 'outgoing'),
    incoming: links.filter((l) => l.direction === 'incoming'),
    links,
    count: links.length,
  };
}

/**
 * Removes every edge touching an entity that is being deleted.
 *
 * The edge table has no foreign key to the things it points at — it cannot,
 * being polymorphic — so nothing in the database will do this. Deleting a task
 * without this leaves rows pointing at an id that no longer resolves.
 *
 * It deletes EDGES ONLY. Nothing at the far end of an edge is touched, ever:
 * unlinking a task from a page must never be a way to delete a page.
 */
export async function cleanupLinksFor(db: Db, ws: string, type: EntityType, id: string) {
  const res = await db.delete(itemLinks).where(and(
    eq(itemLinks.workspaceId, ws),
    or(
      and(eq(itemLinks.sourceType, type), eq(itemLinks.sourceId, id)),
      and(eq(itemLinks.targetType, type), eq(itemLinks.targetId, id)),
    ),
  ));
  return res;
}

/**
 * Finds candidates to link TO, across every type at once.
 *
 * One search rather than a picker per type: a person looking for "the client
 * meeting" does not first decide whether it is an event, a page or a project,
 * and making them choose a tab before they can type is a question the app can
 * answer itself.
 *
 * Titles only, and deliberately. Full-text search over page bodies and diary
 * documents already exists on their own endpoints and means something
 * different — this is "which thing did you mean", not "where was this
 * mentioned".
 */
export async function searchLinkable(db: Db, ws: string, q: string, opts: {
  limit?: number; exclude?: { type: string; id: string } | null;
} = {}) {
  const term = q.trim();
  if (term.length < 2) return { results: [] as Summary[] };
  const like = `%${term.toLowerCase()}%`;
  const per = Math.max(2, Math.floor((opts.limit ?? 24) / 6));
  const hit = (col: any) => sql`lower(${col}) like ${like}`;
  const refs: Ref[] = [];

  const add = (type: EntityType, rows: { id: string }[]) => {
    for (const r of rows) {
      if (opts.exclude && opts.exclude.type === type && opts.exclude.id === r.id) continue;
      refs.push({ type, id: r.id });
    }
  };

  add('task', await db.select({ id: tasks.id }).from(tasks)
    .where(and(eq(tasks.workspaceId, ws), hit(tasks.title))).limit(per));
  add('project', await db.select({ id: projects.id }).from(projects)
    .where(and(eq(projects.workspaceId, ws), hit(projects.title))).limit(per));
  add('habit', await db.select({ id: habits.id }).from(habits)
    .where(and(eq(habits.workspaceId, ws), hit(habits.name))).limit(per));
  add('event', await db.select({ id: calendarEvents.id }).from(calendarEvents)
    .where(and(eq(calendarEvents.workspaceId, ws), hit(calendarEvents.title))).limit(per));
  add('reminder', await db.select({ id: reminders.id }).from(reminders)
    .where(and(eq(reminders.workspaceId, ws), hit(reminders.title))).limit(per));
  add('book_page', await db.select({ id: bookPages.id }).from(bookPages)
    .where(and(eq(bookPages.workspaceId, ws), hit(bookPages.title))).limit(per));
  add('library', await db.select({ id: libraryItems.id }).from(libraryItems)
    .where(and(eq(libraryItems.workspaceId, ws), hit(libraryItems.title))).limit(per));
  add('area', await db.select({ id: areas.id }).from(areas)
    .where(and(eq(areas.workspaceId, ws), hit(areas.name))).limit(per));
  /* A diary day is usually untitled, so its date is what a person searches
     for. Cast rather than `lower()`: there is no lower(date). */
  add('diary', await db.select({ id: diaryEntries.id }).from(diaryEntries)
    .where(and(eq(diaryEntries.workspaceId, ws), or(
      hit(diaryEntries.title),
      sql`${diaryEntries.entryDate}::text like ${like}`,
    ))).limit(per));

  const summaries = await summarise(db, ws, refs);
  return {
    results: refs.map((r) => summaries.get(`${r.type}:${r.id}`)).filter(Boolean) as Summary[],
  };
}

/** Link counts for many entities of one type, for list/detail badges. */
export async function linkCounts(db: Db, ws: string, type: EntityType, entityIds: string[]) {
  const counts = new Map<string, number>();
  if (!entityIds.length) return counts;
  const rows = await db.select({
    id: sql<string>`case when ${itemLinks.sourceType} = ${type} then ${itemLinks.sourceId}
                         else ${itemLinks.targetId} end`,
    n: sql<number>`count(*)::int`,
  }).from(itemLinks).where(and(
    eq(itemLinks.workspaceId, ws),
    or(
      and(eq(itemLinks.sourceType, type), inArray(itemLinks.sourceId, entityIds)),
      and(eq(itemLinks.targetType, type), inArray(itemLinks.targetId, entityIds)),
    ),
  )).groupBy(sql`1`);
  for (const r of rows) counts.set(r.id, Number(r.n));
  return counts;
}
