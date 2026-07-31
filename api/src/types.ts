import type { FastifyInstance } from 'fastify';

/**
 * Route registrars take this loose instance type. buildApp() passes a Fastify
 * instance carrying a concrete pino Logger generic; pinning that through every
 * registrar buys nothing and fights the type system for no safety gain.
 */
export type AppInstance = FastifyInstance<any, any, any, any, any>;

export interface Guards {
  authenticate: (req: any, reply: any) => Promise<void>;
  resolveWorkspace: (req: any, reply: any) => Promise<void>;
}
