import { describe, expect, it } from 'vitest';
import { agency } from '../test/fixtures.js';
import { acknowledge, createDoc, createStarterKit, getDoc, listDocs, updateDoc } from './onboarding.js';

describe('onboarding', () => {
  it('HR writes, everyone reads published docs, drafts stay hidden', async () => {
    const a = await agency();
    const hr = await a.actor(a.users.hr.id);
    const emp = await a.actor(a.users.aziz.id);
    await expect(createDoc(a.ctx, emp, { title: 'X' })).rejects.toThrow(/Ruxsat/);
    const draft = await createDoc(a.ctx, hr, { title: 'Qoralama', blocks: [{ type: 'text', text: 'Salom' }] });
    expect(await listDocs(a.ctx, emp)).toEqual([]);
    await expect(getDoc(a.ctx, emp, draft.id)).rejects.toThrow(/topilmadi/);
    a.notifier.dms.length = 0;
    await updateDoc(a.ctx, hr, draft.id, { published: true });
    expect(a.notifier.dms.length).toBeGreaterThan(3); // everyone except the author
    const list = await listDocs(a.ctx, emp);
    expect(list).toMatchObject([{ title: 'Qoralama', acked: false, forMe: true }]);
    expect(list[0]).not.toHaveProperty('audience');
  });

  it('department-only docs reach only that department', async () => {
    const a = await agency();
    const owner = await a.actor(a.users.ceo.id);
    await createDoc(a.ctx, owner, { title: 'Dizayn standartlari', departmentIds: [a.design.id], published: true });
    expect(await listDocs(a.ctx, await a.actor(a.users.aziz.id))).toHaveLength(1);
    expect(await listDocs(a.ctx, await a.actor(a.users.videographer.id))).toHaveLength(0);
  });

  it('"Tanishdim" is per version: editing the text asks everyone to re-read', async () => {
    const a = await agency();
    const hr = await a.actor(a.users.hr.id);
    const emp = await a.actor(a.users.aziz.id);
    const d = await createDoc(a.ctx, hr, { title: 'Qoidalar', blocks: [{ type: 'text', text: 'v1' }], published: true });
    await acknowledge(a.ctx, emp, d.id);
    expect((await listDocs(a.ctx, emp))[0]).toMatchObject({ acked: true, outdated: false });
    const full = await getDoc(a.ctx, hr, d.id);
    expect(full.readers?.find((r) => r.userId === a.users.aziz.id)?.ackedAt).toBeTruthy();
    const v2 = await updateDoc(a.ctx, hr, d.id, { blocks: [{ ...full.blocks[0]!, type: 'text', text: 'v2' } as never] });
    expect(v2.version).toBe(2);
    expect((await listDocs(a.ctx, emp))[0]).toMatchObject({ acked: false, outdated: true });
    // Re-saving the same content does not bump the version.
    const same = await updateDoc(a.ctx, hr, d.id, { blocks: v2.blocks as never });
    expect(same.version).toBe(2);
  });

  it('starter kit creates three editable drafts', async () => {
    const a = await agency();
    const owner = await a.actor(a.users.ceo.id);
    const docs = await createStarterKit(a.ctx, owner);
    expect(docs).toHaveLength(3);
    expect(docs.every((d) => !d.published && d.blocks.length > 3)).toBe(true);
  });
});
