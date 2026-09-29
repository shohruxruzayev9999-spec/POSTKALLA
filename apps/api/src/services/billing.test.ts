import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { companies } from '../db/schema.js';
import { agency, makeUser } from '../test/fixtures.js';
import { billingOverview, decidePayment, pendingPayments, requestPayment } from './billing.js';
import { createCompany } from './org.js';

describe('billing (Obuna)', () => {
  it('a new agency starts on a 14-day trial; only the CEO sees billing', async () => {
    const a = await agency(); // Mon 21 Sep 2026
    const owner = await a.actor(a.users.ceo.id);
    const b = await billingOverview(a.ctx, owner);
    expect(b).toMatchObject({ plan: 'TRIAL', planUntil: '2026-10-05', status: 'TRIAL', daysLeft: 14, usage: { members: 8, projects: 0 } });
    expect(b.catalog.map((p) => [p.id, p.monthly])).toEqual([
      ['START', 199_000],
      ['BUSINESS', 349_000],
      ['PREMIUM', 599_000],
    ]);
    expect(b.catalog[2]!.prices.find((x) => x.months === 12)).toMatchObject({ discountPct: 30, total: 5_032_000 });
    for (const id of [a.users.admin.id, a.users.pm.id, a.users.aziz.id]) {
      await expect(billingOverview(a.ctx, await a.actor(id))).rejects.toThrow(/Ruxsat/);
    }
  });

  it('payment request → platform admin confirms → plan extended; decisions are final', async () => {
    // The platform agency (oldest) — its owner confirms payments of other agencies.
    const platform = await agency();
    const client = await makeUser(platform.db, 'Rustam');
    const other = await createCompany(platform.ctx, client.id, { name: 'Boshqa Agentlik' });
    const rustam = await platform.actor(client.id).catch(() => null);
    expect(rustam).toBeNull(); // not a member of the platform agency
    const { loadActor } = await import('./context.js');
    const clientCeo = await loadActor(platform.db, client.id, other.id);

    const r = await requestPayment(platform.ctx, clientCeo, { plan: 'BUSINESS', months: 3, method: 'CLICK', contact: '+998 90 000 00 00' });
    expect(r).toMatchObject({ status: 'PENDING', amount: 942_000, discountPct: 10 });
    expect(platform.notifier.payments).toEqual([expect.objectContaining({ telegramId: platform.users.ceo.telegramId, requestId: r.id })]);
    expect(platform.notifier.payments[0]!.text).toMatch(/Boshqa Agentlik[\s\S]*Biznes[\s\S]*942 000 so‘m/);

    // Only a platform admin decides.
    await expect(decidePayment(platform.ctx, client.id, r.id, 'PAID')).rejects.toThrow(/platforma/);
    await expect(pendingPayments(platform.ctx, client.id)).rejects.toThrow(/platforma/);
    expect((await pendingPayments(platform.ctx, platform.users.ceo.id)).map((x) => x.company)).toEqual(['Boshqa Agentlik']);

    const done = await decidePayment(platform.ctx, platform.users.ceo.id, r.id, 'PAID');
    expect(done.request).toMatchObject({ status: 'PAID', paidUntil: '2026-12-21' });
    const [c] = await platform.db.select().from(companies).where(eq(companies.id, other.id));
    expect(c).toMatchObject({ plan: 'BUSINESS', planUntil: '2026-12-21' });
    expect(platform.notifier.dms.at(-1)).toMatchObject({ telegramId: client.telegramId });
    await expect(decidePayment(platform.ctx, platform.users.ceo.id, r.id, 'CANCELLED')).rejects.toThrow(/tasdiqlangan/);

    // Paying again for the same plan adds to the remaining time.
    const r2 = await requestPayment(platform.ctx, await loadActor(platform.db, client.id, other.id), { plan: 'BUSINESS', months: 1 });
    const d2 = await decidePayment(platform.ctx, platform.users.ceo.id, r2.id, 'PAID');
    expect(d2.request.paidUntil).toBe('2027-01-21');
  });

  it('a new request replaces a pending one', async () => {
    const a = await agency();
    const owner = await a.actor(a.users.ceo.id);
    const first = await requestPayment(a.ctx, owner, { plan: 'START', months: 1 });
    await requestPayment(a.ctx, owner, { plan: 'PREMIUM', months: 12 });
    const b = await billingOverview(a.ctx, owner);
    expect(b.requests.map((r) => [r.plan, r.status])).toEqual([
      ['PREMIUM', 'PENDING'],
      ['START', 'CANCELLED'],
    ]);
    expect(b.requests.find((r) => r.id === first.id)?.status).toBe('CANCELLED');
    await expect(requestPayment(a.ctx, owner, { plan: 'PREMIUM', months: 2 as never })).rejects.toThrow();
  });
});
