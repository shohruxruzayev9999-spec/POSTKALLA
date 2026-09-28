import { and, asc, desc, eq, inArray, max, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  DomainError,
  TASK_PRIORITIES,
  TASK_STATUSES,
  allowedActions,
  applyTaskAction,
  canAccess,
  checkAccess,
  type TaskAction,
  type TaskActorRelation,
  type TaskStatus,
  type Target,
} from '@retarget/shared';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { departments, memberships, projects, taskEvents, taskFiles, tasks, users } from '../db/schema.js';
import { notFound, type Ctx, type ResolvedActor } from './context.js';
import type { TaskCard } from './notifier.js';
import { cardCounts, listChecklist, listComments } from './boards.js';

export type TaskRow = typeof tasks.$inferSelect;

export function taskTarget(t: Pick<TaskRow, 'companyId' | 'departmentId' | 'projectId' | 'assigneeUserId' | 'reviewerUserId' | 'createdBy'>): Target {
  return {
    companyId: t.companyId,
    departmentId: t.departmentId,
    projectId: t.projectId,
    ownerUserIds: [t.assigneeUserId, ...(t.reviewerUserId ? [t.reviewerUserId] : [])],
  };
}

/** Seeing a task: the role allows it, and a private 1:1 task only for the people in it and the Owner. */
export function canSeeTask(actor: ResolvedActor, t: TaskRow): boolean {
  if (!canAccess(actor, 'task.view', taskTarget(t))) return false;
  if (!t.isPrivate) return true;
  return actor.roles.includes('OWNER') || [t.assigneeUserId, t.reviewerUserId, t.createdBy].includes(actor.userId);
}

/** Rights beyond "my own task" — used for cancel, re-assign, deadline changes. */
function managesBeyondOwn(actor: ResolvedActor, t: TaskRow): boolean {
  return canAccess(actor, 'task.manage', { ...taskTarget(t), ownerUserIds: [] });
}

export function relationFor(actor: ResolvedActor, t: TaskRow): TaskActorRelation {
  return {
    isAssignee: t.assigneeUserId === actor.userId,
    isReviewer: t.reviewerUserId === actor.userId,
    canReview: canAccess(actor, 'task.review', { ...taskTarget(t), ownerUserIds: [] }),
    canManage: managesBeyondOwn(actor, t),
  };
}

const displayName = (u: { firstName: string; lastName: string | null }) => [u.firstName, u.lastName].filter(Boolean).join(' ');

// ------------------------------------------------------------------------------------------

export const createTaskInput = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(4000).optional(),
  projectId: z.string().uuid().nullable().optional(),
  departmentId: z.string().uuid().nullable().optional(),
  assigneeUserId: z.string().uuid(),
  reviewerUserId: z.string().uuid().nullable().optional(),
  deadline: z.coerce.date(),
  priority: z.enum(TASK_PRIORITIES).default('MEDIUM'),
  points: z.number().int().min(1).max(20).default(1),
  isPrivate: z.boolean().default(false),
  format: z.string().trim().max(40).nullable().optional(),
  platform: z.string().trim().max(40).nullable().optional(),
  links: z.array(z.string().trim().url().max(500)).max(5).default([]),
  columnId: z.string().uuid().nullable().optional(),
});

