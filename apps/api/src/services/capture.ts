import { DEFAULT_SCHEDULE, DomainError, parseTaskText } from '@retarget/shared';
import { and, asc, eq, inArray, lte, notInArray, or, sql } from 'drizzle-orm';
import { companies, memberships, projects, tasks, users } from '../db/schema.js';
import { canSeeTask, createTask } from './tasks.js';
import { loadActor, scheduleOf, type Ctx } from './context.js';

/**
 * Tasks captured from Telegram: `/task ertaga 17:00 @ali Hisobot`, a message forwarded to the
 * bot, or `/task` as a reply in a group. The bot shows a draft and only the author's "Saqlash"
 * creates the task — through the same createTask as the app, so every rule (who may give
 * whom work, reviewer, numbering, group card) applies unchanged.
 */

export interface CaptureInput {
  /** Telegram id of the person writing. */
  telegramId: number;
  /** What follows "/task" (may be empty). */
  text: string;
  /** The message replied to or forwarded: its text becomes the title or the description. */
  source?: { text: string; author?: string | null; authorTelegramId?: number | null } | null;
  /** A group chat the command came from (a bound project group gives the project). */
  groupChatId?: number | null;
}

export interface TaskDraft {
  userId: string;
  companyId: string;
  /** Companies the author can switch the draft to (more than one membership). */
  companyOptions: Array<{ id: string; name: string }>;
  projectId: string | null;
  projectName: string | null;
  title: string;
  description: string | null;
  assigneeUserId: string;
  assigneeName: string;
  deadline: Date;
  deadlineSet: boolean;
  /** @mentions that are not members of the company (the author is the assignee then). */
  unknownMentions: string[];
  timezone: string;
  /** Kept so switching company re-resolves the mention and the source author. */
  mentions: string[];
  sourceAuthorTelegramId: number | null;
}

const name = (u: { firstName: string; lastName: string | null }) => [u.firstName, u.lastName].filter(Boolean).join(' ');

const HELP = 'Vazifa matnini yozing, masalan:\n/task ertaga 17:00 @username Oylik hisobot';

async function activeCompanies(ctx: Ctx, userId: string) {
  return ctx.db
    .select({ id: companies.id, name: companies.name })
    .from(memberships)
    .innerJoin(companies, eq(companies.id, memberships.companyId))
    .where(and(eq(memberships.userId, userId), eq(memberships.status, 'ACTIVE')))
    .orderBy(asc(memberships.joinedAt));
}

async function memberByUsername(ctx: Ctx, companyId: string, username: string) {
  const [row] = await ctx.db
    .select({ u: users })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.companyId, companyId), eq(memberships.status, 'ACTIVE'), sql`lower(${users.username}) = ${username.toLowerCase()}`));
  return row?.u ?? null;
}

async function memberByTelegram(ctx: Ctx, companyId: string, telegramId: number) {
  const [row] = await ctx.db
    .select({ u: users })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.companyId, companyId), eq(memberships.status, 'ACTIVE'), eq(users.telegramId, telegramId)));
  return row?.u ?? null;
}

export async function draftFromTelegram(ctx: Ctx, input: CaptureInput): Promise<TaskDraft> {
  const [author] = await ctx.db.select().from(users).where(eq(users.telegramId, input.telegramId));
  if (!author) throw new DomainError('FORBIDDEN', 'Avval botni oching va /start bosing');
  const options = await activeCompanies(ctx, author.id);
  if (!options.length) throw new DomainError('FORBIDDEN', 'Siz hali hech qaysi kompaniya a’zosi emassiz');

  // A bound project group decides the company and the project.
  let project: typeof projects.$inferSelect | undefined;
  if (input.groupChatId) {
    [project] = await ctx.db.select().from(projects).where(eq(projects.telegramChatId, input.groupChatId));
    if (project && !options.some((o) => o.id === project!.companyId)) project = undefined;
  }
  const companyId = project?.companyId ?? options[0]!.id;

  const parsed = parseTaskText(input.text, ctx.now(), DEFAULT_SCHEDULE);
  const sourceText = input.source?.text?.trim() ?? '';
  let title = parsed.title;
  let description: string | null = null;
  if (sourceText) {
    const firstLine = sourceText.split('\n').find((l) => l.trim())?.trim() ?? '';
    if (title.length < 2) title = firstLine;
    const from = input.source?.author ? `\n\n— ${input.source.author}, Telegram` : '';
    description = `${sourceText}${from}`.slice(0, 4000);
    if (description.trim() === title.trim()) description = null;
  }
  title = title.slice(0, 200).trim();
  if (title.length < 2) throw new DomainError('VALIDATION', HELP);

  const draft: TaskDraft = {
    userId: author.id,
    companyId,
    companyOptions: options,
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
    title,
    description,
    assigneeUserId: author.id,
    assigneeName: name(author),
    deadline: parsed.deadline,
    deadlineSet: parsed.deadlineSet,
    unknownMentions: [],
    timezone: 'Asia/Tashkent',
    mentions: parsed.mentions,
    sourceAuthorTelegramId: input.source?.authorTelegramId ?? null,
  };
  return resolveDraft(ctx, draft, input.text);
}

