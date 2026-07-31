/**
 * Legacy import — Areas + Tasks + Task steps only, from the VERIFIED v242
 * Firestore export.
 *
 * Locked rules (/docs/legacy-data-decision.md, /docs/v2-relaunch-plan.md):
 *  • Personal profile ONLY. Business is legacy contamination and is ignored
 *    entirely — its reminders, People and diary entry never travel.
 *  • Retired fields are NOT imported: dailyDate, dailySince, daily,
 *    linkedPersonId, linkedPromiseId, lastCheckedAt, prevCheckedAt.
 *  • dayNotes and customEvents are excluded (confirmed empty 0/0).
 *  • task.project meant an AREA, not a project → maps to area_id.
 *    project_id stays null; Projects do not exist yet.
 *  • An unparseable scheduledTime is preserved verbatim, never discarded.
 *  • Idempotent: legacy ids are recorded, so a rerun updates instead of
 *    duplicating.
 *
 * Everything here is PURE — no database, no network — so the whole mapping is
 * unit-testable and the preview can run without touching anything.
 */
import { normaliseAreaName } from './bootstrap.js';
import type { Bucket, Priority, Status } from '../db/schema.js';

export const EXPORT_FORMAT = 'life-os-firestore-export';
/** Never imported, for the reasons above. */
export const RETIRED_TASK_FIELDS = [
  'dailyDate', 'dailySince', 'daily',
  'linkedPersonId', 'linkedPromiseId', 'lastCheckedAt', 'prevCheckedAt',
] as const;
export const EXCLUDED_COLLECTIONS = ['dayNotes', 'customEvents', 'people', 'peopleTags',
  'peopleLevelNames', 'peopleSettings', 'learning'] as const;

const PRIORITY_MAP: Record<string, Priority> = {
  urgent: 'urgent', hi: 'high', high: 'high', med: 'medium', medium: 'medium',
  lo: 'low', low: 'low', someday: 'someday',
};
const VALID_BUCKETS: Bucket[] = ['today', 'week', 'month', 'future'];

export interface PlannedArea {
  legacyId: string; name: string; color: string; position: number;
  matchesDefault: 'Personal' | 'Work' | null;
}
export interface PlannedTask {
  legacyId: string; title: string; notes: string | null;
  status: Status; bucket: Bucket; priority: Priority;
  dueDate: string | null; scheduledAt: string | null;
  legacyScheduledTimeRaw: string | null;
  areaLegacyKey: string | null; position: number;
  completedAt: string | null;
  steps: { title: string; completed: boolean; position: number }[];
}
export interface ImportPlan {
  ok: boolean;
  errors: string[];
  warnings: string[];
  source: {
    format: string | null; exportVersion: number | null; appVersion: string | null;
    createdAt: string | null; verified: boolean; verificationStatus: string | null;
  };
  profiles: {
    chosen: { id: string; name: string | null } | null;
    ignored: { id: string; name: string | null; reason: string }[];
  };
  areas: { plan: PlannedArea[]; total: number; mappedToDefaults: number };
  tasks: {
    plan: PlannedTask[];
    total: number;
    skipped: { reason: string; count: number }[];
    byBucket: Record<string, number>;
    byPriority: Record<string, number>;
    withDueDate: number;
    withUnparseableTime: number;
    completed: number;
  };
  steps: { total: number };
  excluded: { collection: string; count: number; reason: string }[];
  /** How many tasks carried each retired field that this import drops. */
  retiredFields: Record<string, number>;
  duplicateRisk: {
    duplicateLegacyIdsInFile: number;
    tasksCarryingLegacyId: number;
    areasCarryingLegacyId: number;
  };
  /** Record counts inside profiles we never read. Counts only, no content. */
  excludedProfiles: { id: string; name: string | null; collections: { collection: string; count: number }[] }[];
}

