/**
 * "I found something." — made as easy as possible to say.
 *
 * ── Why there is no form ─────────────────────────────────────────────────
 *
 * A form means a new endpoint, a new table, a moderation problem and an inbox
 * nobody watches. During a beta of a dozen friends and clients, the thing that
 * actually gets used is the app they already message you in. So the sheet is
 * two buttons: WhatsApp and email, both pre-filled with a subject and the one
 * or two facts that make a bug report actionable.
 *
 * ── What goes in the technical details, and what never does ──────────────
 *
 * In: the build id, which screen they were on, the browser and screen size,
 * and the time. That is enough to reproduce almost anything.
 *
 * Never: what they wrote, what is in their tasks or diary, their email
 * address, any token, any API key, any part of a URL beyond the route name.
 * A "copy technical details" button that quietly copies somebody's data into
 * a WhatsApp message is a privacy incident with a friendly label on it — so
 * the details are assembled from a fixed list of fields, not scraped from
 * whatever happens to be around.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const cfg = () => (window.LIFE_OS_CONFIG?.beta ?? {});

/**
 * The device facts, from a fixed allowlist.
 *
 * Built field by field on purpose. Anything that iterated over what was
 * available — localStorage, the DOM, the URL — would eventually pick up
 * something personal, and would do it silently.
 */
export function technicalDetails(route) {
  const w = window.innerWidth || 0;
  const h = window.innerHeight || 0;
  const ua = String(navigator.userAgent ?? '');
  /* A CLASS of browser, not the full string. The full user agent is a
     fingerprint; "Chrome on Android" is what actually helps. */
  const browser = /Firefox\//.test(ua) ? 'Firefox'
    : /Edg\//.test(ua) ? 'Edge'
      : /Chrome\//.test(ua) ? 'Chrome'
        : /Safari\//.test(ua) ? 'Safari' : 'Other';
  const platform = /Android/.test(ua) ? 'Android'
    : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
      : /Mac OS X/.test(ua) ? 'macOS'
        : /Windows/.test(ua) ? 'Windows' : 'Other';
  return [
    `Build: ${window.LIFE_OS_BUILD ?? 'unknown'}`,
    `Screen: ${esc(route ?? 'unknown')}`,
    `Device: ${browser} on ${platform}`,
    `Window: ${w}x${h}`,
    `Time: ${new Date().toISOString()}`,
  ].join('\n');
}

const INTRO = 'Life OS beta feedback\n\nWhat happened:\n\n\nWhat I expected:\n\n';

export function whatsappHref(route) {
  const base = cfg().whatsappUrl;
  if (!base) return null;
  const text = `${INTRO}\n---\n${technicalDetails(route)}`;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}text=${encodeURIComponent(text)}`;
}

export function mailHref(route) {
  const to = cfg().supportEmail;
  if (!to) return null;
  const subject = encodeURIComponent('Life OS beta feedback');
  const body = encodeURIComponent(`${INTRO}\n---\n${technicalDetails(route)}`);
  return `mailto:${to}?subject=${subject}&body=${body}`;
}

/** True when at least one route to a human is configured. */
export const feedbackAvailable = () => Boolean(cfg().whatsappUrl || cfg().supportEmail);

/**
 * The sheet.
 *
 * When nothing is configured it says so plainly rather than showing two dead
 * buttons — a button that does nothing is worse than an honest sentence, and
 * on this screen in particular, because somebody is here because something is
 * already broken.
 */
export function feedbackSheetHtml(route) {
  const wa = whatsappHref(route);
  const mail = mailHref(route);

  return `<div class="fb">
    <h2 class="fb-h">Found something?</h2>
    <p class="fb-p">If something broke, looked strange, or could simply be
      better — even something small — please send it through. Half-finished
      thoughts are welcome; I would rather hear it than not.</p>

    ${wa || mail ? `<div class="fb-actions">
      ${wa ? `<a class="btn btn-primary fb-btn" href="${esc(wa)}"
        target="_blank" rel="noopener">WhatsApp Zander</a>` : ''}
      ${mail ? `<a class="btn fb-btn" href="${esc(mail)}">Email feedback</a>` : ''}
    </div>` : `<p class="fb-missing">No contact route is configured for this
      deployment yet, so these buttons are not shown rather than shown broken.
      Set <code>PUBLIC_BETA_WHATSAPP_URL</code> or
      <code>PUBLIC_BETA_SUPPORT_EMAIL</code> on the web service.</p>`}

    <details class="fb-tech">
      <summary>Technical details</summary>
      <p class="fb-tech-note">These are attached to the message above. Nothing
        you have written, and nothing from your tasks, diary or library, is
        included — this is the whole of it:</p>
      <pre class="fb-tech-pre" id="fb-tech">${esc(technicalDetails(route))}</pre>
      <button type="button" class="btn btn-quiet" id="fb-copy">Copy technical details</button>
      <span class="fb-said" id="fb-said" role="status"></span>
    </details>
  </div>`;
}
