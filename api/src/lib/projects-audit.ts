/**
 * Legacy Projects audit — READ ONLY.
 *
 * Phase E1 is discovery. This module answers "what is actually in there?" for
 * the ~12 Legacy Projects without importing, writing or transforming anything.
 * There is deliberately no writer beside it: an audit that can also migrate is
 * an audit nobody runs twice.
 *
 * Legacy calls Projects `builds`. That is the whole collection — there is no
 * separate project table, no task→project foreign key and no project→area
 * link. Everything below is derived from the shape the Legacy app actually
 * writes (index.html: rBuilds, renderProjectDetail, openProjectModal,
 * _projEffStatus, PROJECT_STAGES).
 *
 * PRIVACY. The audit reports STRUCTURE, not content. Titles are returned
 * because the user needs them to decide what migrates; descriptions, notes and
 * log bodies are reduced to presence and length. Nothing here is logged — the
 * caller returns it straight to the account that owns it.
 */
import { chooseProfile, countProfileRecords } from './legacy-import.js';

/** Legacy's fixed lifecycle. `stage` is an index into this array. */
export const LEGACY_STAGES = [
  'Idea', 'Planning', 'Building', 'Testing', 'Launch', 'Live', 'Done',
] as const;

/** Legacy's recency status. Not a lifecycle — see the product model. */
export const LEGACY_STATUSES = ['active', 'future', 'background'] as const;

export type ProjectAuditRow = {
  legacyId: string;
  title: string;
  /** Stored status. May disagree with the derived one — see `statusIsDerived`. */
  status: string | null;
  /** Legacy recomputes status from recency unless the user pinned it. */
  statusIsDerived: boolean;
  stage: number | null;
  stageName: string | null;
  hasDescription: boolean;
  descriptionChars: number;
  hasNotes: boolean;
  notesChars: number;
  logEntries: number;
  /** Pre-`notes` progress entries. Legacy folded these into notes on migrate. */
  legacyEntries: number;
  lastTouchedIso: string | null;
  createdIso: string | null;
  /** Nothing to migrate but a name. */
  isEmpty: boolean;
  unknownFields: string[];
};

export type ProjectAudit = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  source: {
    format: string | null;
    exportVersion: number | null;
    appVersion: string | null;
    createdAt: string | null;
    verified: boolean;
  };
  profile: { id: string; name: string | null } | null;
  /** Counts only — never content. What we are deliberately leaving behind. */
  excludedProfiles: {
    id: string; name: string | null;
    projects: number;
    collections: { collection: string; count: number }[];
  }[];
  total: number;
  projects: ProjectAuditRow[];
  summary: {
    byStoredStatus: Record<string, number>;
    byStage: Record<string, number>;
    derivedStatus: number;
    pinnedStatus: number;
    withDescription: number;
    withNotes: number;
    withLog: number;
    empty: number;
    duplicateTitles: { title: string; count: number }[];
    missingId: number;
    missingTitle: number;
    unknownFields: string[];
  };
  /**
   * Legacy has no task→project relationship at all, so there are no orphaned
   * task references to reconcile. Stated as a finding rather than assumed.
   */
  taskLinkage: {
    legacyTasksHaveProjectField: boolean;
    note: string;
  };
};

const KNOWN_FIELDS = new Set([
  'id', 'title', 'desc', 'notes', 'status', 'auto', 'stage', 'lastTouched',
  'prevTouched', 'date', 'entries', 'log', 'priority', 'done', 'order',
  'createdAt', 'updatedAt',
]);

