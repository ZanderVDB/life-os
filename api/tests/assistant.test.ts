/**
 * The assistant's contract, run rather than read.
 *
 * The interface is being built before the intelligence is, on purpose: the
 * hard questions about an assistant that can move your meetings are questions
 * about consent and correction, and those are answered in the interface. A
 * model behind a bad interface is a faster way to get the wrong thing done.
 *
 * So these exercise the real functions. `assertConfirmable` is the same gate
 * the executor will call, and it is tested here rather than merely described.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join('..', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');

const contract = await import('../../web/assistant-contract.js' as string);
const mock = await import('../../web/assistant-mock.js' as string);

const {
  normalise, changeCount, setEnabled, setItemEnabled, setField,
  assertConfirmable, isImportant, isMutation, isProvider, summarise,
} = contract as any;

/* The response §11 describes, which is also what the mock returns. */
const demo = () => normalise({
  transcript: 'demo',
  proposals: [
    { id: 'p1', kind: 'task.complete', title: 'Finish website changes' },
    {
      id: 'p2',
      kind: 'task.create',
      title: 'Haircut',
      fields: [
        { key: 'when', label: 'When', type: 'choice', value: 'Tomorrow', options: ['Tomorrow', 'Saturday'] },
        { key: 'area', label: 'Area', type: 'choice', value: 'Personal', options: ['Personal'] },
      ],
    },
    {
      id: 'p3',
      kind: 'list.add',
      title: 'Add to Groceries',
      items: [{ id: 'a', label: 'Milk' }, { id: 'b', label: 'Chicken' }, { id: 'c', label: 'Toothpaste' }],
    },
    { id: 'p4', kind: 'event.update', title: 'Meeting with John' },
  ],
});

test('the count on the button is the count on the screen', () => {
  /* Six: one completion, one task, three list lines and one calendar move.
   * Sub-items count individually because that is what somebody is agreeing
   * to — a button saying "4 changes" over a card listing six lines is a
   * button nobody can check. */
  const r = demo();
  assert.equal(changeCount(r.proposals), 6);

  // Switching one grocery off is one change fewer, not one card fewer.
  const less = setItemEnabled(r.proposals, 'p3', 'c', false);
  assert.equal(changeCount(less), 5);

  // Switching a whole card off removes everything it was going to do — the
  // two groceries still ticked as well as the one already switched off.
  const fewer = setEnabled(less, 'p3', false);
  assert.equal(changeCount(fewer), 3);
});

test('an answer is not a change', () => {
  const r = normalise({ proposals: [{ id: 'a', kind: 'answer', title: '5 tasks' }] });
  assert.equal(changeCount(r.proposals), 0, 'agreeing with an answer is not an action');
  assert.equal(isMutation('answer'), false);
});

test('editing a field rewrites the line that describes it', () => {
  /* §13. A summary that keeps its original value after an edit is worse than
   * no summary: it is a confident wrong answer directly beneath the right
   * one. And nothing here asks the person to speak again. */
  const r = demo();
  assert.equal(summarise(r.proposals[1]), 'Tomorrow · Personal');
  const edited = setField(r.proposals, 'p2', 'when', 'Saturday');
  assert.equal(edited[1].summary, 'Saturday · Personal');
  assert.equal(changeCount(edited), 6, 'an edit changed how many changes there are');
});

test('nothing executes without a confirmation that names the same number', () => {
  const r = demo();
  assert.throws(() => assertConfirmable(r.proposals, null),
    /require an explicit confirmation/,
    'a batch ran with no confirmation at all');
  assert.throws(() => assertConfirmable(r.proposals, { confirmed: false, count: 6 }),
    /require an explicit confirmation/);

  /* The count is part of the confirmation, not decoration. If the list moved
   * between the button being drawn and being pressed, the person agreed to a
   * different set of changes than the one about to run. */
  assert.throws(() => assertConfirmable(r.proposals, { confirmed: true, count: 5 }),
    /Confirmed 5 changes but 6 are pending/);

  assert.equal(assertConfirmable(r.proposals, { confirmed: true, count: 6 }), true);
});

