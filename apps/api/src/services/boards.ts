import { and, asc, eq, inArray, max, sql } from 'drizzle-orm';
import { DomainError, actionToReach, scopesFor, type TaskStatus } from '@retarget/shared';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { departments, taskChecklist, taskColumns, taskComments, taskFiles, tasks, users } from '../db/schema.js';
import { notFound, type Ctx, type ResolvedActor } from './context.js';
import { audit } from './org.js';
import { actOnTask, canSeeTask, loadTask, relationFor, taskCard } from './tasks.js';

export const BOARDS = ['main', 'DESIGN', 'MEDIA'] as const;
export type Board = (typeof BOARDS)[number];
const BOARD_STATUSES: TaskStatus[] = ['NEW', 'IN_PROGRESS', 'RETURNED', 'REVIEW', 'BLOCKED', 'DONE'];

const DEFAULT_COLUMNS: Record<Board, Array<[string, TaskStatus, string]>> = {
  main: [
    ['Yangi', 'NEW', '#9CA1AB'],
    ['Jarayonda', 'IN_PROGRESS', '#7AA7FF'],
    ['Qaytarilgan', 'RETURNED', '#F59E0B'],
    ['Tekshiruvda', 'REVIEW', '#B69BFF'],
    ['Bloklangan', 'BLOCKED', '#FB7185'],
    ['Bajarildi', 'DONE', '#34D399'],
  ],
  DESIGN: [
    ['Yangi TZ', 'NEW', '#9CA1AB'],
    ['Jarayonda', 'IN_PROGRESS', '#7AA7FF'],
    ["Ko'rib chiqilmoqda", 'REVIEW', '#B69BFF'],
    ['Qayta ishlash', 'RETURNED', '#F59E0B'],
    ['Bloklangan', 'BLOCKED', '#FB7185'],
    ['Yakunlandi', 'DONE', '#34D399'],
  ],
  MEDIA: [
    ['Kutilmoqda', 'NEW', '#9CA1AB'],
    ['Jarayonda', 'IN_PROGRESS', '#7AA7FF'],
    ['Montajda', 'IN_PROGRESS', '#A3E635'],
    ["Ko'rib chiqilmoqda", 'REVIEW', '#B69BFF'],
    ['Qayta ishlash', 'RETURNED', '#F59E0B'],
    ['Bloklangan', 'BLOCKED', '#FB7185'],
    ['Bajarildi', 'DONE', '#34D399'],
  ],
};

const boardSchema = z.enum(BOARDS);

/** Editing columns is for people who run work beyond their own tasks. */
function assertCanEditColumns(actor: ResolvedActor) {
  if (!scopesFor(actor.roles, 'task.manage').some((s) => s !== 'OWN')) {
    throw new DomainError('FORBIDDEN', "Ustunlarni faqat rahbarlar o'zgartiradi");
  }
}

export async function ensureColumns(db: Db, companyId: string, board: Board) {
  const existing = await db
    .select()
    .from(taskColumns)
    .where(and(eq(taskColumns.companyId, companyId), eq(taskColumns.board, board)))
    .orderBy(asc(taskColumns.position));
  if (existing.length) return existing;
  // Concurrent first loads: the advisory lock makes seeding happen once.
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${companyId}:${board}`}))`);
    const again = await tx
      .select()
      .from(taskColumns)
      .where(and(eq(taskColumns.companyId, companyId), eq(taskColumns.board, board)))
      .orderBy(asc(taskColumns.position));
    if (again.length) return again;
    return tx
      .insert(taskColumns)
      .values(DEFAULT_COLUMNS[board].map(([name, status, color], i) => ({ companyId, board, name, status, color, position: i })))
      .returning();
  });
}

export async function listColumns(ctx: Ctx, actor: ResolvedActor, board: string) {
  return ensureColumns(ctx.db, actor.companyId, boardSchema.parse(board));
}

export const columnInput = z.object({
  name: z.string().trim().min(1).max(40),
  status: z.enum(BOARD_STATUSES as [TaskStatus, ...TaskStatus[]]),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
});

export async function createColumn(ctx: Ctx, actor: ResolvedActor, board: string, input: z.input<typeof columnInput>) {
  assertCanEditColumns(actor);
  const b = boardSchema.parse(board);
  const data = columnInput.parse(input);
  const cols = await ensureColumns(ctx.db, actor.companyId, b);
  if (cols.length >= 12) throw new DomainError('VALIDATION', "Ko'pi bilan 12 ta ustun");
  // A new column goes right after the last column of the same status, so the board stays in flow order.
  const lastSame = [...cols].reverse().find((c) => c.status === data.status);
  const insertAt = lastSame ? lastSame.position + 1 : cols.length;
  return ctx.db.transaction(async (tx) => {
    for (const c of cols.filter((c) => c.position >= insertAt)) {
      await tx.update(taskColumns).set({ position: c.position + 1 }).where(eq(taskColumns.id, c.id));
    }
    const [col] = await tx
      .insert(taskColumns)
      .values({ companyId: actor.companyId, board: b, name: data.name, status: data.status, color: data.color ?? '#34D399', position: insertAt })
      .returning();
    await audit(tx as unknown as Db, actor, 'column.create', 'task_column', col!.id, { board: b, ...data });
    return col!;
  });
}

