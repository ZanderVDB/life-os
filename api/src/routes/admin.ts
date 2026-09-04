/**
 * The admin surface.
 *
 * ── What is NOT here ─────────────────────────────────────────────────────
 *
 * Any secret. No API key, no database URL, no OAuth token, no Firebase
 * credential is read by this file or reachable through it. Admin shows usage
 * and status; it is not a control panel for the deployment.
 *
 * ── Authorisation ────────────────────────────────────────────────────────
 *
 * Every route below runs `requireAdmin` server-side. There is no route that
 * decides anything from a URL, a header the browser sets, or a flag in a
 * request body. A normal signed-in user calling any of these gets 403 and
 * nothing else — see `admin/authz.ts`.
 *
 * ── Every mutation is audited ────────────────────────────────────────────
 *
 * Before and after, actor and target, written after the change succeeds. And
 * none of them touches usage history: an allowance change moves the window
 * that history is read through, it does not edit the history.
 */
import type { AppInstance, Guards } from '../types.js';
import { z } from 'zod';
import { and, desc, eq, gte, sql, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  users, aiUsageEvents, aiUsagePolicies, aiUsageAdjustments, aiTurns,
  ACCOUNT_TYPES, USER_ROLES,
} from '../db/schema.js';
import { makeAdminGuard, adminIdentity, ADMIN_SETUP } from '../admin/authz.js';
import { recordAdminAction, readAuditLog, diff, emailOf } from '../admin/audit.js';
import {
  allowanceState, updatePolicy, policyFor, overshootBound, defaultAllowanceUsd,
} from '../usage/allowance.js';
import {
  totalsForAll, totalsForUser, breakdown, recentEvents, asNumber,
} from '../usage/ledger.js';
import { fxRate, toZar, FX_SETUP } from '../usage/fx.js';
import { badRequest, notFound } from '../lib/errors.js';

const uuid = z.string().uuid();

/** Money for display. Rand only when a rate is configured — never invented. */
const withZar = (usd: number) => {
  const fx = fxRate();
  return { usd, zar: fx ? toZar(usd, fx) : null };
};

