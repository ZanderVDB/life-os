/**
 * Legacy Habits import — mapping only. Pure, no database, no I/O.
 *
 * WHERE HABIT HISTORY COMES FROM
 *
 * Legacy stores a habit as `{ id, name, checkedDates: [...], createdAt, notes }`.
 * `checkedDates` is an explicit list of days the habit was ticked — unambiguous,
 * and the only history this import reads.
 *
 * WHAT IT DELIBERATELY DOES NOT READ
 *
 * `routineLog[date]` is a different thing entirely: `{ checks: {...}, journal: {...} }`.
 *   • `checks` are ROUTINE items (a morning/evening checklist), not these five
 *     habits. Their keys cannot be resolved to habit ids with confidence, so
 *     they are counted and reported as ambiguous — never guessed at.
 *   • `journal` is diary writing. It is never opened, never counted by content,
 *     and can never become habit history. Turning someone's diary into a
 *     completion tick would be an unrecoverable misreading of their life.
 *
 * That separation is the whole point of the v2 habits/diary split.
 */
import { normaliseAreaName } from './bootstrap.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const EXPORT_FORMAT = 'life-os-firestore-export';

export interface PlannedHabit {
  legacyId: string;
  name: string;
  color: string;
  position: number;
  targetCount: number;
  frequencyType: 'daily';
  areaLegacyKey: string | null;
  createdAt: string | null;
  /** Unique, sorted ISO dates from `checkedDates`. */
  entryDates: string[];
}

export interface HabitImportPlan {
  ok: boolean;
  errors: string[];
  warnings: string[];
  source: {
    format: string | null; exportVersion: number | null; appVersion: string | null;
    createdAt: string | null; verified: boolean; verificationStatus: string | null;
  };
  profileChosen: { id: string; name: string | null } | null;
  profilesIgnored: { id: string; name: string | null; reason: string }[];
  habits: { plan: PlannedHabit[]; total: number; skipped: { reason: string; count: number }[] };
  entries: {
    total: number;
    earliest: string | null;
    latest: string | null;
    duplicatesCollapsed: number;
    invalidDates: number;
  };
  /** Counted, never read. */
  notImported: {
    routineCheckDays: number;
    routineCheckMarks: number;
    journalDays: number;
    reason: string;
  };
}

const unbox = (v: any): any => {
  if (v && typeof v === 'object' && typeof v.__t === 'string') {
    if (v.__t === 'timestamp' || v.__t === 'date') return v.iso ?? null;
    if (v.__t === 'undefined') return undefined;
    if (v.__t === 'number') return Number(v.v);
  }
  return v;
};

/** Personal is identified POSITIVELY; everything else is excluded by name-agnostic rule. */
export function chooseProfile(exp: any) {
  const profiles: any[] = Array.isArray(exp?.profiles) ? exp.profiles : [];
  const isPersonal = (p: any) =>
    p?.id === 'main' || p?.mode === 'personal' || /^personal$/i.test(String(p?.name ?? ''));
  const chosen = profiles.filter(isPersonal)[0] ?? null;
  const ignored = profiles.filter((p) => p !== chosen).map((p) => ({
    id: String(p?.id ?? '?'), name: p?.name ?? null,
    reason: 'Legacy profile — excluded from Life OS v2 (not migrated).',
  }));
  return { chosen, ignored };
}

const asIsoDate = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (ISO_DATE.test(s)) return s;
  // Legacy occasionally stored a full timestamp; take the calendar day from it
  // rather than discarding a real completion.
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

