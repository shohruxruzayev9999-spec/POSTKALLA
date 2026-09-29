import { and, asc, eq, gte, inArray, lt, lte, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DomainError, canAccess, checkAccess, localDateString, zonedTime } from '@retarget/shared';
import { z } from 'zod';
import { chatMessages, clients, financeRows, projects, shoots, tasks, users } from '../db/schema.js';
import { createHash } from 'node:crypto';
import { bullets, TtlCache } from './ai.js';
import { notFound, type Ctx, type ResolvedActor } from './context.js';
import { canSeeTask } from './tasks.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Sana YYYY-MM-DD ko‘rinishida');
export const reportQuery = z
  .object({
    projectId: z.string().uuid().optional().or(z.literal('').transform(() => undefined)),
    from: day,
    to: day,
    ai: z.coerce.boolean().optional(),
  })
  .refine((q) => q.from <= q.to, { message: 'Boshlanish sanasi tugashdan keyin bo‘lmasin' });
export type ReportQuery = z.input<typeof reportQuery>;

const OPEN = ['NEW', 'IN_PROGRESS', 'REVIEW', 'RETURNED', 'BLOCKED'];
const URL_RE = /https?:\/\/[^\s<>"')]+/g;

function bounds(from: string, to: string, tz: string) {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  const start = zonedTime(fy, fm, fd, 0, 0, tz);
  const end = zonedTime(ty, tm, td + 1, 0, 0, tz); // exclusive; Date.UTC rolls the day over
  if (end.getTime() - start.getTime() > 400 * 86_400_000) throw new DomainError('VALIDATION', 'Davr 13 oydan oshmasin');
  return { start, end };
}

/** YYYY-MM months touched by the period (finance rows are monthly). */
function monthsOf(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

export interface PersonRow {
  userId: string;
  name: string;
  done: number;
  onTime: number;
  open: number;
  overdue: number;
  points: number;
}

export interface ReportData {
  scope: 'PROJECT' | 'COMPANY';
  company: string;
  generatedAt: string;
  timezone: string;
  period: { from: string; to: string };
  project: { id: string; name: string; client: string | null; manager: string | null; status: string; chat: string | null; color: string } | null;
  summary: {
    created: number;
    done: number;
    doneOnTime: number;
    onTimePct: number | null;
    open: number;
    overdue: number;
    returned: number;
    points: number;
    messages: number;
    clientMessages: number;
    shoots: number;
  };
  statusCounts: Record<string, number>;
  people: PersonRow[];
  doneTasks: Array<{ number: number; title: string; assignee: string; completedAt: string; onTime: boolean; revision: number; project: string | null; format: string | null }>;
  openTasks: Array<{ number: number; title: string; assignee: string; deadline: string; status: string; overdue: boolean; project: string | null }>;
  shoots: Array<{ day: string; start: string; title: string; type: string; status: string; location: string | null; project: string | null }>;
  chat: {
    total: number;
    team: number;
    client: number;
    media: Record<string, number>;
    byDay: Array<{ day: string; team: number; client: number }>;
    senders: Array<{ name: string; n: number; isTeam: boolean }>;
    clientMessages: Array<{ at: string; name: string; text: string; kind: string }>;
    links: string[];
    files: string[];
    lastClientAt: string | null;
  };
  projects: Array<{ id: string; name: string; color: string; done: number; onTimePct: number | null; open: number; overdue: number; messages: number }>;
  finance: { expected: number; received: number; debt: number; months: string[] } | null;
  insights: string[];
  aiSummary: string[] | null;
  aiAvailable: boolean;
}

const aiCache = new TtlCache<string[]>(30 * 60_000);

/**
 * Everything a project (or the whole company) did in a period, as the actor may see it:
 * tasks (private 1:1 tasks only for the people in them), shoots, the Telegram group, and money
 * only for CEO/Finance.
 */
export async function buildReport(ctx: Ctx, actor: ResolvedActor, raw: ReportQuery): Promise<ReportData> {
  const q = reportQuery.parse(raw);
  const tz = actor.company.timezone;
  const { start, end } = bounds(q.from, q.to, tz);
  const now = ctx.now();
  const cid = actor.companyId;

  let project: ReportData['project'] = null;
  if (q.projectId) {
    const manager = alias(users, 'manager');
    const [p] = await ctx.db
      .select({ p: projects, client: clients.name, manager: manager.firstName, managerLast: manager.lastName })
      .from(projects)
      .leftJoin(clients, eq(clients.id, projects.clientId))
      .leftJoin(manager, eq(manager.id, projects.managerUserId))
      .where(and(eq(projects.id, q.projectId), eq(projects.companyId, cid)));
    if (!p) throw notFound('Loyiha');
    checkAccess(actor, 'project.view', { companyId: cid, projectId: p.p.id });
    project = {
      id: p.p.id,
      name: p.p.name,
      client: p.client,
      manager: p.manager ? [p.manager, p.managerLast].filter(Boolean).join(' ') : null,
      status: p.p.status,
      chat: p.p.telegramChatTitle,
      color: p.p.color,
    };
  } else {
    checkAccess(actor, 'dashboard.view', { companyId: cid });
  }
  const inProject = <T>(col: T) => (q.projectId ? eq(col as never, q.projectId) : undefined);

  // ------------------------------------------------------------------ tasks
  const assignee = alias(users, 'assignee');
  const rows = await ctx.db
    .select({ t: tasks, first: assignee.firstName, last: assignee.lastName, project: projects.name })
    .from(tasks)
    .innerJoin(assignee, eq(assignee.id, tasks.assigneeUserId))
    .leftJoin(projects, eq(projects.id, tasks.projectId))
    .where(
      and(
        eq(tasks.companyId, cid),
        inProject(tasks.projectId),
        or(
          and(gte(tasks.createdAt, start), lt(tasks.createdAt, end)),
          and(gte(tasks.completedAt, start), lt(tasks.completedAt, end)),
          and(inArray(tasks.status, OPEN), lt(tasks.createdAt, end)),
        ),
      ),
    )
    .orderBy(asc(tasks.number));
  const visible = rows.filter((r) => canSeeTask(actor, r.t));
  const nameOf = (r: (typeof visible)[number]) => [r.first, r.last].filter(Boolean).join(' ');
  const isOpen = (s: string) => OPEN.includes(s);
  const done = visible.filter((r) => r.t.status === 'DONE' && r.t.completedAt && r.t.completedAt >= start && r.t.completedAt < end);
  const onTime = (r: (typeof visible)[number]) => !!r.t.completedAt && r.t.completedAt <= r.t.originalDeadline;
  const open = visible.filter((r) => isOpen(r.t.status));
  const overdueAt = end < now ? end : now;
  const overdue = open.filter((r) => r.t.deadline < overdueAt);
  const created = visible.filter((r) => r.t.createdAt >= start && r.t.createdAt < end);

  const statusCounts: Record<string, number> = {};
  for (const r of open) statusCounts[r.t.status] = (statusCounts[r.t.status] ?? 0) + 1;
  statusCounts.DONE = done.length;

  const people = new Map<string, PersonRow>();
  const person = (r: (typeof visible)[number]) => {
    let p = people.get(r.t.assigneeUserId);
    if (!p) people.set(r.t.assigneeUserId, (p = { userId: r.t.assigneeUserId, name: nameOf(r), done: 0, onTime: 0, open: 0, overdue: 0, points: 0 }));
    return p;
  };
  for (const r of done) {
    const p = person(r);
    p.done++;
    p.points += r.t.points;
    if (onTime(r)) p.onTime++;
  }
  for (const r of open) person(r).open++;
  for (const r of overdue) person(r).overdue++;

  // ------------------------------------------------------------------ shoots
  const shootRows = await ctx.db
    .select({ s: shoots, project: projects.name })
    .from(shoots)
    .leftJoin(projects, eq(projects.id, shoots.projectId))
    .where(and(eq(shoots.companyId, cid), inProject(shoots.projectId), gte(shoots.day, q.from), lte(shoots.day, q.to)))
    .orderBy(asc(shoots.startsAt));
  const shootList = shootRows.filter((r) => r.s.status !== 'CANCELLED');

  // ------------------------------------------------------------------ telegram group
  const msgs = await ctx.db
    .select()
    .from(chatMessages)
    .where(and(eq(chatMessages.companyId, cid), inProject(chatMessages.projectId), gte(chatMessages.sentAt, start), lt(chatMessages.sentAt, end)))
    .orderBy(asc(chatMessages.sentAt));
  const media: Record<string, number> = { PHOTO: 0, VIDEO: 0, DOCUMENT: 0, VOICE: 0 };
  const byDay = new Map<string, { team: number; client: number }>();
  const senders = new Map<string, { name: string; n: number; isTeam: boolean }>();
  const links = new Set<string>();
  const files: string[] = [];
  for (const m of msgs) {
    if (m.kind in media) media[m.kind]!++;
    const d = localDateString(m.sentAt, tz);
    const b = byDay.get(d) ?? { team: 0, client: 0 };
    if (m.isTeam) b.team++;
    else b.client++;
    byDay.set(d, b);
    const key = String(m.fromTelegramId ?? m.fromName);
    const s = senders.get(key) ?? { name: m.fromName, n: 0, isTeam: m.isTeam };
    s.n++;
    senders.set(key, s);
    for (const l of m.text.match(URL_RE) ?? []) links.add(l.replace(/[.,;:!?]+$/, ''));
    if (m.fileName && files.length < 30) files.push(m.fileName);
  }
  const clientMsgs = msgs.filter((m) => !m.isTeam);
  const days: ReportData['chat']['byDay'] = [];
  for (let d = new Date(start); d < end && days.length < 400; d = new Date(d.getTime() + 86_400_000)) {
    const k = localDateString(new Date(d.getTime() + 12 * 3_600_000), tz);
    if (days.at(-1)?.day === k) continue;
    days.push({ day: k, ...(byDay.get(k) ?? { team: 0, client: 0 }) });
  }

  // ------------------------------------------------------------------ projects (company scope)
  let projectRows: ReportData['projects'] = [];
  if (!q.projectId) {
    const all = await ctx.db.select().from(projects).where(eq(projects.companyId, cid));
    const byProject = (id: string | null) => ({
      done: done.filter((r) => r.t.projectId === id),
      open: open.filter((r) => r.t.projectId === id),
      overdue: overdue.filter((r) => r.t.projectId === id).length,
      messages: msgs.filter((m) => m.projectId === id).length,
    });
    projectRows = all
      .map((p) => {
        const s = byProject(p.id);
        return {
          id: p.id,
          name: p.name,
          color: p.color,
          done: s.done.length,
          onTimePct: s.done.length ? Math.round((s.done.filter(onTime).length / s.done.length) * 100) : null,
          open: s.open.length,
          overdue: s.overdue,
          messages: s.messages,
        };
      })
      .filter((p) => p.done + p.open + p.messages > 0)
      .sort((a, b) => b.done + b.open - (a.done + a.open));
  }

  // ------------------------------------------------------------------ money (CEO / Finance only)
  let finance: ReportData['finance'] = null;
  if (canAccess(actor, 'finance.view', { companyId: cid })) {
    const months = monthsOf(q.from, q.to);
    const fin = await ctx.db
      .select()
      .from(financeRows)
      .where(and(eq(financeRows.companyId, cid), eq(financeRows.kind, 'INCOME'), inArray(financeRows.month, months), inProject(financeRows.projectId)));
    const expected = fin.reduce((a, r) => a + r.amount, 0);
    const received = fin.reduce((a, r) => a + r.paid, 0);
    if (fin.length) finance = { expected, received, debt: fin.reduce((a, r) => a + Math.max(0, r.amount - r.paid), 0), months };
  }

  const doneOnTime = done.filter(onTime).length;
  const data: ReportData = {
    scope: q.projectId ? 'PROJECT' : 'COMPANY',
    company: actor.company.name,
    generatedAt: now.toISOString(),
    timezone: tz,
    period: { from: q.from, to: q.to },
    project,
    summary: {
      created: created.length,
      done: done.length,
      doneOnTime,
      onTimePct: done.length ? Math.round((doneOnTime / done.length) * 100) : null,
      open: open.length,
      overdue: overdue.length,
      returned: done.filter((r) => r.t.revision > 1).length,
      points: done.reduce((a, r) => a + r.t.points, 0),
      messages: msgs.length,
      clientMessages: clientMsgs.length,
      shoots: shootList.length,
    },
    statusCounts,
    people: [...people.values()].sort((a, b) => b.done - a.done || b.open - a.open || a.name.localeCompare(b.name)),
    doneTasks: done
      .sort((a, b) => +a.t.completedAt! - +b.t.completedAt!)
      .slice(-80)
      .map((r) => ({
        number: r.t.number,
        title: r.t.title,
        assignee: nameOf(r),
        completedAt: r.t.completedAt!.toISOString(),
        onTime: onTime(r),
        revision: r.t.revision,
        project: r.project,
        format: r.t.format,
      })),
    openTasks: open
      .sort((a, b) => +a.t.deadline - +b.t.deadline)
      .slice(0, 60)
      .map((r) => ({
        number: r.t.number,
        title: r.t.title,
        assignee: nameOf(r),
        deadline: r.t.deadline.toISOString(),
        status: r.t.status,
        overdue: r.t.deadline < overdueAt,
        project: r.project,
      })),
    shoots: shootList.map((r) => ({
      day: r.s.day,
      start: r.s.startTime,
      title: r.s.title,
      type: r.s.type,
      status: r.s.status,
      location: r.s.location,
      project: r.project,
    })),
    chat: {
      total: msgs.length,
      team: msgs.length - clientMsgs.length,
      client: clientMsgs.length,
      media,
      byDay: days,
      senders: [...senders.values()].sort((a, b) => b.n - a.n).slice(0, 10),
      clientMessages: clientMsgs
        .filter((m) => m.text.trim().length >= 3 || m.kind !== 'TEXT')
        .slice(-30)
        .map((m) => ({ at: m.sentAt.toISOString(), name: m.fromName, text: m.text.slice(0, 600), kind: m.kind })),
      links: [...links].slice(0, 20),
      files,
      lastClientAt: clientMsgs.at(-1)?.sentAt.toISOString() ?? null,
    },
    projects: projectRows,
    finance,
    insights: [],
    aiSummary: null,
    aiAvailable: !!ctx.ai,
  };
  data.insights = insightsOf(data, now);
  if (q.ai && ctx.ai) data.aiSummary = await aiSummary(ctx, actor, data);
  return data;
}

const fmtN = (n: number) => n.toLocaleString('ru-RU').replace(/ /g, ' ');

/** Rule-based conclusions: always present, the same for everyone, no model needed. */
export function insightsOf(d: ReportData, now: Date): string[] {
  const s = d.summary;
  const out: string[] = [];
  if (s.done) out.push(`${s.done} ta vazifa bajarildi${s.onTimePct !== null ? `, ${s.onTimePct}% i muddatida` : ''}${s.points !== s.done ? ` (${s.points} ball)` : ''}.`);
  else out.push('Bu davrda yakunlangan vazifa yo‘q.');
  if (s.overdue) out.push(`${s.overdue} ta vazifa muddatidan o‘tgan — birinchi navbatda shularni yopish kerak.`);
  else if (s.open) out.push(`${s.open} ta ochiq vazifa bor, muddati o‘tgani yo‘q.`);
  if (s.returned) out.push(`${s.returned} ta ish qayta ishlashdan (R2+) keyin qabul qilindi.`);
  const lagging = d.people.filter((p) => p.overdue >= 2).map((p) => `${p.name} (${p.overdue})`);
  if (lagging.length) out.push(`Kechikishlar ko‘p: ${lagging.slice(0, 4).join(', ')}.`);
  const best = d.people.filter((p) => p.done >= 3 && p.onTime === p.done)[0];
  if (best) out.push(`${best.name}: ${best.done} ta ishning hammasi muddatida — namunali natija.`);
  if (d.chat.total) {
    out.push(`Guruhda ${d.chat.total} ta xabar: jamoa ${d.chat.team}, mijoz tomoni ${d.chat.client}.`);
    if (d.chat.lastClientAt) {
      const daysAgo = Math.floor((now.getTime() - new Date(d.chat.lastClientAt).getTime()) / 86_400_000);
      if (daysAgo >= 7) out.push(`Mijoz ${daysAgo} kundan beri yozmagan — aloqani tiklash tavsiya etiladi.`);
    }
  } else if (d.scope === 'PROJECT' && d.project?.chat) {
    out.push('Guruhdan xabar yozilmagan (yoki bot guruhda admin emas).');
  }
  if (s.shoots) out.push(`${s.shoots} ta syomka rejalashtirilgan/o‘tkazilgan.`);
  if (d.finance?.debt) out.push(`Qarzdorlik: ${fmtN(d.finance.debt)} so‘m (kutilgan ${fmtN(d.finance.expected)}, tushgan ${fmtN(d.finance.received)}).`);
  return out;
}

async function aiSummary(ctx: Ctx, actor: ResolvedActor, d: ReportData): Promise<string[] | null> {
  const compact = {
    scope: d.scope,
    project: d.project?.name,
    client: d.project?.client,
    period: d.period,
    summary: d.summary,
    people: d.people.slice(0, 12),
    overdue: d.openTasks.filter((t) => t.overdue).slice(0, 15).map((t) => ({ t: t.title, who: t.assignee, deadline: t.deadline })),
    doneTitles: d.doneTasks.slice(-25).map((t) => t.title),
    clientMessages: d.chat.clientMessages.slice(-20).map((m) => ({ at: m.at.slice(0, 16), text: m.text })),
    projects: d.projects.slice(0, 20),
    // Money is never sent to the model.
  };
  // The cache key is the exact prompt: what one person may see never leaks into another's summary.
  const prompt = JSON.stringify(compact);
  const key = `${actor.companyId}:${createHash('sha256').update(prompt).digest('hex')}`;
  const hit = aiCache.get(key);
  if (hit) return hit;
  try {
    const text = await ctx.ai!.complete({
      system:
        'Sen marketing agentligi uchun loyiha tahlilchisisan. Faqat berilgan maʼlumotga tayan, taxmin qilma. ' +
        'Oʻzbek tilida (lotin), qisqa va aniq yoz. 4–6 ta punkt: nima qilindi, mijoz nimani soʻradi yoki nimadan norozi, ' +
        'xavflar, keyingi qadamlar. Har bir punkt bitta qator, "- " bilan boshlansin. Raqamlarni oʻzgartirma.',
      prompt,
      maxTokens: 700,
    });
    const out = bullets(text, 7);
    if (out.length) aiCache.set(key, out);
    return out.length ? out : null;
  } catch (e) {
    console.error('[ai] report summary failed', e);
    return null;
  }
}
