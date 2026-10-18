import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { joinRequests, memberships } from '../db/schema.js';
import { agency, makeUser } from '../test/fixtures.js';
import { approveJoin, claimableCompanies, listGroups, listJoinRequests, myJoinStatus, registerGroup, rejectJoin, requestJoin, updateGroup } from './join.js';
import { listMembers, updateMember } from './org.js';
import { createProject, listProjects } from './projects.js';
import { createTask, listTasks } from './tasks.js';

const in2days = (now: Date) => new Date(now.getTime() + 2 * 86_400_000);

describe('joining through a Telegram group', () => {
  it('a leader claims the group, a newcomer presses the button, the CEO approves', async () => {
    const a = await agency();
    const g = await registerGroup(a.ctx, a.users.ceo.id, a.company.id, -100, 'Menejerlar');
    expect(g.kind).toBe('TEAM');

    const davron = await makeUser(a.db, 'Davron');
    const r = await requestJoin(a.ctx, davron.id, -100);
    expect(r).toMatchObject({ status: 'PENDING', isNew: true });
    // Pressing again does not create a second request.
    expect(await requestJoin(a.ctx, davron.id, -100)).toMatchObject({ status: 'PENDING', isNew: false });
    expect(await myJoinStatus(a.db, davron.id)).toEqual([{ status: 'PENDING', company: 'Test Agency', group: 'Menejerlar' }]);
    // Approvers got a DM; not the newcomer, not plain employees.
    expect(a.notifier.dms.some((d) => d.telegramId === a.users.ceo.telegramId)).toBe(true);
    expect(a.notifier.dms.some((d) => d.telegramId === a.users.aziz.telegramId)).toBe(false);

    const owner = await a.actor(a.users.ceo.id);
    const pending = await listJoinRequests(a.ctx, owner);
    expect(pending.map((p) => p.name)).toEqual(['Davron']);
    await approveJoin(a.ctx, owner, pending[0]!.id, { departmentId: a.video.id });
    const [m] = await a.db.select().from(memberships).where(and(eq(memberships.userId, davron.id), eq(memberships.companyId, a.company.id)));
    expect(m).toMatchObject({ status: 'ACTIVE', roles: ['EMPLOYEE'], departmentId: a.video.id });
    expect(await requestJoin(a.ctx, davron.id, -100)).toEqual({ status: 'MEMBER' });
    expect(await listJoinRequests(a.ctx, owner)).toEqual([]);
  });

  it('a plain employee cannot claim a group nor approve', async () => {
    const a = await agency();
    expect(await claimableCompanies(a.db, a.users.aziz.id)).toEqual([]);
    await expect(registerGroup(a.ctx, a.users.aziz.id, a.company.id, -101, 'X')).rejects.toThrow(/rahbari/);
    await registerGroup(a.ctx, a.users.ceo.id, a.company.id, -101, 'X');
    const u = await makeUser(a.db, 'Yangi');
    const r = await requestJoin(a.ctx, u.id, -101);
    const aziz = await a.actor(a.users.aziz.id);
    expect(await listJoinRequests(a.ctx, aziz)).toEqual([]);
    await expect(approveJoin(a.ctx, aziz, (r as { requestId: string }).requestId, {})).rejects.toThrow(/Ruxsat/);
  });

  it('a department head claims a group for their department and approves only there', async () => {
    const a = await agency();
    const g = await registerGroup(a.ctx, a.users.head.id, a.company.id, -102, 'Dizayn bo‘limi');
    expect(g.departmentId).toBe(a.design.id);
    const u = await makeUser(a.db, 'Dizayner');
    const r = (await requestJoin(a.ctx, u.id, -102)) as { requestId: string };
    const head = await a.actor(a.users.head.id);
    await expect(approveJoin(a.ctx, head, r.requestId, { departmentId: a.video.id })).rejects.toThrow(/Ruxsat/);
    await expect(approveJoin(a.ctx, head, r.requestId, { role: 'PM' })).rejects.toThrow(/Hodim/);
    await approveJoin(a.ctx, head, r.requestId, {});
    const [m] = await a.db.select().from(memberships).where(eq(memberships.userId, u.id));
    expect(m!.departmentId).toBe(a.design.id);
  });

  it('client groups never bring people in; switching to client closes waiting requests', async () => {
    const a = await agency();
    const owner = await a.actor(a.users.ceo.id);
    const g = await registerGroup(a.ctx, a.users.ceo.id, a.company.id, -103, 'WD-40 × Retarget');
    const u = await makeUser(a.db, 'Mijoz');
    await requestJoin(a.ctx, u.id, -103);
    await updateGroup(a.ctx, owner, g.id, { kind: 'CLIENT' });
    const [jr] = await a.db.select().from(joinRequests).where(eq(joinRequests.userId, u.id));
    expect(jr!.status).toBe('REJECTED');
    await expect(requestJoin(a.ctx, u.id, -103)).rejects.toThrow(/mijoz/);
    expect((await listGroups(a.ctx, owner))[0]).toMatchObject({ kind: 'CLIENT', title: 'WD-40 × Retarget' });
  });

  it('a disabled member cannot rejoin through the button; a rejected one can ask again', async () => {
    const a = await agency();
    const owner = await a.actor(a.users.ceo.id);
    await registerGroup(a.ctx, a.users.ceo.id, a.company.id, -104, 'Jamoa');
    await updateMember(a.ctx, owner, a.users.bekzod.id, { status: 'DISABLED' });
    await expect(requestJoin(a.ctx, a.users.bekzod.id, -104)).rejects.toThrow(/yopilgan/);

    const u = await makeUser(a.db, 'Qayta');
    const r = (await requestJoin(a.ctx, u.id, -104)) as { requestId: string };
    await rejectJoin(a.ctx, owner, r.requestId);
    expect(await requestJoin(a.ctx, u.id, -104)).toMatchObject({ status: 'PENDING', isNew: true });
  });

  it('nobody approves their own request', async () => {
    const a = await agency();
    const other = await makeUser(a.db, 'Boshqa');
    const { createCompany } = await import('./org.js');
    const c2 = await createCompany(a.ctx, other.id, { name: 'Ikkinchi', departments: [] });
    await registerGroup(a.ctx, other.id, c2.id, -105, 'G');
    // The CEO of company 1 asks to join company 2 and cannot approve it with company 1 rights.
    const r = (await requestJoin(a.ctx, a.users.ceo.id, -105)) as { requestId: string };
    const owner = await a.actor(a.users.ceo.id);
    await expect(approveJoin(a.ctx, owner, r.requestId, {})).rejects.toThrow(/topilmadi/);
  });
});

