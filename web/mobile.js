/**
 * The phone shell: which mode is running, the bottom navigation, and the
 * sheet primitive everything else on a phone is built out of.
 *
 * ── The one rule ─────────────────────────────────────────────────────────
 *
 *   Mobile preserves CAPABILITY and INFORMATION, not desktop geometry.
 *
 * Nothing reachable on a desktop may be unreachable here. It is fine for a
 * thing to be one tap deeper — Diary is in More rather than in the bar — and
 * it is not fine for it to be gone. `docs/mobile-parity.md` is the ledger of
 * where every desktop surface lives on a phone, and a test walks it.
 *
 * ── Why the query is a constant ──────────────────────────────────────────
 *
 * mobile.css writes this same query at the top of every phone block. If the
 * two ever drift, there is a band of widths where the CSS believes it is a
 * phone and the JavaScript does not — the bottom bar draws, and nothing
 * renders the mobile layout underneath it. So the string is defined once,
 * here, and the stylesheet carries a comment saying not to paraphrase it.
 */

import { icon, logoMark } from './icons.js';

/* Landscape phones are the reason for the second clause. An iPhone 14 Pro
 * Max on its side is 932 x 430 — wider than an iPad in portrait, and
 * emphatically not a tablet. Height is what tells them apart. */
export const PHONE_MQ = '(max-width:899px),(max-height:500px) and (max-width:1099px)';
const TABLET_MQ = '(min-width:900px) and (max-width:1099px)';

/* Guarded, because several of the modules that import this are also imported
 * by the Node test suite to check their exported behaviour. Evaluating
 * `window.matchMedia` at module scope threw before a single assertion ran, and
 * a test file that cannot even load is not a test.
 *
 * `never` is the honest answer off a browser: there is no viewport, so there
 * is no phone. Every caller then takes the desktop composition, which is the
 * one that can be reasoned about from source. */
const NEVER = { matches: false, addEventListener() {}, removeEventListener() {} };
const mql = (q) => (typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia(q) : NEVER);

const phoneMql = mql(PHONE_MQ);
const tabletMql = mql(TABLET_MQ);

export const isPhone = () => phoneMql.matches;
export const isTablet = () => tabletMql.matches;
export const mobileMode = () => (phoneMql.matches ? 'phone' : tabletMql.matches ? 'tablet' : 'desktop');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ── The bar ──────────────────────────────────────────────────────────
 * Five slots. The centre one is the assistant and is deliberately not a
 * route in the same sense as the others — it is an ACTION, larger and
 * lifted, because on a phone it is the point of the application.
 *
 * More is a button rather than a link: it opens a sheet, and a link that
 * does not navigate is a link that lies to a screen reader. */
