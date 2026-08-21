/** Environment, validated once at boot. Fail fast and loudly. */
import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  FIREBASE_PROJECT_ID: z.string().min(1, 'FIREBASE_PROJECT_ID is required'),
  /**
   * Comma-separated exact origins. Never `*` — the API is credential-bearing,
   * and a wildcard would let any site drive it with a user's token.
   */
  CORS_ALLOWED_ORIGINS: z.string().default(''),
  /** Superseded name, still read so an older deploy does not lose its CORS. */
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

/**
 * The origins Life OS is genuinely served from.
 *
 * These are in code, not only in a variable, because CORS is the one setting
 * that fails completely and silently: the browser refuses the response, the
 * app sees `TypeError: Failed to fetch`, and nothing on either side says the
 * word "origin". Moving to the custom domain with the variable still naming
 * only the Railway host did exactly that — every call from
 * life-os.web-anchor.com was blocked, and the app sat on a spinner.
 *
 * Both are listed on purpose: the custom domain is where Life OS lives, and
 * the Railway host stays valid so a DNS or certificate problem on one cannot
 * lock everybody out of the other. This is still an allowlist — adding an
 * origin means editing this line — and `*` is refused below regardless.
 */
export const DEFAULT_WEB_ORIGINS = [
  'https://life-os.web-anchor.com',
  'https://life-os-v2-web-staging-v2-staging.up.railway.app',
] as const;

export function corsOrigins(env: AppEnv): string[] {
  const raw = `${env.CORS_ALLOWED_ORIGINS},${env.CORS_ORIGINS}`;
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  // A wildcard here would be a silent, total hole. Refuse it outright rather
  // than letting a convenient value reach production.
  if (list.includes('*')) throw new Error('CORS_ALLOWED_ORIGINS must not contain "*".');
  return [...new Set([...DEFAULT_WEB_ORIGINS, ...list])];
}
