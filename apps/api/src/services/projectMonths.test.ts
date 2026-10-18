import { describe, expect, it } from 'vitest';
import { agency } from '../test/fixtures.js';
import { createProject, updateProject } from './projects.js';
import { createTask, actOnTask, updateTask } from './tasks.js';
import { createProjectMonth, deleteProjectMonth, getProjectMonth, listProjectMonths, runProjectMonths } from './projectMonths.js';

async function setup() {
  const a = await agency(new Date('2026-09-29T05:00:00Z'));
  const owner = await a.actor(a.users.ceo.id);
  const project = await createProject(a.ctx, owner, { name: 'Oylik loyiha', managerUserId: a.users.pm.id, memberUserIds: [a.users.aziz.id] });
  const pm = await a.actor(a.users.pm.id);
  const employee = await a.actor(a.users.aziz.id);
  const task = await createTask(a.ctx, pm, { title: 'Sentabr vazifasi', projectId: project.id, assigneeUserId: a.users.aziz.id, deadline: new Date('2026-09-30T12:00:00Z') });
  return { a, owner, project, pm, employee, task };
}

describe('project monthly kanban', () => {
 it('freezes the previous month before a post-midnight edit, carries once and preserves the deadline', async () => {
  const { a, pm, project, task, employee } = await setup();
  await actOnTask(a.ctx, employee, task.id, 'START');
  await createProjectMonth(a.ctx, pm, project.id, '2026-10');
  const future = await createTask(a.ctx, pm, { title: 'Oktabr rejasi', projectId: project.id, plannedMonth: '2026-10', assigneeUserId: a.users.aziz.id, deadline: new Date('2026-10-05T12:00:00Z') });
  expect((await getProjectMonth(a.ctx, pm, project.id, '2026-09')).tasks).toHaveLength(1);
  a.clock.set(new Date('2026-09-30T19:00:01Z'));
  await updateTask(a.ctx, pm, task.id, { title: 'Yangi nom' });
  const old = await getProjectMonth(a.ctx, pm, project.id, '2026-09');
  expect(old.archived).toBe(true);
  expect(old.tasks[0]).toMatchObject({ title: 'Sentabr vazifasi', status: 'IN_PROGRESS', overdue: true });
  await runProjectMonths(a.ctx);
  await runProjectMonths(a.ctx);
  const current = await getProjectMonth(a.ctx, pm, project.id, '2026-10');
  expect(current.tasks.map(t => t.id).sort()).toEqual([task.id, future.id].sort());
  expect(current.tasks.find(t => t.id === task.id)).toMatchObject({ title: 'Yangi nom', deadline: task.deadline });
 });
 it('keeps completed work in the archive and catches up after a two-month outage', async () => {
  const { a, pm, project, employee, task } = await setup();
  const done = await createTask(a.ctx, pm, { title: 'Bajarilgan ish', projectId: project.id, assigneeUserId: a.users.aziz.id, deadline: new Date('2026-09-30T12:00:00Z') });
  await actOnTask(a.ctx, employee, done.id, 'START');
  await actOnTask(a.ctx, employee, done.id, 'SUBMIT');
  await actOnTask(a.ctx, pm, done.id, 'APPROVE');
  a.clock.set(new Date('2026-11-01T05:00:00Z'));
  expect((await listProjectMonths(a.ctx, pm, project.id)).map(m => [m.month, m.archived])).toEqual([['2026-09', true], ['2026-10', true], ['2026-11', false]]);
  expect((await getProjectMonth(a.ctx, pm, project.id, '2026-09')).tasks).toHaveLength(2);
  expect((await getProjectMonth(a.ctx, pm, project.id, '2026-11')).tasks.map(t => t.id)).toEqual([task.id]);
 });
 it('rolls December into January and puts reopened archived work into the current month', async () => {
  const { a, pm, project, employee, task } = await setup();
  await actOnTask(a.ctx, employee, task.id, 'START');
  await actOnTask(a.ctx, employee, task.id, 'SUBMIT');
  await actOnTask(a.ctx, pm, task.id, 'APPROVE');
  a.clock.set(new Date('2027-01-01T05:00:00Z'));
  await runProjectMonths(a.ctx);
  expect((await getProjectMonth(a.ctx, pm, project.id, '2027-01')).tasks).toHaveLength(0);
  await actOnTask(a.ctx, pm, task.id, 'REOPEN');
  expect((await getProjectMonth(a.ctx, pm, project.id, '2027-01')).tasks.map(t => t.id)).toEqual([task.id]);
  expect((await getProjectMonth(a.ctx, pm, project.id, '2026-09')).tasks[0]).toMatchObject({ status: 'DONE' });
 });
 it('protects private tasks, month management, archive deletion, and other tenants', async () => {
  const { a, pm, owner, project, employee, task } = await setup();
  await createTask(a.ctx, owner, { title: 'Maxfiy ish', projectId: project.id, isPrivate: true, assigneeUserId: a.users.bekzod.id, reviewerUserId: a.users.ceo.id, deadline: new Date('2026-10-02T12:00:00Z') });
  expect((await getProjectMonth(a.ctx, employee, project.id, '2026-09')).tasks.map(t => t.id)).toEqual([task.id]);
  await expect(createProjectMonth(a.ctx, employee, project.id, '2026-10')).rejects.toThrow(/Faqat/);
  await expect(getProjectMonth(a.ctx, { ...owner, companyId: crypto.randomUUID() }, project.id, '2026-09')).rejects.toThrow(/topilmadi/);
  a.clock.set(new Date('2026-10-01T05:00:00Z'));
  await expect(deleteProjectMonth(a.ctx, pm, project.id, '2026-09')).rejects.toThrow(/admin/);
  await deleteProjectMonth(a.ctx, owner, project.id, '2026-09');
  await runProjectMonths(a.ctx);
  expect((await listProjectMonths(a.ctx, owner, project.id)).map(m => m.month)).toEqual(['2026-10']);
  expect((await getProjectMonth(a.ctx, owner, project.id, '2026-10')).tasks).toHaveLength(2);
 });
 it('lets the manager edit the project, but only the company level re-assigns its manager', async () => {
  const { a, pm, owner, project, employee } = await setup();
  await expect(updateProject(a.ctx, employee, project.id, { name: 'No' })).rejects.toThrow(/Ruxsat/);
  expect(await updateProject(a.ctx, pm, project.id, { name: 'Yangi nom' })).toMatchObject({ name: 'Yangi nom' });
  await expect(updateProject(a.ctx, pm, project.id, { managerUserId: a.users.admin.id })).rejects.toThrow(/Ruxsat/);
  await expect(updateProject(a.ctx, pm, project.id, { managerUserId: null })).rejects.toThrow(/Ruxsat/);
  await expect(updateProject(a.ctx, owner, project.id, { managerUserId: crypto.randomUUID() })).rejects.toThrow(/a.zosi/);
  expect(await updateProject(a.ctx, owner, project.id, { managerUserId: a.users.admin.id })).toMatchObject({ managerUserId: a.users.admin.id });
 });
});