const NAV = [
  { id: 'today', label: 'Today', icon: 'today' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' },
  { id: 'ai', label: 'Life OS', assistant: true },
  { id: 'projects', label: 'Projects', icon: 'projects' },
  { id: 'more', label: 'More', icon: 'menu', sheet: true },
];

/**
 * Everything in the More sheet.
 *
 * `habits` and `reminders` are not routes — they are a sheet and a Calendar
 * utility — but they ARE destinations a person goes to, so they are listed
 * as destinations. The alternative is a mobile app where habits exist only
 * as a card somebody has to know to scroll to.
 */
export const MORE_ITEMS = [
  { id: 'diary', label: 'Diary', icon: 'diary', hash: '#diary',
    desc: 'The day you are writing, the check-in, and every day before it' },
  { id: 'library', label: 'Library', icon: 'library', hash: '#library',
    desc: 'Books, documents, links and everything you have kept' },
  { id: 'habits', label: 'Habits', icon: 'check', kind: 'sheet',
    desc: 'What you are keeping up, and the streaks behind it' },
  { id: 'reminders', label: 'Reminders', icon: 'sparkle', hash: '#calendar/reminders',
    desc: 'Everything due, overdue and repeating' },
  { id: 'history', label: 'Completed', icon: 'check', hash: '#history',
    desc: 'Finished work, newest first' },
  { id: 'settings', label: 'Settings', icon: 'settings', hash: '#settings',
    desc: 'Account, appearance, areas, integrations and your data' },
];

/** Which bar slot a route lights up. Anything not in the bar lights More. */
const slotFor = (route) => (NAV.some((n) => n.id === route) ? route : 'more');

let handlers = {};

export function bottomNavHtml() {
  return `<nav class="mnav" id="mnav" aria-label="Primary">
    ${NAV.map((n) => {
    if (n.assistant) {
      return `<button type="button" class="mnav-ai" id="mnav-ai"
        aria-label="Life OS assistant. Press and hold for Quick add.">
        ${logoMark(26)}</button>`;
    }
    if (n.sheet) {
      return `<button type="button" class="mnav-i" data-slot="more" id="mnav-more">
        <span class="mnav-ico">${icon(n.icon, 21)}</span><span>${n.label}</span></button>`;
    }
    return `<a class="mnav-i" href="#${n.id}" data-slot="${n.id}" data-mroute="${n.id}">
      <span class="mnav-ico">${icon(n.icon, 21)}</span><span>${n.label}</span></a>`;
  }).join('')}
  </nav>`;
}

/** Marks the slot for `route`, and only that slot. */
export function syncMobileNav(route) {
  const want = slotFor(route);
  document.querySelectorAll('#mnav [data-slot]').forEach((el) => {
    if (el.dataset.slot === want) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
  const ai = document.getElementById('mnav-ai');
  if (ai) {
    if (route === 'ai') ai.setAttribute('aria-current', 'page');
    else ai.removeAttribute('aria-current');
  }
}

/**
 * Wires the bar. Called once per shell render.
 *
 * @param {object} h  { go, assistant, quickAdd, habits, search }
 */
export function wireMobileNav(h) {
  handlers = { ...handlers, ...h };
  document.querySelectorAll('#mnav [data-mroute]').forEach((el) => {
    el.addEventListener('click', (e) => { e.preventDefault(); handlers.go(el.dataset.mroute); });
  });
  document.getElementById('mnav-more')?.addEventListener('click', () => openMoreSheet());
  wireAssistantButton(document.getElementById('mnav-ai'));
}

/**
 * Tap opens the assistant; press and hold opens Quick add.
 *
 * ── Why this is pointer events and a timer, not `contextmenu` ────────────
 *
 * Long press on iOS fires no `contextmenu` on a button; on Android it fires
 * one AND selects text. Both platforms do give pointer events with
 * consistent timing, so the gesture is measured rather than delegated.
 *
 * Movement cancels both the hold and the tap: a press that drifts is
 * somebody starting to scroll, and stealing that gesture makes the whole
 * bar feel sticky.
 *
 * Quick add is never the ONLY way to anything (§14) — every row it offers
 * also exists as a visible button on the page it belongs to.
 */
function wireAssistantButton(btn) {
  if (!btn) return;
  let timer = null;
  let held = false;
  let from = null;

  const clear = () => {
    clearTimeout(timer); timer = null;
    btn.classList.remove('is-holding');
  };

  btn.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    held = false;
    from = { x: e.clientX, y: e.clientY };
    btn.classList.add('is-holding');
    timer = setTimeout(() => {
      held = true;
      clear();
      if (navigator.vibrate) navigator.vibrate(12);
      handlers.quickAdd?.();
    }, 480);
  });
  btn.addEventListener('pointermove', (e) => {
    if (!from) return;
    if (Math.hypot(e.clientX - from.x, e.clientY - from.y) > 10) { clear(); from = null; }
  });
  btn.addEventListener('pointerup', () => {
    const wasHeld = held;
    const started = from !== null;
    clear(); from = null;
    if (!wasHeld && started) handlers.assistant?.();
  });
  btn.addEventListener('pointercancel', () => { clear(); from = null; });
  // Keyboard and assistive technology get the tap, never the hold.
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handlers.assistant?.(); }
  });
}

/* ══════════════════════════════════════════════════════════════════════
   THE SHEET
   One implementation. Everything a phone shows over the page — More,
   Quick add, a Book's contents, a Project's tasks, the day list under
   Month — is this, so there is one way in, one way out, and one place
   where focus and scroll are handled correctly.
   ══════════════════════════════════════════════════════════════════════ */
let openSheetState = null;

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),'
  + 'textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

/**
 * @param {object} o
 *   title   heading text
 *   sub     small text beside the heading (a count, usually)
 *   body    HTML for the scrolling area
 *   foot    HTML for the pinned footer, or nothing
 *   onMount (rootEl, closeFn) => void — wire the contents here
 *   label   accessible name when there is no visible title
 */
