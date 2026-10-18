import { calendarWrite, monthAt } from './projectMonths.js';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DomainError, canAccess, checkAccess } from '@retarget/shared';
import { z } from 'zod';
import { clients, memberships, projectMembers, projectMonths, projects, tasks } from '../db/schema.js';
import { notFound, type Ctx, type ResolvedActor } from './context.js';
import { audit } from './org.js';

export const projectInput = z.object({
  name: z.string().trim().min(1).max(80),
  clientName: z.string().trim().max(80).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  status: z.enum(['ACTIVE', 'PAUSED', 'DONE']).optional(),
  managerUserId: z.string().uuid().nullable().optional(),
  deadline: z.coerce.date().nullable().optional(),
  memberUserIds: z.array(z.string().uuid()).max(200).optional(),
});

async function assertMembers(ctx: Ctx, companyId: string, userIds: string[]) {
  if (!userIds.length) return;
  const rows = await ctx.db
    .select({ id: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.companyId, companyId), inArray(memberships.userId, userIds), eq(memberships.status, 'ACTIVE')));
  if (rows.length !== new Set(userIds).size) throw new DomainError('VALIDATION', "Ba'zi foydalanuvchilar kompaniya a'zosi emas");
}

async function createProjectInner(ctx: Ctx, actor: ResolvedActor, input: z.input<typeof projectInput>) {
  // Creating a project is a company-level decision; a PM manages the projects they are given.
  checkAccess(actor, 'client.manage', { companyId: actor.companyId });
  const data = projectInput.parse(input);
  const managerUserId = data.managerUserId ?? actor.userId;
  const memberIds = [...new Set([...(data.memberUserIds ?? []), managerUserId])];
  await assertMembers(ctx, actor.companyId, memberIds);
  return ctx.db.transaction(async (tx) => {
    let clientId: string | null = null;
    if (data.clientName) {
      const [existing] = await tx.select().from(clients).where(and(eq(clients.companyId, actor.companyId), eq(clients.name, data.clientName)));
      clientId = existing?.id ?? (await tx.insert(clients).values({ companyId: actor.companyId, name: data.clientName }).returning())[0]!.id;
    }
    const [p] = await tx
      .insert(projects)
      .values({ companyId: actor.companyId, name: data.name, clientId, color: data.color, managerUserId, deadline: data.deadline ?? null })
      .returning();
    await tx.insert(projectMembers).values(memberIds.map((userId) => ({ projectId: p!.id, userId })));
    await tx.insert(projectMonths).values({ companyId: actor.companyId, projectId: p!.id, month: monthAt(ctx.now(), actor.company.timezone) });
    await audit(tx as never, actor, 'project.create', 'project', p!.id, { name: data.name });
    return p!;
  });
}

async function updateProjectInner(ctx: Ctx, actor: ResolvedActor, projectId: string, input: Partial<z.input<typeof projectInput>>) {
  const [p] = await ctx.db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.companyId, actor.companyId)));
  if (!p) throw notFound('Loyiha');
  checkAccess(actor, 'project.manage', { companyId: actor.companyId, projectId });
  const data = projectInput.partial().parse(input);
  if (data.managerUserId !== undefined && data.managerUserId !== p.managerUserId) {
    checkAccess(actor, 'client.manage', { companyId: actor.companyId }); // only company level re-assigns the PM
    if (data.managerUserId) await assertMembers(ctx, actor.companyId, [data.managerUserId]);
  }
  const { memberUserIds, clientName: _c, ...fields } = data;
  if (memberUserIds) await assertMembers(ctx, actor.companyId, memberUserIds);
  return ctx.db.transaction(async (tx) => {
    const [u] = await tx.update(projects).set(fields).where(eq(projects.id, projectId)).returning();
    if (memberUserIds || data.managerUserId !== undefined) {
      const existing = await tx.select().from(projectMembers).where(eq(projectMembers.projectId, projectId));
      const keep = [...new Set([...(memberUserIds ?? existing.map(m => m.userId)), ...(u!.managerUserId ? [u!.managerUserId] : [])])];
      await tx.delete(projectMembers).where(eq(projectMembers.projectId, projectId));
      if (keep.length) await tx.insert(projectMembers).values(keep.map((userId) => ({ projectId, userId })));
    }
    await audit(tx as never, actor, 'project.update', 'project', projectId, data as Record<string, unknown>);
    return u!;
  });
}

