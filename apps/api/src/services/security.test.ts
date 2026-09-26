import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { auditLog, memberships } from '../db/schema.js';
import { agency, makeUser } from '../test/fixtures.js';
import { loadActor } from './context.js';
import { acceptInvitation, createInvitation, listMembers, updateMember } from './org.js';
import { createProject, listProjects } from './projects.js';
import { actOnTask, createTask, getTask, listTasks, updateTask } from './tasks.js';

const in2days = (now: Date) => new Date(now.getTime() + 2 * 86_400_000);

describe('the holes from the old system are closed', () => {
  it('an employee cannot make themself CEO (or anything else)', async () => {
    const a = await agency();
    const aziz = await a.actor(a.users.aziz.id);
    await expect(updateMember(a.ctx, aziz, a.users.aziz.id, { roles: ['OWNER'] })).rejects.toThrow(/Ruxsat/);
    await expect(updateMember(a.ctx, aziz, a.users.bekzod.id, { position: 'CEO' })).rejects.toThrow(/Ruxsat/);
    const [m] = await a.db.select().from(memberships).where(eq(memberships.userId, a.users.aziz.id));
    expect(m!.roles).toEqual(['EMPLOYEE']);
  });

  it('an admin cannot promote themself nor create another admin or owner', async () => {
    const a = await agency();
    const admin = await a.actor(a.users.admin.id);
    await expect(updateMember(a.ctx, admin, a.users.admin.id, { roles: ['OWNER'] })).rejects.toThrow(/O'z/);
    await expect(updateMember(a.ctx, admin, a.users.aziz.id, { roles: ['ADMIN'] })).rejects.toThrow(/yuqori/);
    await expect(createInvitation(a.ctx, admin, { role: 'OWNER' })).rejects.toThrow(/yuqori/);
    // … but can make a PM
    await updateMember(a.ctx, admin, a.users.aziz.id, { roles: ['PM'] });
  });

  it('an admin cannot touch the CEO', async () => {
    const a = await agency();
    const admin = await a.actor(a.users.admin.id);
    await expect(updateMember(a.ctx, admin, a.users.ceo.id, { status: 'DISABLED' })).rejects.toThrow(/yuqori/);
  });

  it('HR sets salaries but not their own', async () => {
    const a = await agency();
    const hr = await a.actor(a.users.hr.id);
    await updateMember(a.ctx, hr, a.users.aziz.id, { salary: 8_000_000 });
    await expect(updateMember(a.ctx, hr, a.users.hr.id, { salary: 99_000_000 })).rejects.toThrow(/O'z/);
    const admin = await a.actor(a.users.admin.id);
    await expect(updateMember(a.ctx, admin, a.users.aziz.id, { salary: 1 })).rejects.toThrow(/Ruxsat/);
  });

  it('salaries are visible only to HR / finance / owner and to the person themself', async () => {
    const a = await agency();
    const hr = await a.actor(a.users.hr.id);
    await updateMember(a.ctx, hr, a.users.aziz.id, { salary: 8_000_000 });
    const seenBy = async (userId: string) => (await listMembers(a.ctx, await a.actor(userId))).find((m) => m.userId === a.users.aziz.id)!.salary;
    expect(await seenBy(a.users.ceo.id)).toBe(8_000_000);
    expect(await seenBy(a.users.aziz.id)).toBe(8_000_000);
    expect(await seenBy(a.users.bekzod.id)).toBeUndefined();
    expect(await seenBy(a.users.admin.id)).toBeUndefined();
    expect(await seenBy(a.users.head.id)).toBeUndefined();
  });

  it('the last owner cannot be demoted', async () => {
    const a = await agency();
    const owner = await a.actor(a.users.ceo.id);
    const second = await makeUser(a.db, 'Co-founder');
    const inv = await createInvitation(a.ctx, owner, { role: 'OWNER' });
    await acceptInvitation(a.ctx, second.id, inv.token);
    const co = await a.actor(second.id);
    await updateMember(a.ctx, co, a.users.ceo.id, { roles: ['ADMIN'] }); // two owners → fine
    const ceoNow = await a.actor(a.users.ceo.id);
    await expect(updateMember(a.ctx, ceoNow, second.id, { roles: ['ADMIN'] })).rejects.toThrow(/yuqori/);
    const [{ n }] = (await a.db.select({ n: memberships.id }).from(memberships).where(eq(memberships.userId, second.id))) as [{ n: string }];
    expect(n).toBeTruthy();
  });

  it('a department head invites only employees, only into their department', async () => {
    const a = await agency();
    const head = await a.actor(a.users.head.id);
    await createInvitation(a.ctx, head, { role: 'EMPLOYEE', departmentId: a.design.id });
    await expect(createInvitation(a.ctx, head, { role: 'PM', departmentId: a.design.id })).rejects.toThrow();
    await expect(createInvitation(a.ctx, head, { role: 'EMPLOYEE', departmentId: a.video.id })).rejects.toThrow(/Ruxsat/);
  });

  it('an invitation is single-use and expires', async () => {
    const a = await agency();
    const owner = await a.actor(a.users.ceo.id);
    const inv = await createInvitation(a.ctx, owner, { role: 'EMPLOYEE', days: 1 });
    const u1 = await makeUser(a.db, 'U1');
    const u2 = await makeUser(a.db, 'U2');
    await acceptInvitation(a.ctx, u1.id, inv.token);
    await expect(acceptInvitation(a.ctx, u2.id, inv.token)).rejects.toThrow(/muddati/);
    const inv2 = await createInvitation(a.ctx, owner, { role: 'EMPLOYEE', days: 1 });
    a.clock.set(new Date(a.clock.t.getTime() + 2 * 86_400_000));
    await expect(acceptInvitation(a.ctx, u2.id, inv2.token)).rejects.toThrow(/muddati/);
  });

  it('companies are isolated', async () => {
    const a = await agency();
    const b = await agency();
    await expect(loadActor(a.db, b.users.ceo.id, a.company.id)).rejects.toThrow(/a'zosi emas/);
    const owner = await a.actor(a.users.ceo.id);
    // Assigning a task to a stranger from another company is refused.
    await expect(
      createTask(a.ctx, owner, { title: 'Begona', assigneeUserId: b.users.aziz.id, deadline: in2days(a.clock.t) }),
    ).rejects.toThrow(/a'zosi emas/);
  });

  it('every sensitive change is audited', async () => {
    const a = await agency();
    const hr = await a.actor(a.users.hr.id);
    await updateMember(a.ctx, hr, a.users.aziz.id, { salary: 7_000_000 });
    const rows = await a.db.select().from(auditLog).where(eq(auditLog.action, 'member.update'));
    expect(rows.at(-1)!.data).toMatchObject({ targetUserId: a.users.aziz.id, salary: 'changed' });
    expect(JSON.stringify(rows.at(-1)!.data)).not.toContain('7000000');
  });
});

describe('tasks', () => {
  async function setup() {
    const a = await agency();
    const owner = await a.actor(a.users.ceo.id);
    const project = await createProject(a.ctx, owner, {
      name: 'Kafe Bahor',
      clientName: 'Bahor MChJ',
      managerUserId: a.users.pm.id,
      memberUserIds: [a.users.aziz.id, a.users.head.id],
    });
    const pm = await a.actor(a.users.pm.id);
    const task = await createTask(a.ctx, pm, {
      title: 'Banner 1080x1080',
      projectId: project.id,
      assigneeUserId: a.users.aziz.id,
      deadline: in2days(a.clock.t),
      priority: 'HIGH',
    });
    return { a, project, task, pm };
  }

  it('numbers tasks per company and defaults the reviewer to the PM', async () => {
    const { task, a } = await setup();
    expect(task.number).toBe(1);
    expect(task.reviewerUserId).toBe(a.users.pm.id);
    expect(task.departmentId).toBe(a.design.id);
  });

  it('full cycle with a return: R1 → R2 → done', async () => {
    const { a, task, pm } = await setup();
    const aziz = await a.actor(a.users.aziz.id);
    await actOnTask(a.ctx, aziz, task.id, 'START');
    await actOnTask(a.ctx, aziz, task.id, 'SUBMIT');
    await expect(actOnTask(a.ctx, aziz, task.id, 'APPROVE')).rejects.toThrow(/ruxsat/);
    const r = await actOnTask(a.ctx, pm, task.id, 'RETURN', 'Logotip kichik');
    expect(r.revision).toBe(2);
    await actOnTask(a.ctx, aziz, task.id, 'START');
    await actOnTask(a.ctx, aziz, task.id, 'SUBMIT');
    const done = await actOnTask(a.ctx, pm, task.id, 'APPROVE');
    expect(done.status).toBe('DONE');
    expect(done.completedAt).toEqual(a.clock.t);
    const full = await getTask(a.ctx, pm, task.id);
    expect(full.events.map((e) => e.action)).toEqual(['APPROVE', 'SUBMIT', 'START', 'RETURN', 'SUBMIT', 'START', 'CREATE']);
    expect(a.notifier.changes.map((c) => c.action)).toContain('RETURN');
  });

  it('a colleague cannot press buttons on someone else’s task', async () => {
    const { a, task } = await setup();
    const bekzod = await a.actor(a.users.bekzod.id);
    // Same department → can see it on the board …
    expect((await listTasks(a.ctx, bekzod)).map((t) => t.id)).toContain(task.id);
    // … but cannot act on it.
    await expect(actOnTask(a.ctx, bekzod, task.id, 'START')).rejects.toThrow(/ruxsat/);
  });

  it('someone from another department cannot even see it', async () => {
    const { a, task } = await setup();
    const otabek = await a.actor(a.users.videographer.id);
    expect(await listTasks(a.ctx, otabek)).toEqual([]);
    await expect(getTask(a.ctx, otabek, task.id)).rejects.toThrow(/topilmadi/);
  });

  it('the assignee cannot move their own deadline; a manager can, with a reason, and the original stays', async () => {
    const { a, task, pm } = await setup();
    const aziz = await a.actor(a.users.aziz.id);
    await expect(updateTask(a.ctx, aziz, task.id, { deadline: in2days(task.deadline) })).rejects.toThrow(/ruxsat/);
    await expect(updateTask(a.ctx, pm, task.id, { deadline: in2days(task.deadline) })).rejects.toThrow(/sababini/);
    const u = await updateTask(a.ctx, pm, task.id, { deadline: in2days(task.deadline), reason: 'Mijoz kechikdi' });
    expect(u.deadline).toEqual(in2days(task.deadline));
    expect(u.originalDeadline).toEqual(task.deadline);
  });

  it('employees create tasks only for themselves', async () => {
    const { a } = await setup();
    const aziz = await a.actor(a.users.aziz.id);
    await createTask(a.ctx, aziz, { title: 'O‘zim uchun', assigneeUserId: a.users.aziz.id, deadline: in2days(a.clock.t) });
    await expect(createTask(a.ctx, aziz, { title: 'Bekzodga', assigneeUserId: a.users.bekzod.id, deadline: in2days(a.clock.t) })).rejects.toThrow(/Ruxsat/);
  });

  it('a PM sees only their projects', async () => {
    const { a, project } = await setup();
    const owner = await a.actor(a.users.ceo.id);
    await createProject(a.ctx, owner, { name: 'Boshqa loyiha', managerUserId: a.users.ceo.id });
    const pm = await a.actor(a.users.pm.id);
    expect((await listProjects(a.ctx, pm)).map((p) => p.id)).toEqual([project.id]);
    expect((await listProjects(a.ctx, owner)).length).toBe(2);
  });
});
