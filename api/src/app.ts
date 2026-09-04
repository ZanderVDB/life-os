import Fastify from 'fastify';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import { loadEnv, corsOrigins, type AppEnv } from './env.js';
import { makeLogger } from './lib/logger.js';
import { ApiError } from './lib/errors.js';
import { makeAuth } from './auth/middleware.js';
import type { Db } from './db/client.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMeRoutes } from './routes/me.js';
import { registerAreaRoutes } from './routes/areas.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerLibraryRoutes } from './routes/library.js';
import { registerDiaryRoutes } from './routes/diary.js';
import { registerImportRoutes } from './routes/import.js';
import { registerPreferenceRoutes } from './routes/preferences.js';
import { registerHabitRoutes } from './routes/habits.js';
import { registerCalendarRoutes } from './routes/calendar.js';
import { registerGoogleCalendarRoutes } from './routes/google-calendar.js';
import { registerCalendarWriteRoutes, registerCalendarWebhook } from './routes/calendar-write.js';
import { registerLinkRoutes } from './routes/links.js';
import { registerAiRoutes } from './routes/ai.js';
import { registerAdminRoutes } from './routes/admin.js';
import { createAssistant } from './ai/index.js';

export const API_VERSION = '0.1.0';

/**
 * @param assistant  Overridden by tests to inject a stub planner.
 *
 * A model behind a network call cannot be exercised by a test suite, and a
 * test that skipped the turn would leave the most important path in the system
 * uncovered. The seam is here rather than inside the turn so that everything
 * BELOW it — retrieval, ranking, the registry, validation, the proposal row,
 * the confirmation gate, the executor — is the real thing.
 */
export function buildApp(db: Db, env: AppEnv = loadEnv(), assistant = createAssistant()) {
  const app = Fastify({
    loggerInstance: makeLogger(env.LOG_LEVEL),
    genReqId: () => randomUUID(),
    trustProxy: true,
    bodyLimit: 8 * 1024 * 1024, // the legacy export is ~100 KB; 8 MB is ample
  });

  /**
   * Accept an empty body on a request that declares Content-Type: application/json.
   *
   * Fastify's default parser rejects that combination with a 400 before routing.
   * It is a very easy shape for a client to produce — any fetch wrapper with a
   * default JSON header does it on action endpoints like /complete and /archive,
   * which legitimately take no body. Treat empty as {} rather than as an error.
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body: any, done) => {
    const text = typeof body === 'string' ? body.trim() : '';
    if (!text) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      const err: any = new Error('Body is not valid JSON.');
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  const origins = corsOrigins(env);
  app.register(cors, {
    origin: origins.length ? origins : false,
    credentials: false,
    // Must list every method any route uses. A missing verb fails only in a
    // real browser, at the preflight — server-side tests never notice.
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  const guards = makeAuth(db, env);

  registerHealthRoutes(app, db, API_VERSION, assistant);
  registerMeRoutes(app, db, guards);
  registerAreaRoutes(app, db, guards);
  registerTaskRoutes(app, db, guards);
  registerProjectRoutes(app, db, guards, env);
  registerLibraryRoutes(app, db, guards, env);
  registerDiaryRoutes(app, db, guards, env);
  registerImportRoutes(app, db, guards, env);
  registerPreferenceRoutes(app, db, guards);
  registerHabitRoutes(app, db, guards);
  registerCalendarRoutes(app, db, guards);
  registerGoogleCalendarRoutes(app, db, guards, env);
  registerCalendarWriteRoutes(app, db, guards);
  registerLinkRoutes(app, db, guards);
  /* Built once. The module list is fixed at build time; which of them are
     AVAILABLE is asked per request, so two workspaces get different answers
     from the same registry. */
  registerAiRoutes(app, db, guards, assistant);
  /* Admin. Every route inside runs its own server-side authorisation guard —
     being registered is not being reachable. */
  registerAdminRoutes(app, db, guards);
  /* Google is not a signed-in user, so its webhook is registered outside the
   * workspace-scoped routes and proves who it is from a channel row instead. */
  registerCalendarWebhook(app, db);

  /** One error shape. Internals are logged, never returned. */
  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id;
    if (err instanceof ZodError) {
      reply.code(400);
      return { error: { code: 'VALIDATION_FAILED', message: 'Some fields are invalid.',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })), requestId } };
    }
    if (err instanceof ApiError) {
      reply.code(err.statusCode);
      return { error: { code: err.code, message: err.message, details: err.details ?? {}, requestId } };
    }
    // Fastify's own errors (unparseable body, payload too large, unsupported
    // media type) already carry the right 4xx. Honour it — reporting those as
    // 500 tells the client to retry something that will never succeed.
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      reply.code(status);
      const e = err as { code?: string; message?: string };
      return { error: { code: e.code ?? 'BAD_REQUEST',
        message: e.message || 'That request could not be processed.', details: {}, requestId } };
    }
    req.log.error({ err }, 'unhandled error');
    reply.code(500);
    return { error: { code: 'INTERNAL', message: 'Something went wrong.', details: {}, requestId } };
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404);
    return { error: { code: 'NOT_FOUND', message: 'No such endpoint.', details: {}, requestId: req.id } };
  });

  return app;
}
