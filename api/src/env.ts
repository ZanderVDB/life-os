/** Environment, validated once at boot. Fail fast and loudly. */
import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  FIREBASE_PROJECT_ID: z.string().min(1, 'FIREBASE_PROJECT_ID is required'),
  CORS_ORIGINS: z.string().default(''),
  /** Test/local escape hatch only. MUST be empty in staging/production. */
  DEV_AUTH_BYPASS: z.string().optional(),
});

export type AppEnv = z.infer<typeof Env>;

export function loadEnv(raw: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = Env.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${detail}`);
  }
  const env = parsed.data;
  // A bypass token in a deployed environment would be a hole big enough to
  // drive through. Refuse to boot rather than run insecurely.
  if (env.DEV_AUTH_BYPASS && (env.NODE_ENV === 'staging' || env.NODE_ENV === 'production')) {
    throw new Error('DEV_AUTH_BYPASS must not be set in staging or production.');
  }
  return env;
}

export function corsOrigins(env: AppEnv): string[] {
  return env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
}
