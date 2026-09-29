import { describe, expect, it } from 'vitest';
import { issuePurposeToken, verifyPurposeToken, verifyToken } from '../auth/telegram.js';
import { agency } from '../test/fixtures.js';
import { recordGroupMessage, type IncomingMessage } from './chatlog.js';
import { createRow } from './finance.js';
import { bindChat, createProject } from './projects.js';
import { pdfText, renderReportPdf, reportFileName } from './reportPdf.js';
import { buildReport } from './reports.js';
import { sendReport } from './reportSend.js';
import { actOnTask, createTask } from './tasks.js';

const CHAT = -100_555;
const hours = (d: Date, h: number) => new Date(d.getTime() + h * 3_600_000);

async function setup() {
  const a = await agency();
  const owner = await a.actor(a.users.ceo.id);
  const project = await createProject(a.ctx, owner, { name: 'Kafe Bahor', managerUserId: a.users.pm.id, memberUserIds: [a.users.aziz.id, a.users.videographer.id] });
  await bindChat(a.ctx, owner, project.id, CHAT, 'Kafe Bahor × Nova');
  const pm = await a.actor(a.users.pm.id);
  const aziz = await a.actor(a.users.aziz.id);

  // Done on time, done late (after a return), one open overdue, one private 1:1 task.
  const t1 = await createTask(a.ctx, pm, { title: 'Oktabr banneri', projectId: project.id, assigneeUserId: a.users.aziz.id, reviewerUserId: a.users.pm.id, deadline: hours(a.clock.t, 48), points: 2 });
  const t2 = await createTask(a.ctx, pm, { title: 'Stories 5 ta', projectId: project.id, assigneeUserId: a.users.aziz.id, reviewerUserId: a.users.pm.id, deadline: hours(a.clock.t, 4) });
  const t3 = await createTask(a.ctx, pm, { title: 'Reels montaj', projectId: project.id, assigneeUserId: a.users.videographer.id, deadline: hours(a.clock.t, 6) });
  await createTask(a.ctx, owner, { title: 'Maxfiy: narx siyosati', projectId: project.id, assigneeUserId: a.users.pm.id, deadline: hours(a.clock.t, 24), isPrivate: true });

  for (const [t, returnFirst] of [
    [t1, false],
    [t2, true],
  ] as const) {
    await actOnTask(a.ctx, aziz, t.id, 'START');
    await actOnTask(a.ctx, aziz, t.id, 'SUBMIT');
    if (returnFirst) {
      a.clock.set(hours(a.clock.t, 8)); // past t2's deadline
      await actOnTask(a.ctx, pm, t.id, 'RETURN', 'Logotip kichik');
      await actOnTask(a.ctx, aziz, t.id, 'START');
      await actOnTask(a.ctx, aziz, t.id, 'SUBMIT');
    }
    await actOnTask(a.ctx, pm, t.id, 'APPROVE');
  }

  // Group messages: team, client (not a member), a bot, a command, an unbound chat.
  const base = Math.floor(a.clock.t.getTime() / 1000);
  const msg = (id: number, from: { id: number; name: string; bot?: boolean }, extra: Partial<IncomingMessage>, chat = CHAT): IncomingMessage => ({
    message_id: id,
    date: base + id * 60,
    chat: { id: chat, type: 'supergroup' },
    from: { id: from.id, is_bot: !!from.bot, first_name: from.name },
    ...extra,
  });
  const team = { id: a.users.pm.telegramId, name: 'Kamola' };
  const client = { id: 777_001, name: 'Dilnoza (Kafe Bahor)' };
  const results = [
    await recordGroupMessage(a.ctx, msg(1, team, { text: 'Bannerlar tayyor, ko‘rib chiqing' })),
    await recordGroupMessage(a.ctx, msg(2, client, { text: 'Logotipni kattaroq qiling 🙏 https://example.com/brand.' })),
    await recordGroupMessage(a.ctx, msg(3, client, { photo: [{}], caption: 'Mana namuna' })),
    await recordGroupMessage(a.ctx, msg(3, client, { photo: [{}], caption: 'Mana namuna' })), // duplicate delivery
    await recordGroupMessage(a.ctx, msg(4, { id: 1, name: 'bot', bot: true }, { text: 'card' })),
    await recordGroupMessage(a.ctx, msg(5, team, { text: '/bind' })),
    await recordGroupMessage(a.ctx, msg(6, client, { text: 'boshqa guruh' }, -100_999)),
    await recordGroupMessage(a.ctx, msg(7, team, { document: { file_name: 'kontent-reja.xlsx' } })),
  ];
  expect(results).toEqual([true, true, true, false, false, false, false, true]);
  return { a, owner, pm, aziz, project, t3 };
}

