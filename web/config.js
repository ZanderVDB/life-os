/**
 * Life OS v2 web — runtime configuration.  ⚠ NOT YET FILLED IN.
 *
 * Copy the Firebase web-config values from the legacy app's /config.js at the
 * repo root (same Firebase project — v2 reuses the existing Google sign-in).
 * That block is PUBLIC by design: it identifies the project, it does not
 * authorise anything. Real protection is the API verifying the ID token
 * server-side. No private key or service account belongs in this file, ever.
 *
 * apiBaseUrl points at the Railway staging API once that service exists.
 * You can also override it at runtime without editing this file:
 *     localStorage.setItem('los2_api', 'https://<your-staging-api>')
 */
const PLACEHOLDER = 'FILL_ME_IN';

window.LIFE_OS_CONFIG = {
  apiBaseUrl: localStorage.getItem('los2_api') || 'http://localhost:8080',

  firebase: {
    apiKey: PLACEHOLDER,
    authDomain: PLACEHOLDER,
    projectId: PLACEHOLDER,
    appId: PLACEHOLDER,
  },
};

/** Loud, early failure beats a confusing sign-in error later. */
window.LIFE_OS_CONFIG.isConfigured = Object.values(window.LIFE_OS_CONFIG.firebase)
  .every((v) => v && v !== PLACEHOLDER);

/**
 * Build identifier, shown in Settings. A deployed server replaces this whole
 * file with one carrying the real commit sha; this value only appears when the
 * committed fallback is being served, which is itself worth knowing.
 */
window.LIFE_OS_BUILD = 'local-dev';

/**
 * How a beta tester reaches a person.
 *
 * Public by design — a WhatsApp link and an email address exist to be handed
 * out. Deliberately EMPTY here: a deployed server replaces this file with one
 * carrying the configured values, and with nothing set the feedback sheet says
 * what is missing rather than inventing a number to message.
 */
window.LIFE_OS_CONFIG.beta = { whatsappUrl: '', supportEmail: '' };

/** Development tools. False in the committed fallback; the server decides. */
window.LIFE_OS_CONFIG.devTools = window.LIFE_OS_CONFIG.devTools ?? false;
