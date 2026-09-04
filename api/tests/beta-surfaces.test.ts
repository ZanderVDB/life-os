/**
 * The beta surfaces — Phases 4, 6, 7 and 8G.
 *
 * These are source-level assertions about the client, in the same style as
 * `assistant.test.ts`: they cannot prove a screen looks right, and they are not
 * pretending to. What they CAN prove is the set of things that are quiet when
 * they break — a promise about money that says two different things in two
 * places, a feedback button that copies somebody's diary, a development panel
 * left switched on for a stranger.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const web = (f: string) => readFileSync(join('..', 'web', f), 'utf8');

/* ══ Phase 6 — the introduction says the same thing twice ════════════════ */

test('beta: the landing page and the in-app introduction agree', async () => {
  /* The landing page's markup is static in index.html — it is the first paint,
     and waiting for a module before showing anything would be a blank screen
     for the one visitor who has never seen Life OS. The cost of that decision
     is two copies of the same words, and this is what stops them drifting. */
  const intro = await import(
    `file://${join(process.cwd(), '..', 'web', 'beta-intro.js')}?t=${Math.random()}`
  ) as any;
  const html = web('index.html');

  for (const s of intro.INTRO_SECTIONS) {
    assert.ok(html.includes(s.title),
      `the landing page does not say "${s.title}"`);
    assert.ok(html.toLowerCase().includes(s.kicker.toLowerCase()),
      `the landing page has no "${s.kicker}" section`);
  }
  assert.ok(html.includes(intro.INTRO_HEADLINE), 'the headline differs');
  assert.ok(html.includes(intro.INTRO_LEDE), 'the lede differs');
  assert.ok(html.includes(intro.INTRO_CTA), 'the call to action differs');
});

test('beta: the money claim is a rule, not a number', async () => {
  /* It is easy and tempting to write "it will cost you about R30", and if that
     turns out to be wrong somebody has been misled about money. The copy says
     what the SERVER actually enforces: there is an allowance, it is visible,
     and the assistant stops at it. */
  const intro = await import(
    `file://${join(process.cwd(), '..', 'web', 'beta-intro.js')}?t=${Math.random()}`
  ) as any;
  const ai = intro.INTRO_SECTIONS.find((s: any) => s.id === 'ai');
  const text = `${ai.title} ${ai.body.join(' ')}`;
  assert.match(text, /allowance/i, 'the AI section never mentions an allowance');
  assert.match(text, /Settings/, 'it does not say where to look');
  assert.match(text, /rest of Life OS/i, 'it does not say what keeps working');
  /* No promised figure anywhere in the introduction. */
  for (const s of intro.INTRO_SECTIONS) {
    const body = `${s.title} ${s.body.join(' ')}`;
    assert.doesNotMatch(body, /R\s?\d/, `"${s.kicker}" promises a rand figure`);
    assert.doesNotMatch(body, /\$\d/, `"${s.kicker}" promises a dollar figure`);
  }
});

test('beta: the sign-in is revealed, not led with', () => {
  const html = web('index.html');
  const app = web('app.js');
  /* The explanation comes first. The button at the foot of it reveals the
     sign-in; the header link reveals the same block rather than being a second
     way past the reading. */
  assert.match(html, /id="bl-understand"/, 'there is no "I understand" control');
  assert.match(html, /id="bl-signin"[^>]*hidden/, 'the sign-in is not hidden to start');
  assert.match(app, /getElementById\('bl-understand'\)\?\.addEventListener\('click', reveal\)/);
  /* And no giant sign-in form above the fold. */
  const beforeCards = html.slice(0, html.indexOf('bl-cards'));
  assert.doesNotMatch(beforeCards, /Continue with Google/,
    'the page leads with a sign-in button');
});

