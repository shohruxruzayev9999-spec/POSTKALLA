import { describe, expect, it } from 'vitest';
import { agency } from '../test/fixtures.js';
import { addChecklistItem, addComment, createColumn, deleteColumn, listColumns, moveTask, updateChecklistItem } from './boards.js';
import { createProject } from './projects.js';
import { createTask, getTask, listTasks } from './tasks.js';

const in2days = (now: Date) => new Date(now.getTime() + 2 * 86_400_000);

async function setup() {
  const a = await agency();
  const owner = await a.actor(a.users.ceo.id);
  const project = await createProject(a.ctx, owner, { name: 'Reels', managerUserId: a.users.pm.id, memberUserIds: [a.users.videographer.id, a.users.aziz.id] });
  const pm = await a.actor(a.users.pm.id);
  const task = await createTask(a.ctx, pm, { title: 'Reels montaj', projectId: project.id, assigneeUserId: a.users.videographer.id, deadline: in2days(a.clock.t), format: 'Reels', platform: 'Instagram' });
  return { a, pm, task, owner };
}

describe('boards', () => {
  it('seeds default columns per board', async () => {
    const { a, pm } = await setup();
    expect((await listColumns(a.ctx, pm, 'main')).map((c) => c.name)).toEqual(['Yangi', 'Jarayonda', 'Qaytarilgan', 'Tekshiruvda', 'Bloklangan', 'Bajarildi']);
    expect((await listColumns(a.ctx, pm, 'MEDIA')).map((c) => c.name)).toContain('Montajda');
  });

  it('only managers edit columns; the last column of a status cannot be deleted', async () => {
    const { a, pm } = await setup();
    const emp = await a.actor(a.users.aziz.id);
    await expect(createColumn(a.ctx, emp, 'main', { name: 'Ssenariy', status: 'IN_PROGRESS' })).rejects.toThrow(/rahbarlar/);
    const col = await createColumn(a.ctx, pm, 'main', { name: 'Ssenariy', status: 'IN_PROGRESS' });
    const cols = await listColumns(a.ctx, pm, 'main');
    expect(cols.map((c) => c.name)).toEqual(['Yangi', 'Jarayonda', 'Ssenariy', 'Qaytarilgan', 'Tekshiruvda', 'Bloklangan', 'Bajarildi']);
    const done = cols.find((c) => c.status === 'DONE')!;
    await expect(deleteColumn(a.ctx, pm, done.id)).rejects.toThrow(/yagona/);
    await deleteColumn(a.ctx, pm, col.id);
  });

  it('dragging across statuses obeys the same rules as the buttons', async () => {
    const { a, pm, task } = await setup();
    const otabek = await a.actor(a.users.videographer.id);
    const cols = await listColumns(a.ctx, pm, 'MEDIA');
    const by = (n: string) => cols.find((c) => c.name === n)!;
    expect((await moveTask(a.ctx, otabek, task.id, by('Jarayonda').id)).status).toBe('IN_PROGRESS');
    const m = await moveTask(a.ctx, otabek, task.id, by('Montajda').id); // same status, just placement
    expect(m).toMatchObject({ status: 'IN_PROGRESS', columnId: by('Montajda').id });
    await moveTask(a.ctx, otabek, task.id, by("Ko'rib chiqilmoqda").id);
    await expect(moveTask(a.ctx, otabek, task.id, by('Bajarildi').id)).rejects.toThrow(/ruxsat/);
    await expect(moveTask(a.ctx, pm, task.id, by('Qayta ishlash').id)).rejects.toThrow(/Izoh/);
    const r = await moveTask(a.ctx, pm, task.id, by('Qayta ishlash').id, 'Musiqa baland');
    expect(r).toMatchObject({ status: 'RETURNED', revision: 2 });
  });

  it('a stranger cannot drag someone else\'s card', async () => {
    const { a, pm, task } = await setup();
    const aziz = await a.actor(a.users.aziz.id);
    const cols = await listColumns(a.ctx, pm, 'main');
    await expect(moveTask(a.ctx, aziz, task.id, cols[1]!.id)).rejects.toThrow(/ruxsat/);
  });

  it('comments notify the people in the task; checklist is for the people working on it', async () => {
    const { a, pm, task } = await setup();
    await addComment(a.ctx, pm, task.id, 'Musiqani almashtiring');
    expect(a.notifier.dms.some((d) => d.telegramId === a.users.videographer.telegramId && d.text.includes('Musiqani'))).toBe(true);
    const otabek = await a.actor(a.users.videographer.id);
    const item = await addChecklistItem(a.ctx, otabek, task.id, 'Subtitr');
    await updateChecklistItem(a.ctx, otabek, task.id, item.id, { done: true });
    const aziz = await a.actor(a.users.aziz.id);
    await expect(addChecklistItem(a.ctx, aziz, task.id, 'x')).rejects.toThrow(/ruxsat/);
    const full = await getTask(a.ctx, pm, task.id);
    expect(full.comments).toHaveLength(1);
    expect(full.checklist).toMatchObject([{ text: 'Subtitr', done: true }]);
    const list = await listTasks(a.ctx, pm);
    expect(list.find((t) => t.id === task.id)).toMatchObject({ checklistDone: 1, checklistTotal: 1, comments: 1, format: 'Reels' });
  });

  it('filters a department board by section', async () => {
    const { a, pm, task } = await setup();
    expect((await listTasks(a.ctx, pm, { section: 'MEDIA' })).map((t) => t.id)).toEqual([task.id]);
    expect(await listTasks(a.ctx, pm, { section: 'DESIGN' })).toEqual([]);
  });
});