export async function createTask(ctx: Ctx, actor: ResolvedActor, input: z.input<typeof createTaskInput>) {
  const data = createTaskInput.parse(input);
  if (data.deadline.getTime() <= ctx.now().getTime()) throw new DomainError('VALIDATION', "Deadline kelajakda bo'lishi kerak");

  const [assignee] = await ctx.db
    .select()
    .from(memberships)
    .where(and(eq(memberships.companyId, actor.companyId), eq(memberships.userId, data.assigneeUserId), eq(memberships.status, 'ACTIVE')));
  if (!assignee) throw new DomainError('VALIDATION', "Ijrochi kompaniya a'zosi emas");

  let project: typeof projects.$inferSelect | undefined;
  if (data.projectId) {
    [project] = await ctx.db.select().from(projects).where(and(eq(projects.id, data.projectId), eq(projects.companyId, actor.companyId)));
    if (!project) throw notFound('Loyiha');
  }
  const departmentId = data.departmentId ?? assignee.departmentId ?? null;
  let department: typeof departments.$inferSelect | undefined;
  if (departmentId) {
    [department] = await ctx.db.select().from(departments).where(and(eq(departments.id, departmentId), eq(departments.companyId, actor.companyId)));
    if (!department) throw notFound("Bo'lim");
  }

  // Default reviewer: the project manager, else the department head — never the assignee.
  let reviewerUserId = data.reviewerUserId ?? project?.managerUserId ?? department?.headUserId ?? null;
  if (reviewerUserId === data.assigneeUserId) reviewerUserId = department?.headUserId !== data.assigneeUserId ? (department?.headUserId ?? null) : null;
  if (reviewerUserId) {
    const [rv] = await ctx.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.companyId, actor.companyId), eq(memberships.userId, reviewerUserId), eq(memberships.status, 'ACTIVE')));
    if (!rv) throw new DomainError('VALIDATION', "Tekshiruvchi kompaniya a'zosi emas");
  }

  const draft = {
    companyId: actor.companyId,
    departmentId,
    projectId: data.projectId ?? null,
    assigneeUserId: data.assigneeUserId,
    reviewerUserId,
    createdBy: actor.userId,
  };
  checkAccess(actor, 'task.manage', taskTarget(draft));

  const task = await ctx.db.transaction(async (tx) => {
    // Per-company numbering; the advisory lock serialises concurrent creates in one company.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${actor.companyId}))`);
    const [{ n }] = (await tx.select({ n: max(tasks.number) }).from(tasks).where(eq(tasks.companyId, actor.companyId))) as [{ n: number | null }];
    const [t] = await tx
      .insert(tasks)
      .values({
        ...draft,
        number: (n ?? 0) + 1,
        title: data.title,
        description: data.description ?? null,
        priority: data.priority,
        points: data.points,
        isPrivate: data.isPrivate,
        format: data.format ?? null,
        platform: data.platform ?? null,
        links: data.links,
        columnId: data.columnId ?? null,
        deadline: data.deadline,
        originalDeadline: data.deadline,
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
      })
      .returning();
    await tx.insert(taskEvents).values({ taskId: t!.id, actorUserId: actor.userId, action: 'CREATE', toStatus: 'NEW' });
    return t!;
  });

  await publishCard(ctx, task.id);
  return task;
}

export async function loadTask(db: Db, companyId: string, taskId: string): Promise<TaskRow> {
  const [t] = await db.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.companyId, companyId)));
  if (!t) throw notFound('Vazifa');
  return t;
}

async function loadVisibleTask(ctx: Ctx, actor: ResolvedActor, taskId: string): Promise<TaskRow> {
  const t = await loadTask(ctx.db, actor.companyId, taskId);
  // Hide existence from people who may not see it.
  if (!canSeeTask(actor, t)) throw notFound('Vazifa');
  return t;
}