test('beta: the background covers the viewport rather than a centred column', () => {
  /* `.lp::before` was positioned inside `.lp`, which is capped at 1160px and
     centred — so on anything wider the glow ended at the column edge and the
     rest was flat black. That reads as a rendering failure, not a design. */
  const css = web('beta.css');
  const rule = css.slice(css.indexOf('.lp::before{'), css.indexOf('}', css.indexOf('.lp::before{')));
  assert.match(rule, /position:fixed/, 'the landing glow is still absolutely positioned');
  assert.match(rule, /inset:0/, 'it does not cover the viewport');
  assert.match(css, /body:has\(#landing\)\{ background:var\(--app-bg-flat\)/,
    'the page itself does not paint a ground');
});

/* ══ Phase 7 — feedback carries nothing private ══════════════════════════ */

test('feedback: the technical details are an allowlist, not a scrape', async () => {
  const fb = await import(
    `file://${join(process.cwd(), '..', 'web', 'feedback.js')}?t=${Math.random()}`
  ) as any;
  const src = web('feedback.js');

  /* Built field by field. Anything that iterated over what was available —
     localStorage, the DOM, the URL — would eventually pick up something
     personal, and would do it silently. */
  /* The COMMENT mentions localStorage; the code must not use it. */
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ''), /localStorage/,
    'feedback reads browser storage');
  assert.doesNotMatch(src, /document\.body|innerText|innerHTML/, 'feedback scrapes the page');
  assert.doesNotMatch(src, /location\.href|location\.search/, 'feedback includes the URL');
  assert.doesNotMatch(src, /navigator\.userAgent[^;]*join|ua\b\s*,/, 'the raw user agent is sent');

  (globalThis as any).window = { LIFE_OS_CONFIG: { beta: {} } };
  /* Node defines `navigator` with a getter only, so plain assignment throws. */
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/140' },
    configurable: true, writable: true,
  });
  const details = fb.technicalDetails('diary');
  assert.match(details, /^Build: /m);
  assert.match(details, /^Screen: diary$/m);
  assert.match(details, /^Device: Chrome on Android$/m);
  assert.match(details, /^Window: /m);
  assert.match(details, /^Time: /m);
  /* Five lines, and no sixth that somebody added without thinking. */
  assert.equal(details.split('\n').length, 5, `unexpected fields:\n${details}`);
  /* The full user agent is a fingerprint; a class of browser is what helps. */
  assert.doesNotMatch(details, /Mozilla\/5\.0/);
  delete (globalThis as any).window;
});

test('feedback: with nothing configured it says so rather than showing dead buttons', async () => {
  const fb = await import(
    `file://${join(process.cwd(), '..', 'web', 'feedback.js')}?t=${Math.random()}`
  ) as any;
  (globalThis as any).window = { LIFE_OS_CONFIG: { beta: {} } };
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Chrome/140' }, configurable: true, writable: true,
  });
  assert.equal(fb.whatsappHref('today'), null);
  assert.equal(fb.mailHref('today'), null);
  assert.equal(fb.feedbackAvailable(), false);
  const html = fb.feedbackSheetHtml('today');
  assert.doesNotMatch(html, /WhatsApp Zander/, 'a dead WhatsApp button is shown');
  assert.match(html, /PUBLIC_BETA_WHATSAPP_URL/, 'the missing setting is not named');

  (globalThis as any).window.LIFE_OS_CONFIG.beta = {
    whatsappUrl: 'https://wa.me/27123456789', supportEmail: 'z@example.com',
  };
  const live = fb.feedbackSheetHtml('today');
  assert.match(live, /WhatsApp Zander/);
  assert.match(live, /Email feedback/);
  assert.match(fb.whatsappHref('today'), /^https:\/\/wa\.me\/27123456789\?text=/);
  assert.match(fb.mailHref('today'), /^mailto:z@example\.com\?subject=/);
  delete (globalThis as any).window;
});

/* ══ Phase 4 — the usage panel leads with the answer ═════════════════════ */

