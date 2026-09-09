/**
 * The Related section — one component, every detail surface.
 *
 * A relationship that exists only in the database is not a relationship the
 * user has. This renders the answer to "what is this connected to", from
 * either end of the edge, wherever an object is opened.
 *
 * ── Why one component ───────────────────────────────────────────────────
 *
 * Tasks, projects, events, pages, diary entries and habits all want the same
 * thing: a quiet list of what else is involved, secondary to whatever the
 * screen is actually for. Nine bespoke versions would be nine places for the
 * phrasing, the navigation and the empty state to drift apart.
 *
 * ── Why it is quiet ─────────────────────────────────────────────────────
 *
 * Nobody opens a task to read its graph. The section sits at the bottom, in
 * label type, and shows nothing at all when there is nothing to show — an
 * empty "Related" heading on every object in the app would be a permanent
 * reminder of a feature rather than a useful fact.
 */

/** Injected by app.js: the same authenticated caller everything else uses. */
let call = null;
export function initRelated(apiFn) { call = apiFn; }

/** Set by app.js so a click can open the thing it points at. */
let opener = null;
export function setRelatedOpener(fn) { opener = fn; }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* What each type is called in front of a person, and the glyph that carries
   it in a dense row. Short: these sit in a chip beside a title. */
export /**
 * An instant, in the reader's own timezone.
 *
 * The server sends a UTC-formatted `subtitle` as a fallback; when it also
 * sends `at`, the browser is the only party that knows the right hour, so it
 * wins. A Related row must agree with the Calendar row for the same event.
 */