export async function actOnTask(ctx: Ctx, actor: ResolvedActor, taskId: string, action: TaskAction, comment?: string | null) {
  await loadVisibleTask(ctx, actor, taskId);
  const updated = await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select id from tasks where id = ${taskId} for update`);
    const [t] = await tx.select().from(tasks).where(eq(tasks.id, taskId));
    const [dep] = t!.departmentId ? await tx.select().from(departments).where(eq(departments.id, t!.departmentId)) : [];
    const [{ files }] = (await tx
      .select({ files: sql<number>`count(*)::int` })
      .from(taskFiles)
      .where(and(eq(taskFiles.taskId, taskId), eq(taskFiles.revision, t!.revision)))) as [{ files: number }];

    const result = applyTaskAction(
      { status: t!.status as TaskStatus, revision: t!.revision, currentRevisionFileCount: files, requireFileOnSubmit: dep?.requireFileOnSubmit ?? false },
      action,
      relationFor(actor, t!),
      comment,
    );
    const now = ctx.now();
    const [u] = await tx
      .update(tasks)
      .set({
        status: result.status,
        revision: result.revision,
        // The card leaves its column when the status changes; the board shows it in the first
        // column of the new status (or wherever moveTask puts it).
        columnId: result.status === t!.status ? t!.columnId : null,
        completedAt: result.status === 'DONE' ? now : action === 'REOPEN' ? null : t!.completedAt,
        updatedAt: now,
      })
      .where(eq(tasks.id, taskId))
      .returning();
    await tx.insert(taskEvents).values({ taskId, actorUserId: actor.userId, action, fromStatus: t!.status, toStatus: result.status, comment: comment?.trim() || null });
    return u!;
  });

  await publishCard(ctx, updated.id);
  const card = await taskCard(ctx.db, updated.id);
  const [me] = await ctx.db.select().from(users).where(eq(users.id, actor.userId));
  await safe(() => ctx.notifier.taskChanged(card, action, me ? displayName(me) : '', comment?.trim() || null));
  return updated;
}

export const updateTaskInput = z.object({
  title: z.string().trim().min(2).max(200).optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  deadline: z.coerce.date().optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  points: z.number().int().min(1).max(20).optional(),
  assigneeUserId: z.string().uuid().optional(),
  reviewerUserId: z.string().uuid().nullable().optional(),
  reason: z.string().trim().max(500).optional(),
  format: z.string().trim().max(40).nullable().optional(),
  platform: z.string().trim().max(40).nullable().optional(),
  links: z.array(z.string().trim().url().max(500)).max(5).optional(),
});

export async function updateTask(ctx: Ctx, actor: ResolvedActor, taskId: string, input: z.input<typeof updateTaskInput>) {
  const t = await loadVisibleTask(ctx, actor, taskId);
  const data = updateTaskInput.parse(input);
  const isCreator = t.createdBy === actor.userId;
  const manager = managesBeyondOwn(actor, t);
  // The assignee may edit the wording of a task they created for themself, but only a manager
  // moves deadlines or re-assigns — otherwise the motivation score could be gamed.
  const sensitive = data.deadline || data.assigneeUserId || data.reviewerUserId !== undefined || data.points || data.priority;
  // Links, format and platform are working material — the assignee may maintain them too.
  const onlyMaterial = Object.keys(data).every((k) => ['links', 'format', 'platform'].includes(k));
  const isAssignee = t.assigneeUserId === actor.userId;
  const allowed = sensitive ? manager : manager || isCreator || (onlyMaterial && isAssignee);
  if (!allowed) throw new DomainError('FORBIDDEN', "Bu vazifani o'zgartirishga ruxsat yo'q");
  if (data.deadline && !data.reason) throw new DomainError('COMMENT_REQUIRED', 'Deadline o\'zgarishi sababini yozing');
  if ((data.assigneeUserId && data.assigneeUserId === (data.reviewerUserId ?? t.reviewerUserId)) || (data.reviewerUserId && data.reviewerUserId === (data.assigneeUserId ?? t.assigneeUserId))) {
    throw new DomainError('VALIDATION', "Ijrochi o'zini tekshira olmaydi");
  }
  for (const uid of [data.assigneeUserId, data.reviewerUserId].filter(Boolean) as string[]) {
    const [m] = await ctx.db.select().from(memberships).where(and(eq(memberships.companyId, actor.companyId), eq(memberships.userId, uid), eq(memberships.status, 'ACTIVE')));
    if (!m) throw new DomainError('VALIDATION', "Foydalanuvchi kompaniya a'zosi emas");
  }
  const { reason, ...fields } = data;
  const [u] = await ctx.db.update(tasks).set({ ...fields, updatedAt: ctx.now() }).where(eq(tasks.id, taskId)).returning();
  await ctx.db.insert(taskEvents).values({
    taskId,
    actorUserId: actor.userId,
    action: data.deadline ? 'DEADLINE_CHANGE' : 'EDIT',
    comment: reason ?? null,
    data: { before: { deadline: t.deadline, assigneeUserId: t.assigneeUserId }, after: fields },
  });
  await publishCard(ctx, taskId);
  return u!;
}

export const addFileInput = z.object({
  telegramFileId: z.string().min(1).max(300),
  fileName: z.string().max(255).optional(),
  kind: z.enum(['document', 'photo', 'video', 'link']).default('document'),
});

export async function addTaskFile(ctx: Ctx, actor: ResolvedActor, taskId: string, input: z.input<typeof addFileInput>) {
  const t = await loadVisibleTask(ctx, actor, taskId);
  if (t.assigneeUserId !== actor.userId && !managesBeyondOwn(actor, t)) throw new DomainError('FORBIDDEN', 'Faqat ijrochi fayl yuklaydi');
  const data = addFileInput.parse(input);
  const [f] = await ctx.db.insert(taskFiles).values({ taskId, revision: t.revision, uploadedBy: actor.userId, ...data }).returning();
  await ctx.db.insert(taskEvents).values({ taskId, actorUserId: actor.userId, action: 'FILE', data: { fileName: data.fileName, revision: t.revision } });
  return f!;
}

// ------------------------------------------------------------------------------------------

export const listTasksInput = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  projectId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  assigneeUserId: z.string().uuid().optional(),
  mine: z.coerce.boolean().optional(),
  includeClosed: z.coerce.boolean().optional(),
  /** Department board: only tasks of departments in this section. */
  section: z.enum(['DESIGN', 'MEDIA']).optional(),
});

export async function listTasks(ctx: Ctx, actor: ResolvedActor, input: z.input<typeof listTasksInput> = {}) {
  const f = listTasksInput.parse(input);
  const assignee = alias(users, 'assignee');
  const conds = [eq(tasks.companyId, actor.companyId)];
  if (f.status) conds.push(eq(tasks.status, f.status));
  if (f.projectId) conds.push(eq(tasks.projectId, f.projectId));
  if (f.departmentId) conds.push(eq(tasks.departmentId, f.departmentId));
  if (f.assigneeUserId) conds.push(eq(tasks.assigneeUserId, f.assigneeUserId));
  if (f.section) {
    const secDeps = await ctx.db
      .select({ id: departments.id })
      .from(departments)
      .where(and(eq(departments.companyId, actor.companyId), eq(departments.section, f.section)));
    if (!secDeps.length) return [];
    conds.push(inArray(tasks.departmentId, secDeps.map((d) => d.id)));
  }
  if (f.mine) conds.push(or(eq(tasks.assigneeUserId, actor.userId), eq(tasks.reviewerUserId, actor.userId))!);
  if (!f.includeClosed && !f.status) {
    // Closed tasks only from the last 14 days keep the board light.
    conds.push(or(inArray(tasks.status, ['NEW', 'IN_PROGRESS', 'REVIEW', 'RETURNED', 'BLOCKED']), sql`${tasks.updatedAt} > ${new Date(ctx.now().getTime() - 14 * 86_400_000)}`)!);
  }
  const rows = await ctx.db
    .select({ t: tasks, project: projects.name, projectColor: projects.color, a: assignee })
    .from(tasks)
    .innerJoin(assignee, eq(assignee.id, tasks.assigneeUserId))
    .leftJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(...conds))
    .orderBy(asc(tasks.deadline))
    .limit(1000);
  const visible = rows.filter((r) => canSeeTask(actor, r.t));
  const counts = await cardCounts(ctx.db, visible.map((r) => r.t.id));
  return visible
    .map((r) => ({
      ...r.t,
      ...counts.get(r.t.id)!,
      project: r.project,
      projectColor: r.projectColor,
      assignee: { id: r.a.id, name: displayName(r.a), photoUrl: r.a.photoUrl },
      overdue: !['DONE', 'CANCELLED'].includes(r.t.status) && r.t.deadline < ctx.now(),
      actions: allowedActions(
        { status: r.t.status as TaskStatus, revision: r.t.revision, currentRevisionFileCount: 1, requireFileOnSubmit: false },
        relationFor(actor, r.t),
      ),
    }));
}

export async function getTask(ctx: Ctx, actor: ResolvedActor, taskId: string) {
  const t = await loadVisibleTask(ctx, actor, taskId);
  const events = await ctx.db
    .select({ e: taskEvents, name: users.firstName, lastName: users.lastName })
    .from(taskEvents)
    .leftJoin(users, eq(users.id, taskEvents.actorUserId))
    .where(eq(taskEvents.taskId, taskId))
    .orderBy(desc(taskEvents.createdAt));
  const files = await ctx.db.select().from(taskFiles).where(eq(taskFiles.taskId, taskId)).orderBy(desc(taskFiles.createdAt));
  const [dep] = t.departmentId ? await ctx.db.select().from(departments).where(eq(departments.id, t.departmentId)) : [];
  const card = await taskCard(ctx.db, taskId);
  const currentFiles = files.filter((f) => f.revision === t.revision).length;
  const comments = await listComments(ctx.db, taskId);
  const checklist = await listChecklist(ctx.db, taskId);
  return {
    ...t,
    comments: comments.map((c) => ({ ...c, name: [c.firstName, c.lastName].filter(Boolean).join(' ') })),
    checklist,
    project: card.projectName,
    assignee: card.assignee,
    reviewer: card.reviewer,
    department: dep?.name ?? null,
    overdue: !['DONE', 'CANCELLED'].includes(t.status) && t.deadline < ctx.now(),
    files,
    events: events.map((e) => ({ ...e.e, actorName: e.name ? [e.name, e.lastName].filter(Boolean).join(' ') : null })),
    actions: allowedActions(
      { status: t.status as TaskStatus, revision: t.revision, currentRevisionFileCount: currentFiles, requireFileOnSubmit: dep?.requireFileOnSubmit ?? false },
      relationFor(actor, t),
    ),
    canEdit: managesBeyondOwn(actor, t),
  };
}

// ------------------------------------------------------------------------------------------

export async function taskCard(db: Db, taskId: string): Promise<TaskCard> {
  const a = alias(users, 'a');
  const r = alias(users, 'r');
  const [row] = await db
    .select({ t: tasks, a, r, project: projects.name })
    .from(tasks)
    .innerJoin(a, eq(a.id, tasks.assigneeUserId))
    .leftJoin(r, eq(r.id, tasks.reviewerUserId))
    .leftJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(tasks.id, taskId));
  if (!row) throw notFound('Vazifa');
  const person = (u: typeof users.$inferSelect) => ({ id: u.id, name: displayName(u), username: u.username, telegramId: u.telegramId });
  return {
    id: row.t.id,
    number: row.t.number,
    title: row.t.title,
    status: row.t.status,
    priority: row.t.priority,
    deadline: row.t.deadline,
    revision: row.t.revision,
    projectName: row.project,
    assignee: person(row.a),
    reviewer: row.r ? person(row.r) : null,
    groupChatId: row.t.groupChatId,
    groupMessageId: row.t.groupMessageId,
  };
}

/** Post or refresh the task card in the project's Telegram group. */
export async function publishCard(ctx: Ctx, taskId: string): Promise<void> {
  const [row] = await ctx.db
    .select({ t: tasks, chat: projects.telegramChatId })
    .from(tasks)
    .leftJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(tasks.id, taskId));
  if (!row || row.t.isPrivate) return; // 1:1 tasks never go to a group
  const card = await taskCard(ctx.db, taskId);
  if (!card.groupChatId && row.chat) card.groupChatId = row.chat;
  if (!card.groupChatId) return;
  const sent = await safe(() => ctx.notifier.upsertTaskCard(card));
  if (sent && (sent.chatId !== row.t.groupChatId || sent.messageId !== row.t.groupMessageId)) {
    await ctx.db.update(tasks).set({ groupChatId: sent.chatId, groupMessageId: sent.messageId }).where(eq(tasks.id, taskId));
  }
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.error('[notifier]', err);
    return null;
  }
}

