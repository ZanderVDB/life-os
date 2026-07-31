import { loadEnv } from './env.js';
import { makeDb } from './db/client.js';
import { buildApp } from './app.js';

const env = loadEnv();
const { db } = makeDb(env.DATABASE_URL);
const app = buildApp(db, env);

app.listen({ port: env.PORT, host: '0.0.0.0' })
  .then((addr) => app.log.info(`Life OS v2 API listening on ${addr}`))
  .catch((err) => { app.log.error(err); process.exit(1); });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => { await app.close(); process.exit(0); });
}