function unboxValue(v: any): any {
  if (v && typeof v === 'object' && typeof v.__t === 'string') {
    if (v.__t === 'timestamp' || v.__t === 'date') return v.iso ?? null;
    if (v.__t === 'undefined' || v.__t === 'circular' || v.__t === 'unsupported') return undefined;
    if (v.__t === 'number') return Number(v.v);
  }
  return v;
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
const msToIso = (v: unknown): string | null => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const emptyAudit = (): ProjectAudit => ({
  ok: false,
  errors: [],
  warnings: [],
  source: { format: null, exportVersion: null, appVersion: null, createdAt: null, verified: false },
  profile: null,
  excludedProfiles: [],
  total: 0,
  projects: [],
  summary: {
    byStoredStatus: {}, byStage: {}, derivedStatus: 0, pinnedStatus: 0,
    withDescription: 0, withNotes: 0, withLog: 0, empty: 0,
    duplicateTitles: [], missingId: 0, missingTitle: 0, unknownFields: [],
  },
  taskLinkage: {
    legacyTasksHaveProjectField: false,
    note: 'Legacy tasks carry a `project` field, but it holds a workProject id — '
      + 'an AREA, not a Project. No task→Project relationship exists in Legacy.',
  },
});

/**
 * Reads a Legacy export and reports what the Projects collection contains.
 *
 * Pure: takes the parsed export, returns a report. No database, no filesystem,
 * no network — which is what makes it safe to run against the real export.
 */
export function auditLegacyProjects(exp: any): ProjectAudit {
  const out = emptyAudit();

  if (!exp || typeof exp !== 'object') {
    out.errors.push('That does not look like a Life OS export.');
    return out;
  }

  out.source = {
    format: exp.exportFormat ?? null,
    exportVersion: typeof exp.exportVersion === 'number' ? exp.exportVersion : null,
    appVersion: exp.appVersion ?? null,
    createdAt: exp.createdAt ?? null,
    verified: exp?.verification?.ok === true,
  };
  if (!out.source.verified) {
    out.warnings.push('This export did not verify. Read the numbers as indicative.');
  }

  const { chosen, ignored } = chooseProfile(exp);
  if (!chosen) {
    out.errors.push('No Personal profile found in this export.');
    return out;
  }
  out.profile = { id: String(chosen.id), name: chosen.name ?? null };

  // What is being left behind, in counts. The Legacy second profile is not
  // Life OS v2 data and is never read for content.
  for (const p of ignored) {
    const doc = exp?.documents?.[p.id];
    const collections = doc ? countProfileRecords(doc) : [];
    out.excludedProfiles.push({
      id: p.id,
      name: p.name,
      projects: collections.find((c) => c.collection === 'builds')?.count ?? 0,
      collections,
    });
  }

  const doc = exp?.documents?.[chosen.id];
  if (!doc || doc.data == null) {
    out.errors.push(`The Personal profile document ("${chosen.id}") is missing from this export.`);
    return out;
  }
  const data = doc.data;

  const builds: any[] = Array.isArray(data.builds) ? data.builds : [];
  if (!Array.isArray(data.builds)) {
    out.warnings.push('No `builds` collection in the Personal profile — no Projects to migrate.');
  }

  // Legacy tasks: does `project` appear, and does it point at a workProject?
  const tasks: any[] = Array.isArray(data.tasks) ? data.tasks : [];
  const areaIds = new Set((Array.isArray(data.workProjects) ? data.workProjects : [])
    .map((a: any) => String(unboxValue(a?.id) ?? '')).filter(Boolean));
  const buildIds = new Set(builds.map((b) => String(unboxValue(b?.id) ?? '')).filter(Boolean));
  let taskProjectValues = 0;
  let taskProjectPointsAtBuild = 0;
  for (const t of tasks) {
    const v = String(unboxValue(t?.project) ?? '').trim();
    if (!v || v === 'gen') continue;
    taskProjectValues++;
    // The finding that matters: if this ever matched a build id, the field
    // would be ambiguous. It should only ever match an Area.
    if (buildIds.has(v) && !areaIds.has(v)) taskProjectPointsAtBuild++;
  }
  out.taskLinkage.legacyTasksHaveProjectField = taskProjectValues > 0;
  if (taskProjectPointsAtBuild > 0) {
    out.warnings.push(`${taskProjectPointsAtBuild} legacy task(s) have a \`project\` value that `
      + 'matches a Project id rather than an Area id. Investigate before migrating.');
  }

  const titleCounts = new Map<string, number>();
  const unknown = new Set<string>();

  for (const raw of builds) {
    const b = raw ?? {};
    const legacyId = String(unboxValue(b.id) ?? '').trim();
    const title = asString(unboxValue(b.title)).trim();
    const desc = asString(unboxValue(b.desc));
    const notes = asString(unboxValue(b.notes));
    const log = Array.isArray(b.log) ? b.log : [];
    const entries = Array.isArray(b.entries) ? b.entries : [];
    const stageRaw = unboxValue(b.stage);
    const stage = typeof stageRaw === 'number' && Number.isFinite(stageRaw)
      ? Math.max(0, Math.min(LEGACY_STAGES.length - 1, Math.trunc(stageRaw)))
      : null;
    // `auto !== false` is Legacy's rule: derived unless the user pinned it.
    const statusIsDerived = b.auto !== false;

    for (const k of Object.keys(b)) if (!KNOWN_FIELDS.has(k)) unknown.add(k);

    if (!legacyId) out.summary.missingId++;
    if (!title) out.summary.missingTitle++;
    if (title) titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);

    const isEmpty = !desc.trim() && !notes.trim() && log.length === 0 && entries.length === 0;

    out.projects.push({
      legacyId,
      title,
      status: asString(unboxValue(b.status)).trim() || null,
      statusIsDerived,
      stage,
      stageName: stage === null ? null : LEGACY_STAGES[stage]!,
      hasDescription: desc.trim().length > 0,
      descriptionChars: desc.length,
      hasNotes: notes.trim().length > 0,
      notesChars: notes.length,
      logEntries: log.length,
      legacyEntries: entries.length,
      lastTouchedIso: msToIso(unboxValue(b.lastTouched)),
      createdIso: asString(unboxValue(b.date)).trim() || null,
      isEmpty,
      unknownFields: Object.keys(b).filter((k) => !KNOWN_FIELDS.has(k)),
    });
  }

  out.total = out.projects.length;
  for (const p of out.projects) {
    const s = p.status ?? '(none)';
    out.summary.byStoredStatus[s] = (out.summary.byStoredStatus[s] ?? 0) + 1;
    const st = p.stageName ?? '(none)';
    out.summary.byStage[st] = (out.summary.byStage[st] ?? 0) + 1;
    if (p.statusIsDerived) out.summary.derivedStatus++; else out.summary.pinnedStatus++;
    if (p.hasDescription) out.summary.withDescription++;
    if (p.hasNotes) out.summary.withNotes++;
    if (p.logEntries > 0) out.summary.withLog++;
    if (p.isEmpty) out.summary.empty++;
  }
  out.summary.duplicateTitles = [...titleCounts.entries()]
    .filter(([, n]) => n > 1)
    .map(([title, count]) => ({ title, count }));
  out.summary.unknownFields = [...unknown].sort();

  if (out.summary.unknownFields.length) {
    out.warnings.push(`Fields this audit does not recognise: ${out.summary.unknownFields.join(', ')}. `
      + 'Decide explicitly whether each one migrates.');
  }
  out.ok = out.errors.length === 0;
  return out;
}

/** The one-screen version, for a report that should not be a data dump. */
export function summariseProjectAudit(a: ProjectAudit): string[] {
  if (!a.ok) return a.errors;
  const lines = [
    `${a.total} Legacy Project${a.total === 1 ? '' : 's'} in the Personal profile.`,
    `${a.summary.withDescription} have a description, ${a.summary.withNotes} have notes, `
      + `${a.summary.withLog} have a progress log.`,
    `${a.summary.derivedStatus} take their status from recency; `
      + `${a.summary.pinnedStatus} were set by hand.`,
  ];
  if (a.summary.empty) lines.push(`${a.summary.empty} contain nothing but a title.`);
  if (a.summary.duplicateTitles.length) {
    lines.push(`${a.summary.duplicateTitles.length} duplicated title(s).`);
  }
  for (const p of a.excludedProfiles) {
    lines.push(`Excluded profile "${p.name ?? p.id}": ${p.projects} Project(s) left behind.`);
  }
  return lines;
}
