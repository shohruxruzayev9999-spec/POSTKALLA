import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { taskChecklist, taskEvents, tasks, users } from '../db/schema.js';
import { agency } from '../test/fixtures.js';
import { confirmDraft, draftFromTelegram, myOpenTasks, switchDraftCompany } from './capture.js';
import { createCompany } from './org.js';
import { bindChat, createProject } from './projects.js';
import { runRecurring } from './recurring.js';
import { actOnTask, createTask, getTask, updateTask } from './tasks.js';

async function setup() {
  const a = await agency(); // Mon 21 Sep 2026, 10:00 Tashkent
  await a.db.update(users).set({ username: 'aziz_design' }).where(eq(users.id, a.users.aziz.id));
  await a.db.update(users).set({ username: 'kamola_pm' }).where(eq(users.id, a.users.pm.id));
  return a;
}

describe('tasks from Telegram', () => {
  it('a manager drafts "/task ertaga 17:00 @user …", confirms, and a normal task appears', async () => {
    const a = await setup();
    const d = await draftFromTelegram(a.ctx, { telegramId: a.users.head.telegramId, text: 'ertaga 17:00 @aziz_design Oktabr bannerlari' });
    expect(d).toMatchObject({ title: 'Oktabr bannerlari', assigneeUserId: a.users.aziz.id, companyId: a.company.id, deadlineSet: true, unknownMentions: [] });
    expect(d.deadline.toISOString()).toBe('2026-09-22T12:00:00.000Z'); // Tue 17:00 Tashkent
    const t = await confirmDraft(a.ctx, d);
    expect(t).toMatchObject({ title: 'Oktabr bannerlari', assigneeUserId: a.users.aziz.id, createdBy: a.users.head.id, status: 'NEW', number: 1 });
  });

  it('the rules of the app still apply: an employee cannot give work to a colleague', async () => {
    const a = await setup();
    const d = await draftFromTelegram(a.ctx, { telegramId: a.users.bekzod.telegramId, text: '@aziz_design logotip' });
    expect(d.assigneeUserId).toBe(a.users.aziz.id);
    await expect(confirmDraft(a.ctx, d)).rejects.toThrow();
    // For themself it works, without a date: the end of today's working day.
    const own = await draftFromTelegram(a.ctx, { telegramId: a.users.bekzod.telegramId, text: 'logotip variantlari' });
    expect(own).toMatchObject({ assigneeUserId: a.users.bekzod.id, deadlineSet: false });
    expect(own.deadline.toISOString()).toBe('2026-09-21T13:00:00.000Z');
    await confirmDraft(a.ctx, own);
  });

  it('an unknown @mention is flagged and the author stays the assignee', async () => {
    const a = await setup();
    const d = await draftFromTelegram(a.ctx, { telegramId: a.users.pm.telegramId, text: '@nobody_here brief' });
    expect(d).toMatchObject({ assigneeUserId: a.users.pm.id, unknownMentions: ['nobody_here'] });
  });

  it('a forwarded or replied message becomes the title and the description; the reply author is the assignee', async () => {
    const a = await setup();
    const source = { text: 'Mijoz yangi narxlar posterini so‘radi\nO‘lcham 1080x1350', author: 'Aziz', authorTelegramId: a.users.aziz.telegramId };
    const d = await draftFromTelegram(a.ctx, { telegramId: a.users.head.telegramId, text: 'juma', source });
    expect(d).toMatchObject({ title: 'Mijoz yangi narxlar posterini so‘radi', assigneeUserId: a.users.aziz.id });
    expect(d.description).toContain('1080x1350');
    expect(d.deadline.toISOString()).toBe('2026-09-25T13:00:00.000Z'); // Fri 18:00
    // An explicit title wins over the forwarded text.
    const e = await draftFromTelegram(a.ctx, { telegramId: a.users.head.telegramId, text: 'Poster tayyorlash', source });
    expect(e.title).toBe('Poster tayyorlash');
  });

  it('in a bound project group the draft belongs to that project, and the card is posted there', async () => {
    const a = await setup();
    const owner = await a.actor(a.users.ceo.id);
    const p = await createProject(a.ctx, owner, { name: 'Hadid', managerUserId: a.users.pm.id, memberUserIds: [a.users.aziz.id] });
    await bindChat(a.ctx, await a.actor(a.users.pm.id), p.id, -100500, 'Hadid team');
    const d = await draftFromTelegram(a.ctx, { telegramId: a.users.pm.telegramId, text: '@aziz_design stories', groupChatId: -100500 });
    expect(d).toMatchObject({ projectId: p.id, projectName: 'Hadid' });
    await confirmDraft(a.ctx, d);
    expect(a.notifier.cards.at(-1)).toMatchObject({ title: 'stories', groupChatId: -100500 });
    await expect(switchDraftCompany(a.ctx, d, a.company.id)).rejects.toThrow(/loyihaga/);
  });

  it('empty text and strangers are refused with a hint', async () => {
    const a = await setup();
    await expect(draftFromTelegram(a.ctx, { telegramId: a.users.pm.telegramId, text: 'ertaga' })).rejects.toThrow(/\/task/);
    await expect(draftFromTelegram(a.ctx, { telegramId: 999_999, text: 'nimadir' })).rejects.toThrow(/start/);
  });

  it('with two companies the draft can be moved to the other one', async () => {
    const a = await setup();
    const other = await createCompany(a.ctx, a.users.pm.id, { name: 'Ikkinchi', departments: [{ name: 'SMM' }] });
    const d = await draftFromTelegram(a.ctx, { telegramId: a.users.pm.telegramId, text: 'reja' });
    expect(d.companyOptions.map((o) => o.name).sort()).toEqual(['Ikkinchi', 'Test Agency']);
    const moved = await switchDraftCompany(a.ctx, d, other.id);
    expect(moved.companyId).toBe(other.id);
    expect((await confirmDraft(a.ctx, moved)).companyId).toBe(other.id);
  });
});