export function openSheet(o) {
  closeSheet(true);

  const scrim = document.createElement('div');
  scrim.className = 'msheet-scrim';
  const sheet = document.createElement('div');
  sheet.className = `msheet ${o.className ?? ''}`;
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', o.label ?? o.title ?? 'Menu');
  sheet.innerHTML = `
    <div class="msheet-grab" aria-hidden="true"></div>
    ${o.title ? `<div class="msheet-head">
      <h2>${esc(o.title)}</h2>
      ${o.sub ? `<span class="msheet-sub">${esc(o.sub)}</span>` : ''}
      <button type="button" class="msheet-x" data-sheet-close aria-label="Close">&#10005;</button>
    </div>` : ''}
    <div class="msheet-body">${o.body ?? ''}</div>
    ${o.foot ? `<div class="msheet-foot">${o.foot}</div>` : ''}`;

  document.body.append(scrim, sheet);
  document.body.classList.add('msheet-open');

  const previouslyFocused = document.activeElement;

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    // A sheet is modal, so Tab must not walk out of it into the page behind.
    const f = [...sheet.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function close(instant = false) {
    if (openSheetState?.sheet !== sheet) return;
    openSheetState = null;
    document.body.classList.remove('msheet-open');
    document.removeEventListener('keydown', onKey, true);
    const done = () => { scrim.remove(); sheet.remove(); };
    if (instant) done();
    else {
      scrim.classList.remove('is-in');
      sheet.classList.remove('is-in');
      setTimeout(done, 280);
    }
    o.onClose?.();
    try { previouslyFocused?.focus?.({ preventScroll: true }); } catch { /* it went away */ }
  }

  document.addEventListener('keydown', onKey, true);
  scrim.addEventListener('click', () => close());
  sheet.querySelector('[data-sheet-close]')?.addEventListener('click', () => close());
  wireSheetDrag(sheet, close);

  openSheetState = { sheet, scrim, close };
  /* One frame, so the transform transition has a starting point to leave —
   * and a timer as well, because requestAnimationFrame does not fire in a
   * tab that is not compositing. Without the fallback the sheet never gets
   * `is-in`, which means it never leaves `translateY(101%)`: it is mounted,
   * focus-trapped, and entirely below the bottom of the screen. Both paths
   * add the same class, and adding it twice is nothing. */
  const reveal = () => { scrim.classList.add('is-in'); sheet.classList.add('is-in'); };
  requestAnimationFrame(reveal);
  setTimeout(reveal, 24);

  o.onMount?.(sheet, close);
  sheet.querySelector('[data-autofocus]')?.focus?.();
  return close;
}

export function closeSheet(instant = false) { openSheetState?.close(instant); }
export const sheetIsOpen = () => Boolean(openSheetState);

/**
 * Drag the sheet down to dismiss.
 *
 * Only from the grab handle and the header — never from the body. A sheet
 * that dismisses when you flick its scrolling list is a sheet that closes
 * every time somebody tries to read it.
 */
function wireSheetDrag(sheet, close) {
  const handle = sheet.querySelector('.msheet-grab');
  const head = sheet.querySelector('.msheet-head');
  let y0 = null;
  const start = (e) => {
    if (e.target.closest('button')) return;
    y0 = e.clientY;
    sheet.style.transition = 'none';
  };
  const move = (e) => {
    if (y0 === null) return;
    sheet.style.transform = `translateY(${Math.max(0, e.clientY - y0)}px)`;
  };
  const end = (e) => {
    if (y0 === null) return;
    const dy = Math.max(0, e.clientY - y0);
    y0 = null;
    sheet.style.transition = '';
    sheet.style.transform = '';
    if (dy > 90) close();
  };
  [handle, head].forEach((el) => {
    if (!el) return;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', start);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', () => {
      y0 = null; sheet.style.transition = ''; sheet.style.transform = '';
    });
  });
}

/** A row for a sheet's list. */
export const sheetRow = (o) => {
  const tag = o.hash ? 'a' : 'button';
  return `<${tag} class="msheet-row" ${o.hash ? `href="${o.hash}"` : 'type="button"'}
    ${o.id ? `data-more="${o.id}"` : ''} ${o.current ? 'aria-current="page"' : ''}>
    ${o.icon ? `<span class="msheet-ico">${icon(o.icon, 20)}</span>` : ''}
    <span><span class="msheet-label">${esc(o.label)}</span>
      ${o.desc ? `<span class="msheet-row-desc">${esc(o.desc)}</span>` : ''}</span>
    ${o.right ? `<span class="msheet-r">${o.right}</span>` : ''}
    <span class="msheet-chev" aria-hidden="true">${icon('chevR', 16)}</span>
  </${tag}>`;
};

/**
 * More.
 *
 * Six destinations, each with a line saying what is inside it. These are not
 * lesser features — they are the ones a phone reaches for less often, and
 * saying what they hold is what stops "More" reading as "the leftovers".
 */
