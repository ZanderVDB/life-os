import { loadEnv } from './env.js';
import { makeDb } from './db/client.js';
import { buildApp } from './app.js';
import { startCalendarScheduler } from './lib/calendar-scheduler.js';
import { googleConfig } from './lib/calendar-sync.js';

const env = loadEnv();
const { db } = makeDb(env.DATABASE_URL);
const app = buildApp(db, env);

/**
 * The calendar keeps itself current here, in the process that is awake anyway.
 *
 * Deliberately started in the server entry rather than in buildApp: every test
 * builds an app, and none of them wants a background timer calling Google.
 * It is skipped entirely when the integration is not configured, so a local
 * checkout without Google credentials runs exactly as before.
 */
const calendarSync = googleConfig() ? startCalendarScheduler(db, app.log) : null;
if (calendarSync) app.log.info('calendar auto-sync started');

app.listen({ port: env.PORT, host: '0.0.0.0' })
  .then((addr) => app.log.info(`Life OS v2 API listening on ${addr}`))
  .catch((err) => { app.log.error(err); process.exit(1); });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    calendarSync?.stop();
    await app.close();
    process.exit(0);
  });
}
