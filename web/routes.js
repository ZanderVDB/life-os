/**
 * The navigation structure.
 *
 * Every section Life OS has ever had keeps its place here even while its system
 * is being rebuilt. Removing a destination because its feature is not ready
 * teaches people the app has fewer parts than it does, and then teaches them
 * again when it comes back. A section that says "being rebuilt" is honest; a
 * missing one is not.
 */
export const ROUTES = [
  { id: 'today', label: 'Today', icon: 'today' },
  { id: 'history', label: 'Completed', icon: 'check' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar', placeholder: true },
  { id: 'projects', label: 'Projects', icon: 'projects', placeholder: true },
  { id: 'diary', label: 'Diary', icon: 'diary', placeholder: true },
  { id: 'library', label: 'Library', icon: 'library', placeholder: true },
  { id: 'brain', label: 'Brain', icon: 'brain', placeholder: true },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

/**
 * Placeholder copy. Each says what is happening and where the data is — never
 * a bare "coming soon", and never fake content standing in for the real thing.
 */
export const PLACEHOLDERS = {
  calendar: {
    tagline: 'Not yet connected.',
    body: 'Calendar is being rebuilt on the new Life OS v2 foundation. Nothing is shown '
      + 'here because showing invented events would be worse than showing none.',
    note: 'Your Google Calendar connection and any legacy events are untouched in the '
      + 'legacy app and in the verified export. Nothing has been migrated or deleted.',
  },
  projects: {
    tagline: 'Not yet connected.',
    body: 'Projects is being rebuilt. In v2 a Project is an outcome you are working '
      + 'towards — distinct from an Area, which is a part of your life.',
    note: 'Your 12 legacy project records are preserved in the verified export and have '
      + 'not been imported. Tasks already carry a project field ready for them.',
  },
  diary: {
    tagline: 'Not yet connected.',
    body: 'Diary is being rebuilt. Entries are personal writing, and they deserve a '
      + 'considered home rather than a quick port.',
    note: 'Your 50 legacy diary days are preserved in the verified export and have not '
      + 'been imported.',
  },
  library: {
    tagline: 'Not yet connected.',
    body: 'Library is being rebuilt as books, sections and pages — replacing the flat '
      + 'legacy notebook structure.',
    note: 'Your legacy notebook sections are preserved in the verified export and have '
      + 'not been imported.',
  },
  brain: {
    tagline: 'Not yet connected.',
    body: 'Brain is being rebuilt. Ideas, resources and knowledge become one system '
      + 'instead of three separate lists.',
    note: 'Your legacy Brain items are preserved in the verified export and have not '
      + 'been imported.',
  },
};