/** Company-dependent parts of a draft: time zone and working hours, the assignee. */
async function resolveDraft(ctx: Ctx, draft: TaskDraft, text?: string): Promise<TaskDraft> {
  const [company] = await ctx.db.select().from(companies).where(eq(companies.id, draft.companyId));
  if (!company) throw new DomainError('NOT_FOUND', 'Kompaniya topilmadi');
  draft.timezone = company.timezone;
  // Day words ("ertaga", "juma") and the default deadline follow the company's own calendar.
  if (text !== undefined) {
    const p = parseTaskText(text, ctx.now(), scheduleOf(company));
    draft.deadline = p.deadline;
    draft.deadlineSet = p.deadlineSet;
  }

  const [author] = await ctx.db.select().from(users).where(eq(users.id, draft.userId));
  let assignee = author!;
  draft.unknownMentions = [];
  const named = draft.mentions[0];
  if (named) {
    const m = await memberByUsername(ctx, draft.companyId, named);
    if (m) assignee = m;
    else draft.unknownMentions.push(named);
  } else if (draft.sourceAuthorTelegramId && draft.sourceAuthorTelegramId !== author!.telegramId) {
    // "/task" as a reply to a colleague's message: the work is theirs.
    const m = await memberByTelegram(ctx, draft.companyId, draft.sourceAuthorTelegramId);
    if (m) assignee = m;
  }
  draft.assigneeUserId = assignee.id;
  draft.assigneeName = name(assignee);
  return draft;
}

/** Re-target a draft to another of the author's companies (project groups fix the company). */
export async function switchDraftCompany(ctx: Ctx, draft: TaskDraft, companyId: string): Promise<TaskDraft> {
  if (draft.projectId) throw new DomainError('VALIDATION', 'Bu guruh loyihaga ulangan');
  if (!draft.companyOptions.some((o) => o.id === companyId)) throw new DomainError('FORBIDDEN', 'Ruxsat yo‘q');
  return resolveDraft(ctx, { ...draft, companyId });
}

/** The author pressed "Saqlash". */
export async function confirmDraft(ctx: Ctx, draft: TaskDraft) {
  const actor = await loadActor(ctx.db, draft.userId, draft.companyId);
  if (draft.deadline <= ctx.now()) throw new DomainError('VALIDATION', 'Muddat o‘tib ketdi — boshqa vaqt tanlang');
  return createTask(ctx, actor, {
    title: draft.title,
    description: draft.description ?? undefined,
    projectId: draft.projectId,
    assigneeUserId: draft.assigneeUserId,
    deadline: draft.deadline,
  });
}

// ---------------------------------------------------------------------------------- /my, /due

export interface MyTaskLine {
  id: string;
  number: number;
  title: string;
  status: string;
  deadline: Date;
  overdue: boolean;
  company: string;
  timezone: string;
  /** I am the reviewer, not the assignee. */
  toReview: boolean;
}

const CLOSED = ['DONE', 'CANCELLED'];

/**
 * Open work of the person across all their companies. `due`: overdue or due within 48 hours.
 * Only what they may see; private 1:1 tasks are fine here — this list goes to a private chat.
 */
export async function myOpenTasks(ctx: Ctx, telegramId: number, mode: 'my' | 'due'): Promise<MyTaskLine[]> {
  const [me] = await ctx.db.select().from(users).where(eq(users.telegramId, telegramId));
  if (!me) throw new DomainError('FORBIDDEN', 'Avval botni oching va /start bosing');
  const options = await activeCompanies(ctx, me.id);
  if (!options.length) return [];
  const now = ctx.now();
  const conds = [
    inArray(tasks.companyId, options.map((o) => o.id)),
    notInArray(tasks.status, CLOSED),
    or(eq(tasks.assigneeUserId, me.id), and(eq(tasks.reviewerUserId, me.id), eq(tasks.status, 'REVIEW')))!,
    // Work planned for a later project month is not on anyone's plate yet.
    sql`(${tasks.plannedMonth} is null or ${tasks.plannedMonth} <= to_char(${now}::timestamptz at time zone ${companies.timezone}, 'YYYY-MM'))`,
  ];
  if (mode === 'due') conds.push(lte(tasks.deadline, new Date(now.getTime() + 48 * 3_600_000)));
  const rows = await ctx.db
    .select({ t: tasks, company: companies.name, tz: companies.timezone })
    .from(tasks)
    .innerJoin(companies, eq(companies.id, tasks.companyId))
    .where(and(...conds))
    .orderBy(asc(tasks.deadline))
    .limit(60);
  const out: MyTaskLine[] = [];
  const actors = new Map<string, Awaited<ReturnType<typeof loadActor>>>();
  for (const r of rows) {
    let actor = actors.get(r.t.companyId);
    if (!actor) actors.set(r.t.companyId, (actor = await loadActor(ctx.db, me.id, r.t.companyId)));
    if (!canSeeTask(actor, r.t)) continue;
    out.push({
      id: r.t.id,
      number: r.t.number,
      title: r.t.title,
      status: r.t.status,
      deadline: r.t.deadline,
      overdue: r.t.deadline < now,
      company: r.company,
      timezone: r.tz,
      toReview: r.t.assigneeUserId !== me.id,
    });
  }
  return out;
}
