/**
 * CONCEPT A — Spine-first hardback shelf.
 *
 * The closest concept to the stated ideal: *I see the hardbacks. I choose one.
 * It turns toward me. I choose it again and it opens.*
 *
 * RESTING is spine-on. The primary visible surface is the bound edge, books
 * stand shoulder to shoulder with small height differences, and almost none of
 * the front cover shows — which is what a shelf of hardbacks actually looks
 * like, and the opposite of what every previous Library iteration drew.
 *
 * ── The turn, and how it stays crisp (§16/§17) ───────────────────────────
 *
 * Each book is a real 3D box with two faces:
 *
 *     spine   width  = SPINE_W   rotateY(0)      translateZ(COVER_W / 2)
 *     cover   width  = COVER_W   rotateY(90deg)  translateZ(SPINE_W / 2)
 *
 * Turning the volume by −90° swings the cover to the front. Text lives on its
 * own face throughout, so nothing is a flattened screenshot of anything.
 *
 * The important part is what happens at the END. A transformed element
 * rasterises on a transformed grid, so a cover left sitting at rotateY(−90°)
 * would be permanently slightly soft. When the transition finishes, the book
 * is switched to `is-flat`: the 3D is dropped entirely and the cover is drawn
 * as an ordinary untransformed element. The animation illustrates the change;
 * the DOM owns the final state.
 *
 * That handoff is guarded by a timer as well as `transitionend`, because a
 * transition that never fires would otherwise strand the book mid-turn.
 */

import { BOOKS, DIARY, DOCUMENTS, esc, spineTitle, coverFace } from './lab-data.js';

const TURN_MS = 300;

/* Heights vary a little, the way a real shelf does. Deterministic per book so
 * the same volume is the same size every time you switch back. */
const heightFor = (id) => {
  let n = 0;
  for (const ch of String(id)) n = (n + ch.charCodeAt(0) * 7) % 11;
  return 178 + n * 4;                       // 178–218px
};
const spineFor = (id) => {
  let n = 0;
  for (const ch of String(id)) n = (n + ch.charCodeAt(0) * 3) % 4;
  return 30 + n * 5;                        // 30–45px
};

function volume(b) {
  const h = heightFor(b.id);
  const sw = spineFor(b.id);
  return `<article class="cA-vol${b.system ? ' is-system' : ''}" data-obj="${b.id}"
    data-accent="${b.accent}" role="button" tabindex="0" aria-expanded="false"
    aria-label="${esc(b.title)}, Book. Press to turn it toward you."
    style="--h:${h}px;--sw:${sw}px">
    <span class="cA-box">
      <span class="cA-face cA-spine">
        <span class="cA-band"></span>
        <span class="cA-spine-t">${esc(spineTitle(b.title))}</span>
        <span class="cA-imprint">${b.system ? '✦' : 'LOS'}</span>
        <span class="cA-band"></span>
      </span>
      <span class="cA-face cA-front">${coverFace(b)}</span>
    </span>
    <span class="cA-foot">
      <span class="cA-foot-t">${esc(b.title)}</span>
      ${b.sub ? `<span class="cA-foot-s">${esc(b.sub)}</span>` : ''}
      <span class="cA-open" data-open>Open ${b.system ? 'Diary' : 'book'} →</span>
    </span>
  </article>`;
}

/** Documents stand on the same shelf as slim labelled binders. */
function binder(d) {
  return `<article class="cA-binder" data-obj="${d.id}" data-accent="${d.accent}"
    role="button" tabindex="0" aria-label="${esc(d.title)}, Document">
    <span class="cA-binder-spine">
      <span class="cA-binder-label">${esc(spineTitle(d.title, 24))}</span>
    </span>
    <span class="cA-binder-body"></span>
    <span class="cA-foot">
      <span class="cA-foot-t">${esc(d.title)}</span>
      <span class="cA-foot-s">Document</span>
      <span class="cA-open" data-open>Open →</span>
    </span>
  </article>`;
}

export const notes = [
  'Resting: hardbacks stood spine-on, shoulder to shoulder, heights varying.',
  'First press: the volume slides out and turns ~90° to face you.',
  'Second press: opens the Book.',
  'Documents: slim labelled binders standing on the same shelf.',
  'Feeling: a real shelf you read along, then pull from.',
];

export function render(root) {
  root.innerHTML = `<div class="cA">
    <section class="cA-bay">
      <h3 class="lab-shelf-h">Personal</h3>
      <div class="cA-shelf"><div class="cA-row">${volume(DIARY)}</div></div>
    </section>
    <section class="cA-bay">
      <h3 class="lab-shelf-h">Books</h3>
      <div class="cA-shelf"><div class="cA-row">${BOOKS.map(volume).join('')}</div></div>
    </section>
    <section class="cA-bay">
      <h3 class="lab-shelf-h">Documents</h3>
      <div class="cA-shelf"><div class="cA-row">${DOCUMENTS.map(binder).join('')}</div></div>
    </section>
  </div>`;

  let turned = null;
  const timers = new Set();
  const after = (fn, ms) => { const t = setTimeout(fn, ms); timers.add(t); return t; };

  const restAll = () => {
    if (!turned) return;
    const obj = turned;
    turned = null;
    obj.classList.remove('is-turned', 'is-flat');
    obj.setAttribute('aria-expanded', 'false');
  };

  const turn = (obj) => {
    if (obj === turned) return;
    restAll();
    turned = obj;
    obj.classList.add('is-turned');
    obj.setAttribute('aria-expanded', 'true');
    /* COMMIT THE FINAL STATE. When the turn finishes the 3D is dropped and the
     * cover becomes an ordinary untransformed element, so the text it carries
     * rasterises exactly as it would have if it had never moved. The timer is
     * the guarantee; `transitionend` is only the optimisation. */
    const commit = () => { if (turned === obj) obj.classList.add('is-flat'); };
    obj.addEventListener('transitionend', commit, { once: true });
    after(commit, TURN_MS + 60);
  };

  const onClick = (e) => {
    const obj = e.target.closest('[data-obj]');
    if (!obj) { restAll(); return; }
    const isBinder = obj.classList.contains('cA-binder');
    if (isBinder) { obj.classList.toggle('is-out'); return; }
    if (obj === turned || e.target.closest('[data-open]')) { root.dispatchEvent(
      new CustomEvent('lab-open', { bubbles: true, detail: { id: obj.dataset.obj } })); return; }
    turn(obj);
  };
  const onKey = (e) => {
    const obj = e.target.closest('[data-obj]');
    if (!obj) return;
    if (e.key === 'Escape') { restAll(); return; }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onClick({ target: obj, closest: () => obj });
  };

  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKey);

  /** Every concept returns its own teardown — see lab-view.js on switching. */
  return () => {
    timers.forEach(clearTimeout);
    timers.clear();
    root.removeEventListener('click', onClick);
    root.removeEventListener('keydown', onKey);
    turned = null;
  };
}