export async function listProjects(ctx: Ctx, actor: ResolvedActor) {
  const rows = await ctx.db
    .select({ p: projects, client: clients.name })
    .from(projects)
    .leftJoin(clients, eq(clients.id, projects.clientId))
    .where(eq(projects.companyId, actor.companyId))
    .orderBy(asc(projects.name));
  const members = await ctx.db
    .select({ projectId: projectMembers.projectId, userId: projectMembers.userId, departmentId: memberships.departmentId })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .innerJoin(memberships, and(eq(memberships.userId, projectMembers.userId), eq(memberships.companyId, projects.companyId)))
    .where(eq(projects.companyId, actor.companyId));
  const stats = await ctx.db
    .select({
      projectId: tasks.projectId,
      total: sql<number>`count(*)::int`,
      done: sql<number>`count(*) filter (where ${tasks.status} = 'DONE')::int`,
      overdue: sql<number>`count(*) filter (where ${tasks.status} not in ('DONE','CANCELLED') and ${tasks.deadline} < ${ctx.now()})::int`,
      cancelled: sql<number>`count(*) filter (where ${tasks.status} = 'CANCELLED')::int`,
    })
    .from(tasks)
    .where(eq(tasks.companyId, actor.companyId))
    .groupBy(tasks.projectId);

  return rows
    .filter(({ p }) => {
      const team = members.filter((m) => m.projectId === p.id);
      // DEPARTMENT scope for projects: any teammate from a department the actor heads/belongs to.
      return (
        canAccess(actor, 'project.view', { companyId: actor.companyId, projectId: p.id }) ||
        team.some((m) => canAccess(actor, 'project.view', { companyId: actor.companyId, departmentId: m.departmentId }))
      );
    })
    .map(({ p, client }) => {
      const s = stats.find((x) => x.projectId === p.id);
      const live = (s?.total ?? 0) - (s?.cancelled ?? 0);
      return {
        ...p,
        client,
        memberUserIds: members.filter((m) => m.projectId === p.id).map((m) => m.userId),
        taskTotal: live,
        taskDone: s?.done ?? 0,
        taskOverdue: s?.overdue ?? 0,
        progress: live ? Math.round((100 * (s?.done ?? 0)) / live) : 0,
      };
    });
}

/** Called by the bot when a manager binds a Telegram group to a project. */
export async function bindChat(ctx: Ctx, actor: ResolvedActor, projectId: string, chatId: number, title: string) {
  const [p] = await ctx.db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.companyId, actor.companyId)));
  if (!p) throw notFound('Loyiha');
  checkAccess(actor, 'project.manage', { companyId: actor.companyId, projectId });
  const [taken] = await ctx.db.select().from(projects).where(eq(projects.telegramChatId, chatId));
  if (taken && taken.companyId !== actor.companyId) {
    throw new DomainError('FORBIDDEN', 'Bu guruh boshqa kompaniyaga ulangan');
  }
  await ctx.db.transaction(async (tx) => {
    // One group ↔ one project. Re-binding moves the group.
    await tx.update(projects).set({ telegramChatId: null, telegramChatTitle: null }).where(eq(projects.telegramChatId, chatId));
    await tx.update(projects).set({ telegramChatId: chatId, telegramChatTitle: title }).where(eq(projects.id, projectId));
  });
  await audit(ctx.db, actor, 'project.bindChat', 'project', projectId, { chatId, title });
}


export async function createProject(ctx: Ctx, actor: ResolvedActor, input: z.input<typeof projectInput>) {
  return calendarWrite(ctx, actor, inner => createProjectInner(inner, actor, input));
}

export async function updateProject(ctx: Ctx, actor: ResolvedActor, projectId: string, input: Partial<z.input<typeof projectInput>>) {
  return calendarWrite(ctx, actor, inner => updateProjectInner(inner, actor, projectId, input));
}
