import { sql } from 'drizzle-orm';
import type { Ctx } from './context.js';
import { platformAdminTgIds } from './billing.js';

/** Process-wide liveness, filled by main.ts (worker ticks, bot polling). */
export const liveness = {
  startedAt: new Date(),
  workerAt: null as Date | null,
  /** null when the API runs without Telegram (BOT_TOKEN=dev). */
  botRunning: (() => null) as () => boolean | null,
};

/** The worker ticks every minute; five quiet minutes means it is stuck. */
const WORKER_STALE_MS = 5 * 60_000;

export async function checkHealth(ctx: Ctx) {
  let db = false;
  try {
    await ctx.db.execute(sql`select 1`);
    db = true;
  } catch {
    db = false;
  }
  const now = ctx.now().getTime();
  const since = (liveness.workerAt ?? liveness.startedAt).getTime();
  const worker = now - since < WORKER_STALE_MS;
  const bot = liveness.botRunning();
  return { ok: db && worker && bot !== false, db, worker, bot, workerAt: liveness.workerAt?.toISOString() ?? null };
}

const lastAlert = new Map<string, number>();

/** Tells the platform admins in Telegram that something broke — at most every 30 minutes per kind. */
export async function alertAdmins(ctx: Ctx, kind: string, text: string) {
  const now = ctx.now().getTime();
  if (now - (lastAlert.get(kind) ?? 0) < 30 * 60_000) return;
  lastAlert.set(kind, now);
  try {
    for (const tg of await platformAdminTgIds(ctx)) await ctx.notifier.direct(tg, `🚨 <b>Postkalla</b>: ${text}`).catch(() => undefined);
  } catch (err) {
    console.error('[alert]', kind, err);
  }
}
