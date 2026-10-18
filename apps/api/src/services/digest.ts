import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DomainError, ROLES, canAccess, ownProjectsOnly, isWorkingDate, localDateString, localParts, previousWorkingDate, scopesFor, workingHoursBetween, type Role, zonedTime } from '@retarget/shared';
import { attendance, chatMessages, companies, departments, digests, financeRows, memberships, projects, shoots, taskEvents, tasks, users } from '../db/schema.js';
import { bullets } from './ai.js';
import { scheduleOf, type Company, type Ctx, type ResolvedActor } from './context.js';

export type Severity = 'HIGH' | 'MEDIUM' | 'LOW';
export interface DigestItem {
  kind: string;
  severity: Severity;
  text: string;
  taskId?: string;
  projectId?: string;
  userId?: string;
  /** Money: shown only to people who may see finance. */
  finance?: boolean;
}

interface TaskRef {
  taskId: string;
  number: number;
  title: string;
  assignee: string;
  project: string | null;
}

export interface DigestData {
  day: string;
  company: string;
  yesterday: {
    day: string | null;
    done: number;
    onTime: number;
    created: number;
    present: number;
    late: number;
    absent: number;
    tracked: boolean;
  };
  totals: {
    open: number;
    overdue: number;
    review: number;
    blocked: number;
    dueToday: number;
  };
  overdue: Array<TaskRef & { daysLate: number; priority: string }>;
  dueToday: Array<TaskRef & { deadline: string; status: string }>;
  review: Array<TaskRef & { reviewer: string | null; hours: number }>;
  blocked: Array<TaskRef & { reason: string | null }>;
  load: Array<{
    userId: string;
    name: string;
    open: number;
    overdue: number;
    points: number;
    share: number;
  }>;
  clients: Array<{
    projectId: string;
    project: string;
    lastClientAt: string | null;
    waitingHours: number | null;
    silentDays: number | null;
    lastText: string | null;
  }>;
  shoots: Array<{
    day: string;
    start: string;
    title: string;
    project: string | null;
    location: string | null;
  }>;
  finance: {
    overdueCount: number;
    overdueAmount: number;
    parties: Array<{ party: string; debt: number }>;
  } | null;
  items: DigestItem[];
}

