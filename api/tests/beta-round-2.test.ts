/**
 * The second round of beta-tester reports, 8–9 September 2026.
 *
 *   1  Diary history showed the day's description, not what you said you
 *      wanted to remember — and the grid and the panel beside it disagreed
 *   2  Two events at the same time were drawn in the same rectangle
 *   3  Calendar layer toggles forgot themselves on reload
 *   4  A time the assistant set appeared on no screen in the product
 *   5  "Due, not planned" cleared even when the plan landed after the deadline
 *   6  The Link-to dialog's close button sat next to the title
 *   7  "Notify N days before" notified nobody, ever
 *
 * Each is pinned to the property that makes it right, not to the symptom.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { previewOf } from '../src/routes/diary.js';

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');
/* Prose explains the bugs, and prose must not satisfy an assertion about code.
   Every check below reads the stripped source. */
const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');

const css = read('app.css');
const calendar = code(read('calendar.js'));
const app = code(read('app.js'));
const calRoute = readFileSync(join('src', 'routes', 'calendar.ts'), 'utf8');
const diaryRoute = readFileSync(join('src', 'routes', 'diary.ts'), 'utf8');

const web = async (f: string) => import(
  `${pathToFileURL(join(process.cwd(), '..', 'web', f)).href}?t=${Math.random()}`
) as any;

/* ══ 1 · What one line stands for a day ══════════════════════════════════ */

test('diary: what you wanted to remember beats the description', () => {
  /* The description is a description — it often opens mid-thought. "What do I
     want to remember?" is the one field somebody filled in *so that this would
     be the thing they found later*. Answering the question and then not showing
     the answer is the app ignoring the most deliberate thing on the page. */
  assert.equal(
    previewOf({ remember: 'Dad taught me to solder', daySummary: 'so, anyway, the thing is' }),
    'Dad taught me to solder',
  );
  // A title is more deliberate still — somebody named the day.
  assert.equal(previewOf({ title: 'The move', remember: 'the keys' }), 'The move');
  // And the order below it is unchanged.
  assert.equal(previewOf({ highlight: 'H', daySummary: 'S' }), 'H');
  assert.equal(previewOf({ daySummary: 'S', excerpt: 'E' }), 'S');
  assert.equal(previewOf({ excerpt: 'E' }), 'E');
  // Never "Untitled": that describes the label rather than the day.
  assert.equal(previewOf({}), null);
  assert.equal(previewOf({ title: '   ', remember: '' }), null);
});