export function registerAdminRoutes(app: AppInstance, db: Db, guards: Guards) {
  const requireAdmin = makeAdminGuard(db);
  const pre = { preHandler: [guards.authenticate, requireAdmin] };
  const base = '/api/v1/admin';

  const startOfToday = () => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d;
  };

  /* ══ Overview ════════════════════════════════════════════════════════ */

  /**
   * The operational picture, entirely from the ledger.
   *
   * No sampled analytics, no estimates, no rounded-up vanity numbers. Every
   * figure here is a `count` or a `sum` over rows that exist.
   */
  app.get(`${base}/overview`, pre, async () => {
    const fx = fxRate();
    const [today, all, accountRows] = await Promise.all([
      totalsForAll(db, { from: startOfToday() }),
      totalsForAll(db),
      db.select({
        accountType: users.accountType,
        role: users.role,
        email: users.email,
        id: users.id,
      }).from(users),
    ]);

    /* Who is near, and who is past. Computed per user because an allowance is
       per user — a single aggregate cannot answer it. */
    const everyone = await db.select({ id: users.id }).from(users);
    let nearLimit = 0;
    let atLimit = 0;
    let aiOff = 0;
    for (const u of everyone) {
      const s = await allowanceState(db, u.id);
      if (s.status === 'blocked') atLimit += 1;
      else if (s.status === 'warning' || s.status === 'notice') nearLimit += 1;
      if (!s.aiEnabled) aiOff += 1;
    }

    const byType: Record<string, number> = {};
    let admins = 0;
    for (const r of accountRows as any[]) {
      byType[r.accountType] = (byType[r.accountType] ?? 0) + 1;
      /* EFFECTIVE admins, so the bootstrap allowlist is counted. Counting
         only the column would report zero on a deployment whose only admin is
         the configured one — which is every deployment on day one. */
      if (adminIdentity(r).isAdmin) admins += 1;
    }

    const [turnRow] = await db.select({ n: sql<number>`count(*)::int` }).from(aiTurns);

    return {
      users: {
        total: everyone.length,
        byAccountType: byType,
        admins,
        aiDisabled: aiOff,
        nearLimit,
        atLimit,
      },
      spend: {
        today: withZar(today.providerCostUsd),
        allTime: withZar(all.providerCostUsd),
        currency: 'USD',
        fx: fx ? { rate: fx.rate, source: fx.source } : null,
      },
      activity: {
        providerCallsToday: today.calls,
        providerCallsAllTime: all.calls,
        failuresToday: today.failures,
        failuresAllTime: all.failures,
        assistantTurns: Number((turnRow as any)?.n ?? 0),
        /* Rows priced at the unknown-model ceiling. Surfaced rather than
           blended in, because presenting an estimate as a measurement is how
           a bill becomes a surprise. */
        estimatedPriceCalls: all.estimatedCalls,
      },
      tokens: {
        input: all.inputTokens,
        output: all.outputTokens,
        cacheRead: all.cacheReadTokens,
        cacheWrite: all.cacheWriteTokens,
      },
      config: {
        defaultAllowanceUsd: defaultAllowanceUsd(),
        overshoot: overshootBound(),
        fxConfigured: Boolean(fx),
        fxSetup: fx ? null : FX_SETUP,
        adminSetup: ADMIN_SETUP,
      },
    };
  });

  /* ══ Users ═══════════════════════════════════════════════════════════ */

  app.get(`${base}/users`, pre, async (req) => {
    const q = z.object({
      search: z.string().max(120).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).parse((req.query ?? {}) as any);

    const rows = await db.select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      accountType: users.accountType,
      betaStartAt: users.betaStartAt,
      betaEndAt: users.betaEndAt,
      introAcceptedAt: users.introAcceptedAt,
      lastActiveAt: users.lastActiveAt,
      createdAt: users.createdAt,
    }).from(users).orderBy(desc(users.createdAt)).limit(q.limit);

    const needle = q.search?.trim().toLowerCase();
    const filtered = needle
      ? rows.filter((r: any) => `${r.email} ${r.displayName ?? ''}`.toLowerCase().includes(needle))
      : rows;

    /* Usage per row. A list without it is a list nobody can act on. */
    const out = [];
    for (const r of filtered as any[]) {
      const s = await allowanceState(db, r.id);
      out.push({
        ...r,
        isAdmin: adminIdentity(r).isAdmin,
        adminViaAllowlist: adminIdentity(r).viaAllowlist,
        aiEnabled: s.aiEnabled,
        status: s.status,
        allowance: withZar(s.allowanceUsd ?? 0),
        allowanceUsd: s.allowanceUsd,
        usedUsd: s.usedUsd,
        used: withZar(s.usedUsd),
        remainingUsd: s.remainingUsd,
        fraction: s.fraction,
        calls: s.calls,
      });
    }
    return { users: out, total: out.length };
  });

  app.get(`${base}/users/:id`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!row) throw notFound('No such user.');

    const state = await allowanceState(db, id);
    const window = { from: state.periodStart, to: state.periodEnd };
    const [totals, parts, recent, credits, audit] = await Promise.all([
      totalsForUser(db, id, window),
      breakdown(db, { userId: id }, window),
      recentEvents(db, id, 20),
      db.select().from(aiUsageAdjustments)
        .where(eq(aiUsageAdjustments.userId, id))
        .orderBy(desc(aiUsageAdjustments.createdAt)).limit(20),
      readAuditLog(db, { targetUserId: id, limit: 20 }),
    ]);

    const who = adminIdentity(row as any);
    const fx = fxRate();
    return {
      /* So every figure on this page is in one currency. Without it the
         per-call list showed dollars beside rand totals, which reads as two
         different numbers rather than one converted. */
      fx: fx ? { rate: fx.rate, source: fx.source } : null,
      user: {
        id: row.id,
        email: row.email,
        displayName: row.displayName,
        role: row.role,
        isAdmin: who.isAdmin,
        adminViaAllowlist: who.viaAllowlist,
        accountType: row.accountType,
        betaStartAt: row.betaStartAt,
        betaEndAt: row.betaEndAt,
        introAcceptedAt: row.introAcceptedAt,
        lastActiveAt: row.lastActiveAt,
        adminNote: row.adminNote,
        createdAt: row.createdAt,
      },
      allowance: {
        ...state,
        allowance: withZar(state.allowanceUsd ?? 0),
        used: withZar(state.usedUsd),
        remaining: state.remainingUsd === null ? null : withZar(state.remainingUsd),
      },
      usage: {
        providerCostUsd: totals.providerCostUsd,
        providerCost: withZar(totals.providerCostUsd),
        billableCostUsd: totals.billableCostUsd,
        billableCost: withZar(totals.billableCostUsd),
        calls: totals.calls,
        failures: totals.failures,
        estimatedCalls: totals.estimatedCalls,
        tokens: {
          input: totals.inputTokens,
          output: totals.outputTokens,
          cacheRead: totals.cacheReadTokens,
          cacheWrite: totals.cacheWriteTokens,
        },
        byJob: parts.map((p) => ({
          job: p.job, model: p.model, calls: p.calls,
          inputTokens: p.inputTokens, outputTokens: p.outputTokens,
          billableCostUsd: p.billableCostUsd,
          ...withZar(p.billableCostUsd),
        })).sort((a, b) => b.billableCostUsd - a.billableCostUsd),
        recent,
      },
      adjustments: (credits as any[]).map((c) => ({
        ...c, amountUsd: asNumber(c.amountUsd),
      })),
      audit,
    };
  });

  /* ══ Mutations ═══════════════════════════════════════════════════════ */

  const PatchSchema = z.object({
    accountType: z.enum(ACCOUNT_TYPES).optional(),
    role: z.enum(USER_ROLES).optional(),
    aiEnabled: z.boolean().optional(),
    /** null sets unlimited. Absent leaves it alone. */
    allowanceUsd: z.number().min(0).max(100_000).nullable().optional(),
    betaStartAt: z.string().datetime().nullable().optional(),
    betaEndAt: z.string().datetime().nullable().optional(),
    periodStart: z.string().datetime().optional(),
    periodEnd: z.string().datetime().nullable().optional(),
    adminNote: z.string().max(2000).nullable().optional(),
  }).strict();

  /**
   * Change an account.
   *
   * One endpoint for the whole shape of an account, because these are almost
   * always changed together — "make them a tester, give them until the 20th,
   * and raise the allowance" is one decision and belongs in one audit entry.
   */
  app.patch(`${base}/users/:id`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = PatchSchema.parse(req.body ?? {});
    const actor = req.admin!;

    const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!row) throw notFound('No such user.');
    const policyBefore = await policyFor(db, id);

    /* An admin removing their own admin rights would lock the last operator
       out of the system, which is a mistake nobody recovers from in a hurry. */
    if (b.role === 'user' && id === actor.userId) {
      throw badRequest('You cannot remove your own admin access.');
    }

    const userSet: Record<string, unknown> = { updatedAt: new Date() };
    if (b.accountType !== undefined) userSet['accountType'] = b.accountType;
    if (b.role !== undefined) userSet['role'] = b.role;
    if (b.betaStartAt !== undefined) {
      userSet['betaStartAt'] = b.betaStartAt ? new Date(b.betaStartAt) : null;
    }
    if (b.betaEndAt !== undefined) {
      userSet['betaEndAt'] = b.betaEndAt ? new Date(b.betaEndAt) : null;
    }
    if (b.adminNote !== undefined) userSet['adminNote'] = b.adminNote;
    if (Object.keys(userSet).length > 1) {
      await db.update(users).set(userSet).where(eq(users.id, id));
    }

    const patch: Parameters<typeof updatePolicy>[2] = {};
    if (b.aiEnabled !== undefined) patch.aiEnabled = b.aiEnabled;
    if (b.allowanceUsd !== undefined) patch.allowanceUsd = b.allowanceUsd;
    if (b.periodStart !== undefined) patch.periodStart = new Date(b.periodStart);
    if (b.periodEnd !== undefined) {
      patch.periodEnd = b.periodEnd ? new Date(b.periodEnd) : null;
    }
    if (Object.keys(patch).length) await updatePolicy(db, id, patch);

    const [after] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    const policyAfter = await policyFor(db, id);

    const shot = (u: any, p: any) => ({
      accountType: u.accountType, role: u.role,
      betaStartAt: u.betaStartAt, betaEndAt: u.betaEndAt, adminNote: u.adminNote,
      aiEnabled: p.aiEnabled, allowanceUsd: p.allowanceUsd,
      periodStart: p.periodStart, periodEnd: p.periodEnd,
    });
    const changed = diff(shot(row, policyBefore) as any, shot(after, policyAfter) as any);
    if (Object.keys(changed.after).length) {
      await recordAdminAction(db, {
        actor,
        targetUserId: id,
        targetEmail: row.email,
        action: 'user.update',
        before: changed.before,
        after: changed.after,
      });
    }

    return {
      user: after,
      allowance: await allowanceState(db, id),
      changed: changed.after,
    };
  });

  /**
   * Add allowance without rewriting what has been spent.
   *
   * A credit is a ROW. Raising the allowance and topping it up are different
   * actions with different histories: one changes the budget, the other adds
   * to it for this period only.
   */
  app.post(`${base}/users/:id/credit`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({
      amountUsd: z.number().min(-100_000).max(100_000)
        .refine((n) => n !== 0, 'A zero credit changes nothing.'),
      reason: z.string().trim().min(1).max(500),
      kind: z.enum(['credit', 'waiver', 'correction']).default('credit'),
    }).strict().parse(req.body ?? {});
    const actor = req.admin!;

    const before = await allowanceState(db, id);
    await db.insert(aiUsageAdjustments).values({
      userId: id,
      amountUsd: b.amountUsd.toFixed(10),
      reason: b.reason,
      kind: b.kind,
      actorUserId: actor.userId,
      periodStart: before.periodStart,
    });
    const after = await allowanceState(db, id);

    await recordAdminAction(db, {
      actor,
      targetUserId: id,
      targetEmail: await emailOf(db, id),
      action: 'user.credit',
      before: { allowanceUsd: before.allowanceUsd, remainingUsd: before.remainingUsd },
      after: { allowanceUsd: after.allowanceUsd, remainingUsd: after.remainingUsd },
      note: `${b.kind}: ${b.reason}`,
    });
    return { allowance: after };
  });

  /**
   * Start a fresh usage period.
   *
   * Moves the WINDOW. Deliberately does not delete a single usage event —
   * history is why a number looks the way it does, and an accounting system
   * whose past can be erased is evidence of nothing.
   */
  app.post(`${base}/users/:id/new-period`, pre, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({
      periodStart: z.string().datetime().optional(),
      periodEnd: z.string().datetime().nullable().optional(),
      allowanceUsd: z.number().min(0).max(100_000).nullable().optional(),
    }).strict().parse(req.body ?? {});
    const actor = req.admin!;

    const before = await policyFor(db, id);
    const [countBefore] = await db.select({ n: sql<number>`count(*)::int` })
      .from(aiUsageEvents).where(eq(aiUsageEvents.userId, id));

    await updatePolicy(db, id, {
      periodStart: b.periodStart ? new Date(b.periodStart) : new Date(),
      periodEnd: b.periodEnd === undefined ? before.periodEnd
        : (b.periodEnd ? new Date(b.periodEnd) : null),
      ...(b.allowanceUsd !== undefined ? { allowanceUsd: b.allowanceUsd } : {}),
    });

    const [countAfter] = await db.select({ n: sql<number>`count(*)::int` })
      .from(aiUsageEvents).where(eq(aiUsageEvents.userId, id));
    /* Not an assertion for the reader's benefit — if this ever fires, something
       has started deleting financial history and the operator must know. */
    if (Number((countAfter as any).n) !== Number((countBefore as any).n)) {
      throw new Error('Starting a new period changed usage history.');
    }

    const after = await policyFor(db, id);
    await recordAdminAction(db, {
      actor,
      targetUserId: id,
      targetEmail: await emailOf(db, id),
      action: 'user.new-period',
      before: { periodStart: before.periodStart, periodEnd: before.periodEnd,
        allowanceUsd: before.allowanceUsd },
      after: { periodStart: after.periodStart, periodEnd: after.periodEnd,
        allowanceUsd: after.allowanceUsd },
      note: `${countAfter ? (countAfter as any).n : 0} usage events preserved`,
    });
    return { allowance: await allowanceState(db, id) };
  });

  /* ══ Audit ═══════════════════════════════════════════════════════════ */

  app.get(`${base}/audit`, pre, async (req) => {
    const q = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      userId: uuid.optional(),
    }).parse((req.query ?? {}) as any);
    return { entries: await readAuditLog(db, { targetUserId: q.userId ?? null, limit: q.limit }) };
  });

  /* ══ Spend, over time ════════════════════════════════════════════════ */

  /** Daily provider spend, for the overview. Straight from the ledger. */
  app.get(`${base}/spend`, pre, async (req) => {
    const q = z.object({
      days: z.coerce.number().int().min(1).max(90).default(14),
    }).parse((req.query ?? {}) as any);
    const from = new Date(Date.now() - q.days * 24 * 60 * 60 * 1000);
    const rows = await db.select({
      day: sql<string>`to_char(date_trunc('day', ${aiUsageEvents.createdAt}), 'YYYY-MM-DD')`,
      usd: sql<string>`coalesce(sum(${aiUsageEvents.providerCostUsd}), 0)`,
      calls: sql<number>`count(*)::int`,
    }).from(aiUsageEvents)
      .where(gte(aiUsageEvents.createdAt, from))
      .groupBy(sql`date_trunc('day', ${aiUsageEvents.createdAt})`)
      .orderBy(sql`date_trunc('day', ${aiUsageEvents.createdAt})`);
    const fx = fxRate();
    return {
      days: (rows as any[]).map((r) => ({
        day: r.day,
        usd: asNumber(r.usd),
        zar: fx ? toZar(asNumber(r.usd), fx) : null,
        calls: r.calls,
      })),
    };
  });
}
