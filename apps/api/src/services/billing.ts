import { and, asc, count, desc, eq, inArray, ne } from 'drizzle-orm';
import { DURATIONS, DomainError, PLAN_IDS, PLANS, checkAccess, extendUntil, localDateString, planStatus, priceFor, type Duration, type PlanId } from '@retarget/shared';
import { z } from 'zod';
import { companies, memberships, paymentRequests, projects, users } from '../db/schema.js';
import { notFound, type Ctx, type ResolvedActor } from './context.js';
import { audit } from './org.js';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n: number) => n.toLocaleString('ru-RU').replace(/ /g, ' ');
const PLAN_NAME: Record<string, string> = { TRIAL: 'Sinov', START: 'Start', BUSINESS: 'Biznes', PREMIUM: 'Premium' };

const billing = (actor: ResolvedActor) => checkAccess(actor, 'billing.manage', { companyId: actor.companyId });

/**
 * Platform admins confirm manual payments: PLATFORM_ADMIN_TG_IDS (comma-separated Telegram ids),
 * or — when not set — the owners of the oldest company (the agency that runs the platform).
 */
export async function platformAdminTgIds(ctx: Ctx): Promise<number[]> {
  const env = (process.env.PLATFORM_ADMIN_TG_IDS ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (env.length) return env;
  const [first] = await ctx.db.select({ id: companies.id }).from(companies).orderBy(asc(companies.createdAt)).limit(1);
  if (!first) return [];
  const owners = await ctx.db
    .select({ tg: users.telegramId, roles: memberships.roles })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.companyId, first.id), eq(memberships.status, 'ACTIVE')));
  return owners.filter((o) => o.roles.includes('OWNER')).map((o) => o.tg);
}

export async function isPlatformAdmin(ctx: Ctx, userId: string): Promise<boolean> {
  const [u] = await ctx.db.select({ tg: users.telegramId }).from(users).where(eq(users.id, userId));
  return !!u && (await platformAdminTgIds(ctx)).includes(u.tg);
}

export async function billingOverview(ctx: Ctx, actor: ResolvedActor) {
  billing(actor);
  const c = actor.company;
  const today = localDateString(ctx.now(), c.timezone);
  const [m] = await ctx.db
    .select({ n: count() })
    .from(memberships)
    .where(and(eq(memberships.companyId, c.id), eq(memberships.status, 'ACTIVE')));
  const [p] = await ctx.db
    .select({ n: count() })
    .from(projects)
    .where(and(eq(projects.companyId, c.id), ne(projects.status, 'DONE')));
  const requests = await ctx.db.select().from(paymentRequests).where(eq(paymentRequests.companyId, c.id)).orderBy(desc(paymentRequests.createdAt)).limit(12);
  const plan = PLAN_IDS.includes(c.plan as PlanId) ? PLANS[c.plan as PlanId] : null;
  return {
    plan: c.plan,
    planName: PLAN_NAME[c.plan] ?? c.plan,
    planUntil: c.planUntil,
    ...planStatus(c.plan, c.planUntil, today),
    usage: { members: m?.n ?? 0, projects: p?.n ?? 0 },
    limits: { members: plan?.maxMembers ?? null, projects: plan?.maxProjects ?? null },
    catalog: PLAN_IDS.map((id) => ({ ...PLANS[id], prices: DURATIONS.map((d) => priceFor(id, d)) })),
    requests,
    platformAdmin: await isPlatformAdmin(ctx, actor.userId),
  };
}

export const paymentInput = z.object({
  plan: z.enum(PLAN_IDS),
  months: z.coerce.number().refine((n): n is Duration => (DURATIONS as readonly number[]).includes(n), 'Muddat 1, 3, 6 yoki 12 oy'),
  method: z.enum(['PAYME', 'CLICK', 'BANK', 'CASH']).default('PAYME'),
  contact: z.string().trim().max(60).optional(),
  note: z.string().trim().max(500).optional(),
});

/**
 * The CEO asks to pay for a plan. No card data is collected here: a platform admin confirms the
 * payment (Payme / Click / bank transfer) and the plan is extended.
 */