test('diary: ONE rule decides it, and the client does not have a second', () => {
  /* The days endpoint already carried a comment saying the line was decided
     server-side "so the grid cannot decide it differently from the recent
     list" — and then /diary/recent shipped raw fields and let the client decide
     it anyway, with a shorter chain that skipped the Highlight. The same day
     could read one way in the square and another in the panel beside it. */
  const recent = diaryRoute.slice(diaryRoute.indexOf('/diary/recent'));
  assert.match(recent, /preview: previewOf\(\{/, 'the recent list still ships raw fields');
  assert.match(recent, /prompts\?\.remember/, 'the recent list cannot see `remember`');

  const days = diaryRoute.slice(diaryRoute.indexOf('/diary/days'), diaryRoute.indexOf('/diary/recent'));
  assert.match(days, /prompts\?\.remember/, 'the month grid cannot see `remember`');

  const hist = code(read('diary-history.js'));
  assert.ok(!/summaryOf|excerptOf/.test(hist), 'the client still derives its own preview');
  assert.match(hist, /e\.preview/, 'the recent row does not use the server’s line');
});

test('diary: a day with a check-in and no writing still says something', () => {
  /* `previewOf` returns null for a day recorded entirely by tapping — feeling,
     energy, sleep, nothing typed. An empty row reads as a rendering fault. */
  const hist = read('diary-history.js');
  assert.match(hist, /is-quiet/, 'a writing-free day renders an empty row');
  assert.match(css, /\.dia-recent-title\.is-quiet\{/, 'is-quiet has no styling');
});

/* ══ 2 · Two things at the same time ═════════════════════════════════════ */

test('lanes: things that overlap get a lane each; things that do not, do not', async () => {
  const { laneOut } = await web('calendar.js');
  const H = (h: number) => Date.UTC(2026, 8, 9, h) as number;

  // Apart: two clusters, each the full width.
  const apart = laneOut([
    { ref: 'a', start: H(9), end: H(10) }, { ref: 'b', start: H(14), end: H(15) }]);
  assert.equal(apart.length, 2);
  assert.deepEqual(apart.map((c: any) => c.lanes), [1, 1]);

  /* Touching is NOT overlapping. 09:00–10:00 and 10:00–11:00 are a morning,
     not a clash, and splitting the column for them would halve every event in
     a back-to-back day for no reason. */
  const touching = laneOut([
    { ref: 'a', start: H(9), end: H(10) }, { ref: 'b', start: H(10), end: H(11) }]);
  assert.equal(touching.length, 2, 'back-to-back was treated as a clash');

  // Genuinely overlapping: one cluster, two lanes, one each.
  const over = laneOut([
    { ref: 'a', start: H(9), end: H(11) }, { ref: 'b', start: H(10), end: H(12) }]);
  assert.equal(over.length, 1);
  assert.equal(over[0].lanes, 2);
  assert.deepEqual(over[0].items.map((i: any) => i.lane).sort(), [0, 1]);
});

test('lanes: a lane is reused as soon as it is free', async () => {
  const { laneOut } = await web('calendar.js');
  const M = (h: number, m = 0) => Date.UTC(2026, 8, 9, h, m) as number;
  /* A(09–11) overlaps both B(09–10) and C(10:30–11), but B and C do not
     overlap each other — so C belongs beside A in B's lane, and the day splits
     two ways rather than three. Without reuse every event in a busy morning
     would get its own sliver. */
  const [c] = laneOut([
    { ref: 'A', start: M(9), end: M(11) },
    { ref: 'B', start: M(9), end: M(10) },
    { ref: 'C', start: M(10, 30), end: M(11) },
  ]);
  assert.equal(c.lanes, 2, 'the column split three ways for two simultaneous things');
  const lane = (r: string) => c.items.find((i: any) => i.ref === r).lane;
  assert.notEqual(lane('A'), lane('B'));
  assert.equal(lane('B'), lane('C'), 'a free lane was not reused');
});

test('lanes: two things at the same instant still overlap', async () => {
  const { laneOut } = await web('calendar.js');
  const t = Date.UTC(2026, 8, 9, 9);
  /* A zero-length item has start === end, so a naive overlap test says it
     clashes with nothing — and two of them would be drawn full width, in the
     same place, which is the exact defect being fixed. */
  const [c] = laneOut([{ ref: 'a', start: t, end: t }, { ref: 'b', start: t, end: t }]);
  assert.equal(c.lanes, 2, 'two instants were drawn on top of each other');
});

test('lanes: a pair is drawn as a pair, whatever else the day holds', async () => {
  const { laneOut } = await web('calendar.js');
  const H = (h: number) => Date.UTC(2026, 8, 9, h) as number;
  /* `lanes` is per CLUSTER, not per day. Two events at nine must be half the
     column each even when three others collide at two o'clock — a day-wide
     count would make every morning event a third of the width because of an
     afternoon it has nothing to do with. */
  const cs = laneOut([
    { ref: 'a', start: H(9), end: H(10) }, { ref: 'b', start: H(9), end: H(10) },
    { ref: 'c', start: H(14), end: H(15) }, { ref: 'd', start: H(14), end: H(15) },
    { ref: 'e', start: H(14), end: H(15) },
  ], 9);
  assert.deepEqual(cs.map((c: any) => c.lanes), [2, 3]);
});

test('lanes: past what the column can hold, it says so rather than hiding it', async () => {
  const { laneOut } = await web('calendar.js');
  const H = (h: number) => Date.UTC(2026, 8, 9, h) as number;
  const [c] = laneOut([
    { ref: 'a', start: H(9), end: H(10) }, { ref: 'b', start: H(9), end: H(10) },
    { ref: 'c', start: H(9), end: H(10) },
  ], 2);
  assert.equal(c.lanes, 2, 'the cap was ignored');
  assert.equal(c.hiddenItems.length, 1, 'the third was dropped silently');
  assert.equal(c.items.filter((i: any) => !i.hidden).length, 2);
});

test('lanes: the cap is a measurement, and the marker names what it hides', () => {
  /* 110px of Plan-week column is 55px for two lanes — a time and a couple of
     words — and 37px for three, which holds neither. Day view has the width. */
  assert.match(calendar, /const laneCap = \(\) => \(cal\.mode === 'day' \? 4 : 2\)/,
    'the lane cap is no longer stated per view');
  // `+2` that will not say what it is hiding is worse than a cramped row.
  assert.match(calendar, /hiddenItems\.map\(\(x\) => x\.ref\.title\)/,
    'the overflow marker does not name what it hides');
  assert.match(calendar, /title="Also at this time: \$\{esc\(names\)\}"/);
  assert.match(calendar, /data-zoom-day=/, 'the overflow marker goes nowhere');
  // A desktop has no Day mode, so it needs its own answer, not a dead button.
  assert.match(app, /cal\.mode = MODE_IDS\(\)\.includes\('day'\) \? 'day' : 'month'/,
    'the desktop overflow marker has no destination');
});

test('lanes: the column is divided in CSS, and a lone event keeps all of it', () => {
  /* Geometry goes out as `--lane`/`--lanes` so the gutter is decided once,
     beside the radius and padding it has to agree with. */
  assert.match(css, /\.pl-ev,\.pl-block\{[\s\S]{0,200}?var\(--lane, 0\) \/ var\(--lanes, 1\)/,
    'timed blocks do not divide the column');
  assert.match(css, /width:calc\(\(100% - 6px\) \/ var\(--lanes, 1\)/);
  /* The defaults matter: an ordinary day is one thing at a time, and it must
     be drawn exactly as it always was. lane 0 of 1 is the full column. */
  assert.match(css, /--lanes, 1/, 'the default is not a single full-width lane');
  assert.ok(!/\.pl-ev,\.pl-block\{position:absolute;left:3px;right:3px/.test(css),
    'the old full-width rule is still there');

  /* Only a box WITH a neighbour separates itself — a lone event that grew an
     outline would be paying for a problem it does not have. */
  assert.match(css, /\.pl-ev\.is-shared,\.pl-block\.is-shared\{/);
  assert.match(css, /\.pl-ev\.is-lane-alt\{/, 'neighbouring lanes do not step tone');

  /* NOT a hue change. The left border carries which CALENDAR an event came
     from, in the same colour language as the month dots and the layer control.
     Recolouring on overlap would trade that away to say what position says. */
  assert.match(css, /\.pl-ev\{background:var\(--surface-3\);border-left:3px solid var\(--src/,
    'the source colour no longer survives on an event');
});

test('lanes: events and planned blocks share one pool', () => {
  /* Laning them separately would leave a planned block sitting on top of an
     event — the same defect wearing a different hat. */
  const fn = calendar.slice(calendar.indexOf('function planDayHtml'));
  const call = fn.slice(fn.indexOf('laneOut(['), fn.indexOf('laneCap()'));
  assert.match(call, /kind: 'event'/);
  assert.match(call, /kind: 'block'/);
});

test('lanes: all-day events are not in this at all', () => {
  /* A Friday-to-Sunday holiday and a Saturday outing are not a clash, and
     never were: all-day events live in the strip above the axis. */
  const fn = calendar.slice(calendar.indexOf('function planDayHtml'));
  assert.match(fn, /const timed = events\.filter\(\(e\) => !e\.isAllDay/);
  assert.match(fn, /const allDay = events\.filter\(\(e\) => e\.isAllDay\)/);
  assert.match(calendar, /\.filter\(\(e\) => !e\.isAllDay && e\.startsAt && e\.endsAt\)/,
    'the clash detector no longer excludes all-day events');
});

/* ══ 3 · The layer control remembers ═════════════════════════════════════ */

test('layers: a deliberate choice survives a reload', async () => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
  };
  const { cal, restoreLayers, saveLayers } = await web('calendar.js');

  cal.layers.tasks = false;
  saveLayers();
  cal.layers.tasks = true;             // as a fresh page load would have it
  restoreLayers();
  assert.equal(cal.layers.tasks, false, 'turning a layer off did not survive');

  /* Only layers this build knows, and only booleans. A shape stored by another
     build must not introduce a layer this one cannot draw, or turn one into a
     string that reads as permanently on. */
  store.set('los2_cal_layers', JSON.stringify({ tasks: 'yes', wormholes: true }));
  cal.layers.tasks = true;
  restoreLayers();
  assert.equal(cal.layers.tasks, true, 'a non-boolean was accepted');
  assert.equal((cal.layers as any).wormholes, undefined, 'an unknown layer was accepted');

  // A browser that refuses storage still gets a working calendar.
  store.set('los2_cal_layers', '{ not json');
  assert.doesNotThrow(() => restoreLayers());
  delete (globalThis as any).localStorage;
});

test('layers: the toggle writes, and the load reads', () => {
  assert.match(app, /saveLayers\(\);\s*\n\s*paintCalendar\(\)/, 'toggling a layer does not save');
  assert.match(app, /restoreLayers\(\)/, 'nothing restores the layers on load');
});

/* ══ 4 · The time the assistant set ══════════════════════════════════════ */

test('intents: a task can carry three times, and all three are now visible', () => {
  /* `dueDate` is the deadline, a schedule block is time actually held, and
     `scheduledAt` is "I mean to do this then" without holding anything. The
     assistant writes the third whenever somebody says "I'll do that Thursday at
     three" — and Calendar queried the first two and never the third, so the
     time it confirmed out loud appeared on no screen in the product. */
  assert.match(calRoute, /const intents = \(await db\.select\(\{/, 'intended times are not queried');
  assert.match(calRoute, /isNotNull\(tasks\.scheduledAt\)/);
  assert.match(calRoute, /gte\(tasks\.scheduledAt, from\)/);
  assert.match(calRoute, /eq\(tasks\.status, 'open'\)/);
  assert.match(calRoute, /isNull\(tasks\.archivedAt\)/, 'archived tasks come back as intentions');
  // A task that also HOLDS the time would otherwise be drawn twice.
  assert.match(calRoute, /\.filter\(\(t\) => !blocks\.some\(\(b\) => b\.taskId === t\.id\)\)/,
    'a task with a block is drawn twice');
  assert.match(calRoute, /\n      intents,/, 'intents are not returned');
});

test('intents: a mark on the axis, never a block', () => {
  /* An intention that silently reserved an hour would make the day read as
     committed, eat a free window that is genuinely still free, and count
     against workload. */
  assert.match(calendar, /class="pl-intent"/, 'intended times are not drawn');
  assert.ok(!/pl-intent[\s\S]{0,200}?height:/.test(calendar),
    'an intended time was given a duration');
  assert.match(css, /\.pl-intent\{position:absolute/);
  assert.ok(!/\.pl-intent\{[^}]*height:/.test(css), 'the marker has a block height');
  // Same layer as the rest of a task's times, or the control lies.
  assert.match(calendar, /intents: cal\.layers\.tasks/, 'the Tasks layer does not hide them');
  assert.match(app, /\[data-task-open\]/, 'an intended time does not open its task');
});

/* ══ 5 · Planned, but not in time ════════════════════════════════════════ */

test('attention: a plan that lands after the deadline is not silence', () => {
  const fn = calendar.slice(calendar.indexOf('function railAttentionHtml'));
  /* "Due, not planned" used to clear the moment a task got a block — at ANY
     time, including after the deadline. Schedule a Friday task for Saturday and
     the app went quiet, which is the one moment it had something to say. */
  assert.match(fn, /const late = inScope\.filter/, 'nothing notices a late plan');
  assert.match(fn, /!bs\.some\(\(b\) => iso\(new Date\(b\.startsAt\)\) <= t\.dueDate\)/,
    'lateness is not measured against the due date');
  assert.match(fn, /planned after it is due/);

  /* The test is "nothing you planned lands on or before the day it is due",
     not "the latest block is late". A task planned Wednesday AND Saturday for a
     Friday deadline is planned in time, and saying otherwise would be the
     warning crying wolf at somebody who did the right thing. */
  assert.match(fn, /bs\.length && !bs\.some/, 'any late block is enough to warn');
  assert.match(fn, /const unplanned = inScope\.filter\(\(t\) => !blocksFor\(t\.id\)\.length\)/,
    'a task with no plan at all is no longer separated from one planned late');
});

/* ══ 6 · The close button on "Link to" ═══════════════════════════════════ */

test('link picker: the close button sits where every other one does', () => {
  /* `.m-head` is a flex row and `.m-title` grows, which is what pushes the ×
     to the right edge everywhere else. This heading is a plain <h2>, so it was
     only as wide as the words "Link to" — leaving the × parked 12px after them
     with 410px of empty header beside it. Measured in a browser, not guessed. */
  assert.match(css, /\.rel-pick-h\{[^}]*flex:1/, 'the Link-to title still does not grow');
  assert.match(css, /\.m-head\{display:flex/, 'the header is no longer a flex row');
  assert.match(css, /\.m-title\{flex:1/, 'the pattern this copies has changed');
});

/* ══ 7 · A promise the app could not keep ════════════════════════════════ */

test('lead time: nothing claims to notify, because nothing notifies', () => {
  /* There is no push in Life OS — no service worker subscription, no VAPID
     keys, no scheduler. The field saved, the calendar printed "7d notice", and
     no phone ever made a sound. A promise the app cannot keep is worse than an
     absent feature: it stops somebody setting a real reminder somewhere that
     works. */
  const modal = code(read('reminder-modal.js'));
  assert.ok(!/'Notify'/.test(modal), 'the reminder modal still says Notify');
  assert.match(modal, /row\('Start showing'/, 'the field does not say what it does');
  assert.match(read('reminder-modal.js'), /cannot send phone notifications yet/,
    'nothing tells the user there are no notifications');

  assert.ok(!/\['Notify',/.test(app), 'the reminder detail still says Notify');
  assert.ok(!/d notice/.test(calendar), 'the calendar chip still implies something arrives');

  // And nothing anywhere requests the permission we do not act on.
  for (const [name, src] of [['app.js', app], ['calendar.js', calendar]] as const) {
    assert.ok(!/Notification\.requestPermission|pushManager/.test(src),
      `${name} asks for a notification permission nothing uses`);
  }
});

test('lead time: it reaches past the period on screen', () => {
  /* Caught by looking, not by reasoning: with the fix in and a reminder due
     next Monday with a seven-day lead, the attention card said nothing while
     Plan week was open — because the reminder was expanded into the visible
     week and its due date was in the next one.
     "A week early, but only if the week you are looking at already contains
     it" is not a lead time. */
  assert.match(calRoute, /const maxLead = Math\.max\(0, \.\.\.allRems\.map\(\(r\) => r\.leadDays \?\? 0\)\)/,
    'the expansion window ignores lead times');
  assert.match(calRoute, /expand\(r\.dueDate, rule, q\.data\.from, expandTo\)/,
    'occurrences are still expanded only to the visible end');
  // A workspace with no lead times expands exactly the range it always did.
  assert.match(calRoute, /maxLead > 0 \? addDays\(q\.data\.to, maxLead\) : q\.data\.to/,
    'the window widens even when nobody uses lead times');
  /* And nothing new is DRAWN: every day cell filters by its own date, so an
     occurrence past the visible end matches no cell. */
  assert.match(calendar, /reminders: cal\.layers\.reminders \? d\.reminders\.filter\(\(r\) => r\.dueDate === dayIso\)/,
    'a day cell no longer filters reminders to its own date');
});

test('lead time: the field now does the thing its label claims', () => {
  /* Honestly worded and still dead would only be half a fix. A reminder inside
     its own lead window now says so, which is exactly what the label claims. */
  const fn = calendar.slice(calendar.indexOf('function railAttentionHtml'));
  assert.match(fn, /r\.leadDays > 0/, 'lead time still drives nothing');
  assert.match(fn, /iso\(addDays\(parseIso\(r\.dueDate\), -r\.leadDays\)\) <= todayIso/,
    'the lead window is not computed from the due date');
  // A reminder with no lead time is not asking to be seen early.
  assert.match(fn, /const soon = \(d\.reminders \?\? \[\]\)\.filter\(\(r\) => r\.status === 'open'/);
});
