/**
 * Three things reported by beta testers, 7 September 2026.
 *
 *   · the phone's Back button jumped out of Settings entirely
 *   · Search sat below Settings at the bottom of the More sheet
 *   · the Library shelf's hover and open animations overlapped books
 *
 * Each is pinned to the PROPERTY that makes it right, not to the symptom.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const web = (f: string) => readFileSync(join('..', 'web', f), 'utf8');
/* Comments explain the bugs in prose, and prose must not satisfy an assertion
   about code. Every check below reads the stripped source. */
const code = (f: string) => web(f)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

/* ══ The phone's Back button ═════════════════════════════════════════════ */

test('back: which Settings page is open lives in the URL, like every other section', () => {
  const app = code('app.js');
  /* Settings was the ONE section keeping its position in JavaScript. Calendar
     → More → Settings → Account, then Back, popped `#settings` and landed on
     Calendar — because opening Account had created no history entry at all.
     Every other section is already in the hash: `#library/book/<id>`,
     `#diary/<date>`, `#projects/<id>`, `#calendar/reminders`. */
  assert.match(app, /const settingsTabFromHash = \(\) =>/,
    'nothing reads a Settings panel out of the hash');
  assert.match(app, /function openSettingsTab\(id/,
    'there is no single place that opens a Settings page');
  assert.match(app, /setHash\(id \? `#settings\/\$\{id\}` : '#settings'\)/,
    'opening a panel does not write the URL');

  /* The two deep links into a Settings page — the habits sheet's "All habits"
     and the calendar's "reconnect" — say which page in the URL rather than
     setting it and rendering. A named destination that leaves no history entry
     is the same bug in a different place. */
  assert.match(app, /setHash\('#settings\/habits'\)/,
    'the habits deep link does not name its page in the URL');
  assert.match(app, /openSettingsTab\('integrations'\)/,
    'the integrations deep link does not go through the one opener');
});

test('back: the tab buttons and the in-page arrow both go through the URL', () => {
  const app = code('app.js');
  assert.match(app, /el\.onclick = \(\) => openSettingsTab\(el\.dataset\.stab\)/,
    'a Settings tab button no longer writes the URL');
  assert.match(app, /\[data-stab-back\][\s\S]{0,200}openSettingsTab\(null\)/,
    'the in-page back arrow no longer returns to the index by URL');
});

test('back: forward and back INSIDE Settings repaint the screen', () => {
  const app = code('app.js');
  /* The route does not change between `#settings` and `#settings/account`, so
     nothing else re-renders. Without this the URL would move and the screen
     would sit still — which is the same class of defect in the other
     direction. */
  const at = app.indexOf("if (r === 'settings') {");
  assert.ok(at > 0, 'hashchange does not handle movement inside Settings');
  const block = app.slice(at, at + 400);
  assert.match(block, /settingsTabFromHash\(\)/);
  assert.match(block, /renderSettings\(\)/);
});

test('back: clicking Settings while inside a page returns to its top', () => {
  const app = code('app.js');
  /* It has a deeper level now, so it belongs with Library and Diary rather
     than falling through to a plain reload — which would read the panel back
     out of the hash and reopen the page somebody asked to leave. */
  const at = app.indexOf('async function goToSectionRoot');
  const fn = app.slice(at, app.indexOf('async function loadRoute', at));
  assert.match(fn, /if \(id === 'settings'\)/, 'Settings has no section root');
  assert.match(fn, /setHash\('#settings'\)/);
});

/* ══ The More sheet ══════════════════════════════════════════════════════ */

test('more: Search is first and Settings is last', async () => {
  const mobile = await import(
    `file://${join(process.cwd(), '..', 'web', 'mobile.js')}?t=${Math.random()}`
  ) as any;
  /* Search was under a separator BELOW Settings — so the control you reach for
     when you cannot remember where something is was the last thing on the
     list, with account settings above it. */
  const ids = mobile.MORE_ITEMS.map((m: any) => m.id);
  assert.equal(ids.at(-1), 'settings', 'Settings is not the last destination');

  const src = code('mobile.js');
  const body = src.slice(src.indexOf('body: `'), src.indexOf('onMount:'));
  assert.ok(body.indexOf("id: 'search'") < body.indexOf('MORE_ITEMS.map'),
    'Search is still rendered after the destinations');
  assert.ok(body.indexOf('msheet-sep') < body.indexOf('MORE_ITEMS.map'),
    'the separator no longer sits between Search and the destinations');
});

/* ══ The shelf ═══════════════════════════════════════════════════════════ */

test('shelf: hovering a Book makes room to its right', () => {
  const css = web('app.css');
  /* Hover used to lift 8px and raise z-index, and move nothing. With the Books
     touching, the hovered Book's 126px cover — normally hidden behind the next
     spine — painted on top of it, which reads as cutting THROUGH the neighbour
     rather than standing in front of it. */
  assert.match(css, /\.lib-shelf-book \.lib-rail:not\(\.has-pulled\) \.lib-slot:has\(> \.lib-obj:hover\) ~ \.lib-slot/,
    'hover does not make room on a book shelf');
  assert.match(css, /--slot-peek:var\(--lib-book-peek\)/);
  const peek = Number(css.match(/--lib-book-peek:\s*(\d+)px/)![1]);
  /* Books overlap by 13px at rest, so the visible gap is `peek - 13`. 24px gave
     11px, which was reported as further than wanted; 20px gives 7px, which is
     a gap rather than a parting. Anything under 16 closes it entirely. */
  assert.ok(peek >= 16 && peek <= 28, `a ${peek}px peek leaves a ${peek - 13}px gap`);
  /* Every travel on this shelf lands on a whole device pixel at 1, 1.25, 1.5
     and 2, or the moved object rasterises on a different subpixel phase from
     its neighbours — the blur L3.2 chased down. */
  assert.equal(peek % 4, 0, `${peek}px is not device-pixel exact`);

  /* `~`, not `+`. Moving only the next one would push it into the one after,
     recreating in miniature exactly the overlap being fixed on the left. */
  assert.ok(!/\.lib-slot:has\(> \.lib-obj:hover\) \+ \.lib-slot/.test(css),
    'only the immediate neighbour moves, so it overlaps the one after it');
});

test('shelf: while a Book is open, nothing peeks', async () => {
  const css = web('app.css');
  const shelf = readFileSync(join('..', 'web', 'library-shelf.js'), 'utf8');
  /* Reported twice, as two symptoms of one thing. Hovering a Book that is
     ALREADY OPEN pushed its neighbour further away — and it is showing its
     front cover, so it is revealing nothing and has nothing to make room for:
     "it moves it even further away, which doesn't really make sense". Hovering
     the Book to its LEFT shoved the open Book sideways, for the same reason.

     The peek is a RESTING-shelf affordance — it says "there is a cover behind
     this spine". Once a Book is pulled the shelf is in another mode and the
     pull owns the spacing. Suspending it on the whole rail is one rule with no
     exceptions, rather than two special cases that would each need their own. */
  assert.match(shelf, /closest\('\.lib-rail'\)\?\.classList\.toggle\('has-pulled', on\)/,
    'nothing marks the rail while a Book is pulled');
  const rules = css.match(/[^\n]*:has\(> \.lib-obj:hover\) ~ \.lib-slot/g) ?? [];
  assert.ok(rules.length > 0, 'the hover peek rule has gone');
  for (const r of rules) {
    assert.match(r, /:not\(\.has-pulled\)/,
      `a peek rule still fires while a Book is open: ${r.trim()}`);
  }
  // Hover still lifts and brightens; only the parting is suspended.
  assert.match(css, /\.lib-obj:hover\{transform:translateY/, 'hover no longer lifts at all');
});

test('shelf: a mixed shelf separates the Books from everything else', async () => {
  const shelf = await import(
    `file://${join(process.cwd(), '..', 'web', 'library-shelf.js')}?t=${Math.random()}`
  ) as any;
  const book = (id: string) => ({ id, type: 'book', book: { id }, title: id,
    createdAt: '2026-01-01T00:00:00Z' });
  const doc = (id: string) => ({ id, type: 'document', title: id,
    createdAt: '2026-01-01T00:00:00Z' });

  /* "Recently opened" holds whatever you last touched, in any order. Rendered
     as one run it read as a row of mismatched objects — a 34px spine wedged
     between two 178px cards, each clipping the other. */
  const mixed = shelf.shelfHtml({
    id: 'recent', title: 'Recently opened', kind: 'res',
    items: [doc('a'), book('b'), doc('c'), book('d')],
  });
  const order = [...mixed.matchAll(/data-type="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['book', 'book', 'document', 'document'],
    'the Books are not gathered first');
  assert.equal((mixed.match(/is-kind-break(?!-)/g) ?? []).length, 1,
    'there is not exactly one break');
  assert.equal((mixed.match(/is-kind-break-before/g) ?? []).length, 1,
    'the last Book does not reserve its cover');

  /* A shelf of one kind is one run and gets no break at all. */
  for (const only of [[book('a'), book('b')], [doc('a'), doc('b')]]) {
    const html = shelf.shelfHtml({ id: 'x', title: 'X', kind: 'res', items: only });
    assert.ok(!/is-kind-break/.test(html), 'a single-kind shelf was broken up');
  }
});

test('shelf: cards keep their gap however many there are', () => {
  const css = web('app.css');
  /* Touching is a BOOK rule — four documents are four cards, and cards that
     touch clip one another. Measured on "Recently opened" before this: the
     Insurance card was painted over a Book's spine and the invoice card was
     cut off by the one after it. */
  assert.match(css, /\.lib-shelf-res \.lib-rail\.is-dense \.lib-row\{column-gap:\d+px\}/,
    'a dense resource shelf still closes its gaps to zero');
});

test('shelf: the last Book in a run reserves its own cover', () => {
  const css = web('app.css');
  /* A Book occupies its spine and overhangs with its cover. Mid-shelf the next
     spine hides that; at the end of a run there is nothing to hide it, so it
     landed on the first card. The clearance is the Book's own arithmetic, so a
     thick Book and a thin one both come out right. */
  assert.match(css, /\.lib-slot\.is-kind-break-before \.lib-obj\{[\s\S]{0,80}?margin-right:calc\(var\(--bw, 126px\) - var\(--bt, 32px\)\)/,
    'the clearance is not derived from the Book itself');
});