test('the changes that cannot be undone are marked', () => {
  for (const kind of ['event.delete', 'event.update', 'task.complete', 'project.update']) {
    assert.ok(isImportant(kind), `${kind} is not marked as needing confirmation`);
  }
  assert.equal(isImportant('task.create'), false, 'everything is marked, so nothing is');
});

test('a proposal the app cannot render is dropped, not half-shown', () => {
  const r = normalise({
    proposals: [
      { id: 'ok', kind: 'task.create', title: 'Real' },
      { id: 'no', kind: 'bank.transfer', title: 'Send £400' },
    ],
  });
  assert.equal(r.proposals.length, 1, 'an unknown kind was rendered');
  assert.deepEqual(r.dropped, ['bank.transfer']);
  assert.equal(changeCount(r.proposals), 1);
});

test('a provider has exactly one method, and it cannot write', () => {
  assert.ok(isProvider(mock.mockProvider), 'the mock does not satisfy the interface');
  const keys = Object.keys(mock.mockProvider);
  assert.deepEqual(keys.sort(), ['id', 'label', 'propose'],
    `a provider gained a capability: ${keys.join(', ')}`);

  const src = read('assistant-mock.js');
  for (const forbidden of ['fetch(', 'api(', 'localStorage', 'method: \'POST\'', 'workspaces/']) {
    assert.ok(!src.includes(forbidden),
      `the mock provider can reach ${forbidden} — a provider must not be able to write`);
  }
});

test('the mock says what it is, everywhere it appears', () => {
  /* A fake that writes real rows is indistinguishable from a working
   * assistant right up until somebody trusts it with a real calendar. */
  const surface = read('assistant.js');
  /* One line, in the flow, and it never goes away. It used to be a full amber
   * panel: the right weight for "you are about to lose data" and the wrong
   * weight for a standing fact, and it drew the eye before the orb did every
   * time the screen opened. It still has to SAY the two things that matter. */
  assert.match(surface, /class="asst-note"/, 'the surface does not label itself');
  assert.match(surface, /Prototype/, 'the label does not say it is a prototype');
  assert.match(surface, /nothing will be saved/, 'the label does not say nothing is saved');
  assert.ok(!/class="asst-note"[\s\S]{0,200}<b>/.test(surface),
    'the standing label has grown a panel again');
  assert.match(surface, /nothing has been saved/, 'confirming does not say nothing was saved');
  assert.match(mock.mockProvider.label, /Prototype/);
});