test('usage: the panel leads with money and hides tokens behind details', async () => {
  const panel = await import(
    `file://${join(process.cwd(), '..', 'web', 'usage-panel.js')}?t=${Math.random()}`
  ) as any;
  const html = panel.usagePanelHtml({
    status: 'ok', allowanceUsd: 11, usedUsd: 1.54, remainingUsd: 9.46,
    fraction: 0.14, periodStart: '2026-08-21T00:00:00Z', periodEnd: null,
    zar: { rate: 18.2, allowance: 200.2, used: 28.03, remaining: 172.17 },
    turns: 143, calls: 400, failures: 0, estimatedCalls: 0,
    tokens: { input: 2387124, output: 91000, cacheRead: 0, cacheWrite: 0 },
    byJob: [], message: null,
  });
  /* The headline is the money. */
  const headline = html.slice(html.indexOf('use-headline'), html.indexOf('use-bar'));
  assert.match(headline, /R28\.03/);
  assert.match(headline, /of R200/);
  assert.match(headline, /14%/);
  assert.doesNotMatch(headline, /2,387,124|token/i, 'tokens lead the panel');
  /* And the tokens exist, behind a details section. */
  assert.match(html, /<details class="use-details">/);
  assert.ok(html.indexOf('2,387,124') > html.indexOf('use-details'),
    'the token count is not behind Details');
  /* Amounts of a hundred or more drop their decimals — "R172 remaining"
     rather than "R172.17 remaining", which is how anybody would say it. */
  assert.match(html, /R172 remaining/);
  assert.match(html, /143 assistant turns/);
});

test('usage: rand appears only when the server sent a rate', async () => {
  const panel = await import(
    `file://${join(process.cwd(), '..', 'web', 'usage-panel.js')}?t=${Math.random()}`
  ) as any;
  const base = {
    status: 'ok', allowanceUsd: 11, usedUsd: 1.54, remainingUsd: 9.46, fraction: 0.14,
    periodStart: null, periodEnd: null, turns: 0, calls: 0, failures: 0,
    estimatedCalls: 0, tokens: {}, byJob: [], message: null,
  };
  const withoutFx = panel.usagePanelHtml({ ...base, zar: null });
  assert.match(withoutFx, /\$1\.54/, 'with no rate it should show dollars');
  assert.doesNotMatch(withoutFx, /R1\.54|R28/, 'rand was invented without a rate');
});

test('usage: red is reserved for actually blocked', async () => {
  const panel = await import(
    `file://${join(process.cwd(), '..', 'web', 'usage-panel.js')}?t=${Math.random()}`
  ) as any;
  const at = (status: string) => panel.usagePanelHtml({
    status, allowanceUsd: 11, usedUsd: 10, remainingUsd: 1, fraction: 0.92,
    periodStart: null, periodEnd: null, zar: null, turns: 0, calls: 0,
    failures: 0, estimatedCalls: 0, tokens: {}, byJob: [],
    message: 'Something to say.',
  });
  /* Amber for a warning, red only once it has stopped. Red for "nearly there"
     trains people to ignore red. */
  assert.match(at('notice'), /use-panel is-notice/);
  assert.match(at('warning'), /use-panel is-warn/);
  assert.match(at('blocked'), /use-panel is-stop/);
  assert.match(at('ok'), /use-panel is-ok/);
  /* And nothing is said at all when there is nothing to say. */
  assert.equal(panel.usageNoticeHtml({ status: 'ok', message: null }), null);
});

/* ══ Phase 3D/8D — Admin is hidden from people who do not have it ════════ */

test('settings: the Admin section appears only for an admin', async () => {
  const settings = await import(
    `file://${join(process.cwd(), '..', 'web', 'settings.js')}?t=${Math.random()}`
  ) as any;
  const ids = (state: any) => settings.settingsTabs(state).map((t: any) => t.id);

  const normal = ids({ me: { account: { isAdmin: false, isBeta: true } } });
  assert.ok(!normal.includes('admin'), 'a normal user is shown an Admin section');
  assert.ok(normal.includes('usage') && normal.includes('beta'));

  const admin = ids({ me: { account: { isAdmin: true, isBeta: true } } });
  assert.ok(admin.includes('admin'));

  /* Beta is meaningless to a standard account and is not shown to one. */
  const standard = ids({ me: { account: { isAdmin: false, isBeta: false } } });
  assert.ok(!standard.includes('beta'));
  assert.ok(standard.includes('usage'), 'usage is not beta-only');
});

