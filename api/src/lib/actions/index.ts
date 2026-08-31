/**
 * Application services — the business rules of Life OS, callable by anything.
 *
 * ── The rule ─────────────────────────────────────────────────────────────
 *
 * A rule enforced in a route handler is a rule that only applies to callers
 * who happen to use that route. Calendar wrote that down first
 * (`routes/calendar-write.ts`) and it is now the shape of the whole write
 * side: routes parse and authorise, services decide.
 *
 * The assistant is the second caller. It does NOT get its own copies of
 * "what a valid task looks like" or "what happens when a project leaves
 * Completed" — it calls these, so a rule tightened for the UI is tightened
 * for the AI on the same line of code.
 *
 * ── Where the rest of the rules are ──────────────────────────────────────
 *
 * Not everything is in this folder, and it does not need to be. Two domains
 * already had a real service before this phase and are used as they are:
 *
 *   lib/relationships.ts     — every semantic edge, in both directions
 *   lib/calendar-mutations.ts — every Google write, behind propose/execute
 *
 * The AI executor treats all four the same way: it calls a function, and it
 * has no path to a table.
 */
export * as tasks from './tasks.js';
export * as reminders from './reminders.js';
export * as habits from './habits.js';
export * as projects from './projects.js';
