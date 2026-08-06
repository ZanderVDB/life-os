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

/* ── Who wrote the hash ──────────────────────────────────────────────────
 *
 * The D2.2 Library regression, and it is the other half of the same idea.
 *
 * A hash change is a NAVIGATION when a person made it — a sidebar click, Back,
 * Forward, a pasted URL. It is not a navigation when the app wrote it itself to
 * record where the person already is: opening a Book, turning a page, moving to
 * the next diary day. Those writes come AFTER the decision, not before it.
 *
 * Three modules were writing hashes and each kept its own private flag — app.js
 * `ownHashWrite`, library-view `suppressHash`, diary-view `suppressHash`. Only
 * app.js's was consulted by the shell's `hashchange` handler, so a Library or
 * Diary write bumped the token and invalidated the very render that had just
 * made it. Opening a Book set the hash, the token moved, `loadBook` came back,
 * found itself stale and returned without painting — leaving "Opening…" and a
 * skeleton on screen for ever.
 *
 * One writer, one record, one answer. Anything that writes `location.hash` goes
 * through `setHash`, and the shell asks `hashWasOurs()` exactly once per event.
 */

/** Hashes we wrote and whose `hashchange` has not arrived yet. */
const pendingWrites = [];

/**
 * Writes the hash and records that we did.
 *
 * @returns {boolean} whether the URL actually changed
 */
export function setHash(next) {
  const want = next.startsWith('#') ? next : `#${next}`;
  if (location.hash === want) return false;
  pendingWrites.push(want);
  location.hash = want;
  /* The safety net. `hashchange` fires as a task queued during the assignment
   * above, so it is dispatched before this timer — but if it never arrives at
   * all (a same-value write the browser folded away, a document being torn
   * down) the record must not survive to mislabel a LATER, genuine navigation
   * as ours. Worst case we fall back to treating our own write as a
   * navigation, which is exactly the old behaviour and merely wasteful. */
  setTimeout(() => forget(want), 0);
  return true;
}

function forget(hash) {
  const at = pendingWrites.indexOf(hash);
  if (at > -1) pendingWrites.splice(at, 1);
}

/**
 * Was the hash now in the URL one WE wrote?
 *
 * Consumes the record, so it answers true exactly once per write. Call it once
 * per `hashchange`, at the top of the handler, and pass the answer down.
 */
export function hashWasOurs(hash = location.hash) {
  const at = pendingWrites.indexOf(hash);
  if (at === -1) return false;
  pendingWrites.splice(at, 1);
  return true;
}

/** Test seam: forgets every outstanding write. */
export function resetHashWrites() { pendingWrites.length = 0; }
