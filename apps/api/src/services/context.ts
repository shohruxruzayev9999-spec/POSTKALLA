import { and, eq } from 'drizzle-orm';
import {
  normalizePolicy,
  DomainError,
  ROLES,
  type Actor,
  type ReminderPolicy,
  type Role,
  type WorkSchedule,
} from '@retarget/shared';
import type { Db } from '../db/client.js';
import { companies, departments, memberships, projectMembers, projects, users } from '../db/schema.js';
import type { Notifier } from './notifier.js';

export interface Ctx {
  db: Db;
  notifier: Notifier;
  now: () => Date;
}

export type Company = typeof companies.$inferSelect;
export type User = typeof users.$inferSelect;

export interface ResolvedActor extends Actor {
  membershipId: string;
  company: Company;
}

/**
 * Resolves who is acting, from the database, on every request. Roles are never taken from the
 * token or the client — a role change takes effect immediately.
 */
export async function loadActor(db: Db, userId: string, companyId: string): Promise<ResolvedActor> {
  const [row] = await db
    .select({ m: memberships, c: companies })
    .from(memberships)
    .innerJoin(companies, eq(companies.id, memberships.companyId))
    .where(and(eq(memberships.userId, userId), eq(memberships.companyId, companyId)));
  if (!row || row.m.status !== 'ACTIVE') throw new DomainError('FORBIDDEN', "Siz bu kompaniya a'zosi emassiz");

  const headed = await db
    .select({ id: departments.id })
    .from(departments)
    .where(and(eq(departments.companyId, companyId), eq(departments.headUserId, userId)));
  const memberOf = await db
    .select({ id: projectMembers.projectId })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(and(eq(projectMembers.userId, userId), eq(projects.companyId, companyId)));
  const managed = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.companyId, companyId), eq(projects.managerUserId, userId)));

  const roles = row.m.roles.filter((r): r is Role => (ROLES as readonly string[]).includes(r));
  return {
    userId,
    companyId,
    membershipId: row.m.id,
    company: row.c,
    roles: roles.length ? roles : ['EMPLOYEE'],
    departmentIds: row.m.departmentId ? [row.m.departmentId] : [],
    headOfDepartmentIds: headed.map((d) => d.id),
    projectIds: [...new Set([...memberOf.map((p) => p.id), ...managed.map((p) => p.id)])],
  };
}

export function scheduleOf(c: Company): WorkSchedule {
  return { timezone: c.timezone, workDays: c.workDays, start: c.workStart, end: c.workEnd, holidays: c.holidays };
}

export function reminderPolicyOf(c: Company): ReminderPolicy {
  return normalizePolicy(c.reminderPolicy);
}

export function notFound(what = 'Obyekt'): DomainError {
  return new DomainError('NOT_FOUND', `${what} topilmadi`);
}