const OPEN = ['NEW', 'IN_PROGRESS', 'REVIEW', 'RETURNED', 'BLOCKED'];
const LEAD_ROLES = ['OWNER', 'ADMIN', 'PM', 'MARKETER'];
const RANK: Record<Severity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const fmtN = (n: number) => n.toLocaleString('ru-RU').replace(/ /g, ' ');
const fullName = (f: string, l: string | null) => [f, l].filter(Boolean).join(' ');
const q = (s: string, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Leads read the digest: CEO, admins, PMs, marketers and department heads. */
export function canSeeDigest(actor: ResolvedActor): boolean {
  // The digest covers every project, so "only my projects" members do not get it.
  if (ownProjectsOnly(actor)) return false;
  return actor.roles.some((r) => LEAD_ROLES.includes(r)) || actor.headOfDepartmentIds.length > 0;
}

/**
 * The morning picture of the agency: what happened yesterday, what burns today, who waits for
 * whom, and concrete recommendations. Read-only — nothing here changes data.
 */
export async function buildDigest(ctx: Ctx, company: Company, now = ctx.now()): Promise<DigestData> {
  const tz = company.timezone;
  const schedule = scheduleOf(company);
  const cid = company.id;
  const today = localDateString(now, tz);
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  const todayStart = zonedTime(ty, tm, td, 0, 0, tz);
  const todayEnd = zonedTime(ty, tm, td + 1, 0, 0, tz);
  const prev = previousWorkingDate(today, schedule);
  const [py, pm, pd] = (prev ?? today).split('-').map(Number) as [number, number, number];
  const prevStart = zonedTime(py, pm, pd, 0, 0, tz);
  const prevEnd = zonedTime(py, pm, pd + 1, 0, 0, tz);

  const assignee = alias(users, 'assignee');
  const reviewer = alias(users, 'reviewer');
  const rows = await ctx.db
    .select({
      t: tasks,
      af: assignee.firstName,
      al: assignee.lastName,
      rf: reviewer.firstName,
      rl: reviewer.lastName,
      project: projects.name,
    })
    .from(tasks)
    .innerJoin(assignee, eq(assignee.id, tasks.assigneeUserId))
    .leftJoin(reviewer, eq(reviewer.id, tasks.reviewerUserId))
    .leftJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(tasks.companyId, cid), or(inArray(tasks.status, OPEN), gte(tasks.completedAt, prevStart), gte(tasks.createdAt, prevStart))));
  // 1:1 tasks stay out of a shared digest.
  const all = rows.filter((r) => !r.t.isPrivate);
  const ref = (r: (typeof all)[number]): TaskRef => ({
    taskId: r.t.id,
    number: r.t.number,
    title: r.t.title,
    assignee: fullName(r.af, r.al),
    project: r.project,
  });
  const open = all.filter((r) => OPEN.includes(r.t.status));
  const overdue = open.filter((r) => r.t.deadline < now);
  const doneY = all.filter((r) => r.t.status === 'DONE' && r.t.completedAt && r.t.completedAt >= prevStart && r.t.completedAt < prevEnd);
  const createdY = all.filter((r) => r.t.createdAt >= prevStart && r.t.createdAt < prevEnd);
  const dueToday = open.filter((r) => r.t.deadline >= now && r.t.deadline < todayEnd);
  const inReview = open.filter((r) => r.t.status === 'REVIEW');
  const blocked = open.filter((r) => r.t.status === 'BLOCKED');

  // When each REVIEW / BLOCKED task got there, and why it was blocked.
  const ids = [...inReview, ...blocked].map((r) => r.t.id);
  const evs = ids.length
    ? await ctx.db
        .select({
          taskId: taskEvents.taskId,
          toStatus: taskEvents.toStatus,
          comment: taskEvents.comment,
          at: taskEvents.createdAt,
        })
        .from(taskEvents)
        .where(inArray(taskEvents.taskId, ids))
        .orderBy(desc(taskEvents.createdAt), desc(taskEvents.seq))
    : [];
  const lastInto = (taskId: string, status: string) => evs.find((e) => e.taskId === taskId && e.toStatus === status);

  const reviewList = inReview
    .map((r) => {
      const since = lastInto(r.t.id, 'REVIEW')?.at ?? r.t.updatedAt;
      return {
        ...ref(r),
        reviewer: r.rf ? fullName(r.rf, r.rl) : null,
        hours: Math.round(workingHoursBetween(since, now, schedule)),
      };
    })
    .sort((a, b) => b.hours - a.hours);

  // Load: open work per person.
  const members = await ctx.db
    .select({
      userId: memberships.userId,
      roles: memberships.roles,
      joinedAt: memberships.joinedAt,
      first: users.firstName,
      last: users.lastName,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.companyId, cid), eq(memberships.status, 'ACTIVE')));
  const totalPts = open.reduce((a, r) => a + r.t.points, 0) || 1;
  const load = members
    .map((m) => {
      const mine = open.filter((r) => r.t.assigneeUserId === m.userId);
      const pts = mine.reduce((a, r) => a + r.t.points, 0);
      return {
        userId: m.userId,
        name: fullName(m.first, m.last),
        open: mine.length,
        overdue: mine.filter((r) => r.t.deadline < now).length,
        points: pts,
        share: Math.round((pts / totalPts) * 100),
      };
    })
    .filter((p) => p.open > 0)
    .sort((a, b) => b.points - a.points);

  // Attendance of the previous working day (only when the company actually uses check-in).
  const attRows = prev
    ? await ctx.db
        .select()
        .from(attendance)
        .where(and(eq(attendance.companyId, cid), gte(attendance.day, prev), lt(attendance.day, today)))
    : [];
  const [anyAtt] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(attendance)
    .where(and(eq(attendance.companyId, cid), gte(attendance.day, localDateString(new Date(now.getTime() - 14 * 86_400_000), tz))));
  const tracked = (anyAtt?.n ?? 0) > 0;
  const presentY = attRows.filter((a) => a.day === prev && a.checkIn);
  const lateY = presentY.filter((a) => a.lateMinutes > 0);
  const expected = members.filter((m) => m.joinedAt < prevStart && !m.roles.includes('OWNER'));
  const absentY = tracked && prev ? expected.filter((m) => !presentY.some((a) => a.userId === m.userId)) : [];

  // Clients: last message from the client side per bound project, and whether the team answered.
  const bound = await ctx.db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(eq(projects.companyId, cid), eq(projects.status, 'ACTIVE'), isNotNull(projects.telegramChatId)));
  const since = new Date(now.getTime() - 60 * 86_400_000);
  const msgs = bound.length
    ? await ctx.db
        .select({
          projectId: chatMessages.projectId,
          isTeam: chatMessages.isTeam,
          at: chatMessages.sentAt,
          text: chatMessages.text,
          kind: chatMessages.kind,
        })
        .from(chatMessages)
        .where(and(eq(chatMessages.companyId, cid), gte(chatMessages.sentAt, since)))
        .orderBy(desc(chatMessages.sentAt))
    : [];
  const clients = bound.map((p) => {
    const mine = msgs.filter((m) => m.projectId === p.id);
    const lastClient = mine.find((m) => !m.isTeam);
    const answered = lastClient ? mine.some((m) => m.isTeam && m.at > lastClient.at) : true;
    return {
      projectId: p.id,
      project: p.name,
      lastClientAt: lastClient?.at.toISOString() ?? null,
      waitingHours: lastClient && !answered ? Math.round(workingHoursBetween(lastClient.at, now, schedule)) : null,
      silentDays: lastClient ? Math.floor((now.getTime() - lastClient.at.getTime()) / 86_400_000) : null,
      lastText: lastClient ? q(lastClient.text || (lastClient.kind === 'PHOTO' ? '[rasm]' : lastClient.kind === 'VIDEO' ? '[video]' : '[fayl]'), 90) : null,
    };
  });

  // Shoots today and tomorrow.
  const tomorrow = localDateString(new Date(todayEnd.getTime() + 3_600_000), tz);
  const shootRows = await ctx.db
    .select({ s: shoots, project: projects.name })
    .from(shoots)
    .leftJoin(projects, eq(projects.id, shoots.projectId))
    .where(and(eq(shoots.companyId, cid), gte(shoots.day, today), lte(shoots.day, tomorrow), sql`${shoots.status} <> 'CANCELLED'`))
    .orderBy(shoots.startsAt);

  // Money owed past due (finance viewers only).
  const fin = await ctx.db
    .select({
      party: financeRows.party,
      amount: financeRows.amount,
      paid: financeRows.paid,
    })
    .from(financeRows)
    .where(and(eq(financeRows.companyId, cid), eq(financeRows.kind, 'INCOME'), lt(financeRows.dueDate, today), sql`${financeRows.paid} < ${financeRows.amount}`));
  const byParty = new Map<string, number>();
  for (const r of fin) byParty.set(r.party, (byParty.get(r.party) ?? 0) + (r.amount - r.paid));
  const finance = fin.length
    ? {
        overdueCount: byParty.size,
        overdueAmount: [...byParty.values()].reduce((a, b) => a + b, 0),
        parties: [...byParty.entries()]
          .map(([party, debt]) => ({ party, debt }))
          .sort((a, b) => b.debt - a.debt)
          .slice(0, 5),
      }
    : null;

  const data: DigestData = {
    day: today,
    company: company.name,
    yesterday: {
      day: prev,
      done: doneY.length,
      onTime: doneY.filter((r) => r.t.completedAt! <= r.t.originalDeadline).length,
      created: createdY.length,
      present: presentY.length,
      late: lateY.length,
      absent: absentY.length,
      tracked,
    },
    totals: {
      open: open.length,
      overdue: overdue.length,
      review: inReview.length,
      blocked: blocked.length,
      dueToday: dueToday.length,
    },
    overdue: overdue
      .map((r) => ({
        ...ref(r),
        daysLate: Math.max(0, Math.floor((now.getTime() - r.t.deadline.getTime()) / 86_400_000)),
        priority: r.t.priority,
      }))
      .sort((a, b) => b.daysLate - a.daysLate)
      .slice(0, 12),
    dueToday: dueToday
      .sort((a, b) => +a.t.deadline - +b.t.deadline)
      .slice(0, 12)
      .map((r) => ({
        ...ref(r),
        deadline: r.t.deadline.toISOString(),
        status: r.t.status,
      })),
    review: reviewList.slice(0, 10),
    blocked: blocked.slice(0, 10).map((r) => ({
      ...ref(r),
      reason: lastInto(r.t.id, 'BLOCKED')?.comment ?? null,
    })),
    load: load.slice(0, 12),
    clients,
    shoots: shootRows.map((r) => ({
      day: r.s.day,
      start: r.s.startTime,
      title: r.s.title,
      project: r.project,
      location: r.s.location,
    })),
    finance,
    items: [],
  };

  // ---------------------------------------------------------------- recommendations (rules)
  const items: DigestItem[] = [];
  const names = (xs: Array<{ first: string; last: string | null }>) => xs.map((x) => fullName(x.first, x.last));
  for (const t of data.overdue.slice(0, 5)) {
    items.push({
      kind: 'OVERDUE',
      severity: t.daysLate >= 2 || t.priority === 'HIGH' ? 'HIGH' : 'MEDIUM',
      text: `#${t.number} «${q(t.title, 50)}» (${t.assignee}) — ${t.daysLate ? `${t.daysLate} kun kechikmoqda` : 'muddati o‘tdi'}. Bugun yopish yoki yangi muddatni kelishish kerak.`,
      taskId: t.taskId,
    });
  }
  for (const p of load.filter((x) => x.overdue >= 3)) {
    items.push({
      kind: 'OVERLOAD',
      severity: 'HIGH',
      text: `${p.name}da ${p.overdue} ta kechikkan vazifa — ishni qayta taqsimlash yoki muddatlarni qayta ko‘rish tavsiya etiladi.`,
      userId: p.userId,
    });
  }
  for (const c of clients.filter((x) => x.waitingHours !== null && x.waitingHours >= 2).sort((a, b) => b.waitingHours! - a.waitingHours!)) {
    items.push({
      kind: 'CLIENT_WAITING',
      severity: c.waitingHours! >= 8 ? 'HIGH' : 'MEDIUM',
      text: `«${c.project}» guruhida mijoz ${c.waitingHours} ish soatidan beri javob kutmoqda: “${c.lastText}”`,
      projectId: c.projectId,
    });
  }
  for (const r of data.review.filter((x) => x.hours >= 8)) {
    items.push({
      kind: 'REVIEW_WAITING',
      severity: r.hours >= 16 ? 'HIGH' : 'MEDIUM',
      text: `#${r.number} «${q(r.title, 50)}» ${r.hours} ish soatidan beri tekshiruvda${r.reviewer ? ` — ${r.reviewer}, ko‘rib chiqing` : ''}.`,
      taskId: r.taskId,
    });
  }
  for (const b of data.blocked) {
    items.push({
      kind: 'BLOCKED',
      severity: 'MEDIUM',
      text: `#${b.number} «${q(b.title, 50)}» bloklangan${b.reason ? `: ${q(b.reason, 80)}` : ''} — to‘siqni olib tashlash kerak.`,
      taskId: b.taskId,
    });
  }
  for (const r of open.filter((x) => x.t.revision >= 3).slice(0, 3)) {
    items.push({
      kind: 'MANY_RETURNS',
      severity: 'MEDIUM',
      text: `#${r.t.number} «${q(r.t.title, 50)}» ${r.t.revision}-marta qayta ishlanmoqda — TZni aniqlashtirib, mijoz bilan kelishib oling.`,
      taskId: r.t.id,
    });
  }
  if (dueToday.length) {
    const list = data.dueToday
      .slice(0, 4)
      .map((t) => `#${t.number} ${t.assignee}`)
      .join(', ');
    items.push({
      kind: 'DUE_TODAY',
      severity: 'LOW',
      text: `Bugun ${dueToday.length} ta vazifa muddati: ${list}${dueToday.length > 4 ? '…' : ''}.`,
    });
  }
  for (const c of clients.filter((x) => x.silentDays !== null && x.silentDays >= 10 && x.waitingHours === null)) {
    items.push({
      kind: 'CLIENT_SILENT',
      severity: 'LOW',
      text: `«${c.project}» mijozi ${c.silentDays} kundan beri yozmagan — hisobot yuborib, aloqani tiklash tavsiya etiladi.`,
      projectId: c.projectId,
    });
  }
  const workers = members.filter((m) => m.roles.includes('EMPLOYEE'));
  if (open.length >= 5) {
    const idle = workers.filter((m) => !open.some((r) => r.t.assigneeUserId === m.userId));
    if (idle.length)
      items.push({
        kind: 'IDLE',
        severity: 'LOW',
        text: `Ochiq vazifasi yo‘q: ${names(idle).slice(0, 5).join(', ')} — yuklamani tenglashtirish mumkin.`,
      });
  }
  if (tracked && lateY.length) {
    const who = lateY
      .slice(0, 4)
      .map((a) => {
        const m = members.find((x) => x.userId === a.userId);
        return m ? `${fullName(m.first, m.last)} (${a.lateMinutes} daq)` : null;
      })
      .filter(Boolean);
    items.push({
      kind: 'LATE',
      severity: 'LOW',
      text: `Kecha ${lateY.length} kishi kechikdi: ${who.join(', ')}.`,
    });
  }
  if (tracked && absentY.length) {
    items.push({
      kind: 'ABSENT',
      severity: absentY.length >= 3 ? 'MEDIUM' : 'LOW',
      text: `Kecha davomat belgilanmagan: ${names(absentY).slice(0, 5).join(', ')}${absentY.length > 5 ? '…' : ''}. Sababini aniqlang.`,
    });
  }
  for (const s of data.shoots.slice(0, 3)) {
    items.push({
      kind: 'SHOOT',
      severity: 'LOW',
      text: `${s.day === today ? 'Bugun' : 'Ertaga'} ${s.start} — «${q(s.title, 40)}» syomkasi${s.project ? ` (${s.project})` : ''}${s.location ? `, ${s.location}` : ''}. Jihozlar va jamoa tayyorligini tekshiring.`,
    });
  }
  if (finance) {
    items.push({
      kind: 'DEBT',
      severity: 'HIGH',
      finance: true,
      text: `${finance.overdueCount} mijozda muddati o‘tgan qarz: ${fmtN(finance.overdueAmount)} so‘m (${finance.parties
        .slice(0, 3)
        .map((p) => `${p.party} ${fmtN(p.debt)}`)
        .join(', ')}). To‘lovni eslatish kerak.`,
    });
  }
  data.items = items.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  return data;
}

