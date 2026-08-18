/**
 * The Pinboard spread.
 *
 * ── Why this is a module and not more of library-book.js ────────────────
 *
 * The old board reconstructed its items from the DOM on every commit: the
 * element was the authority and the stored record only filled gaps. That works
 * for four independent boxes and stops working the moment anything relates to
 * anything — a group, an edge, a stacking order — because those live BETWEEN
 * elements and there is nowhere in the DOM that honestly owns them.
 *
 * So the board keeps a model, renders from it, and saves it. Which also makes
 * undo a snapshot rather than a diff.
 *
 * ── It is a spread, not a canvas ────────────────────────────────────────
 *
 * Coordinates are percentages of the spread and clamped to it. There is no
 * pan, no zoom and no scroll: a Pinboard is two pages of a Book you can see
 * all of at once, and the moment it can be scrolled it stops being that.
 * Objects may cross the centre gutter freely — the gutter is a drawn line, not
 * a boundary.
 *
 * ── Structure is data, never drawing ────────────────────────────────────
 *
 * A group is a row with an id. A connection is an edge with an id and two
 * endpoints. Neither is inferred from position, and neither is CSS. A later
 * reader — a person or the assistant — has to be able to know that the beach
 * photo, the location link and the Task are one thought, and no amount of
 * "they were near each other" would tell them that.
 */

const uid = () => (crypto?.randomUUID?.() ?? `p${Math.random().toString(36).slice(2, 11)}`).slice(0, 40);

export const NOTE_STYLES = ['plain', 'sun', 'rose', 'sky', 'sage', 'ink', 'quote'];
export const IMAGE_FRAMES = ['none', 'frame', 'polaroid'];
const STYLE_LABEL = {
  plain: 'Plain', sun: 'Sun', rose: 'Rose', sky: 'Sky', sage: 'Sage', ink: 'Ink', quote: 'Quote',
};
const FRAME_LABEL = { none: 'No frame', frame: 'Framed', polaroid: 'Polaroid' };

/** Largest edge and byte budget for an image pasted or dropped onto a board. */
const IMAGE_MAX_EDGE = 1400;
const IMAGE_MAX_CHARS = 850_000;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Pointer capture, which is a nicety rather than a requirement.
 *
 * It throws when the pointer is no longer active — a touch cancelled by the
 * browser, a button released between the event and the handler. Letting that
 * escape would abort the drag it was meant to smooth, leaving the pin stuck
 * under a pointer that is already moving. The drag works without it; it just
 * stops tracking if the pointer leaves the element.
 */
const capture = (el, id) => { try { el.setPointerCapture(id); } catch { /* not fatal */ } };
const round2 = (v) => Math.round(v * 100) / 100;

/** A pin's text is its address once it parses as one. Nothing else is a link. */
export function hrefFrom(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
    return /\./.test(u.hostname) ? u.toString() : null;
  } catch { return null; }
}

const isUrl = (t) => /^https?:\/\/\S+$/i.test(String(t ?? '').trim());

