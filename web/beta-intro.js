/**
 * The beta introduction — the words, in one place.
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 *
 * The same explanation has to appear twice: on the landing page, before
 * anybody signs in, and again as a first-run acknowledgement inside the app
 * for an account that has not yet said it has read it. Two copies of a
 * promise about money is exactly the kind of thing that drifts, so the
 * SECTIONS are data and both surfaces render the same array.
 *
 * The landing page's markup is still static in `index.html` — it is the first
 * paint, and waiting for a module to load before showing anything would be a
 * blank screen for the one visitor who has never seen Life OS. The two are
 * kept honest by a test that asserts the same claims appear in both.
 *
 * ── The one thing that must never be written loosely ─────────────────────
 *
 * The AI cost. It is easy and tempting to write "it will cost you about R30",
 * and if that turns out to be wrong somebody has been misled about money. So
 * the copy says what is enforced: there is an allowance, it is visible in
 * Settings, and the assistant stops when it is reached. Nothing here promises
 * a number the server does not actually hold anybody to.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const INTRO_SECTIONS = [
  {
    id: 'beta',
    kicker: 'Beta',
    title: 'This is early. Genuinely early.',
    body: [
      'Life OS is being built in the open and you are among the first people '
      + 'outside my own screen to use it. Things will break, some corners are '
      + 'unfinished, and a few will look odd on your particular phone.',
      'None of that is your fault, and none of it is a reason to be polite '
      + 'about it.',
    ],
  },
  {
    id: 'feedback',
    kicker: 'Feedback',
    title: 'Tell me anything. Especially the small things.',
    body: [
      'If something breaks, looks strange, feels confusing, or could simply be '
      + 'better — send it. A half-formed “this felt weird” is more useful than '
      + 'silence, and small irritations are usually the ones that matter most.',
      'There is a Send feedback button in Settings, and it will WhatsApp or '
      + 'email me with the build and the screen you were on already attached.',
    ],
  },
  {
    id: 'ai',
    kicker: 'AI usage',
    title: 'The assistant costs real money, and you can see exactly how much.',
    body: [
      'There is no Life OS subscription during this test. The only cost is the '
      + 'AI the assistant actually uses when you talk to it.',
      'Your account has an allowance. What you have used and what is left are '
      + 'in Settings → AI usage, updated after every request, so there is '
      + 'nothing to discover later. If you reach it the assistant pauses — and '
      + 'the rest of Life OS carries on exactly as normal.',
      'Everything else — tasks, projects, calendar, diary, library — never '
      + 'touches it.',
    ],
  },
  {
    id: 'length',
    kicker: 'How long',
    title: 'About one to two weeks.',
    body: [
      'Long enough to use it for real: plan a week, run a project, talk to the '
      + 'assistant, write in the diary, and find out whether it actually helps.',
      'Use it properly rather than carefully. That is the only way either of '
      + 'us learns anything.',
    ],
  },
];

export const INTRO_HEADLINE = 'Welcome to Life OS';
export const INTRO_LEDE = 'You’re early. Very early.';
export const INTRO_OPENING = 'For the next week or two I would like you to use '
  + 'Life OS properly — plan your week, make projects, talk to the assistant, '
  + 'keep notes, write in the diary — and find out whether it actually helps.';
export const INTRO_CTA = 'I understand — enter Life OS';

const sectionHtml = (s) => `<article class="bi-card" data-intro-card="${s.id}">
  <span class="bi-kicker">${esc(s.kicker)}</span>
  <h3 class="bi-card-h">${esc(s.title)}</h3>
  ${s.body.map((p) => `<p>${esc(p)}</p>`).join('')}
</article>`;

/**
 * The introduction, for the in-app first run.
 *
 * @param opts.cta      the button label
 * @param opts.dismiss  whether this is a re-read (Close) or the first run
 *                      (which must be acknowledged before going further)
 */
export function introHtml(opts = {}) {
  const cta = opts.cta ?? INTRO_CTA;
  return `<div class="bi">
    <header class="bi-head">
      <p class="bi-eyebrow">${esc(INTRO_LEDE)}</p>
      <h2 class="bi-h">${esc(INTRO_HEADLINE)}</h2>
      <p class="bi-lede">${esc(INTRO_OPENING)}</p>
    </header>
    <div class="bi-cards">${INTRO_SECTIONS.map(sectionHtml).join('')}</div>
    <div class="bi-foot">
      <button type="button" class="btn btn-primary bi-cta" id="bi-accept">${esc(cta)}</button>
      ${opts.dismiss ? '<button type="button" class="btn btn-quiet" id="bi-close">Close</button>' : ''}
    </div>
  </div>`;
}