/** "3:30pm" / "10am" / "14:05" → minutes since midnight, or null. */
export function parseLegacyTime(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  let m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.exec(s);
  if (m) {
    let h = Number(m[1]); const min = m[2] ? Number(m[2]) : 0;
    if (h < 1 || h > 12 || min > 59) return null;
    if (m[3] === 'pm' && h !== 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    return h * 60 + min;
  }
  m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const h = Number(m[1]); const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }
  return null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const asIsoDate = (v: unknown): string | null =>
  typeof v === 'string' && ISO_DATE.test(v) ? v : null;

/** Unwrap the export's boxed values (timestamps etc). */
function unbox(v: any): any {
  if (v && typeof v === 'object' && typeof v.__t === 'string') {
    if (v.__t === 'timestamp' || v.__t === 'date') return v.iso ?? null;
    if (v.__t === 'undefined' || v.__t === 'circular' || v.__t === 'unsupported') return undefined;
    if (v.__t === 'number') return Number(v.v);
  }
  return v;
}

/**
 * Which profile is authoritative? Personal. Chosen explicitly rather than by
 * position, so a differently-ordered export cannot silently import Business.
 */
/**
 * Counts the records inside a profile document WITHOUT reading any content.
 *
 * Used to report how much of the Business profile is being left behind. It
 * touches only array lengths and key counts — no title, note or free-text
 * value is read, copied or returned. Saying "10 reminders excluded" is a
 * useful check; showing what those reminders say is not, and would defeat the
 * point of excluding them.
 */
export function countProfileRecords(doc: any): { collection: string; count: number }[] {
  const data = doc?.data ?? doc ?? {};
  const out: { collection: string; count: number }[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith('_') || key === 'updatedAt') continue;
    let count = 0;
    if (Array.isArray(value)) count = value.length;
    else if (value && typeof value === 'object') count = Object.keys(value).length;
    else continue;
    if (count > 0) out.push({ collection: key, count });
  }
  return out.sort((a, b) => b.count - a.count);
}

export function chooseProfile(exp: any): { chosen: any | null; ignored: { id: string; name: string | null; reason: string }[] } {
  const profiles: any[] = Array.isArray(exp?.profiles) ? exp.profiles : [];
  const ignored: { id: string; name: string | null; reason: string }[] = [];
  const isPersonal = (p: any) =>
    p?.id === 'main' || p?.mode === 'personal' || /^personal$/i.test(String(p?.name ?? ''));

  const candidates = profiles.filter(isPersonal);
  const chosen = candidates[0] ?? null;
  for (const p of profiles) {
    if (p === chosen) continue;
    ignored.push({
      id: String(p?.id ?? '?'), name: p?.name ?? null,
      reason: 'Legacy profile — excluded from Life OS v2 (not migrated).',
    });
  }
  return { chosen, ignored };
}

