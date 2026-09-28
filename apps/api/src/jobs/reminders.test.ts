import { describe, expect, it } from 'vitest';
import { zonedTime } from '@retarget/shared';
import { agency } from '../test/fixtures.js';
import { bindChat, createProject } from '../services/projects.js';
import { actOnTask, createTask } from '../services/tasks.js';
import { runReminders } from './reminders.js';

const tk = (d: number, h: number, mi = 0) => zonedTime(2026, 9, d, h, mi, 'Asia/Tashkent');

describe('reminder worker', () => {
  async function setup() {
    // Wed 23 Sep 10:00; deadline Fri 25 Sep 17:00.
    const a = await agency(tk(23, 10));
    const owner = await a.actor(a.users.ceo.id);
    const project = await createProject(a.ctx, owner, { name: 'Kafe Bahor', managerUserId: a.users.pm.id, memberUserIds: [a.users.aziz.id] });
    await bindChat(a.ctx, owner, project.id, -100500, 'Kafe Bahor — ishchi guruh');
    const pm = await a.actor(a.users.pm.id);
    const task = await createTask(a.ctx, pm, { title: 'Reels montaj', projectId: project.id, assigneeUserId: a.users.aziz.id, deadline: tk(25, 17) });
    return { a, task, pm };
  }

  it('posts the task card in the bound group', async () => {
    const { a } = await setup();
    expect(a.notifier.cards.at(-1)).toMatchObject({ groupChatId: -100500, title: 'Reels montaj' });
  });

  it('walks the whole chain and deletes the previous reminder each time', async () => {
    const { a } = await setup();
    const tick = async (d: number, h: number) => {
      a.clock.set(tk(d, h));
      return runReminders(a.ctx);
    };
    expect(await tick(24, 16)).toEqual({ sent: 0, skipped: 0 });
    expect((await tick(24, 17)).sent).toBe(1); // 24 h before
    expect((await tick(24, 17)).sent).toBe(0); // idempotent
    await tick(25, 15); // 2 h before
    await tick(25, 17); // overdue-1 (in group)
    await tick(26, 11); // overdue-2
    await tick(26, 13); // overdue-3
    await tick(26, 14); // project manager
    await tick(26, 15); // CEO

    const keys = a.notifier.reminders.map((r) => r.step.key);
    expect(keys).toEqual(['before-24h', 'before-2h', 'overdue-1', 'overdue-2', 'overdue-3', 'escalate-manager', 'escalate-ceo']);

    const tgOf = (u: { telegramId: number }) => u.telegramId;
    const byKey = Object.fromEntries(a.notifier.reminders.map((r) => [r.step.key, r]));
    expect(byKey['overdue-1']!.includeGroup).toBe(true);
    expect(byKey['overdue-3']!.privateChatIds).toEqual([tgOf(a.users.aziz)]);
    expect(byKey['escalate-manager']!.privateChatIds).toEqual([tgOf(a.users.pm)]);
    expect(byKey['escalate-ceo']!.privateChatIds).toEqual([tgOf(a.users.ceo)]);
    expect(byKey['before-2h']!.previous).toHaveLength(1);
  });

  it('skips the CEO when the status moved after the manager was told', async () => {
    const { a, task } = await setup();
    a.clock.set(tk(26, 14));
    await runReminders(a.ctx); // manager told (earlier steps skipped as downtime)
    a.clock.set(tk(26, 14, 30));
    const aziz = await a.actor(a.users.aziz.id);
    await actOnTask(a.ctx, aziz, task.id, 'START');
    a.clock.set(tk(26, 15, 30));
    await runReminders(a.ctx);
    expect(a.notifier.reminders.map((r) => r.step.key)).toEqual(['escalate-manager']);
  });

  it('after downtime sends only the latest reminder', async () => {
    const { a } = await setup();
    a.clock.set(tk(26, 12)); // server was down since Wednesday
    await runReminders(a.ctx);
    expect(a.notifier.reminders.map((r) => r.step.key)).toEqual(['overdue-2']);
  });

  it('stops once the work is submitted', async () => {
    const { a, task } = await setup();
    const aziz = await a.actor(a.users.aziz.id);
    await actOnTask(a.ctx, aziz, task.id, 'START');
    await actOnTask(a.ctx, aziz, task.id, 'SUBMIT');
    a.clock.set(tk(26, 15));
    expect((await runReminders(a.ctx)).sent).toBe(0);
  });

});