describe('per-member switches', () => {
  it('a manager turns off task creation, gives task-giving, limits projects to own', async () => {
    const a = await agency();
    const owner = await a.actor(a.users.ceo.id);
    const mine = await createProject(a.ctx, owner, { name: 'Mening', managerUserId: a.users.pm.id, memberUserIds: [a.users.aziz.id] });
    const other = await createProject(a.ctx, owner, { name: 'Boshqa', managerUserId: a.users.pm.id, memberUserIds: [a.users.bekzod.id] });
    await createTask(a.ctx, owner, { title: 'Boshqa loyiha', projectId: other.id, assigneeUserId: a.users.bekzod.id, deadline: in2days(a.clock.t) });

    // Defaults: aziz creates for himself, cannot give to others, sees all projects.
    let aziz = await a.actor(a.users.aziz.id);
    await createTask(a.ctx, aziz, { title: 'O‘zimga', assigneeUserId: a.users.aziz.id, deadline: in2days(a.clock.t) });
    await expect(createTask(a.ctx, aziz, { title: 'Bekzodga', assigneeUserId: a.users.bekzod.id, deadline: in2days(a.clock.t) })).rejects.toThrow(/berish/);
    expect((await listProjects(a.ctx, aziz)).map((p) => p.name).sort()).toEqual(['Boshqa', 'Mening']);

    // Nobody switches their own.
    await expect(updateMember(a.ctx, aziz, a.users.aziz.id, { perms: { assignTasks: true } })).rejects.toThrow();

    await updateMember(a.ctx, owner, a.users.aziz.id, { perms: { createTasks: false, assignTasks: true, projectsView: 'OWN' } });
    aziz = await a.actor(a.users.aziz.id);
    await expect(createTask(a.ctx, aziz, { title: 'O‘zimga 2', assigneeUserId: a.users.aziz.id, deadline: in2days(a.clock.t) })).rejects.toThrow(/yaratish/);
    await createTask(a.ctx, aziz, { title: 'Bekzodga', assigneeUserId: a.users.bekzod.id, deadline: in2days(a.clock.t) });
    expect((await listProjects(a.ctx, aziz)).map((p) => p.name)).toEqual(['Mening']);
    expect((await listTasks(a.ctx, aziz, {})).map((t) => t.title)).not.toContain('Boshqa loyiha');
    void mine;

    const m = (await listMembers(a.ctx, owner)).find((x) => x.userId === a.users.aziz.id)!;
    expect(m.effectivePerms).toEqual({ createTasks: false, assignTasks: true, projectsView: 'OWN' });

    // null resets to the role default.
    await updateMember(a.ctx, owner, a.users.aziz.id, { perms: { createTasks: null, projectsView: null } });
    const m2 = (await listMembers(a.ctx, owner)).find((x) => x.userId === a.users.aziz.id)!;
    expect(m2.perms).toEqual({ assignTasks: true });
  });
});