export function buildImportPlan(exp: any): ImportPlan {
  const errors: string[] = [];
  const warnings: string[] = [];

  const verification = exp?.verification ?? null;
  const verified = verification?.ok === true;
  const source = {
    format: exp?.exportFormat ?? null,
    exportVersion: typeof exp?.exportVersion === 'number' ? exp.exportVersion : null,
    appVersion: exp?.appVersion ?? null,
    createdAt: exp?.createdAt ?? null,
    verified,
    verificationStatus: verification?.status ?? (verification ? (verification.ok ? 'VERIFIED' : 'FAILED') : null),
  };

  const empty: ImportPlan = {
    ok: false, errors, warnings, source,
    profiles: { chosen: null, ignored: [] },
    areas: { plan: [], total: 0, mappedToDefaults: 0 },
    tasks: { plan: [], total: 0, skipped: [], byBucket: {}, byPriority: {}, withDueDate: 0, withUnparseableTime: 0, completed: 0 },
    steps: { total: 0 },
    excluded: [],
    retiredFields: {},
    duplicateRisk: { duplicateLegacyIdsInFile: 0, tasksCarryingLegacyId: 0, areasCarryingLegacyId: 0 },
    excludedProfiles: [],
  };

  if (exp?.exportFormat !== EXPORT_FORMAT) {
    errors.push(`Not a Life OS export file (expected "${EXPORT_FORMAT}").`);
    return empty;
  }
  if (!verified) {
    errors.push('This export did not pass verification. Import requires a VERIFIED export.');
    return empty;
  }

  const { chosen, ignored } = chooseProfile(exp);
  if (!chosen) {
    errors.push('No Personal profile found in this export.');
    return { ...empty, profiles: { chosen: null, ignored } };
  }

  const doc = exp?.documents?.[chosen.id];
  if (!doc || doc.data == null) {
    errors.push(`The Personal profile document ("${chosen.id}") is missing from this export.`);
    return { ...empty, profiles: { chosen: { id: chosen.id, name: chosen.name ?? null }, ignored } };
  }
  const data = doc.data;

  /* ── Areas (legacy `workProjects`) ─────────────────────────────────── */
  const legacyAreas: any[] = Array.isArray(data.workProjects) ? data.workProjects : [];
  const seen = new Set<string>();
  const areaPlan: PlannedArea[] = [];
  let mappedToDefaults = 0;
  for (const a of legacyAreas) {
    const name = String(unbox(a?.name) ?? '').trim();
    const legacyId = String(unbox(a?.id) ?? '').trim();
    if (!name || !legacyId) { warnings.push('Skipped an Area with no name or id.'); continue; }
    const key = normaliseAreaName(name);
    if (seen.has(key)) { warnings.push(`Duplicate Area name "${name}" — kept the first.`); continue; }
    seen.add(key);
    const matchesDefault = key === 'personal' ? 'Personal' : key === 'work' ? 'Work' : null;
    if (matchesDefault) mappedToDefaults++;
    areaPlan.push({
      legacyId, name, color: String(unbox(a?.color) ?? 'slate'),
      position: typeof a?.order === 'number' ? a.order : areaPlan.length + 2,
      matchesDefault,
    });
  }

  /* ── Tasks ─────────────────────────────────────────────────────────── */
  const legacyTasks: any[] = Array.isArray(data.tasks) ? data.tasks : [];
  const taskPlan: PlannedTask[] = [];
  const skipCounts = new Map<string, number>();
  const bump = (r: string) => skipCounts.set(r, (skipCounts.get(r) ?? 0) + 1);
  const byBucket: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  let withDueDate = 0, withUnparseableTime = 0, completed = 0, stepTotal = 0;
  const seenLegacyIds = new Set<string>();
  /** How many tasks carried each retired field that this import drops. */
  const retiredFieldCounts: Record<string, number> = {};
  let duplicateLegacyIds = 0;

  for (const t of legacyTasks) {
    // Count retired fields on EVERY task, including ones later skipped, so the
    // number reflects what is in the file rather than what survived mapping.
    for (const f of RETIRED_TASK_FIELDS) {
      const v = unbox((t as any)?.[f]);
      if (v !== undefined && v !== null && v !== false && v !== '') {
        retiredFieldCounts[f] = (retiredFieldCounts[f] ?? 0) + 1;
      }
    }

    const legacyId = String(unbox(t?.id) ?? '').trim();
    const title = String(unbox(t?.text) ?? '').trim();
    if (!legacyId) { bump('missing id'); continue; }
    if (!title) { bump('empty title'); continue; }
    if (seenLegacyIds.has(legacyId)) { bump('duplicate legacy id'); duplicateLegacyIds++; continue; }
    seenLegacyIds.add(legacyId);

    const done = unbox(t?.done) === true;
    const status: Status = done ? 'done' : 'open';
    const rawBucket = String(unbox(t?.bucket) ?? '');
    const bucket: Bucket = (VALID_BUCKETS as string[]).includes(rawBucket) ? (rawBucket as Bucket) : 'today';
    const priority: Priority = PRIORITY_MAP[String(unbox(t?.priority) ?? '')] ?? 'medium';
    const dueDate = asIsoDate(unbox(t?.dueDate));
    if (dueDate) withDueDate++;
    if (done) completed++;

    // scheduledTime is a bare time-of-day with no date. Only build a real
    // timestamp when we ALSO have a date; otherwise keep the raw string so
    // nothing is silently lost.
    const rawTime = unbox(t?.scheduledTime);
    const rawTimeStr = typeof rawTime === 'string' && rawTime.trim() ? rawTime.trim() : null;
    const mins = parseLegacyTime(rawTimeStr);
    let scheduledAt: string | null = null;
    let legacyScheduledTimeRaw: string | null = rawTimeStr;
    if (mins != null && dueDate) {
      const hh = String(Math.floor(mins / 60)).padStart(2, '0');
      const mm = String(mins % 60).padStart(2, '0');
      scheduledAt = `${dueDate}T${hh}:${mm}:00`;
      legacyScheduledTimeRaw = null; // fully represented by scheduled_at
    } else if (rawTimeStr) {
      withUnparseableTime++;
    }

    // task.project meant an AREA. 'gen' means none.
    const legacyProject = String(unbox(t?.project) ?? '').trim();
    const legacyArea = String(unbox(t?.area) ?? '').trim();
    let areaLegacyKey: string | null = null;
    if (legacyProject && legacyProject !== 'gen' && areaPlan.some((a) => a.legacyId === legacyProject)) {
      areaLegacyKey = legacyProject;
    } else if (legacyArea === 'work') areaLegacyKey = '__work';
    else if (legacyArea === 'personal') areaLegacyKey = '__personal';

    const legacySteps: any[] = Array.isArray(t?.steps) ? t.steps : [];
    const steps = legacySteps
      .map((s: any, i: number) => ({
        title: String(unbox(s?.text) ?? '').trim(),
        completed: unbox(s?.done) === true,
        position: i,
      }))
      .filter((s) => s.title.length > 0);
    stepTotal += steps.length;

    byBucket[bucket] = (byBucket[bucket] ?? 0) + 1;
    byPriority[priority] = (byPriority[priority] ?? 0) + 1;

    const doneAt = unbox(t?.doneAt);
    taskPlan.push({
      legacyId, title,
      notes: (() => { const n = unbox(t?.notes); return typeof n === 'string' && n.trim() ? n : null; })(),
      status, bucket, priority, dueDate, scheduledAt, legacyScheduledTimeRaw,
      areaLegacyKey,
      position: typeof t?.ord === 'number' ? t.ord : taskPlan.length,
      completedAt: typeof doneAt === 'number' ? new Date(doneAt).toISOString() : null,
      steps,
    });
  }

  /* ── What we deliberately leave behind ─────────────────────────────── */
  const excluded = EXCLUDED_COLLECTIONS.map((c) => {
    const v = (data as any)[c];
    const count = Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0;
    const reason = c === 'dayNotes' || c === 'customEvents'
      ? 'Excluded from Life OS v2 (confirmed empty, retired).'
      : c === 'learning' ? 'Superseded by Habits long ago.'
      : 'People system retired — archived only, never migrated.';
    return { collection: c, count, reason };
  }).filter((e) => e.count > 0 || e.collection === 'dayNotes' || e.collection === 'customEvents');

  // Systems that exist but are not part of THIS baseline import.
  for (const [c, label] of [['reminders', 'Reminders'], ['habits', 'Habits'],
    ['routineLog', 'Diary'], ['notebook', 'Notebook'], ['builds', 'Projects'],
    ['ideas', 'Brain ideas'], ['resources', 'Brain resources'], ['notes', 'Brain notes']] as const) {
    const v = (data as any)[c];
    const count = Array.isArray(v) ? v.length
      : c === 'notebook' ? (Array.isArray(v?.sections) ? v.sections.length : 0)
      : v && typeof v === 'object' ? Object.keys(v).length : 0;
    if (count > 0) warnings.push(`${label}: ${count} record(s) present but NOT imported in this baseline.`);
  }

  return {
    ok: errors.length === 0,
    errors, warnings, source,
    profiles: { chosen: { id: String(chosen.id), name: chosen.name ?? null }, ignored },
    areas: { plan: areaPlan, total: areaPlan.length, mappedToDefaults },
    tasks: {
      plan: taskPlan, total: taskPlan.length,
      skipped: [...skipCounts.entries()].map(([reason, count]) => ({ reason, count })),
      byBucket, byPriority, withDueDate, withUnparseableTime, completed,
    },
    steps: { total: stepTotal },
    excluded,
    retiredFields: retiredFieldCounts,
    duplicateRisk: {
      // Duplicates inside the file itself.
      duplicateLegacyIdsInFile: duplicateLegacyIds,
      // Every task carries a legacy_id, unique per workspace, so re-running a
      // real import updates rather than duplicates. This is the count that
      // would be protected by that constraint.
      tasksCarryingLegacyId: taskPlan.length,
      areasCarryingLegacyId: areaPlan.length,
    },
    // What is being left behind in the profiles we do not read. Counts only —
    // the content of those records is never opened.
    excludedProfiles: ignored.map((p) => ({
      id: p.id, name: p.name,
      collections: countProfileRecords(exp?.documents?.[p.id]),
    })),
  };
}

/** Counts-only summary — safe to log or display; contains no task text. */
export function summarisePlan(plan: ImportPlan) {
  return {
    ok: plan.ok,
    errors: plan.errors,
    warnings: plan.warnings,
    source: plan.source,
    // Ids alone ('main', 'p_x9zxkv4') mean nothing to a human reading the
    // preview, so carry the display name too. Profile names are structural
    // labels ("Personal", "Business"), never personal content.
    profileChosen: plan.profiles.chosen ? { ...plan.profiles.chosen } : null,
    profilesIgnored: plan.profiles.ignored.map((p) => ({ ...p })),
    areas: { total: plan.areas.total, mappedToDefaults: plan.areas.mappedToDefaults },
    tasks: {
      total: plan.tasks.total, completed: plan.tasks.completed,
      withDueDate: plan.tasks.withDueDate,
      withUnparseableTime: plan.tasks.withUnparseableTime,
      byBucket: plan.tasks.byBucket, byPriority: plan.tasks.byPriority,
      skipped: plan.tasks.skipped,
    },
    steps: plan.steps.total,
    excluded: plan.excluded,
    retiredFields: plan.retiredFields,
    duplicateRisk: plan.duplicateRisk,
    excludedProfiles: plan.excludedProfiles,
  };
}
