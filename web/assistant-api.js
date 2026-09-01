/**
 * The assistant's client, and the only thing that talks to the AI routes.
 *
 * ── The change from the prototype ────────────────────────────────────────
 *
 * The mock provider ran in the browser and the browser owned the proposals.
 * Neither is true now. A turn is planned on the server, the proposal set is
 * STORED there, and this file holds an id and a version rather than a list it
 * could edit at will.
 *
 * That inversion is the point: what the executor runs is what the planner
 * wrote. The browser renders a copy and asks the server to change it.
 *
 * ── Capabilities are asked for, never assumed ────────────────────────────
 *
 * `web/assistant-contract.js` used to carry a KINDS map — a second
 * authoritative list of what Life OS can do, which is exactly what the
 * capability registry exists to prevent. It is now a PRESENTATION table:
 * labels and icons for kinds this client knows how to draw nicely, with a
 * sane fallback for everything else. What is actually available comes from
 * `GET /ai/capabilities`, and a capability this client has never heard of
 * still renders, from the server's own label.
 */

/** Injected by app.js so this file needs no knowledge of auth or workspaces. */
let call = null;
export function initAssistantApi(fn) { call = fn; }

const need = () => {
  if (!call) throw new Error('The assistant is not wired up yet.');
  return call;
};

/* ── Capabilities ─────────────────────────────────────────────────────── */

let cached = null;

/**
 * What Life OS can currently do, from the server.
 *
 * Cached for the session because it changes when a module is connected or
 * removed, not between keystrokes. `refresh()` after connecting Google.
 */
export async function capabilities({ force = false } = {}) {
  if (cached && !force) return cached;
  cached = await need()('/ai/capabilities');
  return cached;
}

export const forgetCapabilities = () => { cached = null; };

/** True when a model is configured and a turn can actually be planned. */
export const plannerReady = async () => Boolean((await capabilities()).planner?.available);

/**
 * Is this capability available right now?
 *
 * Used when rendering an OLD proposal: a card naming something that has since
 * gone away is shown as unavailable rather than as a button that will fail.
 */
export async function isAvailable(capabilityId) {
  const c = await capabilities();
  return (c.capabilities ?? []).some((x) => x.id === capabilityId);
}

/**
 * Why a capability is not available, in a sentence rather than a status.
 *
 * Three different situations reach the user as the same silence otherwise:
 * Life OS has never had that, the module is not connected, and the module is
 * connected but cannot write. Only the last of those makes "I can see it, I
 * just cannot change it" the true thing to say.
 */
export async function unavailableReason(capabilityId) {
  const c = await capabilities();
  const moduleId = String(capabilityId).split('.')[0];
  const readOnly = (c.readOnly ?? []).find((m) => m.id === moduleId
    || (c.modules ?? []).some((x) => x.id === m.id && x.capabilities?.includes(capabilityId)));
  if (readOnly) return readOnly.reason;
  const off = (c.unavailable ?? []).find((m) => m.id === moduleId);
  if (off) return off.reason;
  return null;
}

/** The server's own label for a capability, for anything this client cannot draw. */
export async function labelFor(capabilityId) {
  const c = await capabilities();
  const hit = (c.capabilities ?? []).find((x) => x.id === capabilityId);
  return hit?.description?.split('.')[0] ?? capabilityId;
}

/* ── A turn ───────────────────────────────────────────────────────────── */

/**
 * Say something. Returns the server-held proposal set.
 *
 * `surface` is what the user is looking at — level 1 of the context engine,
 * and the difference between "move this to Friday" being answerable and not.
 */
export const turn = ({ text, conversationId = null, surface = null }) => need()('/ai/turn', {
  method: 'POST',
  body: {
    text,
    ...(conversationId ? { conversationId } : {}),
    ...(surface ? { surface } : {}),
    /* The user's own timezone and civil date. "Tomorrow" resolves where the
       person is, not where the server happens to run. */
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
    today: localToday(),
  },
});

export const readTurn = (turnId) => need()(`/ai/turn/${turnId}`);

/** Change the authoritative proposal. The server validates before it keeps it. */
export const editTurn = (turnId, version, edits) => need()(`/ai/turn/${turnId}`, {
  method: 'PATCH',
  body: { version, edits },
});

/**
 * Carry it out.
 *
 * The count is part of the agreement and the server checks it: if the list
 * changed between the button being drawn and pressed, this is refused with a
 * reason rather than running a different set of changes.
 */
export const confirmTurn = (turnId, version, count, importantAccepted = []) =>
  need()(`/ai/turn/${turnId}/confirm`, {
    method: 'POST',
    body: { version, count, importantAccepted },
  });

export const discardTurn = (turnId) => need()(`/ai/turn/${turnId}/discard`, { method: 'POST' });

/**
 * Answer the assistant's own question.
 *
 * Sends an OPTION ID and nothing else. The server holds the option set, so the
 * choice resolves to the exact entity the assistant was already looking at.
 * Sending the button's label back as a new request - which is what this
 * replaces - asks a language model to work out a second time something that
 * was known exactly the first time, and it is the second guess that picks the
 * wrong meeting.
 */
export const clarifyTurn = (turnId, optionId) => need()(`/ai/turn/${turnId}/clarify`, {
  method: 'POST',
  body: { optionId },
});

/* ── Memory ───────────────────────────────────────────────────────────── */

export const memoryList = () => need()('/ai/memory');
export const memoryCreate = (body) => need()('/ai/memory', { method: 'POST', body });
export const memoryUpdate = (id, body) => need()(`/ai/memory/${id}`, { method: 'PATCH', body });
export const memoryDelete = (id) => need()(`/ai/memory/${id}`, { method: 'DELETE' });
export const memoryAccept = (id) =>
  need()(`/ai/memory/candidates/${id}/accept`, { method: 'POST' });
export const memoryReject = (id) =>
  need()(`/ai/memory/candidates/${id}/reject`, { method: 'POST' });

/* ── Helpers ──────────────────────────────────────────────────────────── */

/**
 * Today, where the user is.
 *
 * `toISOString().slice(0,10)` is UTC, which is the wrong day for anyone east
 * of Greenwich after midnight and anyone west of it before it — and "remind me
 * tomorrow" landing on the wrong date is the most obviously broken thing an
 * assistant can do.
 */
export function localToday(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** How many changes a Confirm button covering this set would make. */
export const changeCount = (actions) => (actions ?? []).filter((a) => a.enabled).length;

/** The important ones, each of which needs its own acceptance. */
export const importantIds = (actions) =>
  (actions ?? []).filter((a) => a.enabled && a.important).map((a) => a.id);