export async function requestPayment(ctx: Ctx, actor: ResolvedActor, input: z.input<typeof paymentInput>) {
  billing(actor);
  const data = paymentInput.parse(input);
  const price = priceFor(data.plan, data.months as Duration);
  const [pending] = await ctx.db
    .select({ id: paymentRequests.id })
    .from(paymentRequests)
    .where(and(eq(paymentRequests.companyId, actor.companyId), eq(paymentRequests.status, 'PENDING')));
  if (pending) {
    await ctx.db.update(paymentRequests).set({ status: 'CANCELLED', decidedAt: ctx.now(), note: 'Yangi so‘rov bilan almashtirildi' }).where(eq(paymentRequests.id, pending.id));
  }
  const [row] = await ctx.db
    .insert(paymentRequests)
    .values({
      companyId: actor.companyId,
      plan: data.plan,
      months: data.months,
      amount: price.total,
      discountPct: price.discountPct,
      method: data.method,
      contact: data.contact ?? null,
      note: data.note ?? null,
      requestedBy: actor.userId,
      createdAt: ctx.now(),
    })
    .returning();
  await audit(ctx.db, actor, 'billing.request', 'payment_request', row!.id, { plan: data.plan, months: data.months, amount: price.total });

  const [me] = await ctx.db.select().from(users).where(eq(users.id, actor.userId));
  const text =
    `💳 <b>To‘lov so‘rovi</b>\n` +
    `Kompaniya: <b>${esc(actor.company.name)}</b>\n` +
    `Tarif: <b>${PLANS[data.plan].name}</b> · ${data.months} oy${price.discountPct ? ` (−${price.discountPct}%)` : ''}\n` +
    `Summa: <b>${fmt(price.total)} so‘m</b>\n` +
    `Usul: ${data.method}\n` +
    `So‘radi: ${esc([me?.firstName, me?.lastName].filter(Boolean).join(' '))}${me?.username ? ` (@${esc(me.username)})` : ''}${data.contact ? `, ${esc(data.contact)}` : ''}` +
    (data.note ? `\nIzoh: ${esc(data.note)}` : '');
  for (const tg of await platformAdminTgIds(ctx)) await ctx.notifier.paymentRequest(tg, text, row!.id).catch((e) => console.error('[billing] notify', e));
  return row!;
}

/** Platform admin: confirm (extends the plan) or cancel a payment request. */
export async function decidePayment(ctx: Ctx, deciderUserId: string, requestId: string, decision: 'PAID' | 'CANCELLED') {
  if (!(await isPlatformAdmin(ctx, deciderUserId))) throw new DomainError('FORBIDDEN', 'Faqat platforma administratori');
  return ctx.db.transaction(async (tx) => {
    const [r] = await tx.select().from(paymentRequests).where(eq(paymentRequests.id, requestId)).for('update');
    if (!r) throw notFound('So‘rov');
    if (r.status !== 'PENDING') throw new DomainError('INVALID_TRANSITION', r.status === 'PAID' ? 'Allaqachon tasdiqlangan' : 'So‘rov bekor qilingan');
    const [c] = await tx.select().from(companies).where(eq(companies.id, r.companyId));
    const now = ctx.now();
    let paidUntil: string | null = null;
    if (decision === 'PAID') {
      const today = localDateString(now, c!.timezone);
      // Same plan: add to the remaining time. Another plan: the new one starts today.
      paidUntil = extendUntil(c!.plan === r.plan ? c!.planUntil : null, today, r.months);
      await tx.update(companies).set({ plan: r.plan, planUntil: paidUntil }).where(eq(companies.id, c!.id));
    }
    const [updated] = await tx.update(paymentRequests).set({ status: decision, decidedBy: deciderUserId, decidedAt: now, paidUntil }).where(eq(paymentRequests.id, r.id)).returning();

    const owners = await tx
      .select({ tg: users.telegramId, roles: memberships.roles })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.companyId, r.companyId), eq(memberships.status, 'ACTIVE')));
    const text =
      decision === 'PAID'
        ? `✅ To‘lov tasdiqlandi: <b>${PLAN_NAME[r.plan]}</b> tarifi ${paidUntil} gacha faol. Rahmat!`
        : `✖️ To‘lov so‘rovi bekor qilindi (${PLAN_NAME[r.plan]}, ${r.months} oy). Savol bo‘lsa, javob yozing.`;
    for (const o of owners.filter((x) => x.roles.includes('OWNER'))) await ctx.notifier.direct(o.tg, text, { text: '💎 Obuna', startParam: 'billing' }).catch(() => undefined);
    return { request: updated!, company: c!.name };
  });
}

export async function pendingPayments(ctx: Ctx, userId: string) {
  if (!(await isPlatformAdmin(ctx, userId))) throw new DomainError('FORBIDDEN', 'Faqat platforma administratori');
  return ctx.db
    .select({ r: paymentRequests, company: companies.name })
    .from(paymentRequests)
    .innerJoin(companies, eq(companies.id, paymentRequests.companyId))
    .where(inArray(paymentRequests.status, ['PENDING']))
    .orderBy(desc(paymentRequests.createdAt));
}
