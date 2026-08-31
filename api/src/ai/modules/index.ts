/**
 * Which modules this build offers the assistant.
 *
 * ── The only list ────────────────────────────────────────────────────────
 *
 * This array is the whole extension point. Adding Finance later is writing
 * `modules/finance.ts` and putting `financeModule` in this list — no planner
 * change, no prompt change, no executor change, no new proposal kind. Removing
 * Calendar is deleting one line here: its capabilities vanish from
 * `GET /ai/capabilities`, from what the planner is told it may do, and from
 * what the executor is willing to resolve.
 *
 * That last part is the one worth testing, and `ai-registry.test.ts` does.
 */
import type { AiModule } from '../registry.js';
import { tasksModule } from './tasks.js';
import { projectsModule } from './projects.js';
import { calendarModule } from './calendar.js';
import { remindersModule } from './reminders.js';
import { relationshipsModule } from './relationships.js';
import { habitsModule, areasModule, diaryModule, libraryModule } from './misc.js';

export const MODULES: AiModule[] = [
  tasksModule,
  projectsModule,
  calendarModule,
  remindersModule,
  habitsModule,
  areasModule,
  diaryModule,
  libraryModule,
  relationshipsModule,
];

export {
  tasksModule, projectsModule, calendarModule, remindersModule,
  habitsModule, areasModule, diaryModule, libraryModule, relationshipsModule,
};