describe('reports (Hisobotlar)', () => {
  it('project report: tasks, people, group chat — as the actor may see it', async () => {
    const { a, owner, aziz, project } = await setup();
    const period = { projectId: project.id, from: '2026-09-01', to: '2026-09-30' };
    a.clock.set(new Date('2026-09-22T12:00:00Z'));

    const r = await buildReport(a.ctx, aziz, period);
    expect(r.scope).toBe('PROJECT');
    expect(r.project).toMatchObject({ name: 'Kafe Bahor', manager: 'Kamola', chat: 'Kafe Bahor × Nova' });
    expect(r.summary).toMatchObject({ done: 2, doneOnTime: 1, onTimePct: 50, open: 1, overdue: 1, returned: 1, points: 3, messages: 4, clientMessages: 2 });
    expect(r.people.find((p) => p.name === 'Aziz')).toMatchObject({ done: 2, onTime: 1, points: 3 });
    expect(r.openTasks.map((t) => t.title)).toEqual(['Reels montaj']); // the 1:1 task stays hidden
    expect(r.chat).toMatchObject({ total: 4, team: 2, client: 2, links: ['https://example.com/brand'], files: ['kontent-reja.xlsx'] });
    expect(r.chat.media.PHOTO).toBe(1);
    expect(r.chat.clientMessages.map((m) => m.text)).toEqual(['Logotipni kattaroq qiling 🙏 https://example.com/brand.', 'Mana namuna']);
    expect(r.finance).toBeNull();
    expect(r.insights.join(' ')).toMatch(/2 ta vazifa bajarildi, 50% i muddatida/);

    // The Owner sees the 1:1 task and the money.
    await createRow(a.ctx, owner, { month: '2026-09', party: 'Kafe Bahor', projectId: project.id, amount: 5_000_000, paid: 2_000_000 });
    const o = await buildReport(a.ctx, owner, period);
    expect(o.openTasks.map((t) => t.title).sort()).toEqual(['Maxfiy: narx siyosati', 'Reels montaj']);
    expect(o.finance).toEqual({ expected: 5_000_000, received: 2_000_000, debt: 3_000_000, months: ['2026-09'] });
  });

  it('company report lists projects; other companies stay invisible', async () => {
    const { a, owner } = await setup();
    const r = await buildReport(a.ctx, owner, { from: '2026-09-01', to: '2026-09-30' });
    expect(r.scope).toBe('COMPANY');
    expect(r.projects).toEqual([expect.objectContaining({ name: 'Kafe Bahor', done: 2, open: 2, messages: 4 })]);

    const b = await agency();
    const other = await b.actor(b.users.ceo.id);
    const rb = await buildReport(b.ctx, other, { from: '2026-09-01', to: '2026-09-30' });
    expect(rb.summary.done + rb.summary.messages + rb.projects.length).toBe(0);
    const pid = (await buildReport(a.ctx, owner, { from: '2026-09-01', to: '2026-09-30' })).projects[0]!.id;
    await expect(buildReport(b.ctx, other, { projectId: pid, from: '2026-09-01', to: '2026-09-30' })).rejects.toThrow(/topilmadi/);
  });

  it('validates the period', async () => {
    const { a, owner } = await setup();
    await expect(buildReport(a.ctx, owner, { from: '2026-09-30', to: '2026-09-01' })).rejects.toThrow();
    await expect(buildReport(a.ctx, owner, { from: '2024-01-01', to: '2026-09-01' })).rejects.toThrow(/13 oy/);
  });

  it('renders a PDF with Uzbek text and sends it to the requester', async () => {
    const { a, owner, project } = await setup();
    expect(pdfText('Oʻzbekiston 🙏 gʻalaba — Қарши')).toBe('O‘zbekiston g‘alaba — Карши');
    const r = await buildReport(a.ctx, owner, { projectId: project.id, from: '2026-09-01', to: '2026-09-30' });
    const pdf = await renderReportPdf(r);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.byteLength).toBeGreaterThan(8_000);
    expect(reportFileName(r)).toBe('hisobot-kafe-bahor-2026-09-01_2026-09-30.pdf');

    const sent = await sendReport(a.ctx, owner, { projectId: project.id, from: '2026-09-01', to: '2026-09-30' });
    expect(sent.ok).toBe(true);
    expect(a.notifier.documents).toEqual([expect.objectContaining({ telegramId: a.users.ceo.telegramId, fileName: 'hisobot-kafe-bahor-2026-09-01_2026-09-30.pdf' })]);
  });

  it('a report link token is not a session token', async () => {
    const secret = 'x'.repeat(40);
    const t = await issuePurposeToken('report', 'u1', { cid: 'c1' }, secret);
    expect(await verifyPurposeToken('report', t, secret)).toMatchObject({ sub: 'u1', cid: 'c1' });
    await expect(verifyToken(t, secret)).rejects.toThrow();
    await expect(verifyPurposeToken('other', t, secret)).rejects.toThrow();
  });
});
