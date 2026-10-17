import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { agency } from '../test/fixtures.js';
import { projectMonths, projects, tasks } from '../db/schema.js';
import { runReminders } from '../jobs/reminders.js';
import { editAttendance } from './attendance.js';
import { updateMember } from './org.js';
import { createProject } from './projects.js';
import { createProjectMonth, getProjectMonth, listProjectMonths } from './projectMonths.js';
import { actOnTask, createTask, listTasks } from './tasks.js';

// Fixes from the 5 Oct 2026 audit.
describe('audit fixes', () => {
  async function setup() {
    const a = await agency(new Date('2026-09-29T05:00:00Z'));
    const owner = await a.actor(a.users.ceo.id);
    const project = await createProject(a.ctx, owner, { name: 'Kafe', managerUserId: a.users.pm.id, memberUserIds: [a.users.aziz.id] });
    const pm = await a.actor(a.users.pm.id);
    const aziz = await a.actor(a.users.aziz.id);
    return { a, owner, project, pm, aziz };
  }

  it('a broken Telegram never fails or blocks the task action', async () => {
    const { a, pm, project, aziz } = await setup();
    a.notifier.upsertTaskCard = async () => {
      throw new Error('telegram down');
    };
    a.notifier.taskChanged = async () => {
      throw new Error('telegram down');
    };
    const t = await createTask(a.ctx, pm, { title: 'Post', projectId: project.id, assigneeUserId: a.users.aziz.id, deadline: new Date('2026-09-30T12:00:00Z') });
    expect(await actOnTask(a.ctx, aziz, t.id, 'START')).toMatchObject({ status: 'IN_PROGRESS' });
  });

  it('work planned for a later month stays off the main board and gets no reminders', async () => {
    const { a, pm, project } = await setup();
    await createProjectMonth(a.ctx, pm, project.id, '2026-10');
    const later = await createTask(a.ctx, pm, { title: 'Oktabr', projectId: project.id, plannedMonth: '2026-10', assigneeUserId: a.users.aziz.id, deadline: new Date('2026-09-30T08:00:00Z') });
    for (const q of [{}, { includeClosed: true }, { status: 'NEW' as const }]) {
      expect((await listTasks(a.ctx, pm, q)).map((t) => t.id)).not.toContain(later.id);
    }
    a.clock.set(new Date('2026-09-30T12:00:00Z')); // already past its deadline
    await runReminders(a.ctx);
    expect(a.notifier.reminders.filter((r) => r.card.id === later.id)).toEqual([]);
    expect((await getProjectMonth(a.ctx, pm, project.id, '2026-10')).tasks.map((t) => t.id)).toEqual([later.id]);
  });

  it('a long history of closed tasks never pushes new work off the board', async () => {
    const { a, owner } = await setup();
    const old = new Date('2026-09-20T05:00:00Z');
    const rows = Array.from({ length: 1100 }, (_, i) => ({
      companyId: a.company.id,
      number: 10_000 + i,
      title: `Eski ${i}`,
      status: 'DONE',
      assigneeUserId: a.users.aziz.id,
      createdBy: a.users.ceo.id,
      deadline: new Date('2026-01-01T00:00:00Z'),
      originalDeadline: new Date('2026-01-01T00:00:00Z'),
      completedAt: old,
      updatedAt: old,
    }));
    await a.db.insert(tasks).values(rows);
    const fresh = await createTask(a.ctx, owner, { title: 'Yangi ish', assigneeUserId: a.users.aziz.id, deadline: new Date('2026-12-30T12:00:00Z') });
    const list = await listTasks(a.ctx, owner, { includeClosed: true });
    expect(list.map((t) => t.id)).toContain(fresh.id);
    expect(list.length).toBeLessThanOrEqual(501);
  });

  it('first run files closed history under the month it was finished; an old baseline is repaired', async () => {
    const { a, owner, project } = await setup();
    // A project from before monthly boards: no months yet, tasks without a planned month.
    const [legacy] = await a.db.insert(projects).values({ companyId: a.company.id, name: 'Eski loyiha', managerUserId: a.users.pm.id }).returning();
    const base = { companyId: a.company.id, assigneeUserId: a.users.aziz.id, createdBy: a.users.ceo.id, deadline: new Date('2026-08-10T00:00:00Z'), originalDeadline: new Date('2026-08-10T00:00:00Z') };
    const [aug, open] = await a.db
      .insert(tasks)
      .values([
        { ...base, number: 500, projectId: legacy!.id, title: 'Avgustda tugagan', status: 'DONE', completedAt: new Date('2026-08-12T07:00:00Z'), updatedAt: new Date('2026-08-12T07:00:00Z') },
        { ...base, number: 501, projectId: legacy!.id, title: 'Ochiq', status: 'IN_PROGRESS' },
      ])
      .returning();
    // The bug: a July task was put into the first (September) month, and September was archived with it.
    const [july] = await a.db
      .insert(tasks)
      .values({ ...base, number: 502, projectId: project.id, plannedMonth: '2026-09', title: 'Iyulda tugagan', status: 'DONE', completedAt: new Date('2026-07-05T07:00:00Z'), updatedAt: new Date('2026-07-05T07:00:00Z') })
      .returning();
    await a.db
      .update(projectMonths)
      .set({ archived: true, snapshot: { tasks: [{ ...july!, assignee: { id: a.users.aziz.id, name: 'Aziz', photoUrl: null } }], columns: [] } })
      .where(and(eq(projectMonths.projectId, project.id), eq(projectMonths.month, '2026-09')));

    a.clock.set(new Date('2026-10-02T05:00:00Z'));
    expect((await listProjectMonths(a.ctx, owner, legacy!.id)).map((m) => [m.month, m.archived])).toEqual([['2026-08', true], ['2026-10', false]]);
    expect((await getProjectMonth(a.ctx, owner, legacy!.id, '2026-08')).tasks.map((t) => t.id)).toEqual([aug!.id]);
    expect((await getProjectMonth(a.ctx, owner, legacy!.id, '2026-10')).tasks.map((t) => t.id)).toEqual([open!.id]);

    expect((await listProjectMonths(a.ctx, owner, project.id)).map((m) => [m.month, m.archived])).toEqual([['2026-07', true], ['2026-09', true], ['2026-10', false]]);
    expect((await getProjectMonth(a.ctx, owner, project.id, '2026-07')).tasks.map((t) => t.id)).toEqual([july!.id]);
    expect((await getProjectMonth(a.ctx, owner, project.id, '2026-09')).tasks).toEqual([]);
  });

  it('someone creating their own task cannot pick the reviewer or the points', async () => {
    const { a, aziz } = await setup();
    const t = await createTask(a.ctx, aziz, { title: 'O‘zim', assigneeUserId: a.users.aziz.id, reviewerUserId: a.users.bekzod.id, points: 20, deadline: new Date('2026-10-05T12:00:00Z') });
    expect(t).toMatchObject({ reviewerUserId: a.users.head.id, points: 1 });
    const head = await a.actor(a.users.head.id);
    const byLead = await createTask(a.ctx, head, { title: 'Rahbardan', assigneeUserId: a.users.aziz.id, reviewerUserId: a.users.bekzod.id, points: 5, deadline: new Date('2026-10-05T12:00:00Z') });
    expect(byLead).toMatchObject({ reviewerUserId: a.users.bekzod.id, points: 5 });
  });

  it('HR cannot change the salary or attendance of someone at or above their rank', async () => {
    const { a } = await setup();
    const hr = await a.actor(a.users.hr.id);
    await expect(updateMember(a.ctx, hr, a.users.ceo.id, { salary: 1 })).rejects.toThrow(/yuqori/);
    await expect(updateMember(a.ctx, hr, a.users.admin.id, { salary: 1 })).rejects.toThrow(/yuqori/);
    const day = { day: '2026-09-28', checkIn: new Date('2026-09-28T04:00:00Z'), checkOut: null, note: 'Tuzatish' };
    await expect(editAttendance(a.ctx, hr, { userId: a.users.admin.id, ...day })).rejects.toThrow(/yuqori/);
    expect(await updateMember(a.ctx, hr, a.users.aziz.id, { salary: 5_000_000 })).toMatchObject({ salary: 5_000_000 });
    expect(await editAttendance(a.ctx, hr, { userId: a.users.aziz.id, ...day })).toMatchObject({ userId: a.users.aziz.id });
  });

  it('a private 1:1 task escalates to its giver, never to the project manager', async () => {
    const { a, owner, project } = await setup();
    const t = await createTask(a.ctx, owner, { title: 'Maxfiy', projectId: project.id, isPrivate: true, assigneeUserId: a.users.aziz.id, reviewerUserId: a.users.ceo.id, deadline: new Date('2026-09-29T08:00:00Z') });
    a.clock.set(new Date('2026-10-06T12:00:00Z'));
    await runReminders(a.ctx);
    const mine = a.notifier.reminders.filter((r) => r.card.id === t.id);
    expect(mine.map((r) => r.step.key)).toContain('escalate-manager');
    for (const r of mine) {
      expect(r.privateChatIds).not.toContain(a.users.pm.telegramId);
      expect(r.includeGroup).toBe(false);
    }
  });
});
