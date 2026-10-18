import { DomainError, nextOccurrence, type Recurrence } from '@retarget/shared';
import { and, asc, eq, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { companies, taskChecklist, taskEvents, tasks } from '../db/schema.js';
import { loadActor, scheduleOf, type Ctx } from './context.js';
import { createTask } from './tasks.js';

/**
 * One tick of the repeating-task worker (every minute, next to reminders). A repeating task
 * gets its next copy once its deadline has passed or it was closed, whichever comes first —
 * exactly once: the copy points back at it and that link is unique.
 *
 * The copy is created as its giver (same rights, numbering, reviewer and group card as a task
 * made by hand). If the giver or the assignee has left the company the series stops quietly,
 * with a note in the task's history.
 */
export async function runRecurring(ctx: Ctx): Promise<number> {
  const now = ctx.now();
  const copy = alias(tasks, 'copy');
  const due = await ctx.db
    .select({ t: tasks, c: companies })
    .from(tasks)
    .innerJoin(companies, eq(companies.id, tasks.companyId))
    .leftJoin(copy, eq(copy.repeatedFromId, tasks.id))
    .where(and(isNotNull(tasks.recurrence), isNull(copy.id), or(lte(tasks.deadline, now), inArray(tasks.status, ['DONE', 'CANCELLED']))))
    .orderBy(asc(tasks.deadline))
    .limit(200);

  let created = 0;
  for (const { t, c } of due) {
    try {
      const actor = await loadActor(ctx.db, t.createdBy, t.companyId);
      const items = await ctx.db.select({ text: taskChecklist.text }).from(taskChecklist).where(eq(taskChecklist.taskId, t.id)).orderBy(asc(taskChecklist.position), asc(taskChecklist.createdAt));
      await createTask(
        ctx,
        actor,
        {
          title: t.title,
          description: t.description ?? undefined,
          projectId: t.projectId,
          departmentId: t.departmentId,
          assigneeUserId: t.assigneeUserId,
          reviewerUserId: t.reviewerUserId,
          deadline: nextOccurrence(t.deadline, t.recurrence as Recurrence, scheduleOf(c), now),
          priority: t.priority as never,
          points: t.points,
          isPrivate: t.isPrivate,
          format: t.format,
          platform: t.platform,
          links: t.links,
          recurrence: t.recurrence as Recurrence,
          checklist: items.map((i) => i.text),
        },
        { repeatedFromId: t.id },
      );
      created++;
    } catch (err) {
      if (err instanceof DomainError) {
        // Someone left, a project month is closed, … — stop the series instead of retrying forever.
        await ctx.db.update(tasks).set({ recurrence: null }).where(eq(tasks.id, t.id));
        await ctx.db.insert(taskEvents).values({ createdAt: now, taskId: t.id, actorUserId: t.createdBy, action: 'REPEAT_STOPPED', comment: err.message });
      } else if (!isDuplicate(err)) {
        console.error('[recurring] task failed', t.id, err);
      }
    }
  }
  return created;
}

/** Two workers raced for the same task: the unique link already made the copy. */
function isDuplicate(err: unknown): boolean {
  return String((err as { code?: string })?.code ?? '') === '23505' || /tasks_repeated_from_uq/.test(String((err as Error)?.message ?? ''));
}
