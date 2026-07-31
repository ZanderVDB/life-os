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
import { registerImportRoutes } from './routes/import.js';

export const API_VERSION = '0.1.0';

export function buildApp(db: Db, env: AppEnv = loadEnv()) {
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
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  const guards = makeAuth(db, env);

  registerHealthRoutes(app, db, API_VERSION);
  registerMeRoutes(app, db, guards);
  registerAreaRoutes(app, db, guards);
  registerTaskRoutes(app, db, guards);
  registerImportRoutes(app, db, guards);

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
