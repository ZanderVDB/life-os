/**
 * Legacy import — PREVIEW ONLY in this baseline.
 *
 * The export never leaves the user's device except to reach THIS API, which is
 * their own backend. It is not stored, and nothing is written to the database
 * by the preview endpoint.
 */
import type { AppInstance, Guards } from '../types.js';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { buildImportPlan, summarisePlan } from '../lib/legacy-import.js';
import { badRequest } from '../lib/errors.js';

export function registerImportRoutes(app: AppInstance, _db: Db, guards: Guards) {
  const pre = { preHandler: [guards.authenticate, guards.resolveWorkspace] };
  const base = '/api/v1/workspaces/:workspaceId';

  /**
   * POST …/import/legacy/preview
   * Body: the parsed v242 export JSON.
   * Returns counts only — never task text. Writes NOTHING.
   */
  app.post(`${base}/import/legacy/preview`, pre, async (req) => {
    const body = z.object({ export: z.record(z.any()) }).safeParse(req.body);
    if (!body.success) throw badRequest('Send { "export": <the parsed export JSON> }.');
    const plan = buildImportPlan(body.data.export);
    return { preview: summarisePlan(plan), wouldWrite: false };
  });
}
