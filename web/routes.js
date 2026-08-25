/**
 * The navigation structure.
 *
 * Every section Life OS has ever had keeps its place here even while its system
 * is being rebuilt. Removing a destination because its feature is not ready
 * teaches people the app has fewer parts than it does, and then teaches them
 * again when it comes back. A section that says "being rebuilt" is honest; a
 * missing one is not.
 */
/**
 * PRIMARY navigation — the five places Life OS keeps your life.
 *
 * Completed is not here: finished work is content history, not a section, and
 * it belongs beside Today rather than competing with it. Settings is not here
 * either: it is account-level, reached from the account block at the bottom.
 *
 * ── Brain was removed, and the rule at the top of this file is why ──────
 *
 * That rule protects a section whose system is being REBUILT. Brain was not
 * being rebuilt — it was cancelled. It promised "ideas, resources and
 * knowledge in one place", which is a description of Library, and keeping a
 * destination that advertises another section's job is not honesty, it is a
 * second answer to "where did I write that?".
 *
 * What Brain was going to become — semantic search, connections, resurfacing,
 * suggestions, natural-language actions — is the ASSISTANT, and the assistant
 * already has a home on every screen: the composer at the bottom. Two promised
 * AI surfaces is the one thing the Book system phase was explicit about not
 * building.
 *
 * `#brain` still resolves: unknown routes fall back to Today in app.js, so an
 * old link or a bookmark lands somewhere real rather than on an error.
 */
export const ROUTES = [
  { id: 'today', label: 'Today', icon: 'today' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' },
  { id: 'projects', label: 'Projects', icon: 'projects' },
  { id: 'diary', label: 'Diary', icon: 'diary' },
  { id: 'library', label: 'Library', icon: 'library' },
];

/**
 * Real routes that are reachable but not in the primary list.
 *
 * ── Why `ai` is here and not in ROUTES ───────────────────────────────────
 *
 * On a phone the assistant is the centre of the navigation bar — it is the
 * whole point of picking the phone up. On a desktop it is not built yet: the
 * composer at the foot of the screen still says so, and putting a sixth item
 * in the sidebar would advertise a finished feature that is a prototype.
 *
 * So it is a real route, so `#ai` resolves on any device and a refresh or a
 * shared link lands somewhere real, and it is absent from the desktop chrome
 * until there is something behind it worth advertising.
 */
export const SECONDARY_ROUTES = [
  { id: 'history', label: 'Completed' },
  { id: 'settings', label: 'Settings' },
  { id: 'ai', label: 'Assistant' },
];

export const ALL_ROUTE_IDS = [...ROUTES, ...SECONDARY_ROUTES].map((r) => r.id);

/**
 * Placeholder copy — product voice, not migration commentary.
 *
 * These screens are part of the everyday app, so they say what is coming and
 * reassure that nothing was lost. Technical detail about exports and imports
 * belongs in the migration tools and the docs, never here.
 */
export const PLACEHOLDERS = {
  calendar: {
    tagline: 'Coming soon.',
    body: 'Your calendar, habits and daily rhythm will live here — one view of '
      + 'what the day actually holds.',
    note: 'Nothing you have saved has been lost.',
  },
  projects: {
    tagline: 'Coming soon.',
    body: 'Projects are outcomes you are working towards. Tasks will roll up '
      + 'into them, so you can see progress rather than just a list.',
    note: 'Nothing you have saved has been lost.',
  },
};