test('replacing the mock is one line', () => {
  const surface = read('assistant.js');
  assert.match(surface, /const provider = mockProvider;/,
    'the provider is not a single named binding');
  // The surface talks to the contract, never to the mock's internals.
  const body = surface.slice(surface.indexOf('function propose('));
  assert.ok(!/mockProvider/.test(body), 'the mock leaks into the surface logic');
  assert.match(surface, /provider\.propose\(\{/, 'the surface does not go through the interface');
});

test('the provider is told what exists and given no way to reach it', () => {
  const surface = read('assistant.js');
  const ctx = surface.slice(surface.indexOf('context: {'), surface.indexOf('});', surface.indexOf('context: {')));
  for (const leak of ['token', 'workspace', 'api', 'headers']) {
    assert.ok(!new RegExp(leak, 'i').test(ctx), `the assistant context carries ${leak}`);
  }
  assert.match(ctx, /areas:/);
  assert.match(ctx, /projects:/);
});

test('the mock is deterministic, and the demo returns six changes', async () => {
  const one = await mock.mockProvider.propose({
    text: 'I finished the website changes. I need a haircut tomorrow. '
      + 'Add milk, chicken and toothpaste to groceries. Move my meeting with John from 2 to 3.',
    context: { now: Date.UTC(2026, 7, 25), areas: [{ name: 'Personal' }], projects: [] },
  });
  const two = await mock.mockProvider.propose({
    text: 'I finished the website changes. I need a haircut tomorrow. '
      + 'Add milk, chicken and toothpaste to groceries. Move my meeting with John from 2 to 3.',
    context: { now: Date.UTC(2026, 7, 25), areas: [{ name: 'Personal' }], projects: [] },
  });
  assert.deepEqual(one, two, 'the same sentence produced two different answers');
  assert.equal(changeCount(normalise(one).proposals), 6);
});

test('speech recognition is an enhancement, never the thing it depends on', () => {
  /* §10. Chrome and Safari implement it under a prefix and behave
   * differently; Firefox does not implement it at all. Blocking the work on
   * it would mean the interaction could only be tested in one browser. */
  const surface = read('assistant.js');
  assert.match(surface, /window\.SpeechRecognition \|\| window\.webkitSpeechRecognition/);
  assert.match(surface, /if \(!SR\) \{ showSourceNote/, 'a browser without it gets nothing');
  assert.match(surface, /runMockCapture/, 'there is no development transcript');
  assert.match(surface, /openTypeSheet/, 'there is no way to type instead');
  // And the surface says which source it used rather than passing a
  // synthetic level off as a voice.
  assert.match(surface, /Demo transcript/, 'the development transcript is unlabelled');
});

test('the microphone drives a picture and is released on the way out', () => {
  const orb = read('assistant-orb.js');
  /* Comments stripped first. The rule is that audio is never captured, not
   * that the word may never be written down — the paragraph explaining why
   * it is not captured is exactly the comment worth keeping. */
  const code = orb.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  // Not connected to the speakers, and never stored.
  assert.ok(!/\.connect\(this\.ctx\.destination\)/.test(code),
    'the microphone is routed to the output');
  assert.ok(!/MediaRecorder|new Blob|upload/i.test(code), 'audio is being captured');
  assert.match(code, /getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/,
    'the microphone tracks are never stopped');

  const surface = read('assistant.js');
  assert.match(read('app.js'), /if \(state\.route === 'ai'\) leaveAssistant\(\);/,
    'leaving the route does not release the microphone');
  assert.match(surface, /export const leaveAssistant = endSession;/);
});

test('three listening variants, one assistant', () => {
  /* §8. Only the listening animation differs — three assistants would be
   * three products, and the point is to choose a motion, not a personality. */
  const orb = read('assistant-orb.js');
  const ids = [...orb.matchAll(/\{ id: '(\w)', label: '[^']+'/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['a', 'b', 'c']);
  for (const fn of ['drawConcentric', 'drawHalo', 'drawRadial']) {
    assert.match(orb, new RegExp(`${fn}\\(`), `variant ${fn} is not implemented`);
  }
  // The selector is a development control, not a user setting.
  const surface = read('assistant.js');
  assert.match(surface, /\$\{devTools\(\) \? devPanelHtml\(\) : ''\}/,
    'the variant selector is not behind the development switch');
  assert.ok(!/listening style/i.test(read('settings.js')),
    'the variant selector leaked into Settings as a permanent preference');
});

test('reduced motion still says "listening"', () => {
  /* §49. The requirement is not "less movement" but "communicates active
   * input without large expanding movement" — thickness and opacity rather
   * than things flying across the screen. */
  const orb = read('assistant-orb.js');
  assert.match(orb, /const reducedMotion = \(\) =>/, 'the preference is not read');
  assert.match(orb, /if \(reduce\) \{[\s\S]{0,600}lineWidth = 1 \+ a \* 5/,
    'reduced motion drops the listening signal instead of changing how it is drawn');
  // Read live, so turning it on mid-session does not need a reload.
  assert.ok(!/const reduce = window\.matchMedia\([^)]*\)\.matches;\s*$/m.test(orb));
});
