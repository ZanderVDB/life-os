/**
 * User preferences — the SERVER-scoped half of Settings.
 *
 * The split is deliberate and documented in docs/pwa-v2.md:
 *
 *   server-scoped  follows the account to any device (appearance, sounds,
 *                  anything that is a decision about the workspace)
 *   device-scoped  belongs to one browser and never syncs (which API URL a
 *                  developer is pointed at, whether THIS install has dismissed
 *                  an update prompt). Those live in localStorage and never
 *                  reach this endpoint.
 *
 * Keys are allow-listed. A settings screen that can write arbitrary keys is a
 * settings screen that will one day be used to store something that should have
 * been a column.
 */
import type { AppInstance, Guards } from '../types.js';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { userPreferences } from '../db/schema.js';
import { badRequest } from '../lib/errors.js';

/**
 * Every server-scoped preference, with its allowed values and default.
 * Adding a key here is the only way to make it settable.
 */
export const PREFERENCE_SCHEMA = {
  appearance: { values: ['system', 'dark'] as const, default: 'system' },
  sounds: { values: ['on', 'off'] as const, default: 'off' },
  reducedMotion: { values: ['system', 'always'] as const, default: 'system' },
  /**
   * `Count writing in Diary as a daily habit` (D2.2 §8).
   *
   * Default ON, and the default is what makes this migration-safe: no row is
   * written for a workspace that has never touched the setting, and turning it
   * off writes 'off' rather than deleting anything. Diary itself is unaffected
   * either way — the habit is computed FROM diary content and no diary content
   * is computed from it, so the setting can be flipped for ever without
   * touching a single entry.
   */
  diaryHabit: { values: ['on', 'off'] as const, default: 'on' },
} as const;

export type PreferenceKey = keyof typeof PREFERENCE_SCHEMA;
export const PREFERENCE_KEYS = Object.keys(PREFERENCE_SCHEMA) as PreferenceKey[];

/** Device-scoped settings, listed so the UI and docs cannot drift apart. */
export const DEVICE_SCOPED_SETTINGS = [
  'los2_api', 'los2_dev_token', 'los2_update_dismissed', 'los2_rail_collapsed',
] as const;

export function defaultPreferences(): Record<string, string> {
  return Object.fromEntries(PREFERENCE_KEYS.map((k) => [k, PREFERENCE_SCHEMA[k].default]));
}

/**
 * The stored preferences for a user, defaults filled in.
 *
 * Exported because preferences stopped being purely cosmetic in D2.2: whether
 * the computed Diary habit counts is a preference, and Habits and Calendar both
 * have to read it before they can answer "how many were due". One reader, so
 * "what is the default" has one answer.
 */
export async function readPreferences(db: Db, userId: string): Promise<Record<string, string>> {
  const rows = await db.select().from(userPreferences).where(and(
    eq(userPreferences.userId, userId),
    isNull(userPreferences.deviceId),
  ));
  const prefs = defaultPreferences();
  for (const r of rows) {
    if (PREFERENCE_KEYS.includes(r.key as PreferenceKey) && typeof r.value === 'string') {
      prefs[r.key] = r.value;
    }
  }
  return prefs;
}

export function registerPreferenceRoutes(app: AppInstance, db: Db, guards: Guards) {
  const pre = { preHandler: [guards.authenticate] };

  /** GET /api/v1/preferences — defaults merged with anything stored. */
  app.get('/api/v1/preferences', pre, async (req) => ({
    preferences: await readPreferences(db, req.principal!.userId),
    deviceScoped: DEVICE_SCOPED_SETTINGS,
  }));

  /** PUT /api/v1/preferences — partial update, allow-listed keys only. */
  app.put('/api/v1/preferences', pre, async (req) => {
    const body = z.record(z.string()).safeParse(req.body);
    if (!body.success) throw badRequest('Send an object of preference keys and string values.');

    const userId = req.principal!.userId;
    const entries = Object.entries(body.data);
    if (!entries.length) throw badRequest('No preferences to update.');

    for (const [key, value] of entries) {
      const spec = PREFERENCE_SCHEMA[key as PreferenceKey];
      if (!spec) throw badRequest(`"${key}" is not a known preference.`);
      if (!(spec.values as readonly string[]).includes(value)) {
        throw badRequest(`"${value}" is not valid for ${key}. Allowed: ${spec.values.join(', ')}.`);
      }
    }

    await db.transaction(async (tx) => {
      for (const [key, value] of entries) {
        // The unique index treats a null workspace/device as an empty string,
        // so an upsert keyed on (user, key) needs the same shape every time.
        const existing = (await tx.select().from(userPreferences).where(and(
          eq(userPreferences.userId, userId),
          isNull(userPreferences.deviceId),
          eq(userPreferences.key, key),
        )).limit(1))[0];
        if (existing) {
          await tx.update(userPreferences)
            .set({ value, updatedAt: new Date() })
            .where(eq(userPreferences.id, existing.id));
        } else {
          await tx.insert(userPreferences).values({ userId, scope: 'user', key, value });
        }
      }
    });

    const rows = await db.select().from(userPreferences).where(and(
      eq(userPreferences.userId, userId), isNull(userPreferences.deviceId),
    ));
    const prefs = defaultPreferences();
    for (const r of rows) if (typeof r.value === 'string') prefs[r.key] = r.value;
    return { preferences: prefs };
  });
}