async function loadColumn(db: Db, companyId: string, id: string) {
  const [c] = await db.select().from(taskColumns).where(and(eq(taskColumns.id, id), eq(taskColumns.companyId, companyId)));
  if (!c) throw notFound('Ustun');
  return c;
}

export async function updateColumn(ctx: Ctx, actor: ResolvedActor, id: string, input: { name?: string; color?: string }) {
  assertCanEditColumns(actor);
  await loadColumn(ctx.db, actor.companyId, id);
  const data = columnInput.pick({ name: true, color: true }).partial().parse(input);
  const [c] = await ctx.db.update(taskColumns).set(data).where(eq(taskColumns.id, id)).returning();
  return c!;
}

/** Reorder within a board. Columns may not leave their status group order constraints — any order is allowed. */
export async function reorderColumns(ctx: Ctx, actor: ResolvedActor, board: string, ids: string[]) {
  assertCanEditColumns(actor);
  const b = boardSchema.parse(board);
  const cols = await ensureColumns(ctx.db, actor.companyId, b);
  if (ids.length !== cols.length || !cols.every((c) => ids.includes(c.id))) throw new DomainError('VALIDATION', "Ustunlar ro'yxati to'liq emas");
  await ctx.db.transaction(async (tx) => {
    for (const [i, cid] of ids.entries()) await tx.update(taskColumns).set({ position: i }).where(eq(taskColumns.id, cid));
  });
  return ensureColumns(ctx.db, actor.companyId, b);
}

export async function deleteColumn(ctx: Ctx, actor: ResolvedActor, id: string) {
  assertCanEditColumns(actor);
  const col = await loadColumn(ctx.db, actor.companyId, id);
  const siblings = await ctx.db
    .select()
    .from(taskColumns)
    .where(and(eq(taskColumns.companyId, actor.companyId), eq(taskColumns.board, col.board), eq(taskColumns.status, col.status)));
  if (siblings.length <= 1) {
    throw new DomainError('VALIDATION', "Bu holatdagi yagona ustun — o'chirib bo'lmaydi, faqat nomini o'zgartiring");
  }
  // Cards fall back to the first remaining column of the same status (column_id → null).
  await ctx.db.delete(taskColumns).where(eq(taskColumns.id, id));
  await audit(ctx.db, actor, 'column.delete', 'task_column', id, { name: col.name, board: col.board });
}

// ------------------------------------------------------------------------------------------

/**
 * Drag & drop. Inside one status it only changes placement; across statuses it performs the
 * same action a button would (so no one can approve their own work by dragging).
 */
export async function moveTask(ctx: Ctx, actor: ResolvedActor, taskId: string, columnId: string, comment?: string | null) {
  const t = await loadTask(ctx.db, actor.companyId, taskId);
  if (!canSeeTask(actor, t)) throw notFound('Vazifa');
  const col = await loadColumn(ctx.db, actor.companyId, columnId);
  const rel = relationFor(actor, t);
  if (col.status !== t.status) {
    const [dep] = t.departmentId ? await ctx.db.select().from(departments).where(eq(departments.id, t.departmentId)) : [];
    const [{ files }] = (await ctx.db
      .select({ files: sql<number>`count(*)::int` })
      .from(taskFiles)
      .where(and(eq(taskFiles.taskId, taskId), eq(taskFiles.revision, t.revision)))) as [{ files: number }];
    const action = actionToReach(
      { status: t.status as TaskStatus, revision: t.revision, currentRevisionFileCount: files, requireFileOnSubmit: dep?.requireFileOnSubmit ?? false },
      col.status as TaskStatus,
      rel,
    );
    if (!action) throw new DomainError('INVALID_TRANSITION', `Vazifani «${col.name}» ustuniga o'tkazishga ruxsat yo'q`);
    await actOnTask(ctx, actor, taskId, action, comment);
  } else if (!(rel.isAssignee || rel.isReviewer || rel.canManage)) {
    throw new DomainError('FORBIDDEN', "Bu vazifani ko'chirishga ruxsat yo'q");
  }
  const [u] = await ctx.db.update(tasks).set({ columnId: col.id, updatedAt: ctx.now() }).where(eq(tasks.id, taskId)).returning();
  return u!;
}

// ------------------------------------------------------------------------------------------ comments

