/**
 * Diary — the API surface, the civil-date arithmetic, and the state.
 *
 * ── The date is the whole problem ────────────────────────────────────────
 *
 * `new Date().toISOString().slice(0,10)` is the UTC date. In Johannesburg that
 * is yesterday until 02:00, so a diary opened at half past midnight would show
 * the wrong day and — worse — write into it. Everything here uses LOCAL
 * getters, and every date that leaves this module is a civil `YYYY-MM-DD`
 * string that never becomes a timestamp again.
 *
 * The server takes the same view: it validates the shape and compares, and
 * never derives a date of its own.
 */

/** Injected by app.js so this module needs no knowledge of auth or workspace. */
let call = null;
export function initDiaryApi(apiFn) { call = apiFn; }

/* ── Civil dates ─────────────────────────────────────────────────────── */

const pad = (n) => String(n).padStart(2, '0');

/** Today, in the browser's own reckoning. Local getters, never toISOString. */
export function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The zone the browser believes it is in. Recorded, never used for maths. */
export const localZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
};

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(s) {
  if (typeof s !== 'string' || !ISO_DATE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  // Built at NOON UTC so no offset can push it into a neighbouring day.
  const probe = new Date(Date.UTC(y, m - 1, d, 12));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1
    && probe.getUTCDate() === d;
}

/** Civil arithmetic. Noon UTC throughout, so no zone can shift the answer. */
export function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  const p = new Date(Date.UTC(y, m - 1, d + days, 12));
  return `${p.getUTCFullYear()}-${pad(p.getUTCMonth() + 1)}-${pad(p.getUTCDate())}`;
}

export function addMonths(date, months) {
  const [y, m] = date.split('-').map(Number);
  const p = new Date(Date.UTC(y, m - 1 + months, 1, 12));
  return `${p.getUTCFullYear()}-${pad(p.getUTCMonth() + 1)}-01`;
}

/** A Date built at NOON, only ever for formatting. Never read back as a date. */
export const asDate = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
};

export const formatLong = (s) => asDate(s).toLocaleDateString(undefined,
  { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
export const formatShort = (s) => asDate(s).toLocaleDateString(undefined,
  { day: 'numeric', month: 'short' });
export const dayName = (s) => asDate(s).toLocaleDateString(undefined, { weekday: 'long' });
export const monthName = (s) => asDate(s).toLocaleDateString(undefined,
  { month: 'long', year: 'numeric' });

/** "today", "yesterday", or the date — for history rows. */
export function relativeDay(date, today = localToday()) {
  if (date === today) return 'Today';
  if (date === addDays(today, -1)) return 'Yesterday';
  return formatLong(date);
}

/**
 * The month grid for a date: whole weeks, Monday first.
 *
 * Leading and trailing days come from the neighbouring months and are marked,
 * so the grid is always six rows of seven and never reflows as you page
 * through — a calendar that changes height while you navigate is a calendar
 * you have to re-find your place in every time.
 */
export function monthGrid(date) {
  const [y, m] = date.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1, 12));
  // getUTCDay is 0=Sunday; shift so Monday is 0.
  const lead = (first.getUTCDay() + 6) % 7;
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const p = new Date(Date.UTC(y, m - 1, 1 - lead + i, 12));
    const iso = `${p.getUTCFullYear()}-${pad(p.getUTCMonth() + 1)}-${pad(p.getUTCDate())}`;
    cells.push({
      date: iso,
      day: p.getUTCDate(),
      inMonth: p.getUTCMonth() === m - 1,
    });
  }
  return cells;
}

/* ── State ───────────────────────────────────────────────────────────── */

export const dia = {
  /** The civil date being shown. Never null once Diary has opened. */
  date: null,
  /** The entry for that date, or null when nothing has been written. */
  entry: null,
  /** An archived entry holding this date, offered for restore. */
  archivedEntry: null,
  /**
   * The guided prompts and the check-in for the open day.
   *
   * Held beside `entry` rather than read out of it, because it changes on every
   * chip tap and the right page must repaint from it without waiting for a
   * write to come back.
   */
  reflection: {},
  /** `{ current, wroteToday }`, or null until it has loaded. */
  streak: null,

  mode: 'entry',        // 'entry' | 'history'
  contextOpen: false,   // the optional daily context panel
  loading: false,
  error: null,

  /** History. */
  month: null,          // the month being shown, as its first day
  days: [],             // presence, for the grid
  recent: [],
  /** Search. */
  query: '',
  results: null,
};

export const MOODS = [
  { id: 'very_low', label: 'Very low' },
  { id: 'low', label: 'Low' },
  { id: 'neutral', label: 'Neutral' },
  { id: 'good', label: 'Good' },
  { id: 'very_good', label: 'Very good' },
];
export const ENERGIES = [
  { id: 'very_low', label: 'Very low' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'very_high', label: 'Very high' },
];

export const EMPTY_DOC = { type: 'doc', content: [] };

/* ── Requests ────────────────────────────────────────────────────────── */

export async function loadDay(date) {
  const r = await call(`/diary/entries/${date}`);
  dia.date = date;
  dia.entry = r.entry;
  dia.archivedEntry = r.archivedEntry ?? null;
  dia.reflection = r.entry?.reflection ?? {};
  return r;
}

/** The current run of written days. A fact for the right page, never a target. */
export async function loadStreak(today = localToday()) {
  const r = await call(`/diary/streak?today=${today}`);
  dia.streak = r;
  return r;
}

/**
 * Writes a date.
 *
 * `entry` comes back null when the payload had nothing worth keeping — the
 * server refuses to create a row for an empty day, and that is a success, not
 * a failure. A 409 is surfaced as a typed error because the caller has to do
 * something quite different with it.
 */
export async function saveDay(date, body) {
  try {
    const r = await call(`/diary/entries/${date}`, { method: 'PUT', body });
    return r;
  } catch (e) {
    if (/changed somewhere else/i.test(e.message) || e.status === 409) {
      const c = new Error(e.message);
      c.conflict = true;
      throw c;
    }
    if (/archived entry/i.test(e.message)) {
      const a = new Error(e.message);
      a.archived = true;
      throw a;
    }
    throw e;
  }
}

export const archiveEntry = (id) =>
  call(`/diary/entries/${id}/archive`, { method: 'POST' });
export const restoreEntry = (id) =>
  call(`/diary/entries/${id}/restore`, { method: 'POST' });

export async function loadMonth(monthDate) {
  const r = await call(`/diary/days?month=${monthDate}`);
  dia.month = r.from;
  dia.days = r.days;
  return r;
}

export async function loadRecent(limit = 8) {
  const r = await call(`/diary/recent?limit=${limit}`);
  dia.recent = r.entries;
  return r;
}

/** The nearest day before or after this one that actually has an entry. */
export const adjacentEntry = (date, direction) =>
  call(`/diary/adjacent?date=${date}&direction=${direction}`);

export const searchDiary = (q) =>
  call(`/diary/search?q=${encodeURIComponent(q)}`);

/* ── Sample tooling ──────────────────────────────────────────────────── */

export const sampleCheck = () => call('/diary/sample');
export const sampleAdd = () => call('/diary/sample', {
  method: 'POST', body: { today: localToday() },
});
export const sampleRemove = () => call('/diary/sample/remove', { method: 'POST' });