/** The part of a digest an actor may see: money only for CEO / Finance. */
export function forActor(d: DigestData, actor: ResolvedActor): DigestData {
  if (canAccess(actor, 'finance.view', { companyId: actor.companyId })) return d;
  return { ...d, finance: null, items: d.items.filter((i) => !i.finance) };
}

export async function aiAdvice(ctx: Ctx, d: DigestData): Promise<string[] | null> {
  if (!ctx.ai) return null;
  const compact = {
    day: d.day,
    yesterday: d.yesterday,
    totals: d.totals,
    overdue: d.overdue.slice(0, 10).map((t) => ({
      t: t.title,
      who: t.assignee,
      project: t.project,
      daysLate: t.daysLate,
    })),
    review: d.review.slice(0, 6).map((t) => ({ t: t.title, reviewer: t.reviewer, hours: t.hours })),
    blocked: d.blocked.map((t) => ({ t: t.title, reason: t.reason })),
    load: d.load.slice(0, 10),
    clients: d.clients.filter((c) => c.waitingHours !== null || (c.silentDays ?? 0) >= 7),
    shoots: d.shoots,
    rules: d.items.filter((i) => !i.finance).map((i) => i.text),
  };
  try {
    const text = await ctx.ai.complete({
      system:
        'Sen marketing agentligi rahbariyati uchun kunlik tahlilchisan. Faqat berilgan maʼlumotga tayan, raqamlarni oʻzgartirma, taxmin qilma. ' +
        'Oʻzbek tilida (lotin), aniq va qisqa yoz. Bugun uchun eng muhim 3–5 ta tavsiyani ber: kim, nima, nima uchun. ' +
        'Maʼlumotni oʻzgartirish, vazifa yaratish yoki kimnidir jazolash haqida buyruq berma — faqat tavsiya. Har bir punkt "- " bilan boshlansin.',
      prompt: JSON.stringify(compact),
      maxTokens: 700,
    });
    const out = bullets(text, 6);
    return out.length ? out : null;
  } catch (e) {
    console.error('[ai] digest failed', e);
    return null;
  }
}

const MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ICON: Record<Severity, string> = { HIGH: '🔴', MEDIUM: '🟠', LOW: '🟢' };

export function digestText(d: DigestData, ai: string[] | null): string {
  const [, m, dd] = d.day.split('-').map(Number) as [number, number, number];
  const y = d.yesterday;
  const lines = [`☀️ <b>Kunlik tahlil — ${dd}-${MONTHS[m - 1]}</b>`];
  lines.push(
    `Kecha: ${y.done} ta vazifa yopildi${y.done ? ` (${Math.round((y.onTime / y.done) * 100)}% muddatida)` : ''} · Kechikkan: ${d.totals.overdue} · Tekshiruvda: ${d.totals.review} · Bugun muddat: ${d.totals.dueToday}`,
  );
  const top = d.items.slice(0, 6);
  if (top.length) {
    lines.push('', '<b>Bugun birinchi navbatda</b>');
    top.forEach((i) => lines.push(`${ICON[i.severity]} ${esc(i.text)}`));
    if (d.items.length > top.length) lines.push(`… yana ${d.items.length - top.length} ta tavsiya ilovada`);
  } else {
    lines.push('', 'Muammo ko‘rinmayapti — yaxshi kun tilaymiz! 🙌');
  }
  if (ai?.length) {
    lines.push('', '✨ <b>AI tavsiyasi</b>');
    ai.slice(0, 5).forEach((t) => lines.push(`• ${esc(t)}`));
  }
  lines.push('', '<i>Tavsiyalar maʼlumotni o‘zgartirmaydi — qaror sizda.</i>');
  return lines.join('\n');
}

