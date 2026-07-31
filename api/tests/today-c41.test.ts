/**
 * Phase C4.1 — habit ring, drag insertion, task completion.
 *
 * Source assertions, with the same caveat as the other web tests: they prove a
 * rule is written down, not that a browser honours it. The runtime behaviour
 * was measured with synthetic pointer events in a real browser and the numbers
 * are in the phase report.
 *
 * Each rule here corresponds to a defect that actually shipped, so the comments
 * record the failure rather than restating the assertion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');
const html = read('index.html');
const app = read('app.js');
const drag = read('drag.js');
const motion = read('motion.js');
const habitModal = read('habit-modal.js');
const docs = readFileSync(join('..', 'docs', 'motion-strategy.md'), 'utf8');

const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');

const appCode = code(app);
const dragCode = code(drag);

/** The body of a top-level function, for "this path must not call X" rules. */
function body(src: string, decl: string): string {
  const at = src.indexOf(decl);
  assert.ok(at > -1, `${decl} not found`);
  const rest = src.slice(at + decl.length);
  const end = rest.search(/\n(?:async )?function /);
  return end === -1 ? rest : rest.slice(0, end);
}

/* ── Habit ring geometry ─────────────────────────────────────────────── */

test('ring: geometry is declared in percentages, not a computed circumference', () => {
  // 2*PI*13 = 81.681, but a browser draws <circle> as four Bezier arcs whose
  // real length is 81.155. The hard-coded constant drifted every partial fill.
  assert.ok(!appCode.includes('RING_C'), 'the hard-coded circumference is back');
  assert.ok(!/2 \* Math\.PI \* \d/.test(appCode), 'the circumference is being computed');
  assert.match(appCode, /pathLength="100"/, 'the ring does not declare pathLength');
  assert.match(appCode, /stroke-dasharray="100"/, 'the dash is not in percentage units');
  assert.match(appCode, /stroke-dashoffset="\$\{\(100 - pct \* 100\)/,
    'the offset is not a percentage of the declared length');
});

test('ring: the fill is a closed circle with butt caps and no arrow tail', () => {
  assert.match(html, /\.hr-fill\{[^}]*stroke-linecap:butt/,
    'a round cap overshoots the seam at 100% and leaves a dot at 0%');
  assert.ok(!/\.hr-fill\{[^}]*stroke-linecap:round/.test(html), 'round caps are back');
  // Zero progress hides the stroke outright rather than relying on the dash.
  assert.match(html, /\.hr-fill\.is-empty\{opacity:0\}/, 'an empty ring can still paint');
  assert.ok(!/<path/.test(appCode.slice(appCode.indexOf('function habitRowHtml'),
    appCode.indexOf('function wireRail'))), 'the ring is drawn with a path, not a circle');
});

