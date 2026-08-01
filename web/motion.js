/**
 * Layout animation (FLIP) and the reduced-motion gate.
 *
 * Why FLIP: when a task moves, the cards around it must visibly make room. The
 * naive approach — rebuild the list and let it repaint — is what produced the
 * "board flash" defect: everything is destroyed, everything re-enters, and the
 * eye reads a page reload rather than one card moving.
 *
 * FLIP instead measures where everything WAS, applies the real DOM change, then
 * animates each element from its old position to its new one using transform
 * only. Nothing re-enters, nothing is destroyed, and the browser only
 * composites — no layout thrashing.
 */

/** True when the user has asked for less motion, by OS or by app preference. */
export function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
    || document.documentElement.dataset.motion === 'reduced';
}

const DURATION = 260;   // --d-slow
const EASING = 'cubic-bezier(.2,.7,.2,1)';   // --e-out

/**
 * Runs `done` exactly once, on whichever comes first: the animation finishing,
 * the animation being cancelled, or a timeout.
 *
 * An animation is NOT a reliable callback. A hidden tab, a detached element or
 * a paused compositor can leave one in `running` forever, and `onfinish` then
 * never arrives. When that callback is what removes a completed task from the
 * board, the task is stranded on screen until the next full reload. So the
 * animation is treated as the decoration it is, and the timeout as the
 * guarantee.
 */
export function settle(anim, duration, done) {
  let fired = false;
  const once = () => { if (fired) return; fired = true; done(); };
  anim.onfinish = once;
  anim.oncancel = once;
  setTimeout(once, duration + 60);
  return once;
}

/**
 * The same guarantee for a CSS TRANSITION rather than a WAAPI animation.
 *
 * `transitionend` is no more reliable than `onfinish`: it does not fire if the
 * transition is interrupted, if the property never actually changed, or if the
 * tab is hidden. Anything that cleans up after a transition — clearing a
 * collapsed panel so its buttons leave the tab order, for instance — needs the
 * timeout as the guarantee and the event only as the fast path.
 *
 * @param {Element} el the transitioning element
 * @param {string} prop the property to wait for, e.g. 'grid-template-columns'
 * @param {number} duration the transition duration in ms
 * @param {() => void} done
 */
export function afterTransition(el, prop, duration, done) {
  let fired = false;
  const once = () => {
    if (fired) return;
    fired = true;
    el.removeEventListener('transitionend', onEnd);
    done();
  };
  const onEnd = (e) => { if (e.target === el && e.propertyName === prop) once(); };
  el.addEventListener('transitionend', onEnd);
  setTimeout(once, duration + 80);
  return once;
}

/**
 * Runs `mutate`, then animates every tracked element from where it was to
 * where it now is.
 *
 * @param {Element[]|NodeList} elements elements to track BEFORE the change
 * @param {() => void} mutate the DOM change itself
 * @param {{duration?: number}} [opts]
 */
export function flip(elements, mutate, opts = {}) {
  const list = [...elements];

  if (reducedMotion()) { mutate(); return; }

  // FIRST — where is everything now, and which key identifies it?
  const first = new Map();
  for (const el of list) {
    const key = el.dataset.id ?? el.dataset.habit;
    if (key) first.set(key, el.getBoundingClientRect());
  }

  // LAST — apply the real change.
  mutate();

  // INVERT + PLAY.
  const after = document.querySelectorAll('[data-id],[data-habit]');
  for (const el of after) {
    const key = el.dataset.id ?? el.dataset.habit;
    const prev = first.get(key);
    if (!prev) {
      // New to the view: a quiet fade-in rather than the full stagger, so a
      // single added card does not look like the whole board reloading.
      el.animate(
        [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
        { duration: opts.duration ?? DURATION, easing: EASING },
      );
      continue;
    }
    const now = el.getBoundingClientRect();
    const dx = prev.left - now.left;
    const dy = prev.top - now.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;   // it did not move

    el.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      { duration: opts.duration ?? DURATION, easing: EASING },
    );
  }
}

/**
 * A brief, restrained emphasis — used when a value changes in place (a bucket
 * count, a step tally) so the change is noticed without anything moving.
 */
export function pulse(el) {
  if (!el || reducedMotion()) return;
  el.animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(1.14)' }, { transform: 'scale(1)' }],
    { duration: 300, easing: EASING },
  );
}

/**
 * Collapses an element out of the flow before removing it, so the cards below
 * close the gap rather than jumping up.
 */
export function collapseOut(el, onDone) {
  if (reducedMotion()) { onDone(); return; }
  const h = el.getBoundingClientRect().height;
  const anim = el.animate(
    [
      { height: `${h}px`, opacity: 1, transform: 'none', marginBottom: getComputedStyle(el).marginBottom },
      { height: '0px', opacity: 0, transform: 'translateX(-8px)', marginBottom: '0px' },
    ],
    { duration: 200, easing: 'cubic-bezier(.4,0,.9,.4)' },
  );
  el.style.overflow = 'hidden';
  // The removal is guaranteed by `settle`, not by the animation completing.
  settle(anim, 200, onDone);
}