/** Recipients: active leads who allowed the bot to message them. */
async function recipients(ctx: Ctx, companyId: string) {
  const rows = await ctx.db
    .select({
      userId: memberships.userId,
      roles: memberships.roles,
      tg: users.telegramId,
      canDm: users.canDm,
      perms: memberships.perms,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.companyId, companyId), eq(memberships.status, 'ACTIVE')));
  const heads = await ctx.db.select({ userId: departments.headUserId }).from(departments).where(eq(departments.companyId, companyId));
  const headIds = new Set(heads.map((h) => h.userId).filter(Boolean));
  const leader = (r: (typeof rows)[number]) => r.roles.includes('OWNER') || r.roles.includes('ADMIN');
  return rows.filter(
    (r) => r.canDm && (leader(r) || r.perms?.projectsView !== 'OWN') && (r.roles.some((x) => LEAD_ROLES.includes(x)) || headIds.has(r.userId)),
  );
}

/** Minute worker: once per working day at the digest time, build, store and send. Idempotent. */
export async function runDigests(ctx: Ctx): Promise<number> {
  const now = ctx.now();
  const list = await ctx.db.select().from(companies).where(eq(companies.digestEnabled, true));
  let sent = 0;
  for (const c of list) {
    try {
      sent += await digestFor(ctx, c, now);
    } catch (e) {
      console.error('[digest] company failed', c.id, e);
    }
  }
  return sent;
}

