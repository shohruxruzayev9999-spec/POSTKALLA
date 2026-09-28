import { describe, expect, it } from 'vitest';
import { agency } from '../test/fixtures.js';
import { createProject } from './projects.js';
import { createShoot, deleteShoot, listShoots, runShootReminders, updateShoot } from './shoots.js';

// Clock starts Mon 21 Sep 2026 10:00 Tashkent.
async function setup() {
  const a = await agency();
  const owner = await a.actor(a.users.ceo.id);
  const project = await createProject(a.ctx, owner, { name: 'Kafe Bahor', managerUserId: a.users.pm.id, memberUserIds: [a.users.videographer.id] });
  const other = await createProject(a.ctx, owner, { name: 'Boshqa' });
  const pm = await a.actor(a.users.pm.id);
  return { a, owner, pm, project, other };
}

describe('shoots (Syomka)', () => {
  it('managers plan shoots; crew gets a DM; everyone sees the calendar', async () => {
    const { a, pm, project } = await setup();
    const { shoot, conflicts } = await createShoot(a.ctx, pm, {
      title: 'Menyu fotosessiyasi',
      projectId: project.id,
      type: 'PHOTO',
      day: '2026-09-23',
      startTime: '14:00',
      endTime: '16:00',
      location: 'Chilonzor',
      crew: [a.users.videographer.id, a.users.aziz.id],
    });
    expect(conflicts).toEqual([]);
    // 14:00 Tashkent = 09:00 UTC
    expect(shoot.startsAt.toISOString()).toBe('2026-09-23T09:00:00.000Z');
    expect(a.notifier.dms.filter((d) => d.text.includes('Yangi syomka'))).toHaveLength(2);

    const emp = await a.actor(a.users.aziz.id);
    const list = await listShoots(a.ctx, emp, { from: '2026-09-21', to: '2026-09-27' });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: 'Menyu fotosessiyasi', project: 'Kafe Bahor', canEdit: false });
    expect(list[0]!.crew.map((c) => c.name).sort()).toEqual(['Aziz', 'Otabek']);
  });

  it('employees cannot plan; a PM only for their own projects', async () => {
    const { a, pm, other } = await setup();
    const emp = await a.actor(a.users.aziz.id);
    const base = { title: 'X', day: '2026-09-23', startTime: '10:00', endTime: '11:00' };
    await expect(createShoot(a.ctx, emp, base)).rejects.toThrow(/Ruxsat/);
    await expect(createShoot(a.ctx, pm, { ...base, projectId: other.id })).rejects.toThrow(/Ruxsat/);
    await expect(createShoot(a.ctx, pm, base)).rejects.toThrow(/Ruxsat/); // no project → company-level
  });

  it('rejects end before start and strangers in the crew', async () => {
    const { a, owner } = await setup();
    await expect(createShoot(a.ctx, owner, { title: 'X', day: '2026-09-23', startTime: '12:00', endTime: '11:00' })).rejects.toThrow();
    await expect(
      createShoot(a.ctx, owner, { title: 'X', day: '2026-09-23', startTime: '10:00', endTime: '11:00', crew: ['00000000-0000-0000-0000-000000000000'] }),
    ).rejects.toThrow(/a'zosi/);
  });

  it('warns about overlapping crew bookings', async () => {
    const { a, owner } = await setup();
    const crew = [a.users.videographer.id];
    await createShoot(a.ctx, owner, { title: 'A', day: '2026-09-24', startTime: '10:00', endTime: '12:00', crew });
    const b = await createShoot(a.ctx, owner, { title: 'B', day: '2026-09-24', startTime: '11:30', endTime: '13:00', crew });
    expect(b.conflicts).toMatchObject([{ userId: a.users.videographer.id, title: 'A' }]);
    const c = await createShoot(a.ctx, owner, { title: 'C', day: '2026-09-24', startTime: '12:00', endTime: '13:00', crew: [a.users.aziz.id] });
    expect(c.conflicts).toEqual([]);
  });

  it('tells the crew about time changes and cancellation', async () => {
    const { a, owner } = await setup();
    const { shoot } = await createShoot(a.ctx, owner, { title: 'Reels', day: '2026-09-24', startTime: '10:00', endTime: '12:00', crew: [a.users.videographer.id] });
    a.notifier.dms.length = 0;
    await updateShoot(a.ctx, owner, shoot.id, { startTime: '15:00', endTime: '17:00', crew: [a.users.videographer.id, a.users.aziz.id] });
    const texts = a.notifier.dms.map((d) => d.text);
    expect(texts.filter((t) => t.includes('vaqti o‘zgardi'))).toHaveLength(1);
    expect(texts.filter((t) => t.includes('qo‘shildingiz'))).toHaveLength(1);
    a.notifier.dms.length = 0;
    await updateShoot(a.ctx, owner, shoot.id, { status: 'CANCELLED' });
    expect(a.notifier.dms.filter((d) => d.text.includes('bekor'))).toHaveLength(2);
    await deleteShoot(a.ctx, owner, shoot.id);
    expect(await listShoots(a.ctx, owner, { from: '2026-09-21', to: '2026-09-27' })).toEqual([]);
  });

  it('reminds the crew the day before and 2 h before, once each', async () => {
    const { a, owner } = await setup();
    await createShoot(a.ctx, owner, { title: 'Podkast', day: '2026-09-24', startTime: '15:00', endTime: '17:00', crew: [a.users.videographer.id] });
    a.notifier.dms.length = 0;
    a.clock.set(new Date('2026-09-23T09:30:00Z')); // Wed 14:30 — 24.5 h before
    expect(await runShootReminders(a.ctx)).toBe(0);
    a.clock.set(new Date('2026-09-23T10:05:00Z')); // Wed 15:05 — inside 24 h
    expect(await runShootReminders(a.ctx)).toBe(1);
    expect(await runShootReminders(a.ctx)).toBe(0);
    expect(a.notifier.dms[0]!.text).toContain('Ertaga syomka');
    a.clock.set(new Date('2026-09-24T08:10:00Z')); // Thu 13:10 — under 2 h
    expect(await runShootReminders(a.ctx)).toBe(1);
    expect(a.notifier.dms[1]!.text).toContain('2 soatdan keyin');
    expect(await runShootReminders(a.ctx)).toBe(0);
  });
});
