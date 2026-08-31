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
  block: 'Scheduled',
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

/* ── Making one ──────────────────────────────────────────────────────────
 *
 * Search across every type at once. A person looking for "the client meeting"
 * has not first decided whether it is an event, a page or a project, and
 * making them pick a tab before they can type is a question the app can
 * answer itself from the title.
 *
 * The KIND is chosen after the thing, not before: what two objects have to do
 * with each other is easier to say once both are named. It defaults to
 * `related`, which is always true and never precise — a person who does not
 * care gets a correct link without a decision. */
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

let openPicker = null;

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
        placeholder="Search tasks, projects, pages, events…" aria-label="Search">
      <label class="rel-pick-kind">
        <span>How are they related?</span>
        <select class="m-input" data-rel-kind>
          ${KIND_CHOICES.map(([id, label]) =>
    `<option value="${id}">${label}</option>`).join('')}
        </select>
      </label>
      <ul class="rel-pick-list" data-rel-results role="list"></ul>
      <p class="rel-pick-hint" data-rel-hint>Type at least two letters.</p>
    </div>`;
  document.body.append(scrim, dlg);
  document.body.classList.add('modal-open');

  const q = dlg.querySelector('[data-rel-q]');
  const list = dlg.querySelector('[data-rel-results]');
  const hint = dlg.querySelector('[data-rel-hint]');
  const kindEl = dlg.querySelector('[data-rel-kind]');

  const close = () => {
    scrim.remove(); dlg.remove();
    document.body.classList.remove('modal-open');
    openPicker = null;
  };
  openPicker = close;
  scrim.addEventListener('click', close);
  dlg.querySelector('[data-rel-cancel]').addEventListener('click', close);

  let seq = 0;
  const search = async () => {
    const term = q.value.trim();
    const mine = ++seq;
    if (term.length < 2) { list.innerHTML = ''; hint.textContent = 'Type at least two letters.'; return; }
    hint.textContent = 'Searching…';
    let res = null;
    try { res = await searchLinkable(term, { type: sourceType, id: sourceId }); }
    catch { hint.textContent = 'Could not search just now.'; return; }
    // A slower earlier request must not overwrite a faster later one.
    if (mine !== seq) return;
    const rows = res.results ?? [];
    hint.textContent = rows.length ? '' : 'Nothing matches that.';
    list.innerHTML = rows.map((r) => `<li>
      <button type="button" class="rel-pick-row" data-pick-type="${esc(r.type)}"
          data-pick-id="${esc(r.id)}">
        <span class="rel-kind">${esc(ENTITY_LABEL[r.type] ?? r.type)}</span>
        <span class="rel-body">
          <span class="rel-title">${esc(r.title)}</span>
          ${whenLocal(r) ? `<span class="rel-sub">${esc(whenLocal(r))}</span>` : ''}
        </span>
      </button></li>`).join('');
    list.querySelectorAll('[data-pick-type]').forEach((b) => {
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          await createLink({
            sourceType, sourceId,
            targetType: b.dataset.pickType, targetId: b.dataset.pickId,
            kind: kindEl.value,
          });
          close();
          await onDone?.();
        } catch (err) {
          hint.textContent = err?.message ?? 'That could not be linked.';
          b.disabled = false;
        }
      });
    });
  };

  let t = null;
  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(search, 180); });
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
