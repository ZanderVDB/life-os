/**
 * The navigation token — the most recent user navigation wins.
 *
 * ── The defect this exists for ───────────────────────────────────────────
 *
 * `go(id)` awaits `libraryWillLeave()` before it changes the route, so that a
 * pending save finishes before the editor goes away. That await is correct and
 * it can take seconds.
 *
 * While it runs, `state.route` is still the OLD route. So a second click
 * entered `go()` and took the same "I am leaving Library" branch, and a third
 * did too. Three concurrent navigations, each holding its own target, each
 * eventually calling `loadRoute()`. Whichever one's fetch finished LAST painted
 * last — so clicking Projects, Calendar, Today could land on Today and then be
 * overwritten by Projects a second later.
 *
 * Library and Diary made it worse: their render functions call `setHash()`, so
 * a stale render did not merely repaint, it rewrote the URL and put the person
 * back inside the Book they had left.
 *
 * ── The rule ─────────────────────────────────────────────────────────────
 *
 * Every navigation takes a token. Any asynchronous continuation must check it
 * before touching the screen — before painting, before setting the hash, before
 * moving focus or scroll, before changing the sidebar.
 *
 * A pending SAVE may still finish. It updates its own record and its own save
 * coordinator, and it must never call a render routine that assumes the route
 * it started under is still the route.
 */

let token = 0;

/** Claims a new navigation. Called before anything else in a route change. */
export const bumpNav = () => (token += 1);

/** The token to capture at the start of an async render. */
export const navToken = () => token;

/** True when a newer navigation has happened since `t` was taken. */
export const navStale = (t) => t !== token;

/**
 * Runs `fn` only if the navigation that captured `t` is still current.
 *
 * The readable form of the guard, for the common case of "paint this".
 */
export function ifCurrent(t, fn) {
  if (navStale(t)) return undefined;
  return fn();
}
