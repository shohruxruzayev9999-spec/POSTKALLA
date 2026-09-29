import { describe, expect, it } from 'vitest';
import { agency } from '../test/fixtures.js';
import type { AiClient } from './ai.js';
import { checkIn } from './attendance.js';
import { recordGroupMessage } from './chatlog.js';
import { buildDigest, digestText, forActor, refreshDigest, runDigests, todayDigest } from './digest.js';
import { createRow } from './finance.js';
import { bindChat, createProject } from './projects.js';
import { actOnTask, createTask } from './tasks.js';

const CHAT = -100_777;
const at = (iso: string) => new Date(iso);

// Mon 21 Sep 2026 10:00 Tashkent. Digest runs Tue 22 Sep at the work start (10:00).
async function setup() {
  const a = await agency();
  const owner = await a.actor(a.users.ceo.id);
  const project = await createProject(a.ctx, owner, { name: 'Kafe Bahor', managerUserId: a.users.pm.id, memberUserIds: [a.users.aziz.id, a.users.bekzod.id, a.users.videographer.id] });
  const pm = await a.actor(a.users.pm.id);
  await bindChat(a.ctx, owner, project.id, CHAT, 'Kafe Bahor');

  const late = await createTask(a.ctx, pm, { title: 'Oktabr banneri', projectId: project.id, assigneeUserId: a.users.aziz.id, deadline: at('2026-09-21T06:00:00Z'), priority: 'HIGH' });
  const review = await createTask(a.ctx, pm, { title: 'Stories 5 ta', projectId: project.id, assigneeUserId: a.users.bekzod.id, reviewerUserId: a.users.pm.id, deadline: at('2026-09-23T12:00:00Z') });
  const blocked = await createTask(a.ctx, pm, { title: 'Reels montaj', projectId: project.id, assigneeUserId: a.users.videographer.id, deadline: at('2026-09-24T12:00:00Z') });
  const today = await createTask(a.ctx, pm, { title: 'Menyu posti', projectId: project.id, assigneeUserId: a.users.aziz.id, deadline: at('2026-09-22T12:00:00Z') });
  await createTask(a.ctx, owner, { title: 'Maxfiy ish', assigneeUserId: a.users.pm.id, deadline: at('2026-09-21T06:00:00Z'), isPrivate: true });

  const bekzod = await a.actor(a.users.bekzod.id);
  const otabek = await a.actor(a.users.videographer.id);
  await actOnTask(a.ctx, bekzod, review.id, 'START');
  a.clock.set(at('2026-09-21T05:05:00Z'));
  await actOnTask(a.ctx, bekzod, review.id, 'SUBMIT');
  await actOnTask(a.ctx, otabek, blocked.id, 'START');
  await actOnTask(a.ctx, otabek, blocked.id, 'BLOCK', 'Mijoz video materiallarni bermadi');

  // Monday attendance: Aziz 25 minutes late; Bekzod checks in on time.
  a.clock.set(at('2026-09-21T05:25:00Z'));
  await checkIn(a.ctx, await a.actor(a.users.aziz.id), {});
  a.clock.set(at('2026-09-21T04:58:00Z'));
  await checkIn(a.ctx, bekzod, {});

  // The client asks something on Monday 15:00; nobody from the team answers.
  await recordGroupMessage(a.ctx, { message_id: 1, date: Date.parse('2026-09-21T10:00:00Z') / 1000, chat: { id: CHAT, type: 'supergroup' }, from: { id: 555, is_bot: false, first_name: 'Dilnoza' }, text: 'Logo qachon tayyor bo‘ladi?' });

  await createRow(a.ctx, owner, { month: '2026-09', party: 'Kafe Bahor', amount: 5_000_000, dueDate: '2026-09-10', projectId: project.id });
  a.clock.set(at('2026-09-22T05:30:00Z')); // Tue 10:30
  return { a, owner, pm, project, late, review, blocked, today };
}

