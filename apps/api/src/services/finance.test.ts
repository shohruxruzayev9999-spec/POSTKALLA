import { describe, expect, it } from 'vitest';
import { agency } from '../test/fixtures.js';
import { copyMonth, createRow, deleteRow, financeMonth, rowHistory, statusOf, updateRow } from './finance.js';
import { createInvitation, acceptInvitation } from './org.js';
import { makeUser } from '../test/fixtures.js';

// Clock: Mon 21 Sep 2026.
describe('finance (Moliya)', () => {
  it('status is derived from amount, paid and due date', () => {
    expect(statusOf({ amount: 100, paid: 100, dueDate: null }, '2026-09-21')).toBe('PAID');
    expect(statusOf({ amount: 100, paid: 40, dueDate: '2026-09-30' }, '2026-09-21')).toBe('PARTIAL');
    expect(statusOf({ amount: 100, paid: 40, dueDate: '2026-09-10' }, '2026-09-21')).toBe('OVERDUE');
    expect(statusOf({ amount: 100, paid: 0, dueDate: null }, '2026-09-21')).toBe('UNPAID');
  });

  it('only the CEO and Finance see or touch money', async () => {
    const a = await agency();
    const owner = await a.actor(a.users.ceo.id);
    for (const id of [a.users.admin.id, a.users.hr.id, a.users.pm.id, a.users.aziz.id]) {
      const x = await a.actor(id);
      await expect(financeMonth(a.ctx, x, { month: '2026-09' })).rejects.toThrow(/Ruxsat/);
      await expect(createRow(a.ctx, x, { month: '2026-09', party: 'X', amount: 1 })).rejects.toThrow(/Ruxsat/);
    }
    const fin = await makeUser(a.db, 'Feruza');
    const inv = await createInvitation(a.ctx, owner, { role: 'FINANCE' });
    await acceptInvitation(a.ctx, fin.id, inv.token);
    const f = await a.actor(fin.id);
    await createRow(a.ctx, f, { month: '2026-09', party: 'Kafe Bahor', title: 'SMM', amount: 5_000_000 });
    expect((await financeMonth(a.ctx, owner, { month: '2026-09' })).rows).toHaveLength(1);
  });

  it('computes the month: expected, received, debt, overdue, profit; lists debtors across months', async () => {
    const a = await agency();
    const owner = await a.actor(a.users.ceo.id);
    await createRow(a.ctx, owner, { month: '2026-08', party: 'Orzu Mebel', title: 'Target', amount: 3_000_000, paid: 1_000_000, dueDate: '2026-08-10' });
    const r1 = await createRow(a.ctx, owner, { month: '2026-09', party: 'Kafe Bahor', title: 'SMM', amount: 5_000_000, dueDate: '2026-09-10' });
    await createRow(a.ctx, owner, { month: '2026-09', party: 'FitLife', title: 'Video', amount: 4_000_000, paid: 4_000_000 });
    await createRow(a.ctx, owner, { kind: 'EXPENSE', month: '2026-09', party: 'Reklama byudjeti', amount: 2_000_000, paid: 2_000_000 });

    const m = await financeMonth(a.ctx, owner, { month: '2026-09' });
    expect(m.summary).toMatchObject({ expected: 9_000_000, received: 4_000_000, receivable: 5_000_000, overdue: 5_000_000, expenses: 2_000_000, profit: 2_000_000, collectedPct: 44 });
    expect(m.rows.find((r) => r.id === r1.id)?.status).toBe('OVERDUE');
    expect(m.debtors.map((d) => [d.party, d.debt])).toEqual([
      ['Kafe Bahor', 5_000_000],
      ['Orzu Mebel', 2_000_000],
    ]);
    expect(m.debtors[1]!.overdueDays).toBe(42);

    // Paying in full clears the debt, stamps the date and leaves an audit trail.
    const paid = await updateRow(a.ctx, owner, r1.id, { paid: 5_000_000 });
    expect(paid).toMatchObject({ status: 'PAID', debt: 0, paidAt: '2026-09-21' });
    const h = await rowHistory(a.ctx, owner, r1.id);
    expect(h[0]).toMatchObject({ action: 'finance.update', data: { paid: { from: 0, to: 5_000_000 } } });
  });

  it('copies monthly retainers into the next month once', async () => {
    const a = await agency();
    const owner = await a.actor(a.users.ceo.id);
    await createRow(a.ctx, owner, { month: '2026-09', party: 'Kafe Bahor', title: 'SMM', amount: 5_000_000, paid: 5_000_000, dueDate: '2026-09-30' });
    await createRow(a.ctx, owner, { kind: 'EXPENSE', month: '2026-09', party: 'Ijara', amount: 1_000_000 });
    expect(await copyMonth(a.ctx, owner, { from: '2026-09', to: '2026-10' })).toEqual({ copied: 2 });
    expect(await copyMonth(a.ctx, owner, { from: '2026-09', to: '2026-10' })).toEqual({ copied: 0 });
    const oct = await financeMonth(a.ctx, owner, { month: '2026-10' });
    expect(oct.rows.find((r) => r.party === 'Kafe Bahor')).toMatchObject({ paid: 0, dueDate: '2026-10-30', status: 'UNPAID' });
    await deleteRow(a.ctx, owner, oct.rows[0]!.id);
    expect((await financeMonth(a.ctx, owner, { month: '2026-10' })).rows).toHaveLength(1);
  });

  it('never leaks across companies', async () => {
    const a = await agency();
    const b = await agency();
    const ownerA = await a.actor(a.users.ceo.id);
    const r = await createRow(a.ctx, ownerA, { month: '2026-09', party: 'X', amount: 1 });
    const ownerB = await b.actor(b.users.ceo.id);
    await expect(updateRow(b.ctx, ownerB, r.id, { paid: 1 })).rejects.toThrow(/topilmadi/);
  });
});
