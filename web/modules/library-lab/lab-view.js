/**
 * The Library design lab — the shell (L3.3 §2/§21/§22/§31).
 *
 * A staging-only surface for comparing six complete visual directions against
 * the same objects. It exists because the last several Library phases each
 * corrected something real and the result still did not look right — which is
 * the signature of optimising the wrong metaphor rather than of a bug.
 *
 * ── Rules this file enforces ─────────────────────────────────────────────
 *
 * READ-ONLY BY CONSTRUCTION. The lab makes no network requests at all. Its
 * subject is a fixed literal set in `lab-data.js`, so there is no code path by
 * which an experiment could rename, archive or reorder anything (§24).
 *
 * ONE CONCEPT MOUNTED AT A TIME. Every concept's `render` returns a teardown,
 * and switching calls it before mounting the next: listeners removed, timers
 * cleared, DOM replaced. Switching A→B→C→A repeatedly must leave the node and
 * listener counts where they started (§31).
 *
 * NO RECOMMENDATION. The concepts are labelled A–F with neutral descriptors and
 * nothing is marked preferred. The point of the phase is that the choice is
 * the user's, and a badge would make it mine (§4/§21).
 */

import { navToken, navStale } from '../../nav.js';

const CONCEPTS = [
  /* C2 leads the list. C was chosen as the base direction in L3.4 and C2 is the
   * only concept receiving new design work; A, B, D, E and F stay reachable so
   * the comparison that produced the choice can still be re-made, but they are
   * frozen. */
  { id: 'c2', label: 'C2', desc: 'Modern Library refined', mod: () => import('./concept-c2.js') },
  { id: 'a', label: 'A', desc: 'Spine-first', mod: () => import('./concept-a.js') },
  { id: 'b', label: 'B', desc: 'Fantasy shelf', mod: () => import('./concept-b.js') },
  { id: 'c', label: 'C', desc: 'Modern library', mod: () => import('./concept-c.js') },
  { id: 'd', label: 'D', desc: 'Cover-forward', mod: () => import('./concept-d.js') },
  { id: 'e', label: 'E', desc: 'Alcoves', mod: () => import('./concept-e.js') },
  { id: 'f', label: 'F', desc: 'Personal archive', mod: () => import('./concept-f.js') },
];

/** Injected by library-view.js: the API caller, so the gate can ask the server. */
let ctx = null;
export function initLab(c) { ctx = c; }

/**
 * Is the lab available here?
 *
 * Asked of the SERVER rather than guessed from a hostname. `GET /library/sample`
 * already reports `allowed`, which is exactly `NODE_ENV !== 'production'` — the
 * same guard the sample tooling uses. Reusing it means the lab cannot appear in
 * production without the sample endpoints appearing too, and there is no new
 * configuration to get wrong.
 *
 * Cached for the session: it cannot change under a running page.
 */
let allowed = null;
export async function labAllowed() {
  if (allowed !== null) return allowed;
  try {
    const r = await ctx.api('/library/sample');
    allowed = r?.allowed === true;
  } catch {
    // A failure is not permission. Refusing is the safe direction.
    allowed = false;
  }
  return allowed;
}

/** Test seam. */
export const __resetLabGate = () => { allowed = null; };

let teardown = null;
let current = null;

/** Unmounts whatever is showing. Safe to call when nothing is. */
function unmount(stage) {
  try { teardown?.(); } catch { /* a broken prototype must not wedge the lab */ }
  teardown = null;
  if (stage) stage.innerHTML = '';
}

async function mount(stage, id, nav) {
  const spec = CONCEPTS.find((c) => c.id === id) ?? CONCEPTS[0];
  unmount(stage);
  const mod = await spec.mod();
  if (navStale(nav)) return;                    // they left while it loaded
  current = spec.id;
  const host = document.createElement('div');
  host.className = `lab-stage-in lab-${spec.id}`;
  stage.appendChild(host);
  teardown = mod.render(host) ?? null;

  const notes = document.getElementById('lab-notes-body');
  if (notes) {
    notes.innerHTML = (mod.notes ?? []).map((n) => `<li>${n}</li>`).join('');
  }
  document.querySelectorAll('[data-concept]').forEach((b) => {
    const on = b.dataset.concept === spec.id;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  const cap = document.getElementById('lab-current');
  if (cap) cap.textContent = `${spec.label} — ${spec.desc}`;
}

export async function renderLab(head, scroll, nav = navToken()) {
  if (!(await labAllowed())) return false;       // caller falls through to Library
  if (navStale(nav)) return true;

  head.innerHTML = `<p class="eyebrow lib-page">Life OS · staging</p>
    <h1>Library design lab</h1>
    <p class="sub">Six directions, one set of objects. Nothing here is live
      — the lab reads a fixed sample and never writes.</p>`;

  scroll.innerHTML = `<div class="lab">
    <div class="lab-bar" role="group" aria-label="Choose a concept">
      ${CONCEPTS.map((c) => `<button type="button" class="lab-pick" data-concept="${c.id}"
        aria-pressed="false"><b>${c.label}</b><small>${c.desc}</small></button>`).join('')}
      <span class="lab-current" id="lab-current"></span>
    </div>
    <details class="lab-notes">
      <summary>Design notes</summary>
      <ul id="lab-notes-body"></ul>
    </details>
    <div class="lab-stage" id="lab-stage"></div>
  </div>`;

  const stage = scroll.querySelector('#lab-stage');
  scroll.querySelectorAll('[data-concept]').forEach((b) => {
    b.addEventListener('click', () => void mount(stage, b.dataset.concept, navToken()));
  });

  /* Opening from a prototype routes to the REAL Library, which is the honest
   * way to show the handoff without the lab owning a Book view of its own. */
  stage.addEventListener('lab-open', () => { window.location.hash = '#library'; });

  await mount(stage, current ?? 'c2', nav);
  return true;
}

/** Called when Library leaves the lab route, so nothing is left running. */
export function leaveLab() {
  unmount(document.getElementById('lab-stage'));
}

export { CONCEPTS };