describe('daily digest (AI agent — recommends only)', () => {
  it('finds what burns: overdue, waiting review, blocked, due today, a waiting client, late check-ins, money', async () => {
    const { a, owner, late, review, blocked, today } = await setup();
    const d = await buildDigest(a.ctx, owner.company);
    expect(d.day).toBe('2026-09-22');
    expect(d.yesterday).toMatchObject({ day: '2026-09-21', present: 2, late: 1, tracked: true });
    expect(d.totals).toMatchObject({ open: 4, overdue: 1, review: 1, blocked: 1, dueToday: 1 }); // the 1:1 task stays out
    const byKind = (k: string) => d.items.filter((i) => i.kind === k);
    expect(byKind('OVERDUE')[0]).toMatchObject({ severity: 'HIGH', taskId: late.id });
    expect(byKind('REVIEW_WAITING')[0]).toMatchObject({ taskId: review.id });
    expect(d.review[0]!.hours).toBe(8);
    expect(byKind('BLOCKED')[0]!.text).toMatch(/Mijoz video materiallarni bermadi/);
    expect(byKind('BLOCKED')[0]!.taskId).toBe(blocked.id);
    expect(byKind('DUE_TODAY')[0]!.text).toMatch(new RegExp(`#${today.number}`));
    expect(byKind('CLIENT_WAITING')[0]!.text).toMatch(/4 ish soatidan beri javob kutmoqda: “Logo qachon/);
    expect(byKind('LATE')[0]!.text).toMatch(/Aziz \(25 daq\)/);
    expect(byKind('DEBT')[0]).toMatchObject({ severity: 'HIGH', finance: true });
    expect(d.items.map((i) => i.severity)).toEqual([...d.items.map((i) => i.severity)].sort((x, y) => ['HIGH', 'MEDIUM', 'LOW'].indexOf(x) - ['HIGH', 'MEDIUM', 'LOW'].indexOf(y)));

    // Money stays with the CEO.
    const pmView = forActor(d, await a.actor(a.users.pm.id));
    expect(pmView.finance).toBeNull();
    expect(pmView.items.some((i) => i.finance)).toBe(false);
    expect(digestText(pmView, null)).not.toMatch(/qarz/);
  });

  it('sends once per working day at the digest time to leads only; AI advice is optional', async () => {
    const { a } = await setup();
    const calls: string[] = [];
    a.ctx.ai = { complete: async ({ prompt }) => (calls.push(prompt), '- Aziz bilan bannerni bugun yakunlang\n- Kamola, Stories ni ko‘rib chiqing') } satisfies AiClient;

    a.clock.set(at('2026-09-22T04:50:00Z')); // 09:50 — too early
    expect(await runDigests(a.ctx)).toBe(0);
    a.clock.set(at('2026-09-22T05:30:00Z'));
    const sent = await runDigests(a.ctx);
    // CEO, admin, PM and the design head (Jasur); never ordinary employees or HR.
    const to = a.notifier.dms.map((m) => m.telegramId).sort();
    expect(to).toEqual([a.users.ceo, a.users.admin, a.users.pm, a.users.head].map((u) => u.telegramId).sort());
    expect(sent).toBe(4);
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toMatch(/5000000|qarz/); // the model never sees money
    const ceoMsg = a.notifier.dms.find((m) => m.telegramId === a.users.ceo.telegramId)!.text;
    const pmMsg = a.notifier.dms.find((m) => m.telegramId === a.users.pm.telegramId)!.text;
    expect(ceoMsg).toMatch(/Kunlik tahlil — 22-sentabr/);
    expect(ceoMsg).toMatch(/AI tavsiyasi[\s\S]*Aziz bilan bannerni/);
    expect(ceoMsg).toMatch(/qarz/);
    expect(pmMsg).not.toMatch(/qarz/);

    // Idempotent.
    expect(await runDigests(a.ctx)).toBe(0);
    // Sunday is a day off.
    a.clock.set(at('2026-09-27T06:00:00Z'));
    expect(await runDigests(a.ctx)).toBe(0);
  });

  it('keeps working when the model fails', async () => {
    const { a } = await setup();
    a.ctx.ai = { complete: async () => Promise.reject(new Error('overloaded')) };
    expect(await runDigests(a.ctx)).toBe(4);
    const stored = await todayDigest(a.ctx, await a.actor(a.users.ceo.id));
    expect(stored).toMatchObject({ stored: true, ai: null });
  });

  it('dashboard: leads read it, employees cannot; only the CEO/admin rebuilds', async () => {
    const { a, owner } = await setup();
    const live = await todayDigest(a.ctx, await a.actor(a.users.pm.id));
    expect(live.stored).toBe(false);
    expect(live.finance).toBeNull();
    await expect(todayDigest(a.ctx, await a.actor(a.users.aziz.id))).rejects.toThrow(/rahbarlar/);
    await expect(refreshDigest(a.ctx, await a.actor(a.users.pm.id))).rejects.toThrow(/rahbar/);
    const fresh = await refreshDigest(a.ctx, owner);
    expect(fresh.stored).toBe(true);
    expect(fresh.finance?.overdueAmount).toBe(5_000_000);
    expect(a.notifier.dms).toHaveLength(0); // rebuilding never messages anyone
  });

  it('an early manual refresh does not cancel the morning messages', async () => {
    const { a, owner } = await setup();
    a.clock.set(at('2026-09-22T04:00:00Z')); // 09:00, before the digest time
    await refreshDigest(a.ctx, owner);
    expect(await runDigests(a.ctx)).toBe(0);
    a.clock.set(at('2026-09-22T05:30:00Z'));
    expect(await runDigests(a.ctx)).toBe(4);
    await refreshDigest(a.ctx, owner); // after sending: still never re-sent
    expect(await runDigests(a.ctx)).toBe(0);
  });
});