export function buildHabitImportPlan(exp: any): HabitImportPlan {
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
    verificationStatus: verification?.status ?? null,
  };

  const { chosen, ignored } = chooseProfile(exp);
  const empty: HabitImportPlan = {
    ok: false, errors, warnings, source,
    profileChosen: chosen ? { id: String(chosen.id), name: chosen.name ?? null } : null,
    profilesIgnored: ignored,
    habits: { plan: [], total: 0, skipped: [] },
    entries: { total: 0, earliest: null, latest: null, duplicatesCollapsed: 0, invalidDates: 0 },
    notImported: {
      routineCheckDays: 0, routineCheckMarks: 0, journalDays: 0,
      reason: 'Routine checks cannot be mapped to habits with confidence; journal text is diary writing.',
    },
  };

  if (exp?.exportFormat !== EXPORT_FORMAT) {
    errors.push(`Not a Life OS export file (expected "${EXPORT_FORMAT}").`);
    return empty;
  }
  if (!verified) {
    errors.push('This export did not pass verification. Import requires a VERIFIED export.');
    return empty;
  }
  if (!chosen) {
    errors.push('No Personal profile was found in this export.');
    return empty;
  }
  const doc = exp?.documents?.[chosen.id];
  if (!doc || doc.data == null) {
    errors.push(`The Personal profile document ("${chosen.id}") is missing from this export.`);
    return empty;
  }
  const data = doc.data;

  /* ── Habits ─────────────────────────────────────────────────────────── */
  const legacyHabits: any[] = Array.isArray(data.habits) ? data.habits : [];
  const plan: PlannedHabit[] = [];
  const skips = new Map<string, number>();
  const bump = (r: string) => skips.set(r, (skips.get(r) ?? 0) + 1);
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();

  let entryTotal = 0, duplicatesCollapsed = 0, invalidDates = 0;
  let earliest: string | null = null, latest: string | null = null;

  for (const h of legacyHabits) {
    const legacyId = String(unbox(h?.id) ?? '').trim();
    const name = String(unbox(h?.name) ?? '').trim();
    if (!legacyId) { bump('missing id'); continue; }
    if (!name) { bump('empty name'); continue; }
    if (seenIds.has(legacyId)) { bump('duplicate legacy id'); continue; }
    const nameKey = normaliseAreaName(name);
    if (seenNames.has(nameKey)) { bump('duplicate name'); continue; }
    seenIds.add(legacyId); seenNames.add(nameKey);

    const raw: unknown[] = Array.isArray(h?.checkedDates) ? h.checkedDates : [];
    const dates = new Set<string>();
    for (const d of raw) {
      const iso = asIsoDate(unbox(d));
      if (!iso) { invalidDates++; continue; }
      if (dates.has(iso)) { duplicatesCollapsed++; continue; }
      dates.add(iso);
    }
    const entryDates = [...dates].sort();
    entryTotal += entryDates.length;
    if (entryDates.length) {
      const lo = entryDates[0]!, hi = entryDates[entryDates.length - 1]!;
      if (!earliest || lo < earliest) earliest = lo;
      if (!latest || hi > latest) latest = hi;
    }

    // Legacy habits carry no Area, frequency or target — they were simple
    // daily yes/no. Inventing a richer schedule would be fabrication.
    plan.push({
      legacyId, name,
      color: String(unbox(h?.color) ?? 'sage'),
      position: (plan.length + 1) * 1000,
      targetCount: 1,
      frequencyType: 'daily',
      areaLegacyKey: null,
      createdAt: asIsoDate(unbox(h?.createdAt)),
      entryDates,
    });
  }

  /* ── What we count but never read ───────────────────────────────────── */
  const routineLog = data.routineLog && typeof data.routineLog === 'object' ? data.routineLog : {};
  let routineCheckDays = 0, routineCheckMarks = 0, journalDays = 0;
  for (const day of Object.values<any>(routineLog)) {
    if (!day || typeof day !== 'object') continue;
    const checks = day.checks && typeof day.checks === 'object' ? day.checks : null;
    if (checks) {
      const marks = Object.values(checks).filter(Boolean).length;
      if (marks) { routineCheckDays++; routineCheckMarks += marks; }
    }
    // Presence only. The journal object is never iterated for content.
    if (day.journal && typeof day.journal === 'object' && Object.keys(day.journal).length) {
      journalDays++;
    }
  }
  if (routineCheckMarks) {
    warnings.push(`${routineCheckMarks} routine check mark(s) across ${routineCheckDays} day(s) `
      + 'could not be mapped to a habit and were NOT imported.');
  }
  if (journalDays) {
    warnings.push(`${journalDays} day(s) of diary writing are present and were NOT touched. `
      + 'Diary arrives with its own system.');
  }
  if (!plan.length) errors.push('No importable habits were found in the Personal profile.');

  return {
    ok: errors.length === 0,
    errors, warnings, source,
    profileChosen: { id: String(chosen.id), name: chosen.name ?? null },
    profilesIgnored: ignored,
    habits: {
      plan, total: plan.length,
      skipped: [...skips.entries()].map(([reason, count]) => ({ reason, count })),
    },
    entries: { total: entryTotal, earliest, latest, duplicatesCollapsed, invalidDates },
    notImported: {
      routineCheckDays, routineCheckMarks, journalDays,
      reason: 'Routine checks cannot be mapped to habits with confidence; journal text is diary writing.',
    },
  };
}

/** Counts only — safe to display and to log. Contains no habit names. */
export function summariseHabitPlan(plan: HabitImportPlan) {
  return {
    ok: plan.ok,
    errors: plan.errors,
    warnings: plan.warnings,
    source: plan.source,
    profileChosen: plan.profileChosen,
    profilesIgnored: plan.profilesIgnored,
    habits: { total: plan.habits.total, skipped: plan.habits.skipped },
    entries: plan.entries,
    notImported: plan.notImported,
  };
}