async function digestFor(ctx: Ctx, c: Company, now: Date): Promise<number> {
  const today = localDateString(now, c.timezone);
  if (!isWorkingDate(today, scheduleOf(c))) return 0;
  const p = localParts(now, c.timezone);
  const hm = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  if (hm < (c.digestTime ?? c.workStart)) return 0;
  const [existing] = await ctx.db
    .select({ id: digests.id, sentAt: digests.sentAt })
    .from(digests)
    .where(and(eq(digests.companyId, c.id), eq(digests.day, today)));
  if (existing?.sentAt) return 0;

  // Fresh numbers at send time (a manual refresh earlier in the morning may be stale).
  const data = await buildDigest(ctx, c, now);
  const quiet = !data.items.length && !data.yesterday.done && !data.totals.open;
  const ai = quiet ? null : await aiAdvice(ctx, data);
  const payload = data as unknown as Record<string, unknown>;
  await ctx.db
    .insert(digests)
    .values({ companyId: c.id, day: today, data: payload, ai, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: [digests.companyId, digests.day], set: { data: payload, ai, updatedAt: now } });
  // Claim the send exactly once.
  const [claimed] = await ctx.db
    .update(digests)
    .set({ sentAt: now })
    .where(and(eq(digests.companyId, c.id), eq(digests.day, today), isNull(digests.sentAt)))
    .returning({ id: digests.id });
  if (!claimed || quiet) return 0;

  let n = 0;
  for (const r of await recipients(ctx, c.id)) {
    try {
      const roles = r.roles.filter((x): x is Role => (ROLES as readonly string[]).includes(x));
      const mayFinance = scopesFor(roles, 'finance.view').length > 0;
      const view = mayFinance ? data : { ...data, finance: null, items: data.items.filter((i) => !i.finance) };
      await ctx.notifier.direct(r.tg, digestText(view, ai), { text: '📊 To‘liq tahlil', startParam: 'digest' });
      n++;
    } catch (e) {
      console.error('[digest] send failed', r.userId, e);
    }
  }
  await ctx.db.update(digests).set({ sentTo: n }).where(eq(digests.id, claimed.id));
  return n;
}

