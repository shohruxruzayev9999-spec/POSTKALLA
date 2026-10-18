import { describe, expect, it } from 'vitest';
import { agency } from '../test/fixtures.js';
import { createProject } from './projects.js';
import { globalSearch } from './search.js';
import { createTask } from './tasks.js';

describe('global search', () => {
  it('finds tasks by words and #number, projects and people — and hides private 1:1 work', async () => {
    const a = await agency();
    const owner = await a.actor(a.users.ceo.id);
    const head = await a.actor(a.users.head.id);
    const p = await createProject(a.ctx, owner, { name: 'Hadid Light', managerUserId: a.users.pm.id, memberUserIds: [a.users.aziz.id] });
    const due = new Date(a.clock.t.getTime() + 2 * 86_400_000);
    await createTask(a.ctx, head, { title: 'Hadid banner 50% chegirma', projectId: p.id, assigneeUserId: a.users.aziz.id, deadline: due });
    await createTask(a.ctx, head, { title: 'Maxfiy suhbat', description: 'hadid haqida', assigneeUserId: a.users.aziz.id, deadline: due, isPrivate: true });

    const r = await globalSearch(a.ctx, owner, { q: 'hadid' });
    expect(r.tasks.map((t) => t.title).sort()).toEqual(['Hadid banner 50% chegirma', 'Maxfiy suhbat']); // the Owner sees 1:1
    expect(r.projects.map((x) => x.name)).toEqual(['Hadid Light']);

    const bekzod = await a.actor(a.users.bekzod.id);
    expect((await globalSearch(a.ctx, bekzod, { q: 'hadid' })).tasks.map((t) => t.title)).toEqual(['Hadid banner 50% chegirma']);

    expect((await globalSearch(a.ctx, bekzod, { q: '#1' })).tasks[0]).toMatchObject({ number: 1 });
    // "%" is a literal character, not "match anything".
    expect((await globalSearch(a.ctx, owner, { q: '50%' })).tasks).toHaveLength(1);
    expect((await globalSearch(a.ctx, owner, { q: '%' })).tasks).toHaveLength(0);
    expect((await globalSearch(a.ctx, owner, { q: 'Azi' })).members.map((m) => m.name)).toEqual(['Aziz']);
  });
});

describe('task export', () => {
  it('sends a CSV of the tasks the person may see to their Telegram chat', async () => {
    const a = await agency();
    const head = await a.actor(a.users.head.id);
    const due = new Date(a.clock.t.getTime() + 2 * 86_400_000);
    await createTask(a.ctx, head, { title: '=HYPERLINK("x") banner, "katta"', assigneeUserId: a.users.aziz.id, deadline: due, recurrence: 'WEEKLY' });
    await createTask(a.ctx, head, { title: 'Sir', assigneeUserId: a.users.aziz.id, deadline: due, isPrivate: true });
    const { exportTasks } = await import('./tasks.js');
    const bekzod = await a.actor(a.users.bekzod.id);
    const r = await exportTasks(a.ctx, bekzod);
    expect(r.count).toBe(1); // the 1:1 task is not his to see
    const doc = a.notifier.documents.at(-1)!;
    expect(doc).toMatchObject({ telegramId: a.users.bekzod.telegramId, fileName: 'vazifalar-2026-09-21.csv' });
    expect(doc.bytes).toBeGreaterThan(50);
  });
});