export async function addComment(ctx: Ctx, actor: ResolvedActor, taskId: string, body: string) {
  const t = await loadTask(ctx.db, actor.companyId, taskId);
  if (!canSeeTask(actor, t)) throw notFound('Vazifa');
  const text = z.string().trim().min(1).max(4000).parse(body);
  const [c] = await ctx.db.insert(taskComments).values({ taskId, userId: actor.userId, body: text, createdAt: ctx.now() }).returning();
  // Tell the people in the task (not the author) — a comment nobody sees is lost.
  const card = await taskCard(ctx.db, taskId);
  const [me] = await ctx.db.select().from(users).where(eq(users.id, actor.userId));
  const recipients = [card.assignee, card.reviewer].filter((p): p is NonNullable<typeof p> => !!p && p.id !== actor.userId);
  for (const p of recipients) {
    await ctx.notifier
      .direct(p.telegramId, `💬 <b>#${card.number} · ${escapeHtml(card.title)}</b>\n${escapeHtml(me?.firstName ?? '')}: ${escapeHtml(text.slice(0, 500))}`)
      .catch(() => undefined);
  }
  return c!;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function listComments(db: Db, taskId: string) {
  return db
    .select({ id: taskComments.id, body: taskComments.body, createdAt: taskComments.createdAt, userId: taskComments.userId, firstName: users.firstName, lastName: users.lastName, photoUrl: users.photoUrl })
    .from(taskComments)
    .innerJoin(users, eq(users.id, taskComments.userId))
    .where(eq(taskComments.taskId, taskId))
    .orderBy(asc(taskComments.createdAt));
}

// ------------------------------------------------------------------------------------------ checklist

async function assertCanWorkOn(ctx: Ctx, actor: ResolvedActor, taskId: string) {
  const t = await loadTask(ctx.db, actor.companyId, taskId);
  if (!canSeeTask(actor, t)) throw notFound('Vazifa');
  const rel = relationFor(actor, t);
  if (!(rel.isAssignee || rel.isReviewer || rel.canManage || t.createdBy === actor.userId)) {
    throw new DomainError('FORBIDDEN', "Bu vazifani o'zgartirishga ruxsat yo'q");
  }
  return t;
}

export async function addChecklistItem(ctx: Ctx, actor: ResolvedActor, taskId: string, text: string) {
  await assertCanWorkOn(ctx, actor, taskId);
  const value = z.string().trim().min(1).max(300).parse(text);
  const [{ n }] = (await ctx.db.select({ n: max(taskChecklist.position) }).from(taskChecklist).where(eq(taskChecklist.taskId, taskId))) as [{ n: number | null }];
  const [i] = await ctx.db.insert(taskChecklist).values({ taskId, text: value, position: (n ?? -1) + 1 }).returning();
  return i!;
}

export async function updateChecklistItem(ctx: Ctx, actor: ResolvedActor, taskId: string, itemId: string, input: { done?: boolean; text?: string }) {
  await assertCanWorkOn(ctx, actor, taskId);
  const data = z.object({ done: z.boolean().optional(), text: z.string().trim().min(1).max(300).optional() }).parse(input);
  const [i] = await ctx.db
    .update(taskChecklist)
    .set(data)
    .where(and(eq(taskChecklist.id, itemId), eq(taskChecklist.taskId, taskId)))
    .returning();
  if (!i) throw notFound('Band');
  return i;
}

export async function deleteChecklistItem(ctx: Ctx, actor: ResolvedActor, taskId: string, itemId: string) {
  await assertCanWorkOn(ctx, actor, taskId);
  await ctx.db.delete(taskChecklist).where(and(eq(taskChecklist.id, itemId), eq(taskChecklist.taskId, taskId)));
}

export async function listChecklist(db: Db, taskId: string) {
  return db.select().from(taskChecklist).where(eq(taskChecklist.taskId, taskId)).orderBy(asc(taskChecklist.position));
}

/** Counts for cards: checklist done/total and comments, for many tasks at once. */
export async function cardCounts(db: Db, taskIds: string[]) {
  if (!taskIds.length) return new Map<string, { checklistDone: number; checklistTotal: number; comments: number }>();
  const cl = await db
    .select({ taskId: taskChecklist.taskId, total: sql<number>`count(*)::int`, done: sql<number>`count(*) filter (where ${taskChecklist.done})::int` })
    .from(taskChecklist)
    .where(inArray(taskChecklist.taskId, taskIds))
    .groupBy(taskChecklist.taskId);
  const cm = await db
    .select({ taskId: taskComments.taskId, n: sql<number>`count(*)::int` })
    .from(taskComments)
    .where(inArray(taskComments.taskId, taskIds))
    .groupBy(taskComments.taskId);
  const out = new Map<string, { checklistDone: number; checklistTotal: number; comments: number }>();
  for (const id of taskIds) {
    const c = cl.find((x) => x.taskId === id);
    out.set(id, { checklistDone: c?.done ?? 0, checklistTotal: c?.total ?? 0, comments: cm.find((x) => x.taskId === id)?.n ?? 0 });
  }
  return out;
}