test('admin: the client computes no money of its own', () => {
  const src = web('admin.js');
  /* Percentages, remaining balances and statuses all arrive from the server.
     A browser that can work out an allowance is a browser that can be
     persuaded it has a bigger one. The only arithmetic here is a currency
     conversion at a rate the server supplied, and drawing a bar. */
  assert.doesNotMatch(src, /allowanceUsd\s*-\s*usedUsd/, 'the client subtracts a balance');
  assert.doesNotMatch(src, /usedUsd\s*\/\s*allowance/, 'the client computes a percentage');
  assert.match(src, /const pct = \(f\)/, 'the fraction is not taken from the server');
});

/* ══ Phase 8G — nothing developer-facing in a tester's way ═══════════════ */

test('cleanup: diagnostics need a deliberate switch, not just a staging build', () => {
  /* The panel, the twenty-preset waveform lab and the demo transcripts are
     tools for whoever is building Life OS. A tester who opens "Development"
     and finds sliders labelled `fold` and `drive` has found a way to make the
     app look broken and a bug report they cannot write.

     Two gates: the ENVIRONMENT decides whether they can exist (production
     never), and an explicit `?diag=1` decides whether they are showing. */
  const src = web('assistant.js');
  assert.match(src, /const devPossible = \(\)/, 'the environment gate is gone');
  assert.match(src, /export const devTools = \(\) => \{/, 'the second gate is gone');
  assert.match(src, /if \(!devPossible\(\)\) return false;/,
    'the switch can turn diagnostics on where the environment forbids them');
  assert.match(src, /los2_diag/, 'there is no explicit switch');
  assert.match(src, /URLSearchParams[\s\S]*'diag'/, 'the switch cannot be set from a URL');
});

test('cleanup: the tester’s assistant screen has no development surfaces', () => {
  const src = web('assistant.js');
  /* Every developer surface is behind `devTools()`, which is now false unless
     somebody deliberately asked. Checked by construction rather than by
     reading: each of these appears only inside that condition. */
  for (const marker of ['devPanelHtml()', 'asst-demos']) {
    const at = src.indexOf(marker);
    assert.ok(at > 0, `${marker} is missing entirely`);
    const line = src.slice(src.lastIndexOf('\n', at) + 1, src.indexOf('\n', at));
    assert.match(line, /devTools\(\)/, `${marker} is not behind the development gate`);
  }
});

test('cleanup: production gets no development tools at all', () => {
  const server = readFileSync(join('..', 'web', 'server.js'), 'utf8');
  /* Unchanged from the diagnostics work, and re-asserted here because the
     second gate must not be mistaken for the first: an explicit `?diag=1` on
     production must still get nothing. */
  assert.match(server, /IS_PRODUCTION = \/prod\//);
  assert.match(server, /!IS_PRODUCTION && \(IS_STAGING \|\| IS_LOCAL\)/);
});

/* ══ The beta mark ═══════════════════════════════════════════════════════ */

test('beta: the mark is shown to beta accounts and is a way to send feedback', () => {
  const app = web('app.js');
  assert.match(app, /state\.me\?\.account\?\.isBeta \? '<span class="beta-tag"/,
    'the sidebar mark is not gated on the account being a beta one');
  assert.match(app, /beta-tag-m/, 'the phone has no mark');
  assert.match(app, /\['beta-tag', 'beta-tag-m'\]\.forEach/, 'the mark does nothing');
  assert.match(app, /el\.addEventListener\('click', openFeedback\)/);
  /* Reachable by keyboard, not only by tapping. */
  assert.match(app, /e\.key === 'Enter' \|\| e\.key === ' '/);
});

test('beta: an unconfigured deployment still shows the introduction', () => {
  const app = web('app.js');
  /* This used to replace everything with "Set the FIREBASE_* variables", so a
     mis-deployed Life OS greeted a first-time visitor with a developer's error
     message. The person who can fix that is not the person reading it. */
  const at = app.indexOf('if (!CFG.isConfigured) {');
  assert.ok(at > 0);
  const block = app.slice(at, at + 900);
  assert.match(block, /return renderSignIn\(/, 'the landing page is still replaced');
  assert.doesNotMatch(block, /renderFatal/, 'a developer error still takes the page');
});