describe('review fixes', () => {
  it('assignTasks=false also blocks re-assigning an existing task', async () => {
    const a = await agency();
    const owner = await a.actor(a.users.ceo.id);
    const t = await createTask(a.ctx, owner, { title: 'Bannerlar', assigneeUserId: a.users.aziz.id, deadline: in2days(a.clock.t) });
    await updateMember(a.ctx, owner, a.users.head.id, { perms: { assignTasks: false } });
    const head = await a.actor(a.users.head.id);
    const { updateTask } = await import('./tasks.js');
    await expect(updateTask(a.ctx, head, t.id, { assigneeUserId: a.users.bekzod.id })).rejects.toThrow(/berish/);
  });

  it('a request can be decided only once', async () => {
    const a = await agency();
    const owner = await a.actor(a.users.ceo.id);
    const admin = await a.actor(a.users.admin.id);
    await registerGroup(a.ctx, a.users.ceo.id, a.company.id, -110, 'Jamoa');
    const u = await makeUser(a.db, 'Ikki');
    const r = (await requestJoin(a.ctx, u.id, -110)) as { requestId: string };
    const results = await Promise.allSettled([approveJoin(a.ctx, owner, r.requestId, {}), rejectJoin(a.ctx, admin, r.requestId)]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const [jr] = await a.db.select().from(joinRequests).where(eq(joinRequests.userId, u.id));
    const [m] = await a.db.select().from(memberships).where(eq(memberships.userId, u.id));
    expect(jr!.status === 'APPROVED').toBe(!!m);
  });

  it('"only my projects" hides other shoots, the company report and the digest', async () => {
    const a = await agency();
    const owner = await a.actor(a.users.ceo.id);
    const mine = await createProject(a.ctx, owner, { name: 'Mening', managerUserId: a.users.pm.id, memberUserIds: [a.users.aziz.id] });
    const other = await createProject(a.ctx, owner, { name: 'Boshqa', managerUserId: a.users.pm.id });
    const { createShoot, listShoots } = await import('./shoots.js');
    const day = '2026-09-23';
    await createShoot(a.ctx, owner, { title: 'Meniki', projectId: mine.id, day, startTime: '10:00', endTime: '11:00', crew: [] });
    await createShoot(a.ctx, owner, { title: 'Begona', projectId: other.id, day, startTime: '12:00', endTime: '13:00', crew: [] });
    await updateMember(a.ctx, owner, a.users.pm.id, { perms: { projectsView: 'OWN' } });
    await updateMember(a.ctx, owner, a.users.aziz.id, { perms: { projectsView: 'OWN' } });
    const aziz = await a.actor(a.users.aziz.id);
    expect((await listShoots(a.ctx, aziz, { from: day, to: day })).map((s) => s.title)).toEqual(['Meniki']);
    const pm = await a.actor(a.users.pm.id);
    const { buildReport } = await import('./reports.js');
    await expect(buildReport(a.ctx, pm, { from: '2026-09-01', to: '2026-09-30' } as never)).rejects.toThrow(/Ruxsat/);
    const { canSeeDigest } = await import('./digest.js');
    expect(canSeeDigest(pm)).toBe(false);
    expect(canSeeDigest(owner)).toBe(true);
  });
});

describe('home alerts', () => {
  it('shows escalated tasks and my live reminders, within task visibility', async () => {
    const a = await agency();
    const owner = await a.actor(a.users.ceo.id);
    const t = await createTask(a.ctx, owner, { title: 'Kech qolgan', assigneeUserId: a.users.aziz.id, deadline: in2days(a.clock.t) });
    const { reminderLog, reminderMessages, tasks } = await import('../db/schema.js');
    const [row] = await a.db.select().from(tasks).where(eq(tasks.id, t.id));
    await a.db.insert(reminderLog).values({ taskId: t.id, stepKey: 'escalate-ceo', deadline: row!.deadline, sent: true });
    await a.db.insert(reminderMessages).values({ taskId: t.id, chatId: a.users.aziz.telegramId, messageId: 1 });
    const { homeAlerts } = await import('./analytics.js');
    const o = await homeAlerts(a.ctx, owner);
    expect(o.escalations.map((x) => [x.title, x.level])).toEqual([['Kech qolgan', 'CEO']]);
    expect(o.reminders).toEqual([]);
    const aziz = await a.actor(a.users.aziz.id);
    expect((await homeAlerts(a.ctx, aziz)).reminders.map((x) => x.title)).toEqual(['Kech qolgan']);
  });
});