const fileSizeWord = (n) => {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * A dropped or pasted picture, shrunk to something a page can carry.
 *
 * There is no blob storage in this stack, so the image is stored inline with
 * the page. That is only reasonable if it is bounded, hence the downscale and
 * the quality walk. WebP first because it keeps transparency; JPEG is the
 * fallback, and a screenshot with an alpha channel would otherwise come back
 * with a black background.
 */
async function fileToDataUrl(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const type = canvas.toDataURL('image/webp', 0.9).startsWith('data:image/webp')
    ? 'image/webp' : 'image/jpeg';
  let q = 0.86;
  let url = canvas.toDataURL(type, q);
  while (url.length > IMAGE_MAX_CHARS && q > 0.35) {
    q -= 0.12;
    url = canvas.toDataURL(type, q);
  }
  return url.length > IMAGE_MAX_CHARS ? null : url;
}

/* ══ The model ═══════════════════════════════════════════════════════════ */

const normalise = (content) => ({
  type: 'pinboard',
  items: (content?.items ?? []).map((i) => ({ ...i })),
  groups: (content?.groups ?? []).map((g) => ({ ...g })),
  connections: (content?.connections ?? []).map((c) => ({ ...c })),
});

const snapshot = (s) => JSON.stringify(s);

/* ══ Rendering ═══════════════════════════════════════════════════════════ */

function pinBodyHtml(item, lookupRef) {
  const k = item.kind;
  if (k === 'task' || k === 'project' || k === 'resource' || k === 'page') {
    const live = lookupRef(k === 'task' ? 'taskRef' : `${k}Ref`,
      item.taskId || item.projectId || item.itemId || item.pageId);
    if (!live) {
      return `<span class="bk-pin-k">${esc(k)}</span>
        <span class="bk-pin-t">No longer available</span>`;
    }
    const done = live.status === 'done' || live.status === 'completed';
    return `<span class="bk-pin-k">${esc(live.kindLabel ?? k)}</span>
      <span class="bk-pin-t${done ? ' is-done' : ''}">${esc(live.title ?? '')}</span>
      ${live.dueDate ? `<span class="bk-pin-m">Due ${esc(String(live.dueDate).slice(5))}</span>` : ''}`;
  }

  if (k === 'link' || k === 'video') {
    /* A link shows its destination, not its address, once it has one — an
     * 80-character URL tells you nothing at a glance. The address stays
     * editable, because a pin you cannot correct is a pin you must delete. */
    let host = '';
    try { host = item.href ? new URL(item.href).hostname.replace(/^www\./, '') : ''; } catch { host = ''; }
    return `<span class="bk-pin-k">${k === 'video' ? 'Video' : 'Link'}${host ? ` · ${esc(host)}` : ''}</span>
      <span class="bk-pin-t" data-pin-text contenteditable="true" role="textbox"
        data-placeholder="Paste a web address" aria-label="Link address"
        >${esc(item.text ?? '')}</span>
      ${item.href ? `<a class="bk-pin-go" href="${esc(item.href)}" target="_blank"
        rel="noopener noreferrer">Open link</a>` : ''}`;
  }

  if (k === 'image') {
    return `${item.href ? `<img class="bk-pin-img" src="${esc(item.href)}"
      alt="${esc(item.caption || item.text || '')}" loading="lazy" decoding="async" draggable="false">`
    : `<span class="bk-pin-k">Image</span>
       <span class="bk-pin-t bk-pin-src" data-pin-text contenteditable="true" role="textbox"
         data-placeholder="Paste an image address" aria-label="Image address"
         >${esc(item.text ?? '')}</span>`}
      ${item.href && item.caption !== undefined ? `<span class="bk-pin-cap" data-pin-caption
        contenteditable="true" role="textbox" data-placeholder="Caption"
        aria-label="Image caption">${esc(item.caption ?? '')}</span>` : ''}`;
  }

  if (k === 'file') {
    /* Honest about what it is. Life OS has nowhere to put the bytes, so this
     * records that the file exists and what it is called — useful on a board
     * about a thing, and never pretending to be a copy of it. */
    return `<span class="bk-pin-k">File${item.fileSize ? ` · ${esc(fileSizeWord(item.fileSize))}` : ''}</span>
      <span class="bk-pin-t">${esc(item.fileName ?? 'File')}</span>
      <span class="bk-pin-m">Noted here — the file itself is not stored.</span>`;
  }

  return `<span class="bk-pin-t" data-pin-text contenteditable="true" role="textbox"
    data-placeholder="Write a note" aria-label="Note">${esc(item.text ?? '')}</span>`;
}

function pinHtml(item, { lookupRef, selected, dimmed }) {
  const ref = item.taskId || item.projectId || item.itemId || item.pageId || '';
  const style = [
    `left:${item.x}%`, `top:${item.y}%`, `width:${item.w}%`,
    `min-height:${item.h}%`, `z-index:${item.z ?? 1}`,
  ].join(';');
  const cls = [
    'bk-pin', `bk-pin-${item.kind}`,
    item.style && item.style !== 'plain' ? `bk-s-${item.style}` : '',
    item.kind === 'image' && item.frame && item.frame !== 'none' ? `bk-f-${item.frame}` : '',
    selected ? 'is-selected' : '',
    dimmed ? 'is-dimmed' : '',
  ].filter(Boolean).join(' ');

  return `<div class="${cls}" data-pin="${esc(item.id)}" data-kind="${esc(item.kind)}"
    ${ref ? ` data-ref-id="${esc(ref)}"` : ''}${item.groupId ? ` data-group="${esc(item.groupId)}"` : ''}
    style="${style}"${item.accent ? ` data-accent="${esc(item.accent)}"` : ''}
    tabindex="0" role="group" aria-label="${esc(item.kind)} pin">
    <span class="bk-pin-grip" data-pin-grip aria-hidden="true"></span>
    ${pinBodyHtml(item, lookupRef)}
    <button type="button" class="bk-pin-x" data-pin-remove aria-label="Remove this pin">×</button>
    <span class="bk-pin-size" data-pin-resize aria-hidden="true"></span>
    <span class="bk-pin-link" data-pin-connect role="button" tabindex="-1"
      aria-label="Connect this to something"></span>
  </div>`;
}

/* ══ Mount ═══════════════════════════════════════════════════════════════ */

/**
 * Wires one board.
 *
 * `save(content)` persists; `lookupRef(type, id)` resolves a live reference.
 * Everything else is local to this board, including undo — two boards on one
 * screen must not share a history, because Ctrl+Z would then undo something
 * the user cannot see.
 */
export function mountPinboard(board, { page, save, onDirty, lookupRef, toast }) {
  let state = normalise(page.content);
  const past = [];
  const future = [];
  let sel = new Set();
  let selConn = null;
  let focusOn = null;                 // pin id or group id being focused
  const look = lookupRef ?? (() => null);

  const item = (id) => state.items.find((i) => i.id === id);
  const groupMembers = (gid) => state.items.filter((i) => i.groupId === gid).map((i) => i.id);

  /** Everything that must move when `id` moves: itself, or its whole group. */
  const moveSet = (ids) => {
    const out = new Set();
    for (const id of ids) {
      const it = item(id);
      if (!it) continue;
      out.add(id);
      if (it.groupId) groupMembers(it.groupId).forEach((m) => out.add(m));
    }
    return out;
  };

  const persist = () => {
    page.content = JSON.parse(snapshot(state));
    save(page.content);
    onDirty?.();
  };

  /** One change: snapshot for undo, mutate, redraw, save. */
  function apply(fn, { history = true, redraw = true } = {}) {
    const before = snapshot(state);
    fn();
    if (snapshot(state) === before) return;
    if (history) { past.push(before); if (past.length > 60) past.shift(); future.length = 0; }
    persist();
    if (redraw) render();
  }

  function undo() {
    if (!past.length) return;
    future.push(snapshot(state));
    state = JSON.parse(past.pop());
    sel = new Set([...sel].filter((id) => item(id)));
    persist(); render();
  }
  function redo() {
    if (!future.length) return;
    past.push(snapshot(state));
    state = JSON.parse(future.pop());
    sel = new Set([...sel].filter((id) => item(id)));
    persist(); render();
  }

  /* ── Painting ─────────────────────────────────────────────────────── */

  const dimmedIds = () => {
    if (!focusOn) return null;
    const keep = new Set();
    const g = state.groups.find((x) => x.id === focusOn);
    if (g) groupMembers(g.id).forEach((m) => keep.add(m));
    else {
      keep.add(focusOn);
      const it = item(focusOn);
      if (it?.groupId) groupMembers(it.groupId).forEach((m) => keep.add(m));
      // What it is connected to stays lit: an edge means "these belong together".
      for (const c of state.connections) {
        if (c.from === focusOn) keep.add(c.to);
        if (c.to === focusOn) keep.add(c.from);
      }
    }
    return keep;
  };

  function render() {
    const keep = dimmedIds();
    const html = state.items.map((i) => pinHtml(i, {
      lookupRef: look,
      selected: sel.has(i.id),
      dimmed: keep ? !keep.has(i.id) : false,
    })).join('');

    board.innerHTML = `<svg class="bk-wires" data-wires aria-hidden="true"></svg>
      <div class="bk-groups" data-groups></div>
      ${html}
      ${state.items.length ? '' : `<p class="bk-board-empty">Nothing pinned yet.
        Double-click anywhere to write a note, paste a picture or a link,
        or drag a task in from the project on the right.</p>`}
      <div class="bk-marquee" data-marquee hidden></div>`;
    board.classList.toggle('is-focused', !!focusOn);
    drawGroups();
    drawWires();
    drawToolbar();
  }

  /** Group frames are drawn FROM the membership, never stored as geometry. */
  function drawGroups() {
    const host = board.querySelector('[data-groups]');
    if (!host) return;
    const keep = dimmedIds();
    host.innerHTML = state.groups.map((g) => {
      const members = state.items.filter((i) => i.groupId === g.id);
      if (members.length < 2) return '';
      const els = members.map((m) => board.querySelector(`[data-pin="${CSS.escape(m.id)}"]`))
        .filter(Boolean);
      if (!els.length) return '';
      const bw = board.clientWidth || 1;
      const bh = board.clientHeight || 1;
      const l = Math.min(...els.map((e) => e.offsetLeft));
      const t = Math.min(...els.map((e) => e.offsetTop));
      const r = Math.max(...els.map((e) => e.offsetLeft + e.offsetWidth));
      const b = Math.max(...els.map((e) => e.offsetTop + e.offsetHeight));
      const dim = keep && !members.some((m) => keep.has(m.id));
      return `<div class="bk-group${dim ? ' is-dimmed' : ''}" data-group-frame="${esc(g.id)}"
        style="left:${((l - 10) / bw) * 100}%;top:${((t - 16) / bh) * 100}%;
               width:${((r - l + 20) / bw) * 100}%;height:${((b - t + 26) / bh) * 100}%">
        <span class="bk-group-t" data-group-title="${esc(g.id)}" contenteditable="true"
          role="textbox" data-placeholder="Name this group"
          aria-label="Group name">${esc(g.title ?? '')}</span>
      </div>`;
    }).join('');
  }

  /** Edges, drawn in board pixels so a line lands where the boxes actually are. */
  function drawWires() {
    const svg = board.querySelector('[data-wires]');
    if (!svg) return;
    const w = board.clientWidth || 1;
    const h = board.clientHeight || 1;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const keep = dimmedIds();

    const centre = (id) => {
      const el = board.querySelector(`[data-pin="${CSS.escape(id)}"]`);
      if (!el) return null;
      return { x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop + el.offsetHeight / 2 };
    };

    svg.innerHTML = state.connections.map((c) => {
      const a = centre(c.from); const b = centre(c.to);
      if (!a || !b) return '';
      const dim = keep && !(keep.has(c.from) && keep.has(c.to));
      const mx = (a.x + b.x) / 2; const my = (a.y + b.y) / 2;
      /* A gentle curve rather than a straight line: two boxes in a row would
       * otherwise draw a wire straight through everything between them. */
      const bend = Math.min(40, Math.hypot(b.x - a.x, b.y - a.y) / 6);
      const path = `M ${a.x} ${a.y} Q ${mx} ${my - bend} ${b.x} ${b.y}`;
      return `<g class="bk-wire${dim ? ' is-dimmed' : ''}${selConn === c.id ? ' is-selected' : ''}"
          data-wire="${esc(c.id)}">
        <path class="bk-wire-hit" d="${path}" fill="none"></path>
        <path class="bk-wire-line" d="${path}" fill="none"></path>
        ${c.label ? `<text class="bk-wire-lb" x="${mx}" y="${my - bend / 2}"
          text-anchor="middle">${esc(c.label)}</text>` : ''}
      </g>`;
    }).join('');
  }

  /* ── The contextual toolbar ───────────────────────────────────────── */

  function drawToolbar() {
    board.querySelector('[data-pin-bar]')?.remove();
    if (selConn) return drawWireToolbar();
    if (!sel.size) return;

    const ids = [...sel];
    const els = ids.map((id) => board.querySelector(`[data-pin="${CSS.escape(id)}"]`)).filter(Boolean);
    if (!els.length) return;
    const l = Math.min(...els.map((e) => e.offsetLeft));
    const t = Math.min(...els.map((e) => e.offsetTop));
    const r = Math.max(...els.map((e) => e.offsetLeft + e.offsetWidth));

    const one = ids.length === 1 ? item(ids[0]) : null;
    const grouped = ids.some((id) => item(id)?.groupId);
    const b = (act, label, extra = '') =>
      `<button type="button" data-bar="${act}"${extra}>${esc(label)}</button>`;

    let buttons;
    if (!one) {
      /* Restraint: with several things selected the only questions worth
       * asking are about the set, not about any one member. */
      buttons = [
        b('group', `Group ${ids.length}`),
        grouped ? b('ungroup', 'Ungroup') : '',
        b('duplicate', 'Duplicate'),
        b('delete', 'Delete'),
      ];
    } else if (one.kind === 'task' || one.kind === 'project'
      || one.kind === 'resource' || one.kind === 'page') {
      buttons = [
        b('open', one.kind === 'task' ? 'Open task' : 'Open'),
        one.kind === 'task' ? b('open-project', 'Open project') : '',
        b('connect', 'Connect'),
        grouped ? b('ungroup', 'Ungroup') : '',
        b('delete', 'Unlink'),
      ];
    } else if (one.kind === 'image') {
      buttons = [
        b('caption', one.caption === undefined ? 'Caption' : 'Hide caption'),
        b('frame', FRAME_LABEL[one.frame ?? 'none']),
        b('replace', 'Replace'),
        b('connect', 'Connect'),
        b('more', 'More', ' aria-haspopup="true"'),
      ];
    } else {
      buttons = [
        b('edit', 'Edit'),
        b('connect', 'Connect'),
        b('group', 'Group'),
        b('duplicate', 'Duplicate'),
        b('more', 'More', ' aria-haspopup="true"'),
      ];
    }

    const bw = board.clientWidth || 1;
    const bh = board.clientHeight || 1;
    const bar = document.createElement('div');
    bar.className = 'bk-pin-bar';
    bar.dataset.pinBar = '';
    bar.setAttribute('role', 'toolbar');
    bar.style.left = `${clamp(((l + r) / 2 / bw) * 100, 8, 92)}%`;
    bar.style.top = `${clamp(((t - 8) / bh) * 100, 0, 96)}%`;
    bar.innerHTML = buttons.filter(Boolean).join('');
    board.appendChild(bar);
  }

  function drawWireToolbar() {
    const c = state.connections.find((x) => x.id === selConn);
    const g = board.querySelector(`[data-wire="${CSS.escape(selConn)}"] .bk-wire-line`);
    if (!c || !g) return;
    const box = g.getBBox();
    const bar = document.createElement('div');
    bar.className = 'bk-pin-bar';
    bar.dataset.pinBar = '';
    bar.style.left = `${clamp(((box.x + box.width / 2) / (board.clientWidth || 1)) * 100, 8, 92)}%`;
    bar.style.top = `${clamp(((box.y + box.height / 2) / (board.clientHeight || 1)) * 100, 0, 96)}%`;
    bar.innerHTML = `<span class="bk-bar-in"><input data-wire-label
      value="${esc(c.label ?? '')}" placeholder="Label this link" aria-label="Connection label"></span>
      <button type="button" data-bar="wire-delete">Remove</button>`;
    board.appendChild(bar);
  }

  /** The style / frame sheet, opened from More. */
  function openMoreSheet(anchorId) {
    board.querySelector('[data-pin-sheet]')?.remove();
    const it = item(anchorId);
    if (!it) return;
    const el = board.querySelector(`[data-pin="${CSS.escape(it.id)}"]`);
    if (!el) return;

    const rows = it.kind === 'image'
      ? `<p class="bk-sheet-h">Frame</p><div class="bk-sheet-r">${IMAGE_FRAMES.map((f) =>
        `<button type="button" data-frame="${f}" class="${(it.frame ?? 'none') === f ? 'is-on' : ''}"
          >${esc(FRAME_LABEL[f])}</button>`).join('')}</div>`
      : `<p class="bk-sheet-h">Style</p><div class="bk-sheet-r bk-sheet-sw">${NOTE_STYLES.map((st) =>
        `<button type="button" data-style="${st}" class="bk-sw bk-s-${st} ${(it.style ?? 'plain') === st ? 'is-on' : ''}"
          title="${esc(STYLE_LABEL[st])}" aria-label="${esc(STYLE_LABEL[st])}"></button>`).join('')}</div>`;

    const sheet = document.createElement('div');
    sheet.className = 'bk-pin-sheet';
    sheet.dataset.pinSheet = '';
    sheet.style.left = `${clamp((el.offsetLeft / (board.clientWidth || 1)) * 100, 2, 70)}%`;
    sheet.style.top = `${clamp(((el.offsetTop + el.offsetHeight + 6) / (board.clientHeight || 1)) * 100, 0, 78)}%`;
    sheet.innerHTML = `${rows}
      <p class="bk-sheet-h">Arrange</p>
      <div class="bk-sheet-r">
        <button type="button" data-bar="forward">Bring forward</button>
        <button type="button" data-bar="backward">Send backward</button>
        <button type="button" data-bar="focus">Focus</button>
        <button type="button" data-bar="duplicate">Duplicate</button>
        <button type="button" data-bar="delete">Delete</button>
      </div>`;
    board.appendChild(sheet);
  }

  /* ── Selection ────────────────────────────────────────────────────── */

  /**
   * Selection repaints; it does not re-render.
   *
   * `render()` replaces the board's innerHTML, which DETACHES every element in
   * it. Selecting on pointerdown and then starting a drag on the same press
   * therefore handed the drag a node that was no longer in the document, and
   * the first click on a pin selected it while doing nothing else — you had to
   * press a second time to move it. Nothing about a selection changes the
   * board's structure, so nothing about it should rebuild the board.
   */
  function paintSelection() {
    for (const el of board.querySelectorAll('[data-pin]')) {
      el.classList.toggle('is-selected', sel.has(el.dataset.pin));
    }
    for (const g of board.querySelectorAll('[data-wire]')) {
      g.classList.toggle('is-selected', g.dataset.wire === selConn);
    }
    drawToolbar();
  }

  const select = (ids, { add = false } = {}) => {
    selConn = null;
    if (!add) sel = new Set();
    for (const id of ids) (sel.has(id) && add) ? sel.delete(id) : sel.add(id);
    paintSelection();
  };
  const clearSelection = () => {
    if (!sel.size && !selConn) return;
    sel = new Set();
    selConn = null;
    paintSelection();
  };

  /* ── Creating things ──────────────────────────────────────────────── */

  /** A spot that is not on top of anything, in reading order. */
  function freeSpot() {
    const taken = state.items.map((i) => ({ x: i.x, y: i.y, w: i.w, h: Math.max(i.h, 8) }));
    const clear = (x, y) => !taken.some((t) => x < t.x + t.w + 1 && x + 27 > t.x
      && y < t.y + t.h + 1 && y + 17 > t.y);
    for (let y = 5; y <= 70; y += 9) {
      for (let x = 4; x <= 68; x += 30) if (clear(x, y)) return { x, y };
    }
    const n = taken.length;
    return { x: Math.min(66, 4 + n * 3), y: Math.min(76, 5 + n * 3) };
  }

  const topZ = () => state.items.reduce((m, i) => Math.max(m, i.z ?? 1), 1);

  function addItem(partial, at) {
    const base = at ?? freeSpot();
    const it = {
      id: uid(), w: 26, h: 16, z: topZ() + 1,
      x: clamp(round2(base.x), 0, 94), y: clamp(round2(base.y), 0, 94),
      ...partial,
    };
    state.items.push(it);
    return it;
  }

  /** Board coordinates, in percent, from a pointer event. */
  function pointAt(e, { centre = true, w = 26, h = 16 } = {}) {
    const box = board.getBoundingClientRect();
    return {
      x: clamp(((e.clientX - box.left) / box.width) * 100 - (centre ? w / 2 : 0), 0, 100 - w),
      y: clamp(((e.clientY - box.top) / box.height) * 100 - (centre ? h / 2 : 0), 0, 100 - h),
    };
  }

  /** Turns whatever arrived — text, a URL, files — into pins. */
  async function ingest({ text, files, at }) {
    const made = [];
    const spot = (n) => (at ? { x: clamp(at.x + n * 3, 0, 74), y: clamp(at.y + n * 3, 0, 80) } : null);

    for (const file of files ?? []) {
      if (file.type?.startsWith('image/')) {
        try {
          const href = await fileToDataUrl(file);
          if (href) { made.push({ kind: 'image', href, caption: '', frame: 'frame', w: 30, h: 24 }); continue; }
          toast?.('That image is too large to pin, even after shrinking.', true);
        } catch { toast?.('That image could not be read.', true); }
        continue;
      }
      made.push({
        kind: 'file', fileName: file.name || 'File',
        fileType: file.type || '', fileSize: file.size ?? 0, w: 24, h: 14,
      });
    }

    const t = String(text ?? '').trim();
    if (t && !made.length) {
      if (isUrl(t)) {
        made.push(/\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(t)
          ? { kind: 'image', href: t, text: t, caption: '', frame: 'frame', w: 30, h: 24 }
          : { kind: 'link', text: t, href: hrefFrom(t), w: 28, h: 12 });
      } else {
        made.push({ kind: 'text', text: t.slice(0, 4000), w: 26, h: 16 });
      }
    }

    if (!made.length) return null;
    let first = null;
    apply(() => {
      made.forEach((m, n) => {
        const it = addItem(m, spot(n));
        first = first ?? it.id;
      });
    });
    if (first) select([first]);
    return first;
  }

  /* ── Moving, resizing, connecting ─────────────────────────────────── */

  /** Edges worth snapping to: the other pins, and the spread's own thirds. */
  function guidesFor(movingIds) {
    const others = state.items.filter((i) => !movingIds.has(i.id));
    return {
      x: [...new Set([0, 50, 100, ...others.flatMap((i) => [i.x, i.x + i.w / 2, i.x + i.w])])],
      y: [...new Set([0, 50, 100, ...others.flatMap((i) => [i.y, i.y + i.h / 2, i.y + i.h])])],
    };
  }

  const SNAP = 0.9;
  function snap(value, span, candidates) {
    for (const edge of [value, value + span / 2, value + span]) {
      for (const c of candidates) {
        if (Math.abs(edge - c) <= SNAP) return { v: round2(value + (c - edge)), at: c };
      }
    }
    return { v: round2(value), at: null };
  }

  function showGuides(x, y) {
    let g = board.querySelector('[data-guides]');
    if (!g) {
      g = document.createElement('div');
      g.className = 'bk-guides';
      g.dataset.guides = '';
      board.appendChild(g);
    }
    g.innerHTML = `${x === null ? '' : `<i class="bk-guide bk-guide-v" style="left:${x}%"></i>`}
      ${y === null ? '' : `<i class="bk-guide bk-guide-h" style="top:${y}%"></i>`}`;
  }
  const hideGuides = () => board.querySelector('[data-guides]')?.remove();

  function beginMove(e, pin) {
    const id = pin.dataset.pin;
    if (!sel.has(id)) select([id]);
    const moving = moveSet(sel);
    const box = board.getBoundingClientRect();
    const start = new Map([...moving].map((m) => {
      const it = item(m);
      return [m, { x: it.x, y: it.y }];
    }));
    const anchor = item(id);
    const guides = guidesFor(moving);
    board.classList.add('is-moving');
    capture(pin, e.pointerId);

    const move = (ev) => {
      const dx = ((ev.clientX - e.clientX) / box.width) * 100;
      const dy = ((ev.clientY - e.clientY) / box.height) * 100;
      const sx = snap(clamp(start.get(id).x + dx, 0, 100 - anchor.w), anchor.w, guides.x);
      const sy = snap(clamp(start.get(id).y + dy, 0, 100 - anchor.h), anchor.h, guides.y);
      const ax = sx.v - start.get(id).x;
      const ay = sy.v - start.get(id).y;
      for (const m of moving) {
        const it = item(m);
        const s = start.get(m);
        it.x = clamp(round2(s.x + ax), 0, 100 - it.w);
        it.y = clamp(round2(s.y + ay), 0, 100 - it.h);
        const el = board.querySelector(`[data-pin="${CSS.escape(m)}"]`);
        if (el) { el.style.left = `${it.x}%`; el.style.top = `${it.y}%`; }
      }
      showGuides(sx.at, sy.at);
      drawWires();
      drawGroups();
    };
    const done = () => {
      pin.removeEventListener('pointermove', move);
      pin.removeEventListener('pointerup', done);
      pin.removeEventListener('pointercancel', done);
      board.classList.remove('is-moving');
      hideGuides();
      /* One history entry for the whole drag: undo should put the pin back
       * where it started, not walk it backwards a pixel at a time. */
      const before = new Map([...moving].map((m) => [m, { ...start.get(m) }]));
      const after = new Map([...moving].map((m) => [m, { x: item(m).x, y: item(m).y }]));
      for (const m of moving) Object.assign(item(m), before.get(m));
      apply(() => { for (const m of moving) Object.assign(item(m), after.get(m)); });
    };
    pin.addEventListener('pointermove', move);
    pin.addEventListener('pointerup', done);
    pin.addEventListener('pointercancel', done);
  }

  function beginResize(e, pin) {
    const id = pin.dataset.pin;
    const it = item(id);
    if (!it) return;
    const box = board.getBoundingClientRect();
    const start = { w: it.w, h: it.h };
    capture(pin, e.pointerId);
    const move = (ev) => {
      const dw = ((ev.clientX - e.clientX) / box.width) * 100;
      const dh = ((ev.clientY - e.clientY) / box.height) * 100;
      it.w = clamp(round2(start.w + dw), 8, 100 - it.x);
      it.h = clamp(round2(start.h + dh), 6, 100 - it.y);
      pin.style.width = `${it.w}%`;
      pin.style.minHeight = `${it.h}%`;
      drawWires(); drawGroups();
    };
    const done = () => {
      pin.removeEventListener('pointermove', move);
      pin.removeEventListener('pointerup', done);
      const after = { w: it.w, h: it.h };
      Object.assign(it, start);
      apply(() => Object.assign(it, after));
    };
    pin.addEventListener('pointermove', move);
    pin.addEventListener('pointerup', done);
  }

  function beginConnect(e, fromId) {
    const svg = board.querySelector('[data-wires]');
    const fromEl = board.querySelector(`[data-pin="${CSS.escape(fromId)}"]`);
    if (!svg || !fromEl) return;
    const box = board.getBoundingClientRect();
    const a = { x: fromEl.offsetLeft + fromEl.offsetWidth / 2, y: fromEl.offsetTop + fromEl.offsetHeight / 2 };
    const ghost = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    ghost.setAttribute('class', 'bk-wire-ghost');
    ghost.setAttribute('fill', 'none');
    svg.appendChild(ghost);
    board.classList.add('is-connecting');
    capture(board, e.pointerId);

    let overId = null;
    const move = (ev) => {
      const x = ev.clientX - box.left;
      const y = ev.clientY - box.top;
      ghost.setAttribute('d', `M ${a.x} ${a.y} L ${x} ${y}`);
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-pin]');
      const next = el && el.dataset.pin !== fromId ? el.dataset.pin : null;
      if (next !== overId) {
        board.querySelector('.is-connect-target')?.classList.remove('is-connect-target');
        overId = next;
        if (overId) el.classList.add('is-connect-target');
      }
    };
    const done = () => {
      board.removeEventListener('pointermove', move);
      board.removeEventListener('pointerup', done);
      board.classList.remove('is-connecting');
      board.querySelector('.is-connect-target')?.classList.remove('is-connect-target');
      ghost.remove();
      if (!overId) { render(); return; }
      const to = overId;
      apply(() => {
        const exists = state.connections.some((c) =>
          (c.from === fromId && c.to === to) || (c.from === to && c.to === fromId));
        if (!exists) state.connections.push({ id: uid(), from: fromId, to });
      });
    };
    board.addEventListener('pointermove', move);
    board.addEventListener('pointerup', done);
  }

  /** Rubber-band selection across empty board. */
  function beginMarquee(e) {
    const el = board.querySelector('[data-marquee]');
    if (!el) return;
    const box = board.getBoundingClientRect();
    const ox = e.clientX - box.left;
    const oy = e.clientY - box.top;
    const additive = e.shiftKey;
    const kept = new Set(sel);
    let moved = false;
    capture(board, e.pointerId);

    const move = (ev) => {
      const x = clamp(ev.clientX - box.left, 0, box.width);
      const y = clamp(ev.clientY - box.top, 0, box.height);
      if (!moved && Math.hypot(x - ox, y - oy) < 4) return;
      moved = true;
      el.hidden = false;
      const l = Math.min(ox, x); const t = Math.min(oy, y);
      const w = Math.abs(x - ox); const h = Math.abs(y - oy);
      Object.assign(el.style, { left: `${l}px`, top: `${t}px`, width: `${w}px`, height: `${h}px` });
      const hit = new Set(additive ? kept : []);
      for (const it of state.items) {
        const pe = board.querySelector(`[data-pin="${CSS.escape(it.id)}"]`);
        if (!pe) continue;
        const overlap = pe.offsetLeft < l + w && pe.offsetLeft + pe.offsetWidth > l
          && pe.offsetTop < t + h && pe.offsetTop + pe.offsetHeight > t;
        if (overlap) hit.add(it.id);
        pe.classList.toggle('is-selected', hit.has(it.id));
      }
      sel = hit;
    };
    const done = () => {
      board.removeEventListener('pointermove', move);
      board.removeEventListener('pointerup', done);
      el.hidden = true;
      if (!moved) clearSelection(); else paintSelection();
    };
    board.addEventListener('pointermove', move);
    board.addEventListener('pointerup', done);
  }

  /* ── Toolbar actions ──────────────────────────────────────────────── */

  function act(name) {
    const ids = [...sel];
    const one = ids.length === 1 ? item(ids[0]) : null;

    if (name === 'group') {
      const members = ids.length > 1 ? ids : [...moveSet(sel)];
      if (members.length < 2) { toast?.('Select two or more pins to group them.'); return; }
      apply(() => {
        const g = { id: uid() };
        state.groups.push(g);
        members.forEach((m) => { const it = item(m); if (it) it.groupId = g.id; });
      });
      return;
    }
    if (name === 'ungroup') {
      apply(() => {
        const gids = new Set(ids.map((i) => item(i)?.groupId).filter(Boolean));
        state.items.forEach((i) => { if (gids.has(i.groupId)) delete i.groupId; });
        state.groups = state.groups.filter((g) => !gids.has(g.id));
      });
      return;
    }
    if (name === 'duplicate') {
      const copies = [];
      apply(() => {
        for (const id of ids) {
          const it = item(id);
          if (!it) continue;
          const copy = {
            ...it, id: uid(), z: topZ() + 1,
            x: clamp(round2(it.x + 3), 0, 100 - it.w), y: clamp(round2(it.y + 3), 0, 100 - it.h),
          };
          // A copy is a new thing: it does not inherit membership of a group.
          delete copy.groupId;
          state.items.push(copy);
          copies.push(copy.id);
        }
      });
      if (copies.length) select(copies);
      return;
    }
    if (name === 'delete') {
      apply(() => {
        const gone = new Set(ids);
        state.items = state.items.filter((i) => !gone.has(i.id));
        state.connections = state.connections.filter((c) => !gone.has(c.from) && !gone.has(c.to));
        const left = new Set(state.items.map((i) => i.groupId).filter(Boolean));
        state.groups = state.groups.filter((g) => left.has(g.id));
      });
      sel = new Set();
      render();
      return;
    }
    if (name === 'forward' || name === 'backward') {
      apply(() => {
        for (const id of ids) {
          const it = item(id);
          if (it) it.z = clamp((it.z ?? 1) + (name === 'forward' ? 1 : -1), 0, 9999);
        }
      });
      return;
    }
    if (name === 'connect' && one) {
      toast?.('Drag the round handle on the pin onto another pin.');
      return;
    }
    if (name === 'focus' && one) {
      focusOn = one.groupId ?? one.id;
      render();
      return;
    }
    if (name === 'caption' && one) {
      apply(() => { if (one.caption === undefined) one.caption = ''; else delete one.caption; });
      return;
    }
    if (name === 'frame' && one) {
      apply(() => {
        const i = IMAGE_FRAMES.indexOf(one.frame ?? 'none');
        one.frame = IMAGE_FRAMES[(i + 1) % IMAGE_FRAMES.length];
      });
      return;
    }
    if (name === 'replace' && one) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const href = await fileToDataUrl(file);
          if (href) apply(() => { one.href = href; delete one.text; });
          else toast?.('That image is too large to pin.', true);
        } catch { toast?.('That image could not be read.', true); }
      });
      input.click();
      return;
    }
    if (name === 'edit' && one) {
      board.querySelector(`[data-pin="${CSS.escape(one.id)}"] [data-pin-text]`)?.focus();
      return;
    }
    if (name === 'more' && one) { openMoreSheet(one.id); return; }
    if (name === 'wire-delete' && selConn) {
      const id = selConn;
      selConn = null;
      apply(() => { state.connections = state.connections.filter((c) => c.id !== id); });
    }
  }

  /* ── Events ───────────────────────────────────────────────────────── */

  board.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const sheet = e.target.closest('[data-pin-sheet]');
    const bar = e.target.closest('[data-pin-bar]');
    if (sheet || bar) return;
    board.querySelector('[data-pin-sheet]')?.remove();

    const grip = e.target.closest('[data-pin-grip]');
    const resize = e.target.closest('[data-pin-resize]');
    const connect = e.target.closest('[data-pin-connect]');
    const pin = e.target.closest('[data-pin]');

    if (connect && pin) { e.preventDefault(); beginConnect(e, pin.dataset.pin); return; }
    if (resize && pin) { e.preventDefault(); beginResize(e, pin); return; }
    if (grip && pin) { e.preventDefault(); beginMove(e, pin); return; }

    if (pin) {
      const id = pin.dataset.pin;
      if (e.shiftKey) { select([id], { add: true }); e.preventDefault(); return; }
      if (!sel.has(id)) select([id]);
      /* Dragging the body of a pin moves it too, EXCEPT where the body is
       * something you are meant to be able to click into. */
      if (!e.target.closest('[data-pin-text], [data-pin-caption], a, button')) {
        e.preventDefault();
        beginMove(e, pin);
      }
      return;
    }

    const wire = e.target.closest('[data-wire]');
    if (wire) { selConn = wire.dataset.wire; sel = new Set(); paintSelection(); return; }

    beginMarquee(e);
  });

  board.addEventListener('dblclick', (e) => {
    const pin = e.target.closest('[data-pin]');
    if (pin) {
      if (e.target.closest('[data-pin-text], [data-pin-caption]')) return;
      const it = item(pin.dataset.pin);
      focusOn = focusOn ? null : (it?.groupId ?? pin.dataset.pin);
      render();
      return;
    }
    if (e.target.closest('[data-pin-bar], [data-pin-sheet], [data-group-frame]')) return;
    const at = pointAt(e, { centre: true, w: 26, h: 16 });
    let created = null;
    apply(() => { created = addItem({ kind: 'text', text: '', style: 'plain' }, at).id; });
    if (created) {
      select([created]);
      board.querySelector(`[data-pin="${CSS.escape(created)}"] [data-pin-text]`)?.focus();
    }
  });

  board.addEventListener('click', (e) => {
    const barBtn = e.target.closest('[data-pin-bar] [data-bar], [data-pin-sheet] [data-bar]');
    if (barBtn) { act(barBtn.dataset.bar); return; }

    const sw = e.target.closest('[data-style]');
    if (sw) {
      const one = sel.size === 1 ? item([...sel][0]) : null;
      if (one) apply(() => { one.style = sw.dataset.style; });
      return;
    }
    const fr = e.target.closest('[data-frame]');
    if (fr) {
      const one = sel.size === 1 ? item([...sel][0]) : null;
      if (one) apply(() => { one.frame = fr.dataset.frame; });
      return;
    }
    const x = e.target.closest('[data-pin-remove]');
    if (x) {
      const id = x.closest('[data-pin]')?.dataset.pin;
      if (id) { sel = new Set([id]); act('delete'); }
    }
  });

  /* Typing never re-renders: the model is updated in place and saved, so the
   * caret stays exactly where the person put it. */
  board.addEventListener('input', (e) => {
    const t = e.target.closest('[data-pin-text]');
    const cap = e.target.closest('[data-pin-caption]');
    const gt = e.target.closest('[data-group-title]');
    if (gt) {
      const g = state.groups.find((x) => x.id === gt.dataset.groupTitle);
      if (g) { g.title = gt.textContent ?? ''; persist(); }
      return;
    }
    const pin = e.target.closest('[data-pin]');
    if (!pin) return;
    const it = item(pin.dataset.pin);
    if (!it) return;
    if (cap) { it.caption = cap.textContent ?? ''; persist(); return; }
    if (!t) return;
    it.text = t.textContent ?? '';
    if (it.kind === 'link' || it.kind === 'video' || it.kind === 'image') {
      it.href = hrefFrom(it.text) ?? undefined;
    }
    persist();
  });

  /* A pin that has BECOME something — an address typed into an empty link pin
   * — is redrawn once typing stops, and only if it crossed that line. */
  let settle = 0;
  board.addEventListener('input', () => {
    clearTimeout(settle);
    settle = setTimeout(() => {
      const stale = state.items.some((i) => {
        if (i.kind !== 'link' && i.kind !== 'video' && i.kind !== 'image') return false;
        const el = board.querySelector(`[data-pin="${CSS.escape(i.id)}"]`);
        if (!el) return false;
        const shows = i.kind === 'image' ? !!el.querySelector('.bk-pin-img') : !!el.querySelector('.bk-pin-go');
        return !!i.href !== shows;
      });
      if (stale) render();
    }, 700);
  });

  board.addEventListener('change', (e) => {
    const lb = e.target.closest('[data-wire-label]');
    if (!lb || !selConn) return;
    const c = state.connections.find((x) => x.id === selConn);
    if (c) apply(() => { c.label = lb.value.slice(0, 80); });
  });

  /* Paste: text, a URL, or a picture straight off the clipboard. */
  board.addEventListener('paste', async (e) => {
    if (e.target.closest('[data-pin-text], [data-pin-caption], [data-group-title], input')) return;
    const dt = e.clipboardData;
    if (!dt) return;
    const files = [...(dt.files ?? [])];
    const text = dt.getData('text/plain');
    if (!files.length && !text) return;
    e.preventDefault();
    await ingest({ text, files, at: freeSpot() });
  });

  const DROP_TYPES = ['Files', 'text/uri-list', 'text/plain', 'application/x-los-task'];
  board.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types?.some((t) => DROP_TYPES.includes(t))) return;
    e.preventDefault();
    board.classList.add('is-drop');
  });
  board.addEventListener('dragleave', (e) => {
    if (e.target === board) board.classList.remove('is-drop');
  });
  board.addEventListener('drop', async (e) => {
    board.classList.remove('is-drop');
    const dt = e.dataTransfer;
    if (!dt) return;
    const taskId = dt.getData('application/x-los-task');
    const files = [...(dt.files ?? [])];
    const text = dt.getData('text/uri-list') || dt.getData('text/plain');
    if (!taskId && !files.length && !text) return;
    e.preventDefault();

    const at = pointAt(e, { centre: true, w: 26, h: 16 });
    if (taskId) {
      if (state.items.some((i) => i.taskId === taskId)) return;
      let made = null;
      apply(() => { made = addItem({ kind: 'task', taskId, w: 26, h: 14 }, at).id; });
      if (made) select([made]);
      return;
    }
    await ingest({ text, files, at });
  });

  /* Keys. Scoped to the board, and never stolen from a text box. */
  board.addEventListener('keydown', (e) => {
    const typing = e.target.closest('[contenteditable="true"], input, textarea');
    const meta = e.metaKey || e.ctrlKey;

    if (e.key === 'Escape') {
      if (focusOn) { focusOn = null; render(); e.stopPropagation(); return; }
      if (sel.size || selConn) { clearSelection(); e.stopPropagation(); }
      return;
    }
    if (typing) return;

    if (meta && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      select(state.items.map((i) => i.id));
      return;
    }
    if (meta && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (meta && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (meta && e.key.toLowerCase() === 'd' && sel.size) { e.preventDefault(); act('duplicate'); return; }
    if (meta && e.key.toLowerCase() === 'g' && sel.size > 1) {
      e.preventDefault();
      act(e.shiftKey ? 'ungroup' : 'group');
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size) {
      e.preventDefault();
      act('delete');
      return;
    }
    /* Arrow keys nudge, which is the only way to place something exactly. */
    const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (nudge && sel.size) {
      e.preventDefault();
      const step = e.shiftKey ? 4 : 0.5;
      const moving = moveSet(sel);
      apply(() => {
        for (const m of moving) {
          const it = item(m);
          it.x = clamp(round2(it.x + nudge[0] * step), 0, 100 - it.w);
          it.y = clamp(round2(it.y + nudge[1] * step), 0, 100 - it.h);
        }
      });
    }
  });

  /* The header buttons stay as the plain way in — discoverable, and the only
   * route that needs no clipboard, no file and no pointer. */
  const tools = board.closest('.bk-page')?.querySelectorAll('[data-pin-add]') ?? [];
  tools.forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.pinAdd;
      let made = null;
      apply(() => {
        made = addItem(kind === 'image'
          ? { kind: 'image', text: '', caption: '', frame: 'frame', w: 30, h: 22 }
          : { kind, text: '', ...(kind === 'text' ? { style: 'plain' } : {}) }).id;
      });
      if (made) {
        select([made]);
        board.querySelector(`[data-pin="${CSS.escape(made)}"] [data-pin-text]`)?.focus();
      }
    });
  });

  const onResize = () => { drawWires(); drawGroups(); drawToolbar(); };
  window.addEventListener('resize', onResize);

  render();
  return {
    destroy() { window.removeEventListener('resize', onResize); clearTimeout(settle); },
    /* Exposed for tests and for the page menu, not for general use. */
    get state() { return state; },
    undo,
    redo,
    ingest,
  };
}
