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
 * PRIMARY navigation — the six places Life OS keeps your life.
 *
 * Completed is not here: finished work is content history, not a section, and
 * it belongs beside Today rather than competing with it. Settings is not here
 * either: it is account-level, reached from the account block at the bottom.
 */
export const ROUTES = [
  { id: 'today', label: 'Today', icon: 'today' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' },
  { id: 'projects', label: 'Projects', icon: 'projects', placeholder: true },
  { id: 'diary', label: 'Diary', icon: 'diary', placeholder: true },
  { id: 'library', label: 'Library', icon: 'library', placeholder: true },
  { id: 'brain', label: 'Brain', icon: 'brain', placeholder: true },
];

/** Real routes that are reachable but not in the primary list. */
export const SECONDARY_ROUTES = [
  { id: 'history', label: 'Completed' },
  { id: 'settings', label: 'Settings' },
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
  diary: {
    tagline: 'Coming soon.',
    body: 'A place to write. Personal writing deserves a considered home, so '
      + 'it is being built with care rather than rushed.',
    note: 'Nothing you have saved has been lost.',
  },
  library: {
    tagline: 'Coming soon.',
    body: 'Books, sections and pages — somewhere to keep the things you want '
      + 'to return to.',
    note: 'Nothing you have saved has been lost.',
  },
  brain: {
    tagline: 'Coming soon.',
    body: 'Ideas, resources and knowledge in one place instead of three '
      + 'separate lists.',
    note: 'Nothing you have saved has been lost.',
  },
};