describe('/my and /due', () => {
  it('lists my open work and what I must review, nearest deadline first', async () => {
    const a = await setup();
    const pm = await a.actor(a.users.head.id);
    const day = 86_400_000;
    const t1 = await createTask(a.ctx, pm, { title: 'Uzoq', assigneeUserId: a.users.aziz.id, deadline: new Date(a.clock.t.getTime() + 5 * day) });
    await createTask(a.ctx, pm, { title: 'Yaqin', assigneeUserId: a.users.aziz.id, deadline: new Date(a.clock.t.getTime() + day) });
    await createTask(a.ctx, pm, { title: 'Boshqaniki', assigneeUserId: a.users.bekzod.id, deadline: new Date(a.clock.t.getTime() + day) });
    expect((await myOpenTasks(a.ctx, a.users.aziz.telegramId, 'my')).map((t) => t.title)).toEqual(['Yaqin', 'Uzoq']);
    expect((await myOpenTasks(a.ctx, a.users.aziz.telegramId, 'due')).map((t) => t.title)).toEqual(['Yaqin']);
    // Submitted work shows up for the reviewer.
    const aziz = await a.actor(a.users.aziz.id);
    await actOnTask(a.ctx, aziz, t1.id, 'START');
    await actOnTask(a.ctx, aziz, t1.id, 'SUBMIT');
    const review = await myOpenTasks(a.ctx, a.users.head.telegramId, 'my');
    expect(review.find((t) => t.title === 'Uzoq')).toMatchObject({ toReview: true });
  });
});

describe('repeating tasks', () => {
  // The design head gives work to the designers.
  it('the next copy comes once the deadline passes, exactly once, with the checklist unticked', async () => {
    const a = await setup();
    const pm = await a.actor(a.users.head.id);
    const t = await createTask(a.ctx, pm, {
      title: 'Haftalik hisobot',
      assigneeUserId: a.users.aziz.id,
      deadline: new Date('2026-09-25T12:00:00Z'), // Fri 17:00
      recurrence: 'WEEKLY',
      checklist: ['Raqamlar', 'Xulosa'],
    });
    const aziz = await a.actor(a.users.aziz.id);
    const [first] = await a.db.select().from(taskChecklist).where(eq(taskChecklist.taskId, t.id));
    const { updateChecklistItem } = await import('./boards.js');
    await updateChecklistItem(a.ctx, aziz, t.id, first!.id, { done: true });

    expect(await runRecurring(a.ctx)).toBe(0); // not due yet
    a.clock.set(new Date('2026-09-25T12:01:00Z'));
    expect(await runRecurring(a.ctx)).toBe(1);
    expect(await runRecurring(a.ctx)).toBe(0); // never twice

    const [copy] = await a.db.select().from(tasks).where(eq(tasks.repeatedFromId, t.id));
    expect(copy).toMatchObject({ title: 'Haftalik hisobot', recurrence: 'WEEKLY', assigneeUserId: a.users.aziz.id, createdBy: a.users.head.id, number: 2 });
    expect(copy!.deadline.toISOString()).toBe('2026-10-02T12:00:00.000Z');
    const items = await a.db.select().from(taskChecklist).where(eq(taskChecklist.taskId, copy!.id));
    expect(items.map((i) => [i.text, i.done]).sort()).toEqual([['Raqamlar', false], ['Xulosa', false]]);
    expect((await getTask(a.ctx, pm, copy!.id)).recurrence).toBe('WEEKLY');
  });

  it('closing early also brings the next one; switching the repeat off stops the series', async () => {
    const a = await setup();
    const pm = await a.actor(a.users.head.id);
    const t = await createTask(a.ctx, pm, { title: 'Kunlik stories', assigneeUserId: a.users.aziz.id, deadline: new Date('2026-09-21T12:00:00Z'), recurrence: 'DAILY' });
    await actOnTask(a.ctx, pm, t.id, 'CANCEL');
    expect(await runRecurring(a.ctx)).toBe(1);
    const [copy] = await a.db.select().from(tasks).where(eq(tasks.repeatedFromId, t.id));
    expect(copy!.deadline.toISOString()).toBe('2026-09-22T12:00:00.000Z');
    await updateTask(a.ctx, pm, copy!.id, { recurrence: null });
    a.clock.set(new Date('2026-09-23T05:00:00Z'));
    expect(await runRecurring(a.ctx)).toBe(0);
  });

  it('when the assignee has left, the series stops with a note instead of failing every minute', async () => {
    const a = await setup();
    const pm = await a.actor(a.users.head.id);
    const t = await createTask(a.ctx, pm, { title: 'Oylik reja', assigneeUserId: a.users.bekzod.id, deadline: new Date('2026-09-21T12:00:00Z'), recurrence: 'MONTHLY' });
    const { memberships } = await import('../db/schema.js');
    await a.db.update(memberships).set({ status: 'DISABLED' }).where(eq(memberships.userId, a.users.bekzod.id));
    a.clock.set(new Date('2026-09-21T13:00:00Z'));
    expect(await runRecurring(a.ctx)).toBe(0);
    const [after] = await a.db.select().from(tasks).where(eq(tasks.id, t.id));
    expect(after!.recurrence).toBeNull();
    const ev = await a.db.select().from(taskEvents).where(eq(taskEvents.taskId, t.id));
    expect(ev.some((e) => e.action === 'REPEAT_STOPPED')).toBe(true);
  });
});