/** Today's digest for the dashboard: the stored one, or a live one (without AI) before it is sent. */
export async function todayDigest(ctx: Ctx, actor: ResolvedActor) {
  if (!canSeeDigest(actor)) throw new DomainError('FORBIDDEN', 'Kunlik tahlil rahbarlar uchun');
  const today = localDateString(ctx.now(), actor.company.timezone);
  const [row] = await ctx.db
    .select()
    .from(digests)
    .where(and(eq(digests.companyId, actor.companyId), eq(digests.day, today)));
  if (row)
    return {
      ...forActor(row.data as unknown as DigestData, actor),
      ai: row.ai ?? null,
      stored: true,
      generatedAt: row.updatedAt.toISOString(),
      aiAvailable: !!ctx.ai,
    };
  const live = await buildDigest(ctx, actor.company);
  return {
    ...forActor(live, actor),
    ai: null,
    stored: false,
    generatedAt: ctx.now().toISOString(),
    aiAvailable: !!ctx.ai,
  };
}

/** Rebuild today's digest now (CEO / admin), with AI when available. Nothing is sent. */
export async function refreshDigest(ctx: Ctx, actor: ResolvedActor) {
  if (!actor.roles.includes('OWNER') && !actor.roles.includes('ADMIN')) throw new DomainError('FORBIDDEN', 'Faqat rahbar yangilay oladi');
  const now = ctx.now();
  const today = localDateString(now, actor.company.timezone);
  const data = await buildDigest(ctx, actor.company, now);
  const ai = await aiAdvice(ctx, data);
  await ctx.db
    .insert(digests)
    .values({
      companyId: actor.companyId,
      day: today,
      data: data as unknown as Record<string, unknown>,
      ai,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [digests.companyId, digests.day],
      set: {
        data: data as unknown as Record<string, unknown>,
        ai,
        updatedAt: now,
      },
    });
  return todayDigest(ctx, actor);
}