test('ring: the svg rule is scoped so it cannot capture nested icons', () => {
  // THE ARROW BUG. `.hb-ring svg` also matched the check icon inside .hr-mark
  // and forced it to 32px, position:absolute, inset:0 and rotate(-90deg) — a
  // checkmark blown up 2.5x, stretched over the control and turned on its side.
  assert.ok(!/\.hb-ring svg\{/.test(html), 'the unscoped descendant selector is back');
  assert.match(html, /\.hb-ring>svg\.hr-svg\{/, 'the ring svg rule is not scoped');
  assert.match(appCode, /<svg class="hr-svg"/, 'the ring svg carries no distinguishing class');
  // The centre icon must be immune to ancestor sizing.
  assert.match(html, /\.hr-mark>svg\{width:14px;height:14px;position:static;transform:none\}/,
    'the centre icon is not pinned to its own size');
});

test('ring: binary and target-count fills are one calculation', () => {
  assert.match(appCode, /function habitPct/, 'no shared fill calculation');
  const fn = body(appCode, 'function habitPct(h)');
  assert.match(fn, /target > 1/, 'target-count habits are not handled');
  assert.match(fn, /Math\.min\(1,/, 'progress can exceed a full ring');
  assert.match(fn, /completedToday \? 1 : 0/, 'binary habits have no branch');
});

/* ── Habit interaction ───────────────────────────────────────────────── */

test('habits: the row is mutated in place so the fill can transition', () => {
  // `outerHTML =` gives the browser a new <circle> already at its final offset,
  // so the CSS transition has no start value and the ring snaps. Measured: the
  // offset was final 60ms after the click.
  const fn = body(appCode, 'function patchHabitRow(id)');
  assert.ok(!/row\.outerHTML\s*=/.test(fn), 'the row is replaced, killing the transition');
  assert.match(fn, /fill\.setAttribute\('stroke-dashoffset'/, 'the offset is not updated in place');
  assert.match(fn, /row\.classList\.toggle\('is-done'/, 'completion state is not toggled in place');
  assert.match(html, /transition:stroke-dashoffset var\(--d-slow\)/, 'the fill does not transition');
});

test('habits: check and undo share one path, and rollback restores state', () => {
  const fn = body(appCode, 'async function toggleHabit(id)');
  assert.match(fn, /wasDone \? 'uncheck' : 'check'/, 'check and undo diverge');
  assert.match(fn, /Object\.assign\(h, before\)/, 'a failed toggle does not roll back');
  assert.match(fn, /finally/, 'the busy flag can leak on failure');
  // Each press adds one; pressing a complete habit clears it.
  assert.match(fn, /Math\.min\(target, \(h\.todayCount \?\? 0\) \+ 1\)/,
    'a target-count habit does not increment');
  assert.match(fn, /nowDone !== wasDone/, 'the streak moves when completion did not change');
});

test('habits: celebration is one restrained pulse, never particles', () => {
  const fn = body(appCode, 'function celebrateHabit(id)');
  assert.match(fn, /reducedMotion\(\)/, 'the celebration ignores reduced motion');
  assert.ok(!/confetti|particle|firework/i.test(appCode),
    'a particle effect exists');
  const peaks = fn.match(/scale\(([\d.]+)\)/g) ?? [];
  for (const p of peaks) {
    const n = Number(p.replace(/[^\d.]/g, ''));
    assert.ok(n <= 1.15, `celebration scales to ${n} — that is a bounce, not a pulse`);
  }
});

test('habits: the streak sits beside the habit, not floating at the row edge', () => {
  assert.match(appCode, /function streakHtml/, 'no shared streak rendering');
  assert.match(appCode, /hs-unit">d</, 'the compact "2d" label is gone');
  assert.match(html, /\.hb-streak\.is-zero\{/, 'a zero streak is not understated');
  assert.ok(!/\.hb-streak\{[^}]*text-align:right/.test(html),
    'the streak is pinned to the row edge again');
});

test('habits: editing stays reachable from the rail', () => {
  assert.match(appCode, /function editHabit/, 'habits cannot be edited from the rail');
  assert.match(appCode, /data-habit-open=/, 'no edit affordance on the row');
  for (const cap of ['onSave', 'onArchive', 'onRestore', 'onDelete']) {
    assert.ok(habitModal.includes(cap), `the habit modal cannot ${cap}`);
  }
  assert.match(habitModal, /h-freq/, 'frequency cannot be edited');
  assert.match(habitModal, /h-days-field/, 'applicable days cannot be edited');
  assert.match(habitModal, /h-target/, 'target count cannot be edited');
  assert.match(habitModal, /h-area/, 'area cannot be edited');
  assert.match(habitModal, /h-recent/, 'recent history is not shown');
  assert.ok(habitModal.includes('cannot be undone'), 'deletion is not confirmed');
});

/* ── Drag: live insertion preview ────────────────────────────────────── */

test('drag: native HTML5 drag-and-drop is gone', () => {
  // It cannot preview an insertion gap and never fires on touch.
  assert.ok(!/draggable="true"/.test(appCode), 'cards are still natively draggable');
  assert.ok(!/ondragstart|ondragover|ondrop\b|dataTransfer/.test(appCode),
    'native drag handlers survive');
  assert.match(dragCode, /pointerdown/, 'drag is not pointer-based');
  assert.match(dragCode, /pointercancel/, 'a cancelled pointer strands the drag');
});

test('drag: a real placeholder holds the proposed position', () => {
  assert.match(dragCode, /className = 'task-placeholder'/, 'no placeholder element');
  assert.match(dragCode, /ph\.style\.height = `\$\{rect\.height\}px`/,
    'the placeholder does not match the card height');
  assert.match(html, /\.task-placeholder\{/, 'the placeholder has no styling');
  // The card keeps its visible size while lifted.
  assert.match(dragCode, /card\.style\.width = `\$\{rect\.width\}px`/,
    'the lifted card does not keep its width');
});

test('drag: insertion index is decided by card midpoints', () => {
  assert.match(dragCode, /y < r\.top \+ r\.height \/ 2/, 'midpoint crossing is not used');
  // Only cards present in the DOM count, which is what keeps an Area filter
  // honest: a hidden task can never be chosen as an insertion anchor.
  assert.match(dragCode, /zone\.querySelectorAll\('\.task'\)/,
    'insertion considers something other than the visible cards');
});

test('drag: neighbours are moved with FLIP, never rebuilt', () => {
  assert.match(dragCode, /function flipSiblings/, 'no FLIP during drag');
  assert.match(dragCode, /getBoundingClientRect\(\)/, 'FLIP does not measure');
  assert.ok(!/innerHTML/.test(dragCode), 'the drag path replaces markup');
  // The dragged card follows the pointer and must be excluded from the layout
  // animation, or it fights the transform driving it.
  assert.match(dragCode, /filter\(\(c\) => c !== session\.card\)/,
    'the dragged card is included in the sibling FLIP');
});

test('drag: nothing is persisted until the drop', () => {
  assert.ok(!/\bapi\(|fetch\(/.test(dragCode), 'the drag module talks to the API directly');
  assert.match(dragCode, /hooks\.onDrop\(/, 'the drop does not notify the app');
  // One call, made from finish() only.
  assert.equal((dragCode.match(/onDrop\(/g) ?? []).length, 1,
    'onDrop is called from more than one place');
});

test('drag: the drop does not reshuffle a board that is already correct', () => {
  // The placeholder already holds the final slot, so rebuilding would destroy
  // node identity and produce the second reorganisation this phase removes.
  assert.match(appCode, /settled: true/, 'the drop path still rebuilds');
  const fn = body(appCode, 'async function moveTask(id, bucket, anchor = {}, opts = {})');
  assert.match(fn, /if \(opts\.settled\)/, 'moveTask has no settled path');
  const settled = fn.slice(fn.indexOf('if (opts.settled)'), fn.indexOf('} else {'));
  assert.ok(!/rebuildBucket/.test(settled), 'the settled path rebuilds buckets');
  assert.ok(!/loadRoute/.test(fn), 'moving a task reloads the route');
});

test('drag: auto-scroll exists near the edges', () => {
  assert.match(dragCode, /EDGE/, 'no edge auto-scroll');
  assert.match(dragCode, /requestAnimationFrame/, 'auto-scroll is not frame-driven');
  assert.match(dragCode, /scrollTop \+= dy/, 'auto-scroll does not move the scroller');
});

test('drag: reduced motion still produces the correct final state', () => {
  assert.match(dragCode, /reducedMotion\(\)/, 'drag ignores reduced motion');
  const fn = body(dragCode, 'function flipSiblings(mutate)');
  assert.match(fn, /if \(reducedMotion\(\)\) \{ mutate\(\); return; \}/,
    'reduced motion skips the mutation as well as the animation');
});

test('drag: touch has a hold delay so the board can still be scrolled', () => {
  assert.match(dragCode, /TOUCH_HOLD/, 'a finger drag hijacks scrolling immediately');
  assert.match(dragCode, /pointerType === 'touch'/, 'touch is not distinguished');
});

test('move: drag, keyboard and the Move menu share one commit path', () => {
  assert.match(appCode, /function shiftBucket/, 'no keyboard bucket move');
  assert.match(appCode, /function nudge/, 'no keyboard reorder');
  // All of them end up in moveTask; only the drop passes settled.
  for (const caller of ['shiftBucket', 'nudge']) {
    assert.match(body(appCode, `function ${caller}(`), /moveTask\(/,
      `${caller} does not use the shared move path`);
  }
});

/* ── Task completion ─────────────────────────────────────────────────── */

test('completion: acknowledges immediately, then collapses', () => {
  const fn = body(appCode, 'async function toggleTask(id)');
  assert.match(fn, /classList\.add\('is-completing'\)/, 'no immediate acknowledgement');
  assert.match(fn, /collapseOut\(card, removeNode\)/, 'the card does not collapse out');
  assert.match(html, /\.task\.is-completing \.t-tick\{background:var\(--ok\)/,
    'the tick does not confirm completion');
  assert.match(html, /\.task\.is-completing \.t-title\{[^}]*line-through/,
    'the title does not soften');
});

test('completion: removes one node and never rebuilds the bucket', () => {
  // Rebuilding destroys identity for every REMAINING card, which is why the
  // gap used to snap shut instead of closing.
  const fn = body(appCode, 'async function toggleTask(id)');
  const rmAt = fn.indexOf('const removeNode');
  const removeFn = fn.slice(rmAt, fn.indexOf('if (card && !wasDone)', rmAt));
  assert.match(removeFn, /card\?\.remove\(\)/, 'the card node is not removed directly');
  assert.ok(!/rebuildBucket/.test(removeFn), 'completion rebuilds the bucket');
  assert.ok(!/loadRoute/.test(fn), 'completion reloads the route');
  assert.ok(!/main-scroll'\)\.innerHTML\s*=/.test(fn), 'completion replaces main-scroll');
  assert.match(fn, /syncBucketCounts\(\)/, 'the bucket count is not kept honest');
});

test('completion: a hidden tab cannot strand the card', () => {
  assert.match(code(motion), /settle\(anim, 200, onDone\)/,
    'collapseOut does not use the timeout guarantee');
  assert.match(code(motion), /setTimeout\(once, duration/, 'settle has no timeout');
});

test('completion: failure puts the card back where it was', () => {
  const fn = body(appCode, 'async function toggleTask(id)');
  assert.match(fn, /state\.tasks\.push\(t\)/, 'the task is not restored to state');
  assert.match(fn, /parent\.insertBefore\(card, parent\.children\[index\]/,
    'the card is not restored to its original index');
  assert.match(fn, /classList\.remove\('is-completing'\)/, 'stale completed styling remains');
});

/* ── Rail ────────────────────────────────────────────────────────────── */

test('rail: Up Next is gone and was not replaced with filler', () => {
  for (const gone of ['pickUpNext', 'up-next', 'un-title', 'un-actions', 'Up next']) {
    assert.ok(!app.includes(gone), `Up Next survives as ${gone}`);
    assert.ok(!html.includes(gone), `Up Next styling survives as ${gone}`);
  }
  const rail = body(appCode, 'function renderRail()');
  assert.match(rail, /Habits today/, 'the rail lost Habits');
  // Nothing invented in its place.
  assert.ok(!/Upcoming|Recently finished|Active work|Your day|Quick capture/i.test(rail),
    'a filler card took Up Next\'s place');
});

test('rail: the reason Up Next was removed is written down, with the way back', () => {
  // Removing a feature without recording why invites someone to rebuild it.
  assert.match(app, /ARCHITECTURE NOTE/, 'no note for whoever restores Up Next');
  for (const signal of ['calendar', 'due date', 'reminder', 'deadline']) {
    assert.match(app.toLowerCase(), new RegExp(signal),
      `the note does not mention ${signal} as a required signal`);
  }
});

test('rail: Area filters survive', () => {
  assert.ok(appCode.includes('areaFilter'), 'the Area filter was dropped');
});

/* ── Strategy ────────────────────────────────────────────────────────── */

test('motion strategy is documented with the build-now/defer split', () => {
  assert.match(docs, /Interaction-explaining motion is built alongside each feature/,
    'the locked rule is not stated');
  for (const now of ['drag insertion', 'completion', 'rollback', 'Modal open']) {
    assert.ok(docs.includes(now), `"${now}" is not listed as built now`);
  }
  for (const later of ['celebration', 'star-field', 'composer']) {
    assert.ok(docs.toLowerCase().includes(later.toLowerCase()),
      `"${later}" is not listed as deferred`);
  }
  assert.match(docs, /pathLength="100"/, 'the ring geometry lesson is not recorded');
});

/* ── Data integrity ──────────────────────────────────────────────────── */

test('data: this phase cannot have moved the imported rows', () => {
  // The imported counts (71 tasks / 21 active / 50 completed / 20 steps /
  // 4 areas / 5 habits / 131 habit entries) live in staging and cannot be
  // asserted from here. What CAN be asserted is the thing that protects them:
  // C4.1 is frontend-only, so no schema, no migration and no writer changed.
  const migrations = readdirSync(join('..', 'api', 'drizzle'))
    .filter((f) => f.endsWith('.sql'));
  assert.equal(migrations.length, 2, 'a migration was added or removed this phase');

  // No destructive verb may reach the database from the web client at all.
  for (const f of ['app.js', 'drag.js', 'motion.js', 'habit-modal.js', 'task-modal.js']) {
    const src = read(f);
    // Anchored on SQL context: a bare /DROP /i matches the word "drop", and
    // this codebase is full of drop zones.
    assert.ok(!/(DROP TABLE|TRUNCATE TABLE|DELETE FROM)/i.test(src),
      `${f} contains raw SQL`);
    assert.ok(!/firebase-firestore|onSnapshot|setDoc|collection\(/.test(src),
      `${f} touches Firestore`);
  }
  // Deleting a habit must stay explicitly opt-in; archive is the default.
  assert.match(appCode, /permanent=true/, 'habit deletion is no longer explicit');
});

test('data: dragging can never write more than once per drop', () => {
  // A per-frame or per-index write would rewrite sparse positions continuously
  // and could corrupt ordering under a slow connection.
  assert.ok(!/api\(|fetch\(/.test(dragCode), 'the drag module writes directly');
  // Checked against the raw source: dragCode has its comments stripped.
  assert.match(drag, /Nothing is written while dragging/, 'the rule is not recorded');
});
