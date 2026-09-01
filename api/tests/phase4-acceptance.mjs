/**
 * Phase 4 acceptance — the nine §15 scenarios, against the real model.
 *
 * Run against a live server with a real ANTHROPIC_API_KEY:
 *
 *   node --env-file-if-exists=api/.env api/node_modules/tsx/dist/cli.mjs \
 *        api/tests/live-server.ts            # in the background
 *   node api/tests/phase4-acceptance.mjs [--seed-only]
 *
 * `--seed-only` builds the fixture and makes NO model calls, which is how the
 * script itself is checked without spending anything. Every payload shape here
 * has been wrong at least once; proving the fixture separately means a real
 * run is never wasted on a typo.
 *
 * One turn per scenario. The point is acceptance, not statistics.
 */
const API = process.env.LOS_API ?? 'http://127.0.0.1:8080';
const TOKEN = 'dev-verify-token';
const TODAY = '2026-09-01';           // a Tuesday. Fri=4th, Sat=5th, Mon=7th, Tue=8th
const SEED_ONLY = process.argv.includes('--seed-only');

let WS = null;
let turns = 0;

const req = async (method, path, body) => {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 300)}`);
  return data;
};
const ws = (method, path, body) => req(method, `/api/v1/workspaces/${WS}${path}`, body);

/* ── Reporting ───────────────────────────────────────────────────────── */
const results = [];
const check = (scenario, label, ok, detail = '') => {
  results.push({ scenario, label, ok });
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const head = (n, title) => console.log(`\n══ ${n}. ${title} ${'═'.repeat(Math.max(0, 54 - title.length))}`);

const show = (t) => {
  console.log(`   route=${t.metrics?.route} status=${t.status}`
    + ` actions=${t.actions?.length ?? 0} retrieved=${t.metrics?.retrieved ?? '-'}`);
  if (t.understood) console.log(`   understood: ${t.understood}`);
  if (t.answer) console.log(`   answer: ${String(t.answer).replace(/\s+/g, ' ').slice(0, 400)}`);
  if (t.note) console.log(`   note: ${t.note}`);
  for (const a of t.actions ?? []) {
    console.log(`   [${a.id}] ${a.capability}  "${a.title}"`);
    console.log(`        payload ${JSON.stringify(a.payload).slice(0, 220)}`);
    if (a.assumptions?.length) console.log(`        assumes ${a.assumptions.join(' | ')}`);
  }
  if (t.clarification) {
    console.log(`   ASKS: ${t.clarification.question}`);
    for (const o of t.clarification.options) {
      console.log(`        (${o.id}) ${o.label}${o.detail ? ` — ${o.detail}` : ''}`);
    }
  }
  if (t.metrics?.inconsistencyDetail?.length) {
    console.log(`   findings: ${t.metrics.inconsistencyDetail.join(' || ').slice(0, 300)}`);
  }
};

const turn = async (text, conversationId) => {
  turns += 1;
  console.log(`\n > "${text}"`);
  const t = await ws('POST', '/ai/turn', { text, today: TODAY, conversationId });
  show(t);
  return t;
};
const confirm = (t, important = []) => ws('POST', `/ai/turn/${t.turnId}/confirm`, {
  version: t.version, count: t.actions.filter((a) => a.enabled).length,
  importantAccepted: important,
});
const clarify = async (t, optionId) => {
  turns += 1;
  const n = await ws('POST', `/ai/turn/${t.turnId}/clarify`, { optionId });
  show(n);
  return n;
};
const discard = (t) => ws('POST', `/ai/turn/${t.turnId}/discard`, {}).catch(() => {});

/* ══ Fixture ═══════════════════════════════════════════════════════════
 * A workspace that looks like somebody's, because retrieval quality is the
 * thing under test and an empty workspace cannot fail interestingly. */
async function seed() {
  const me = await req('GET', '/api/v1/me');
  WS = me.workspace.id;
  const areas = Object.fromEntries(me.areas.map((a) => [a.name, a.id]));
  const work = areas['Work'] ?? me.areas[0].id;
  const personal = areas['Personal'] ?? me.areas[0].id;

  const project = (await ws('POST', '/projects', {
    title: 'WebAnchor client handover',
    outcome: 'WebAnchor are running the site themselves with no open questions',
    areaId: work, focus: 'now',
  })).project;

  const mk = (body) => ws('POST', '/tasks', body).then((r) => r.task);
  const credentials = await mk({
    title: 'Send final credentials', projectId: project.id, areaId: work, priority: 'high',
  });
  const notes = await mk({ title: 'Draft handover notes', projectId: project.id, areaId: work });
  const call = await mk({ title: 'Book the handover call', projectId: project.id, areaId: work });
  await ws('PATCH', `/tasks/${notes.id}`, { status: 'done' });

  /* Two tasks with the SAME name, so scenario 2 has something to be
     genuinely ambiguous about. */
  const dupA = await mk({ title: 'Call the removals firm', areaId: personal });
  const dupB = await mk({ title: 'Call the removals firm', areaId: personal });

  /* A book with a page worth citing. */
  const book = await ws('POST', '/library/books', {
    title: 'WebAnchor', subtitle: 'Handover', firstSection: 'Notes',
  });
  const sections = (await ws('GET', `/library/books/${book.book.id}`)).sections ?? [];
  const sectionId = sections[0]?.id ?? book.section.id;
  /* Create, then write. The route creates a SPREAD and takes no text; the
     content goes on in a second call, in the document grammar the editor
     uses. */
  const page = (await ws('POST', `/library/sections/${sectionId}/pages`, {
    title: 'Handover checklist', layout: 'notes',
  })).pages[0];
  const para = (text) => ({
    type: 'paragraph', attrs: { id: Math.random().toString(36).slice(2, 10) },
    content: [{ type: 'text', text }],
  });
  await ws('PATCH', `/library/pages/${page.id}`, {
    content: {
      type: 'doc',
      content: [
        para('Hand over the DNS records, the CMS logins and the deploy runbook.'),
        para('Nothing goes to the client until the staging review is signed off.'),
      ],
    },
  });

  return { work, personal, project, credentials, notes, call, dupA, dupB, book, sectionId, page };
}

/* ══ The nine ══════════════════════════════════════════════════════════ */
async function main() {
  console.log(`Phase 4 acceptance — ${SEED_ONLY ? 'SEED ONLY (no model calls)' : 'real model'}`);
  const f = await seed();
  console.log(`\nFixture built in workspace ${WS}`);
  console.log(`  project   ${f.project.id}  WebAnchor client handover`);
  console.log(`  task      ${f.credentials.id}  Send final credentials (open)`);
  console.log(`  task      ${f.notes.id}  Draft handover notes (done)`);
  console.log(`  task      ${f.call.id}  Book the handover call (open)`);
  console.log(`  dupes     ${f.dupA.id} / ${f.dupB.id}  Call the removals firm`);
  console.log(`  page      ${f.page.id}  Handover checklist`);
  if (SEED_ONLY) {
    console.log('\nFixture OK. Endpoint shapes and payloads all accepted.');
    return;
  }

  let conv = null;

  /* ── 1. Read across connected systems ───────────────────────────── */
  head(1, 'Cross-system read');
  const t1 = await turn(
    'What still needs to happen for the WebAnchor client handover, and what has already been done?',
  );
  conv = t1.conversationId;
  const cited = JSON.stringify(t1.sources ?? []);
  check(1, 'answered rather than proposing changes', !t1.actions?.length && Boolean(t1.answer));
  check(1, 'retrieved the real project', cited.includes(f.project.id));
  check(1, 'retrieved the open task', cited.includes(f.credentials.id));
  check(1, 'knows the drafted notes are done',
    /done|finish|complet|drafted|already/i.test(t1.answer ?? ''));

  /* ── 2. Resolve a named entity and mutate it ────────────────────── */
  head(2, 'Named entity -> mutation, and duplicates must ask');
  const t2a = await turn('Mark Send final credentials complete.', conv);
  const act2 = t2a.actions?.[0];
  check(2, 'proposed a completion', act2?.capability === 'task.complete');
  check(2, 'targets the correct stable id', act2?.payload?.id === f.credentials.id,
    `${act2?.payload?.id} vs ${f.credentials.id}`);
  if (act2?.capability === 'task.complete' && act2.payload?.id === f.credentials.id) {
    const done = await confirm(t2a, t2a.actions.filter((a) => a.important).map((a) => a.id));
    check(2, 'executed against the right task',
      done.results?.[0]?.status === 'done' && done.results[0].ref?.id === f.credentials.id);
    await ws('PATCH', `/tasks/${f.credentials.id}`, { status: 'open' });   // put it back
  } else { await discard(t2a); }

  const t2b = await turn('Complete Call the removals firm.', conv);
  check(2, 'duplicate names ask rather than guess',
    t2b.status === 'clarifying' || !t2b.actions?.length,
    `status=${t2b.status} actions=${t2b.actions?.length ?? 0}`);
  await discard(t2b);

  /* ── 3. Multi-action across modules ─────────────────────────────── */
  head(3, 'Several independent actions in one sentence');
  const t3 = await turn(
    'Add buy milk to my list, remind me Friday about the insurance renewal, '
    + 'and create a habit called Stretch.', conv);
  const caps3 = (t3.actions ?? []).map((a) => a.capability);
  check(3, 'three separate actions', (t3.actions?.length ?? 0) === 3, caps3.join(', '));
  check(3, 'one is a task', caps3.some((c) => c === 'task.create'));
  check(3, 'one is a reminder', caps3.some((c) => c.startsWith('reminder.')));
  check(3, 'one is a habit', caps3.some((c) => c === 'habit.create'));
  const rem = (t3.actions ?? []).find((a) => a.capability.startsWith('reminder.'));
  const remDate = JSON.stringify(rem?.payload ?? {});
  check(3, 'Friday resolves to the 4th', remDate.includes('2026-09-04'), remDate.slice(0, 160));
  await discard(t3);

  /* ── 4. Ambiguous timing, then amend before confirming ──────────── */
  head(4, 'Timing clarification, then an amendment');
  const t4 = await turn('I need a haircut Saturday.', conv);
  check(4, 'ambiguous timing asks', t4.status === 'clarifying', `status=${t4.status}`);
  let t4b = t4;
  if (t4.status === 'clarifying') {
    const opt = t4.clarification.options.find((o) => /do it/i.test(o.label))
      ?? t4.clarification.options[0];
    t4b = await clarify(t4, opt.id);
  }
  const a4 = t4b.actions?.[0];
  const p4 = { ...(a4?.payload ?? {}), ...(a4?.payload?.changes ?? {}) };
  check(4, '"do it then" means scheduledAt, not dueDate',
    Boolean(p4.scheduledAt) && !p4.dueDate, JSON.stringify(p4).slice(0, 160));
  check(4, 'Saturday resolves to the 5th',
    JSON.stringify(p4).includes('2026-09-05'), JSON.stringify(p4).slice(0, 160));

  const t4c = await turn('Actually make it Monday.', t4b.conversationId ?? conv);
  check(4, 'amended rather than re-planned', t4c.metrics?.route === 'amend',
    `route=${t4c.metrics?.route}`);
  check(4, 'still exactly one action', (t4c.actions?.length ?? 0) === 1,
    `${t4c.actions?.length ?? 0} actions`);
  const p4c = JSON.stringify(t4c.actions?.[0]?.payload ?? {});
  check(4, 'Monday resolves to the 7th', p4c.includes('2026-09-07'), p4c.slice(0, 160));
  check(4, 'still a working time, not a deadline', !p4c.includes('dueDate'), p4c.slice(0, 160));
  await discard(t4c);

  /* ── 5. Conversation reference ──────────────────────────────────── */
  head(5, '"it" resolves from conversation, not fuzzy title matching');
  const t5a = await turn('Create a task called Order the packing boxes.', conv);
  const made5 = await confirm(t5a, t5a.actions.filter((a) => a.important).map((a) => a.id));
  const boxesId = made5.results?.[0]?.ref?.id;
  check(5, 'the task was created', Boolean(boxesId));
  const t5b = await turn('Move it to Tuesday.', conv);
  const p5 = JSON.stringify(t5b.actions?.[0]?.payload ?? {});
  check(5, '"it" is the task just created', p5.includes(boxesId ?? 'never'), p5.slice(0, 160));
  check(5, 'Tuesday resolves to the 8th', p5.includes('2026-09-08'), p5.slice(0, 160));
  await discard(t5b);

  /* ── 6. Composite dependency ────────────────────────────────────── */
  head(6, 'Action B needs the id action A produces');
  const t6 = await turn(
    'Create a project called Office move in Work, and add a task to it called Get moving quotes.',
    conv);
  const [c1, c2] = t6.actions ?? [];
  check(6, 'two actions', (t6.actions?.length ?? 0) === 2,
    (t6.actions ?? []).map((a) => a.capability).join(', '));
  check(6, 'first creates the project', c1?.capability === 'project.create');
  check(6, 'second references the first by placeholder',
    JSON.stringify(c2?.payload ?? {}).includes(`{{${c1?.id}.id}}`),
    JSON.stringify(c2?.payload ?? {}).slice(0, 180));
  if ((t6.actions?.length ?? 0) === 2) {
    const done6 = await confirm(t6, t6.actions.filter((a) => a.important).map((a) => a.id));
    check(6, 'both executed', done6.done === 2, JSON.stringify(done6.results).slice(0, 240));
    check(6, 'reported in card order',
      done6.results?.[0]?.actionId === c1.id && done6.results?.[1]?.actionId === c2.id);
    const projId = done6.results?.[0]?.ref?.id;
    const shown = await ws('GET', `/projects/${projId}`);
    check(6, 'the real id was substituted — task is inside the project',
      (shown.tasks ?? []).some((x) => /moving quotes/i.test(x.title)),
      JSON.stringify((shown.tasks ?? []).map((x) => x.title)));
  }

  /* ── 7. Relationship inference ──────────────────────────────────── */
  head(7, 'An inferred link, proposed not written');
  const t7 = await turn(
    'The handover call is where we are going to go through the final credentials.', conv);
  const link = (t7.actions ?? []).find((a) => a.capability === 'link.create');
  check(7, 'proposed a link', Boolean(link), (t7.actions ?? []).map((a) => a.capability).join(','));
  if (link) {
    const ids = [link.payload.sourceId, link.payload.targetId];
    check(7, 'both ends are real stable ids',
      ids.includes(f.call.id) && ids.includes(f.credentials.id), JSON.stringify(link.payload));
    check(7, 'uses a real relationship kind',
      typeof link.payload.kind === 'string' && link.payload.kind !== 'scheduled_as',
      String(link.payload.kind));
    const done7 = await confirm(t7, t7.actions.filter((a) => a.important).map((a) => a.id));
    check(7, 'executed through the link service', done7.done >= 1);
    const rel = await ws('GET', `/links?type=task&id=${f.call.id}`);
    check(7, 'visible on the entity in the UI',
      JSON.stringify(rel).includes(f.credentials.id), JSON.stringify(rel).slice(0, 200));
  } else { await discard(t7); }

  /* ── 8. Memory ──────────────────────────────────────────────────── */
  head(8, 'A preference is noticed, not silently believed');
  const before = (await ws('GET', '/ai/memory')).memories ?? [];
  const t8 = await turn('I always do my admin work in the afternoons.', conv);
  const cands = (await ws('GET', '/ai/memory/candidates')).candidates ?? [];
  const after = (await ws('GET', '/ai/memory')).memories ?? [];
  check(8, 'became a candidate, not a memory', cands.length > 0,
    `${cands.length} candidates: ${cands.map((c) => c.fact).join(' | ').slice(0, 160)}`);
  check(8, 'nothing was silently remembered', after.length === before.length,
    `${before.length} -> ${after.length}`);
  await discard(t8);

  /* ── 9. Capability boundary ─────────────────────────────────────── */
  head(9, 'Something Life OS genuinely cannot do');
  const t9 = await turn('Reorder my tasks so the shopping ones are at the top of the list.', conv);
  check(9, 'proposed no action', (t9.actions?.length ?? 0) === 0,
    (t9.actions ?? []).map((a) => a.capability).join(','));
  check(9, 'said so rather than pretending',
    /can.?not|unable|do not|don.t|no way|not something|not able|isn.t/i
      .test(`${t9.answer ?? ''} ${t9.note ?? ''}`),
    String(t9.answer ?? t9.note ?? '').slice(0, 200));

  /* ── Tally ──────────────────────────────────────────────────────── */
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`Anthropic turns used: ${turns}`);
  console.log(`Checks: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('\nFAILED:');
    for (const r of failed) console.log(`  §${r.scenario}  ${r.label}`);
  } else {
    console.log('\nAll acceptance checks passed.');
  }
}

main().catch((e) => { console.error('\nFATAL', e); process.exit(1); });
