import { canAccess } from '@retarget/shared';
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { clients, departments, memberships, projects, tasks, users } from '../db/schema.js';
import type { Ctx, ResolvedActor } from './context.js';
import { canSeeTask } from './tasks.js';

export const searchInput = z.object({ q: z.string().trim().min(1).max(100) });

/** "%" and "_" typed by a person are literal characters, not wildcards. */
const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * One search box over the company: tasks (title, description, "#142"), projects (name, client)
 * and people (name, @username). Visibility is the same as in the lists: private 1:1 tasks only
 * for the people in them, the directory only for those who may see it.
 */
export async function globalSearch(ctx: Ctx, actor: ResolvedActor, input: z.input<typeof searchInput>) {
  const { q } = searchInput.parse(input);
  const needle = q.replace(/^#/, '');
  const number = /^\d{1,7}$/.test(needle) ? Number(needle) : null;
  if (!number && needle.length < 2) return { tasks: [], projects: [], members: [] };
  const pattern = like(needle);

  const assignee = users;
  const taskRows = await ctx.db
    .select({ t: tasks, project: projects.name, a: assignee })
    .from(tasks)
    .innerJoin(assignee, eq(assignee.id, tasks.assigneeUserId))
    .leftJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(tasks.companyId, actor.companyId), or(ilike(tasks.title, pattern), ilike(tasks.description, pattern), number ? eq(tasks.number, number) : sql`false`)))
    // An exact "#142" first, then open work, then the most recent.
    .orderBy(number ? sql`(${tasks.number} = ${number}) desc` : sql`1`, sql`(${tasks.status} in ('DONE','CANCELLED'))`, desc(tasks.updatedAt))
    .limit(80);
  const foundTasks = taskRows
    .filter((r) => canSeeTask(actor, r.t))
    .slice(0, 20)
    .map((r) => ({
      id: r.t.id,
      number: r.t.number,
      title: r.t.title,
      status: r.t.status,
      deadline: r.t.deadline,
      isPrivate: r.t.isPrivate,
      project: r.project,
      assignee: [r.a.firstName, r.a.lastName].filter(Boolean).join(' '),
      overdue: !['DONE', 'CANCELLED'].includes(r.t.status) && r.t.deadline < ctx.now(),
    }));

  const foundProjects = needle.length < 2 ? [] : (
    await ctx.db
      .select({ id: projects.id, name: projects.name, color: projects.color, status: projects.status, client: clients.name })
      .from(projects)
      .leftJoin(clients, eq(clients.id, projects.clientId))
      .where(and(eq(projects.companyId, actor.companyId), or(ilike(projects.name, pattern), ilike(clients.name, pattern))))
      .orderBy(asc(projects.name))
      .limit(10)
  );

  const directory = canAccess(actor, 'employee.directory', { companyId: actor.companyId });
  const foundMembers = !directory || needle.length < 2 ? [] : (
    await ctx.db
      .select({ userId: users.id, firstName: users.firstName, lastName: users.lastName, username: users.username, photoUrl: users.photoUrl, position: memberships.position, department: departments.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .leftJoin(departments, eq(departments.id, memberships.departmentId))
      .where(
        and(
          eq(memberships.companyId, actor.companyId),
          eq(memberships.status, 'ACTIVE'),
          or(ilike(sql`${users.firstName} || ' ' || coalesce(${users.lastName}, '')`, pattern), ilike(users.username, like(needle.replace(/^@/, ''))), ilike(memberships.position, pattern)),
        ),
      )
      .orderBy(asc(users.firstName))
      .limit(10)
  ).map(({ firstName, lastName, ...m }) => ({ ...m, name: [firstName, lastName].filter(Boolean).join(' ') }));

  return { tasks: foundTasks, projects: foundProjects, members: foundMembers };
}
