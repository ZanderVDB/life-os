/**
 * The icon set, and the mark.
 *
 * Lifted out of app.js unchanged when the phone shell arrived. The bottom
 * navigation draws the same five glyphs the sidebar draws, and two copies of
 * an icon set is how two navigations end up looking like two applications.
 */
export const ICON = {
  today: '<rect x="3" y="4.5" width="14" height="13" rx="2.5"/><path d="M3 8.5h14M7 3v3M13 3v3"/><circle cx="10" cy="13" r="1.6" fill="currentColor" stroke="none"/>',
  calendar: '<rect x="3" y="4.5" width="14" height="13" rx="2.5"/><path d="M3 8.5h14M7 3v3M13 3v3"/>',
  projects: '<path d="M3 5.5A1.5 1.5 0 0 1 4.5 4h3l1.5 2h6.5A1.5 1.5 0 0 1 17 7.5v7A1.5 1.5 0 0 1 15.5 16h-11A1.5 1.5 0 0 1 3 14.5v-9Z"/>',
  diary: '<path d="M5.5 3.5h9A1.5 1.5 0 0 1 16 5v10a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 15V5a1.5 1.5 0 0 1 1.5-1.5Z"/><path d="M7 3.5v13M9.5 7.5h4M9.5 10.5h4"/>',
  library: '<path d="M4 4h2.6v13H4zM8 4h2.6v13H8z"/><path d="m12.6 4.6 2.5.7-2.8 12-2.5-.7z"/>',
  settings: '<circle cx="10" cy="10" r="2.6"/><path d="M10 2.6v2M10 15.4v2M17.4 10h-2M4.6 10h-2M15.2 4.8l-1.4 1.4M6.2 13.8l-1.4 1.4M15.2 15.2l-1.4-1.4M6.2 6.2 4.8 4.8"/>',
  search: '<circle cx="9" cy="9" r="5.2"/><path d="m13 13 4 4"/>',
  menu: '<path d="M3.5 6h13M3.5 10h13M3.5 14h13"/>',
  sparkle: '<path d="M10 3.5 11.4 8 16 9.4 11.4 10.8 10 15.4 8.6 10.8 4 9.4 8.6 8 10 3.5Z"/>',
  check: '<path d="m4.5 10.5 3.5 3.5 7.5-8"/>',
  // Three lines, shortest last — the conventional "sort" mark, at the same
  // stroke weight as every other icon in the set.
  sort: '<path d="M4 6h12M4 10h8M4 14h4"/>',
  chevL: '<path d="m12 5-5 5 5 5"/>',
  chevR: '<path d="m8 5 5 5-5 5"/>',
  // Horizontal, matching utilityTriggerHtml. The app had both orientations —
  // task rows and Today's overflow stacked them vertically, Calendar laid them
  // flat — so "the ⋯ button" meant two different glyphs depending on where you
  // were looking. One overflow mark, everywhere.
  dots: '<circle cx="4.5" cy="10" r="1.4" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.4" fill="currentColor" stroke="none"/><circle cx="15.5" cy="10" r="1.4" fill="currentColor" stroke="none"/>',
  grip: '<circle cx="7.5" cy="5" r="1.2" fill="currentColor" stroke="none"/><circle cx="12.5" cy="5" r="1.2" fill="currentColor" stroke="none"/><circle cx="7.5" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="12.5" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="7.5" cy="15" r="1.2" fill="currentColor" stroke="none"/><circle cx="12.5" cy="15" r="1.2" fill="currentColor" stroke="none"/>',
  pencil: '<path d="M13.5 3.5 16.5 6.5 7 16H4v-3z"/>',
};
export const icon = (name, size = 20) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor"
    stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] ?? ''}</svg>`;

/**
 * The Life OS lockup. The gradient is inlined and self-contained rather than
 * referenced from a sprite: a gradient defined inside a `display:none` <symbol>
 * does not paint in Chrome, which is exactly how this logo went invisible once.
 */
export const logoMark = (n = 26) => `<svg class="logo-mark" width="${n}" height="${n}" viewBox="0 0 24 24"
    role="img" aria-label="Life OS">
  <defs><linearGradient id="lotus${n}" gradientUnits="userSpaceOnUse" x1="4" y1="21" x2="20" y2="3">
    <stop offset="0" stop-color="#7C4DFF"/><stop offset="1" stop-color="#C28DFF"/></linearGradient></defs>
  <path d="M12 20.4C6.9 17.6 3.4 13.1 3.4 8.5 7.1 9.2 10.1 13 12 20.4Z" fill="url(#lotus${n})" fill-opacity=".82"/>
  <path d="M12 20.4c5.1-2.8 8.6-7.3 8.6-11.9-3.7.7-6.7 4.5-8.6 11.9Z" fill="url(#lotus${n})" fill-opacity=".82"/>
  <path d="M12 2.3C8.6 8 8.6 15 12 20.4 15.4 15 15.4 8 12 2.3Z" fill="url(#lotus${n})"/></svg>`;