export function openMoreSheet() {
  const route = handlers.currentRoute?.() ?? '';
  openSheet({
    title: 'Life OS',
    body: `<div class="msheet-group">Go to</div>
      ${MORE_ITEMS.map((m) => sheetRow({
    ...m, current: m.hash === `#${route}`, id: m.id,
  })).join('')}
      <div class="msheet-sep"></div>
      ${sheetRow({ id: 'search', label: 'Search', icon: 'search', desc: 'Find anything you have written down' })}`,
    onMount: (rootEl, close) => {
      rootEl.querySelectorAll('[data-more]').forEach((el) => {
        el.addEventListener('click', (e) => {
          e.preventDefault();
          close();
          const id = el.dataset.more;
          const item = MORE_ITEMS.find((m) => m.id === id);
          if (id === 'search') return handlers.search?.();
          if (item?.kind === 'sheet') return handlers.habits?.();
          if (item?.hash) return handlers.goHash?.(item.hash);
          return undefined;
        });
      });
    },
  });
}

/* ══════════════════════════════════════════════════════════════════════
   SWIPE
   Used by Calendar (previous / next day), the Book (page turn) and Diary.
   ══════════════════════════════════════════════════════════════════════ */

/**
 * A horizontal swipe, and only a horizontal one.
 *
 * ── The rules a swipe has to obey to be worth having ─────────────────────
 *
 * It must never steal a scroll. Vertical intent wins outright — if the
 * finger has moved further down than across, this gesture is over — because
 * a page that occasionally turns when somebody meant to scroll is worse
 * than a page with no swipe at all.
 *
 * It must never be the only way to do something (§41). Every caller here
 * also has visible arrows or a Today button.
 *
 * And it must not fire from inside something draggable or scrollable: a
 * calendar block being moved, or a row of chips being scrolled sideways,
 * is a different gesture that happens to start with the same two events.
 *
 * @param {HTMLElement} el
 * @param {object} o  { onLeft, onRight, ignore }  ignore = a CSS selector
 */
export function onSwipe(el, o) {
  let x0 = null;
  let y0 = null;
  let done = false;

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    if (o.ignore && e.target.closest(o.ignore)) return;
    // Anything that scrolls sideways owns horizontal movement inside it.
    let n = e.target;
    while (n && n !== el) {
      if (n.scrollWidth > n.clientWidth + 4) return;
      n = n.parentElement;
    }
    x0 = e.clientX; y0 = e.clientY; done = false;
  });

  el.addEventListener('pointermove', (e) => {
    if (x0 === null || done) return;
    const dx = e.clientX - x0;
    const dy = e.clientY - y0;
    if (Math.abs(dy) > Math.abs(dx)) { x0 = null; return; }   // a scroll
    if (Math.abs(dx) < 64) return;
    done = true;
    x0 = null;
    if (dx < 0) o.onLeft?.(); else o.onRight?.();
  });

  const end = () => { x0 = null; };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

/**
 * Swipe a row.
 *
 * Right completes, left opens the row's actions. Both are also visible
 * buttons on the row itself — §41 — so this is an accelerator for people who
 * know it is there, never the way anything is discovered.
 *
 * The row follows the finger, and a coloured layer behind it says what is
 * about to happen. A swipe with no feedback until release is a gamble, and
 * people stop using it after the first time it does the wrong thing.
 *
 * @param {HTMLElement} el      the row
 * @param {object} o  { onRight, onLeft, rightLabel, leftLabel, ignore }
 */
export function rowSwipe(el, o) {
  const COMMIT = 76;
  let x0 = null;
  let y0 = null;
  let axis = null;   // null until the direction is decided, then 'x' or 'y'
  let back = null;

  const surface = el.querySelector('[data-swipe-surface]') ?? el;

  const reset = (animate = true) => {
    surface.style.transition = animate ? 'transform 180ms cubic-bezier(.2,.7,.2,1)' : '';
    surface.style.transform = '';
    if (back) { back.remove(); back = null; }
    x0 = null; y0 = null; axis = null;
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    if (o.ignore && e.target.closest(o.ignore)) return;
    x0 = e.clientX; y0 = e.clientY; axis = null;
    surface.style.transition = 'none';
  });

  el.addEventListener('pointermove', (e) => {
    if (x0 === null) return;
    const dx = e.clientX - x0;
    const dy = e.clientY - y0;
    if (!axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      // Vertical intent wins outright. A list that occasionally swipes when
      // somebody meant to scroll is worse than a list with no swipe at all.
      axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (axis === 'y') { reset(false); return; }
      back = document.createElement('span');
      back.className = 'swipe-back';
      el.prepend(back);
    }
    if (axis !== 'x') return;
    const capped = Math.max(-140, Math.min(140, dx));
    surface.style.transform = `translateX(${capped}px)`;
    back.className = `swipe-back ${dx > 0 ? 'is-right' : 'is-left'} ${
      Math.abs(dx) > COMMIT ? 'is-armed' : ''}`;
    back.textContent = dx > 0 ? (o.rightLabel ?? 'Done') : (o.leftLabel ?? 'Actions');
  });

  const end = (e) => {
    if (x0 === null || axis !== 'x') { reset(false); return; }
    const dx = e.clientX - x0;
    reset();
    if (dx > COMMIT) o.onRight?.();
    else if (dx < -COMMIT) o.onLeft?.();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', () => reset(false));
}

/* ══════════════════════════════════════════════════════════════════════
   THE VIRTUAL KEYBOARD
   A fixed bottom bar and a software keyboard want the same edge of the
   screen. Nothing in CSS can see the keyboard, so this measures it.
   ══════════════════════════════════════════════════════════════════════ */
function watchKeyboard() {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return;
  /* Measured against the TALLEST visual viewport seen in this orientation,
   * not against window.innerHeight.
   *
   * innerHeight is the layout viewport, and the two are not the same number
   * even with no keyboard: iOS Safari keeps innerHeight at the tall value
   * while the address bar is showing, and any browser that scales the layout
   * viewport — a device emulator, a desktop responsive mode — puts a
   * permanent gap between them. Subtracting one from the other therefore
   * reports a keyboard that is not there, and hides the navigation on a
   * page nobody is typing into.
   *
   * The tallest height this orientation has ever had is the keyboard-free
   * height by definition, so the difference from it is the keyboard. */
  let tallest = 0;
  let width = 0;
  const sync = () => {
    // A rotation is a different tallest, so the record starts again.
    if (Math.round(vv.width) !== width) { width = Math.round(vv.width); tallest = 0; }
    if (vv.height > tallest) tallest = vv.height;
    const covered = tallest - vv.height;
    const open = covered > 150;
    document.documentElement.classList.toggle('kb-open', open);
    // Published so a composer or a sheet footer can sit ON the keyboard
    // rather than under it.
    document.documentElement.style.setProperty('--kb-h', `${open ? Math.round(covered) : 0}px`);
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  window.addEventListener('orientationchange', () => { tallest = 0; sync(); });
  sync();
}

/**
 * Publishes the running mode as a class on the root element.
 *
 * Read by CSS that needs the mode without repeating the query, and by
 * anything in JavaScript that has to choose a COMPOSITION rather than a
 * style. Driven by the media query itself, never by a resize listener
 * guessing at widths.
 */
export function initMobileShell(h) {
  handlers = { ...handlers, ...h };
  let last = null;

  const sync = () => {
    const m = mobileMode();
    const root = document.documentElement;
    root.classList.toggle('is-phone', m === 'phone');
    root.classList.toggle('is-tablet', m === 'tablet');
    root.classList.toggle('is-desktop', m === 'desktop');
    /* Only on a real CHANGE. The listener below fires on every resize, and
     * re-rendering the route on each frame of a window being dragged would
     * throw away scroll position sixty times a second. */
    if (m === last) return;
    const before = last;
    last = m;
    if (before !== null) handlers.onModeChange?.(m);
  };

  phoneMql.addEventListener('change', sync);
  tabletMql.addEventListener('change', sync);
  /* And a ResizeObserver on the root element, deliberately.
   *
   * `matchMedia` change is the right mechanism and it is not always
   * delivered. A device emulator that rewrites the viewport metrics — and
   * some in-app browsers resizing their own chrome — move the query's answer
   * without dispatching either `change` or `resize`, which leaves the class
   * on the root saying "phone" while the stylesheet has already moved on.
   * The two then disagree, which is the exact failure the shared query
   * exists to prevent, and it is silent.
   *
   * A ResizeObserver watches the box itself, so it fires whenever the layout
   * really changed however that came about. `sync` is idempotent and returns
   * early unless the mode moved, so this costs one matchMedia read. */
  window.addEventListener('resize', sync);
  window.addEventListener('orientationchange', sync);
  new ResizeObserver(sync).observe(document.documentElement);
  sync();
  watchKeyboard();
}
