/**
 * What an answer looks like on screen.
 *
 * The bug: `**Urgent**` reached the user as four asterisks and a word, because
 * the answer was escaped and inserted as one string. The fix is a fixed, tiny
 * grammar — paragraphs, bold, simple lists — rendered from text that has
 * already been escaped, so nothing the model writes can become an element.
 *
 * These run the real module in this process; there is no DOM involved, because
 * the module produces a string.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join('..', 'web', 'assistant-prose.js'), 'utf8');
/* Loaded by evaluating the module's exports, so the test exercises the file
   the browser loads rather than a copy of its logic. */
const mod = await import(`file://${join(process.cwd(), '..', 'web', 'assistant-prose.js')}`);
const { proseHtml, proseText } = mod as {
  proseHtml: (s: string) => string; proseText: (s: string) => string;
};

/* ══ The subset ══════════════════════════════════════════════════════════ */

test('prose: no marker survives to the screen', () => {
  const answer = [
    'Your Today board has four tasks:',
    '',
    '- **Reconcile against the bank** (urgent, due 30 Aug)',
    '- **Pay the deposit** (high priority)',
    '- Invoice',
    '',
    'Two reminders are also due soon.',
  ].join('\n');

  const html = proseHtml(answer);
  assert.ok(!html.includes('**'), 'raw asterisks reached the screen');
  assert.ok(!html.includes('\n- '), 'a hyphen bullet was rendered literally');
  assert.match(html, /<strong>Reconcile against the bank<\/strong>/);
  assert.match(html, /<ul><li>.*<\/li><li>.*<\/li><li>Invoice<\/li><\/ul>/);
  assert.match(html, /<p>Your Today board has four tasks:<\/p>/);
  assert.match(html, /<p>Two reminders are also due soon\.<\/p>/);
});

test('prose: numbered lists, and only one list at a time', () => {
  const html = proseHtml('Do these:\n1. First\n2. Second\n\n- And a bullet');
  assert.match(html, /<ol><li>First<\/li><li>Second<\/li><\/ol>/);
  assert.match(html, /<ul><li>And a bullet<\/li><\/ul>/);
});

test('prose: an empty bullet is dropped rather than drawn', () => {
  /* "Two more without a priority set: - (no other tasks visible)" was the
     model padding a list it could not fill. The placeholder is its own
     problem, told to the model; an EMPTY item is the visible half and is
     simply not rendered. */
  assert.equal(proseHtml('Nothing else:\n-   \n-\n'), '<p>Nothing else:</p>');
  assert.equal(proseHtml('   '), '');
  assert.equal(proseHtml(null as unknown as string), '');
});

test('prose: markers outside the subset lose the marker and keep the words', () => {
  const html = proseHtml('## A heading\n\n> quoted\n\n`code`');
  assert.match(html, /<p>A heading<\/p>/, 'a heading kept its hashes');
  assert.match(html, /<p>quoted<\/p>/);
  assert.match(html, /<code>code<\/code>/);
  assert.ok(!html.includes('#'), 'a hash reached the screen');
});

/* ══ Safety ══════════════════════════════════════════════════════════════ */

test('prose: model output can never become an element', () => {
  const nasty = '<img src=x onerror=alert(1)> and <script>bad()</script>'
    + '\n- <b>bold?</b> **really bold**'
    + '\n\n[a link](javascript:alert(1))';
  const html = proseHtml(nasty);

  /* The words survive as words — "onerror=" is still there, as text, which is
     right. What must not survive is a TAG: nothing here can open an element,
     because every angle bracket was escaped before a single tag was written. */
  for (const forbidden of ['<img', '<script', '<b>', '<a ']) {
    assert.ok(!html.includes(forbidden), `${forbidden} survived into the output`);
  }
  assert.ok(html.includes('&lt;img'), 'the angle bracket was not escaped');
  assert.ok(html.includes('&lt;script'), 'the angle bracket was not escaped');
  /* The only tags present are the ones this module writes. */
  const tags = [...html.matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1]!.toLowerCase());
  const allowed = new Set(['p', 'strong', 'code', 'ul', 'ol', 'li']);
  for (const t of new Set(tags)) assert.ok(allowed.has(t), `unexpected element <${t}>`);
  // …and the bold that WAS in the subset still rendered.
  assert.match(html, /<strong>really bold<\/strong>/);
});

test('prose: escaping happens before anything is produced', () => {
  /* Read as a structural claim, not a behavioural one: if `esc` ever moves
     after the tag-producing steps, this file becomes an injection surface and
     the tests above would still pass on today's inputs. */
  const fn = src.slice(src.indexOf('export function proseHtml'));
  const escAt = fn.indexOf('esc(raw)');
  const tagAt = Math.min(...['<p>', '<li>', '<ul'].map((t) => {
    const i = fn.indexOf(t);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  }));
  assert.ok(escAt > -1 && escAt < tagAt, 'a tag is produced before the text is escaped');
  assert.ok(!/innerHTML|insertAdjacentHTML|document\./.test(src),
    'the prose renderer touches the DOM; it should return a string');
});

/* ══ The plain form ══════════════════════════════════════════════════════ */

test('prose: the plain form is for places that cannot hold elements', () => {
  assert.equal(proseText('**Urgent** — see `notes`'), 'Urgent — see notes');
  assert.equal(proseText('- one\n- two'), 'one two');
  assert.ok(!proseText('## Heading').includes('#'));
});