function whenLocal(e) {
  if (!e?.at) return e?.subtitle ?? '';
  const d = new Date(e.at);
  if (Number.isNaN(d.getTime())) return e.subtitle ?? '';
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} · `
    + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

const ENTITY_LABEL = {
  task: 'Task',
  project: 'Project',
  area: 'Area',
  habit: 'Habit',
  reminder: 'Reminder',
  event: 'Calendar',
  library: 'Library',
  book_page: 'Book page',
  diary: 'Diary',
};

export const fetchLinks = (type, id) =>
  call(`/links?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`);

export const createLink = (body) => call('/links', { method: 'POST', body });

export const deleteLink = (id) => call(`/links/${id}`, { method: 'DELETE' });

export const fetchKinds = () => call('/links/kinds');

export const searchLinkable = (q, exclude) =>
  call(`/links/search?q=${encodeURIComponent(q)}`
    + (exclude ? `&excludeType=${exclude.type}&excludeId=${exclude.id}` : ''));

/** Walk a place rather than type at it. `parent` is a book, for its pages. */
export const browseLinkable = (type, parent) =>
  call(`/links/browse?type=${encodeURIComponent(type)}`
    + (parent ? `&parent=${encodeURIComponent(parent)}` : ''));

/** The relationship that is a foreign key. Writes no edge — see the route. */
export const attachStructural = (body) => call('/links/attach', { method: 'POST', body });

/**
 * The section.
 *
 * Renders NOTHING when there are no links. The caller can therefore always
 * include it without deciding whether it is worth including.
 *
 * Outgoing and incoming are shown in one list. The distinction is a storage
 * detail — what matters to a reader is what this is connected to and how, and
 * the label already reads correctly from this end because the server resolved
 * it against the direction.
 */
export function relatedHtml(data, opts = {}) {
  const links = data?.links ?? [];
  if (!links.length) return emptyHtml(opts);
  const title = opts.title ?? 'Related';
  return `<section class="rel" data-rel>
    <h3 class="rel-h">${esc(title)}<span class="rel-n">${links.length}</span>
      ${opts.canLink === false ? '' : '<button type="button" class="rel-add" data-rel-add>Link…</button>'}
    </h3>
    <ul class="rel-list" role="list">
      ${links.map((l) => relatedRowHtml(l, opts)).join('')}
    </ul>
  </section>`;
}

/**
 * The section when there is nothing in it.
 *
 * Just the control, and only where the surface asked for one. The heading is
 * dropped entirely: "Related — 0" on every object in the application is a
 * standing note about a feature rather than a fact about the object.
 */
function emptyHtml(opts) {
  if (opts.canLink === false) return '';
  return `<section class="rel rel-empty" data-rel>
    <button type="button" class="rel-add rel-add-only" data-rel-add>Link to something…</button>
  </section>`;
}

function relatedRowHtml(l, opts = {}) {
  const e = l.entity;
  if (!e) return '';
  /* A coupled edge is not something to unlink from here — the task and the
     event it is scheduled as are one piece of work, and the way to undo that
     is to unschedule, not to sever a wire. It is shown, and marked. */
  const removable = !l.coupled && opts.canUnlink !== false;
  return `<li class="rel-row ${l.coupled ? 'is-coupled' : ''}"
      data-link="${esc(l.id)}" data-etype="${esc(e.type)}" data-eid="${esc(e.id)}"
      ${e.href ? `data-href="${esc(e.href)}"` : ''}>
    <button type="button" class="rel-go" data-rel-open
        title="${esc(l.label)} — ${esc(e.title)}">
      <span class="rel-kind">${esc(ENTITY_LABEL[e.type] ?? e.type)}</span>
      <span class="rel-body">
        <span class="rel-title">${esc(e.title)}</span>
        ${whenLocal(e) ? `<span class="rel-sub">${esc(whenLocal(e))}</span>` : ''}
      </span>
      <span class="rel-rel">${esc(l.label)}</span>
    </button>
    ${removable
    ? `<button type="button" class="rel-x" data-rel-remove
        aria-label="Unlink ${esc(e.title)}" title="Unlink — this deletes only the connection"
        >&times;</button>`
    : '<span class="rel-lock" title="Kept in step with its scheduled time" aria-hidden="true"></span>'}
  </li>`;
}

/**
 * Loads, renders and wires one Related section into `host`.
 *
 * Returns a `reload()` so a surface that changes its own links can refresh
 * without knowing how any of this works.
 */
export async function mountRelated(host, type, id, opts = {}) {
  if (!host || !call) return { reload: async () => {} };

  const paint = async () => {
    let data = null;
    try {
      data = await fetchLinks(type, id);
    } catch {
      /* A links failure must never take down the thing being looked at. The
         section is supplementary; if it cannot load, it is not there. */
      host.innerHTML = '';
      return;
    }
    host.innerHTML = relatedHtml(data, opts);
    wireRelated(host, { onChange: paint, ...opts });
  };

  await paint();
  return { reload: paint };
}

export function wireRelated(host, opts = {}) {
  host.querySelectorAll('[data-rel-open]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      const row = b.closest('.rel-row');
      opener?.({
        type: row.dataset.etype,
        id: row.dataset.eid,
        href: row.dataset.href || null,
      });
    });
  });

  host.querySelectorAll('[data-rel-add]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      const raw = host.dataset.relHost || '';
      const at = raw.indexOf(':');
      if (at < 1) return;
      openLinkPicker(raw.slice(0, at), raw.slice(at + 1), opts.onChange);
    });
  });

  host.querySelectorAll('[data-rel-remove]').forEach((b) => {
    b.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const row = b.closest('.rel-row');
      b.disabled = true;
      try {
        await deleteLink(row.dataset.link);
        /* Only the edge. Both objects are still there, which is why this needs
           no confirmation — there is nothing to lose that a second click
           cannot restore. */
        await opts.onChange?.();
      } catch {
        b.disabled = false;
      }
    });
  });
}

/* The vocabulary, as a fallback. The server serves the real list with the
   structural pairs; this is what the picker draws with if that call has not
   landed yet, so an offline moment is a shorter list rather than an empty one. */
const KIND_CHOICES = [
  ['related', 'Related to'],
  ['resource', 'Resource'],
  ['context', 'Context'],
  ['preparation', 'Preparation for'],
  ['discussed_in', 'Discussed in'],
  ['result', 'Resulted in'],
  ['deadline', 'Deadline for'],
  ['follow_up', 'Follow-up'],
  ['supports', 'Supports'],
];

/* One picker at a time: opening a second while one is up leaves a scrim that
   nothing can dismiss. */
let openPicker = null;

/**
 * Link to something — pick a PLACE, then the thing.
 *
 * ── Why this was rebuilt ────────────────────────────────────────────────
 *
 * It was a search box and nothing else. That is fine when you know the name
 * and useless when you do not: "link this task to the page about the geyser"
 * means opening the book you have in mind and looking, not guessing which
 * words are in its title. Reported from use as "searching for it is a bit
 * tough — especially if I want to combine a task to a specific page on a
 * specific book, this wouldn't allow me to really do that".
 *
 * So the first question is WHERE, which is a question anybody can answer about
 * their own app, and the search box stays for when you already know.
 *
 * ── And the more important half ─────────────────────────────────────────
 *
 * Linking a task to a project used to write a `related` edge. `relationships.js`
 * opens by saying a generic edge must never express a structural relationship,
 * because two competing answers to "which project is this task in" is worse
 * than either answer — and that is precisely what it did, because making edges
 * was all it knew how to do. Reported as "it added it as a related item instead
 * of adding it as a task itself, which I think is stupid". Correct.
 *
 * The pairs that have a real relationship are declared on the SERVER, beside
 * the doctrine, and served with the kinds. Where one exists it is the default
 * and it does the foreign-key thing; the edge stays available underneath for
 * the genuine case — a task that references a project it does not belong to.
 *
 * ── Why picking a row does not link it ──────────────────────────────────
 *
 * It used to link the instant you clicked, with whatever kind happened to be
 * in the select. A row now SELECTS, and the footer then says what will happen
 * to that specific pair before you commit. One more click, in exchange for the
 * app never doing something other than what it said.
 */

/* Where things live, in the words the app uses for them. Ordered as the
   sidebar is, because that is the order already in the reader's head. */
const PLACES = [
  { id: 'task', label: 'Today', hint: 'Tasks' },
  { id: 'event', label: 'Calendar', hint: 'Events near now' },
  { id: 'reminder', label: 'Reminders', hint: 'Open reminders' },
  { id: 'project', label: 'Projects', hint: 'All projects' },
  { id: 'library', label: 'Library', hint: 'Books, documents, files' },
  { id: 'diary', label: 'Diary', hint: 'Days you have written' },
  { id: 'habit', label: 'Habits', hint: 'What you are keeping up' },
  { id: 'area', label: 'Areas', hint: 'The parts of your life' },
];

export function openLinkPicker(sourceType, sourceId, onDone) {
  openPicker?.();
  const scrim = document.createElement('div');
  scrim.className = 'modal-scrim rel-pick-scrim';
  const dlg = document.createElement('div');
  dlg.className = 'modal rel-pick';
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  dlg.setAttribute('aria-label', 'Link to something');
  dlg.innerHTML = `
    <div class="m-head">
      <h2 class="rel-pick-h">Link to</h2>
      <button class="m-close" data-rel-cancel aria-label="Close">&times;</button>
    </div>
    <div class="m-body rel-pick-body">
      <input class="m-input rel-pick-q" type="search" data-rel-q autocomplete="off"
        placeholder="Search everything…" aria-label="Search everything">
      <nav class="rel-crumbs" data-rel-crumbs aria-label="Where you are looking"></nav>
      <div class="rel-places" data-rel-places></div>
      <ul class="rel-pick-list" data-rel-results role="list"></ul>
      <p class="rel-pick-hint" data-rel-hint></p>
    </div>
    <div class="m-foot rel-pick-foot" data-rel-foot hidden></div>`;
  document.body.append(scrim, dlg);
  document.body.classList.add('modal-open');

  const $ = (s) => dlg.querySelector(s);
  const q = $('[data-rel-q]');
  const list = $('[data-rel-results]');
  const hint = $('[data-rel-hint]');
  const places = $('[data-rel-places]');
  const crumbs = $('[data-rel-crumbs]');
  const foot = $('[data-rel-foot]');

  const close = () => {
    scrim.remove(); dlg.remove();
    document.body.classList.remove('modal-open');
    openPicker = null;
  };
  openPicker = close;
  scrim.addEventListener('click', close);
  $('[data-rel-cancel]').addEventListener('click', close);

  /* `place` null means the chooser is showing. `parent` is the book whose
     pages are listed, which is the one place with a second level. */
  const view = { place: null, parent: null, parentTitle: '', chosen: null, structural: null };
  let kinds = KIND_CHOICES.map(([id, label]) => ({ id, label }));
  let structuralPairs = [];
  fetchKinds().then((k) => {
    if (k?.kinds?.length) kinds = k.kinds;
    structuralPairs = k?.structural ?? [];
  }).catch(() => { /* the built-in list still works */ });

  const structuralFor = (targetType) =>
    structuralPairs.find((p) => p.sourceType === sourceType && p.targetType === targetType) ?? null;

  /* ── Painting ──────────────────────────────────────────────────────── */

  const paintPlaces = () => {
    places.hidden = Boolean(view.place) || q.value.trim().length >= 2;
    if (places.hidden) { places.innerHTML = ''; return; }
    places.innerHTML = `<p class="rel-places-h">Where is it?</p>
      <div class="rel-places-grid">${PLACES.map((p) => `
        <button type="button" class="rel-place" data-place="${p.id}">
          <span class="rel-place-l">${esc(p.label)}</span>
          <span class="rel-place-s">${esc(p.hint)}</span>
        </button>`).join('')}</div>`;
    places.querySelectorAll('[data-place]').forEach((b) => {
      b.addEventListener('click', () => { view.place = b.dataset.place; view.parent = null; load(); });
    });
  };

  const paintCrumbs = () => {
    const bits = [];
    if (view.place) {
      const p = PLACES.find((x) => x.id === view.place);
      bits.push({ label: p?.label ?? view.place, to: { place: view.place, parent: null } });
    }
    if (view.parent) bits.push({ label: view.parentTitle, to: null });
    crumbs.hidden = !bits.length;
    crumbs.innerHTML = bits.length
      ? `<button type="button" class="rel-crumb-back" data-crumb-up
           aria-label="Back">${'‹'}</button>`
        + bits.map((b, i) => `<span class="rel-crumb${i === bits.length - 1 ? ' is-here' : ''}"
             ${b.to ? `data-crumb="${i}"` : ''}>${esc(b.label)}</span>`).join(
        '<span class="rel-crumb-sep">/</span>')
      : '';
    crumbs.querySelector('[data-crumb-up]')?.addEventListener('click', () => {
      if (view.parent) { view.parent = null; view.parentTitle = ''; } else view.place = null;
      load();
    });
    crumbs.querySelectorAll('[data-crumb]').forEach((el) => {
      el.addEventListener('click', () => { view.parent = null; view.parentTitle = ''; load(); });
    });
  };

  /** One row. A Book gets a second control, because it has an inside. */
  const rowHtml = (r) => {
    const openable = view.place === 'library' && r.subtype === 'book' && r.intoId;
    return `<li class="rel-pick-li">
      <button type="button" class="rel-pick-row ${
  view.chosen && view.chosen.id === r.id ? 'is-chosen' : ''}"
        data-pick-type="${esc(r.type)}" data-pick-id="${esc(r.id)}"
        data-pick-title="${esc(r.title)}">
        <span class="rel-kind">${esc(ENTITY_LABEL[r.type] ?? r.type)}</span>
        <span class="rel-body">
          <span class="rel-title">${esc(r.title)}</span>
          ${whenLocal(r) ? `<span class="rel-sub">${esc(whenLocal(r))}</span>` : ''}
        </span>
      </button>
      ${openable ? `<button type="button" class="rel-pick-into" data-into="${esc(r.intoId)}"
        data-into-title="${esc(r.title)}" title="Pick a page inside ${esc(r.title)}"
        aria-label="Open ${esc(r.title)} to pick a page">›</button>` : ''}
    </li>`;
  };

  const paintRows = (rows) => {
    list.innerHTML = rows.map(rowHtml).join('');
    list.querySelectorAll('[data-pick-type]').forEach((b) => {
      b.addEventListener('click', () => {
        view.chosen = {
          type: b.dataset.pickType, id: b.dataset.pickId, title: b.dataset.pickTitle,
        };
        list.querySelectorAll('.rel-pick-row').forEach((x) => x.classList.remove('is-chosen'));
        b.classList.add('is-chosen');
        paintFoot();
      });
    });
    /* Into a Book, for its pages. A separate control from the row, because
       "link me to this book" and "show me its pages" are different answers and
       one target cannot mean both. */
    list.querySelectorAll('[data-into]').forEach((b) => {
      b.addEventListener('click', () => {
        view.parent = b.dataset.into;
        view.parentTitle = b.dataset.intoTitle;
        view.chosen = null;
        load();
      });
    });
  };

  /** What will happen, said before it happens. */
  const paintFoot = () => {
    foot.hidden = !view.chosen;
    if (!view.chosen) return;
    const st = structuralFor(view.chosen.type);
    view.structural = st;
    foot.innerHTML = `
      <div class="rel-foot-what">
        ${st ? `<span class="rel-foot-verb">${esc(st.verb)}</span>
                <span class="rel-foot-note">${esc(st.note)}</span>`
    : '<label class="rel-foot-kind"><span>How are they related?</span></label>'}
      </div>
      <div class="rel-foot-controls">
        ${st ? `<button type="button" class="rail-link rel-foot-alt" data-rel-alt>
                  or just note a relationship</button>` : ''}
        <select class="m-input rel-foot-select" data-rel-kind ${st ? 'hidden' : ''}
          aria-label="How are they related">
          ${kinds.filter((k) => !k.coupled).map((k) =>
    `<option value="${esc(k.id)}">${esc(k.label)}</option>`).join('')}
        </select>
        <button type="button" class="btn-primary rel-foot-go" data-rel-go>Link</button>
      </div>`;
    const sel = foot.querySelector('[data-rel-kind]');
    foot.querySelector('[data-rel-alt]')?.addEventListener('click', (e) => {
      e.currentTarget.remove();
      sel.hidden = false;
      view.structural = null;
      foot.querySelector('.rel-foot-what').innerHTML =
        '<label class="rel-foot-kind"><span>How are they related?</span></label>';
    });
    foot.querySelector('[data-rel-go]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      hint.textContent = '';
      try {
        if (view.structural) {
          await attachStructural({
            sourceType, sourceId,
            targetType: view.chosen.type, targetId: view.chosen.id,
          });
        } else {
          await createLink({
            sourceType, sourceId,
            targetType: view.chosen.type, targetId: view.chosen.id,
            kind: sel.value,
          });
        }
        close();
        await onDone?.();
      } catch (err) {
        hint.textContent = err?.message ?? 'That could not be linked.';
        btn.disabled = false;
      }
    });
  };

  /* ── Loading ───────────────────────────────────────────────────────── */

  let seq = 0;
  const load = async () => {
    const mine = ++seq;
    const term = q.value.trim();
    view.chosen = null;
    paintFoot();
    paintCrumbs();
    paintPlaces();

    if (term.length >= 2) {
      hint.textContent = 'Searching…';
      let res = null;
      try { res = await searchLinkable(term, { type: sourceType, id: sourceId }); }
      catch { hint.textContent = 'Could not search just now.'; return; }
      if (mine !== seq) return;
      const rows = res.results ?? [];
      hint.textContent = rows.length ? '' : 'Nothing matches that.';
      paintRows(rows);
      return;
    }
    if (!view.place) {
      list.innerHTML = '';
      hint.textContent = '';
      return;
    }
    const type = view.parent ? 'book_page' : view.place;
    hint.textContent = 'Loading…';
    let res = null;
    try { res = await browseLinkable(type, view.parent); }
    catch { hint.textContent = 'Could not load that just now.'; return; }
    if (mine !== seq) return;
    const rows = (res.results ?? []).filter((r) => !(r.type === sourceType && r.id === sourceId));
    hint.textContent = rows.length ? '' : 'Nothing here yet.';
    paintRows(rows);
  };

  let t = null;
  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 180); });
  load();
  q.focus();
}

/**
 * A count, for places too dense for the list.
 *
 * A task row on the Today board is not the place to enumerate a graph. A
 * single mark saying "there is more here" is, and it is the same affordance
 * whichever board it appears on.
 */
export const linkBadgeHtml = (n) => (n > 0
  ? `<span class="rel-badge" title="${n} linked item${n === 1 ? '' : 's'}"
      aria-label="${n} linked">${n}</span>`
  : '');
