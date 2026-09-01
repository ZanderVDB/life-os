/**
 * PWA lifecycle — registration, install prompt, and the update flow.
 *
 * The legacy app's service worker caused recurring stale-deploy bugs because a
 * new version could take over whenever it liked and the cache name had to be
 * bumped by hand in lockstep with the app version. v2 inverts that:
 *
 *   - the worker NEVER calls skipWaiting on its own; it waits
 *   - the user is told an update is ready and chooses when to take it
 *   - activation happens once, and the page reloads exactly once
 *   - the cache name carries the build id, so versions cannot collide
 *
 * Nothing here caches API responses. See sw.js for why.
 */
const SW_URL = './sw.js';
const SCOPE = './';

let waitingWorker = null;
let installPrompt = null;
let reloading = false;
let installedKnown = false;

/** True when the page is already running as an installed app. */
const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches
  || window.matchMedia('(display-mode: window-controls-overlay)').matches
  || window.navigator.standalone === true;

/**
 * What we can honestly say about installation.
 *
 * `installed` is true only when we can actually observe it — running in
 * standalone mode, the appinstalled event, or getInstalledRelatedApps. A
 * browser that simply never fires beforeinstallprompt (Safari, Firefox) is
 * reported as "not installed", never as "cannot be installed", because Add to
 * Home Screen still works there and Settings explains how.
 */
export function installState() {
  if (isStandalone() || installedKnown) {
    return { label: 'Installed on this device.', canInstall: false, installed: true };
  }
  if (installPrompt) {
    return { label: 'Ready to install.', canInstall: true, installed: false };
  }
  return { label: 'Not installed on this device.', canInstall: false, installed: false };
}

export async function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  // Chrome fires this instead of showing its own prompt; hold it so Settings
  // can offer a real install button rather than describing a menu.
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    const el = document.getElementById('install-status');
    if (el) el.textContent = installState().label;
  });
  // Some Chromium builds can confirm an existing installation directly.
  if (navigator.getInstalledRelatedApps) {
    navigator.getInstalledRelatedApps().then((apps) => {
      if (apps.length) {
        installedKnown = true;
        const el = document.getElementById('install-status');
        if (el) el.textContent = installState().label;
      }
    }).catch(() => {});
  }

  window.addEventListener('appinstalled', () => {
    installedKnown = true;
    installPrompt = null;
    const el = document.getElementById('install-status');
    if (el) el.textContent = 'Installed and running as an app.';
  });

  window.__promptInstall = async () => {
    if (!installPrompt) return false;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === 'accepted') installPrompt = null;
    return outcome === 'accepted';
  };

  let reg;
  try {
    reg = await navigator.serviceWorker.register(SW_URL, { scope: SCOPE, updateViaCache: 'none' });
  } catch {
    return;   // A failed registration must never break the app.
  }

  window.__checkForUpdate = async () => {
    try { await reg.update(); } catch { /* offline is not an error here */ }
    return Boolean(reg.waiting);
  };

  const noteWaiting = (worker) => {
    if (!worker) return;
    waitingWorker = worker;
    showUpdatePrompt();
  };

  /**
   * A worker that was ALREADY waiting when this page booted is taken NOW,
   * without asking.
   *
   * The policy was to ask every time, and the reason was good: never change
   * the app under somebody mid-sentence. But at BOOT there is no sentence.
   * Nothing has been typed, nothing is half-finished, and the reload is
   * indistinguishable from the load that is already happening — so the
   * question has no content, and a question with no content is one more
   * thing to dismiss.
   *
   * What it cost: an installed app whose owner tapped "Later" once, or
   * looked past the toast, stays on that build FOREVER. Every subsequent
   * deploy installs another worker that also waits behind the same prompt.
   * Three rounds of "the phone looks exactly the same" were this.
   *
   * The prompt survives for updates that arrive DURING a session — that is
   * the case it was written for, and the only one where the question means
   * something.
   */
  if (reg.waiting && navigator.serviceWorker.controller) {
    /* At boot there is normally no sentence to interrupt. "Normally" is not
       "always": an installed app resumed from the background is booting and
       being used at the same moment, which is exactly when this fired while
       somebody was talking to the assistant. */
    const take = () => {
      if (isBusy()) { setTimeout(take, 2000); return; }
      sessionStorage.removeItem('los2_update_dismissed');
      reg.waiting?.postMessage({ type: 'SKIP_WAITING' });
    };
    take();
  }

  /** Applies a waiting update on demand. Returns false if there is none. */
  window.__applyUpdate = () => {
    const worker = reg.waiting ?? waitingWorker;
    if (!worker) return false;
    sessionStorage.removeItem('los2_update_dismissed');
    worker.postMessage({ type: 'SKIP_WAITING' });
    return true;
  };

  reg.addEventListener('updatefound', () => {
    const next = reg.installing;
    if (!next) return;
    next.addEventListener('statechange', () => {
      // `controller` is null on the very first install — that is not an update,
      // and prompting then would be nonsense.
      if (next.state === 'installed' && navigator.serviceWorker.controller) noteWaiting(next);
    });
  });

  /**
   * Reload exactly once, when a NEW worker takes control.
   *
   * The `reloading` guard is what prevents the classic infinite loop: without
   * it, a controllerchange fired during startup reloads, which registers again,
   * which fires controllerchange, forever.
   */
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    /* Not while the person is mid-sentence. A new build is never so urgent
       that it is worth taking the microphone away in the middle of a
       sentence, and "it reloaded itself as I started speaking" is
       indistinguishable from a crash. */
    const go = () => {
      if (isBusy()) { setTimeout(go, 2000); return; }
      window.location.reload();
    };
    go();
  });

  // Check on load and whenever the tab is brought back into view, so a long-
  // lived tab still learns about a deploy.
  reg.update().catch(() => {});
  /* Throttled. A phone foregrounds an app constantly — every notification,
     every glance — and an update check per glance is a request per glance,
     each of which can install a worker that then wants to reload. Once every
     ten minutes learns about a deploy soon enough. */
  let lastCheck = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastCheck < 600000) return;
    lastCheck = Date.now();
    reg.update().catch(() => {});
  });
}

function isEditing() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
    || Boolean(document.querySelector('.panel'));
}

/**
 * Is the app in the middle of something a reload would destroy?
 *
 * Broader than `isEditing`, and it exists because a reload arriving while
 * somebody is TALKING to the assistant is the worst version of this: the
 * microphone dies, the words go, and from the outside the app simply threw
 * the sentence away for no reason. Surfaces raise the flag; nothing here
 * needs to know what they are doing.
 */
function isBusy() {
  return isEditing()
    || Boolean(window.__losBusy?.())
    || Boolean(document.querySelector('[data-state="listening"], .composer.is-listening'));
}

function showUpdatePrompt() {
  if (document.querySelector('.updater')) return;
  // Never interrupt someone mid-sentence. Wait until the field is released.
  if (isBusy()) { setTimeout(showUpdatePrompt, 4000); return; }
  if (sessionStorage.getItem('los2_update_dismissed') === 'session') return;

  const el = document.createElement('div');
  el.className = 'updater';
  el.setAttribute('role', 'status');
  el.innerHTML = `
    <div class="u-text"><b>Update available</b><span>Restart to get the latest Life OS.</span></div>
    <button class="btn" id="u-later">Later</button>
    <button class="btn btn-primary" id="u-now">Update</button>`;
  document.body.appendChild(el);

  el.querySelector('#u-later').onclick = () => {
    // Postponing lasts for this browser session only — a device-scoped choice
    // that must never sync to the account.
    sessionStorage.setItem('los2_update_dismissed', 'session');
    el.remove();
  };
  el.querySelector('#u-now').onclick = () => {
    el.querySelector('#u-now').textContent = 'Updating…';
    sessionStorage.removeItem('los2_update_dismissed');
    // Telling the worker to take over triggers controllerchange, which reloads.
    // Every other open tab is reloaded by its own controllerchange listener.
    waitingWorker?.postMessage({ type: 'SKIP_WAITING' });
  };
}
