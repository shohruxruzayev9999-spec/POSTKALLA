import { randomBytes } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  DomainError,
  ROLE_RANK,
  ROLES,
  assertCanGrantRole,
  assertNotSelf,
  assertOwnerRemains,
  canAccess,
  checkAccess,
  type Role,
} from '@retarget/shared';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { auditLog, companies, departments, invitations, memberships, users } from '../db/schema.js';
import { notFound, type Ctx, type ResolvedActor } from './context.js';

export async function audit(
  db: Db,
  actor: { userId: string; companyId: string },
  action: string,
  entity: string,
  entityId: string | null,
  data?: Record<string, unknown>,
): Promise<void> {
  await db.insert(auditLog).values({ companyId: actor.companyId, actorUserId: actor.userId, action, entity, entityId, data });
}

// ------------------------------------------------------------------------------------------
// Companies
// ------------------------------------------------------------------------------------------

export const createCompanyInput = z.object({
  name: z.string().trim().min(2).max(80),
  departments: z
    .array(z.object({ name: z.string().trim().min(1).max(60) }))
    .max(20)
    .default([]),
});

/** Anyone can start a company; they become its first Owner. */
export async function createCompany(ctx: Ctx, userId: string, input: z.input<typeof createCompanyInput>) {
  const data = createCompanyInput.parse(input);
  return ctx.db.transaction(async (tx) => {
    const [company] = await tx.insert(companies).values({ name: data.name }).returning();
    await tx.insert(memberships).values({ companyId: company!.id, userId, roles: ['OWNER'], position: 'CEO', joinedAt: ctx.now() });
    if (data.departments.length) {
      await tx.insert(departments).values(data.departments.map((d) => ({ companyId: company!.id, name: d.name, section: detectSection(d.name) })));
    }
    await audit(tx as unknown as Db, { userId, companyId: company!.id }, 'company.create', 'company', company!.id);
    return company!;
  });
}

export async function myCompanies(db: Db, userId: string) {
  return db
    .select({ id: companies.id, name: companies.name, roles: memberships.roles, status: memberships.status })
    .from(memberships)
    .innerJoin(companies, eq(companies.id, memberships.companyId))
    .where(eq(memberships.userId, userId))
    .orderBy(asc(memberships.joinedAt));
}

export const updateCompanyInput = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  timezone: z.string().min(3).max(64).optional(),
  workDays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
  workStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  workEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(100).optional(),
  officeLat: z.number().min(-90).max(90).nullable().optional(),
  officeLng: z.number().min(-180).max(180).nullable().optional(),
  officeRadiusM: z.number().int().min(50).max(5000).optional(),
  reminderPolicy: z
    .object({
      beforeDeadlineHours: z.array(z.number().min(0).max(168)).max(5),
      overdueWorkingHours: z.array(z.number().min(0).max(80)).min(1).max(6),
      escalateAtReminder: z.number().int().min(1).max(6),
      ceoAfterWorkingHours: z.number().min(0).max(40),
      skipDeptHead: z.boolean(),
    })
    .partial()
    .optional(),
});

export async function updateCompany(ctx: Ctx, actor: ResolvedActor, input: z.input<typeof updateCompanyInput>) {
  checkAccess(actor, 'settings.company', { companyId: actor.companyId });
  const data = updateCompanyInput.parse(input);
  if (data.timezone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: data.timezone });
    } catch {
      throw new DomainError('VALIDATION', "Noto'g'ri vaqt zonasi");
    }
  }
  const [c] = await ctx.db.update(companies).set(data).where(eq(companies.id, actor.companyId)).returning();
  await audit(ctx.db, actor, 'company.update', 'company', actor.companyId, data);
  return c!;
}

// ------------------------------------------------------------------------------------------
// Departments
// ------------------------------------------------------------------------------------------

/** Department boards: a name that sounds like design or video lands on that board by default. */
export function detectSection(name: string): 'DESIGN' | 'MEDIA' | 'NONE' {
  if (/(dizayn|design)/i.test(name)) return 'DESIGN';
  if (/(video|montaj|media|mobilograf|edit)/i.test(name)) return 'MEDIA';
  return 'NONE';
}

export const departmentInput = z.object({
  section: z.enum(['DESIGN', 'MEDIA', 'NONE']).optional(),
  name: z.string().trim().min(1).max(60),
  headUserId: z.string().uuid().nullable().optional(),
  requireFileOnSubmit: z.boolean().optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
});

export async function listDepartments(ctx: Ctx, actor: ResolvedActor) {
  const rows = await ctx.db.select().from(departments).where(eq(departments.companyId, actor.companyId)).orderBy(asc(departments.name));
  const counts = await ctx.db
    .select({ departmentId: memberships.departmentId, n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(and(eq(memberships.companyId, actor.companyId), eq(memberships.status, 'ACTIVE')))
    .groupBy(memberships.departmentId);
  return rows.map((d) => ({ ...d, memberCount: counts.find((c) => c.departmentId === d.id)?.n ?? 0 }));
}

async function assertMember(db: Db, companyId: string, userId: string) {
  const [m] = await db.select().from(memberships).where(and(eq(memberships.companyId, companyId), eq(memberships.userId, userId)));
  if (!m || m.status !== 'ACTIVE') throw new DomainError('VALIDATION', "Foydalanuvchi kompaniya a'zosi emas");
  return m;
}

export async function createDepartment(ctx: Ctx, actor: ResolvedActor, input: z.input<typeof departmentInput>) {
  checkAccess(actor, 'settings.company', { companyId: actor.companyId });
  const data = departmentInput.parse(input);
  if (data.headUserId) await assertMember(ctx.db, actor.companyId, data.headUserId);
  const [d] = await ctx.db.insert(departments).values({ ...data, section: data.section ?? detectSection(data.name), companyId: actor.companyId }).returning();
  if (data.headUserId) await ensureRole(ctx.db, actor.companyId, data.headUserId, 'DEPT_HEAD');
  await audit(ctx.db, actor, 'department.create', 'department', d!.id, data);
  return d!;
}

export async function updateDepartment(ctx: Ctx, actor: ResolvedActor, departmentId: string, input: Partial<z.input<typeof departmentInput>>) {
  const [dep] = await ctx.db.select().from(departments).where(and(eq(departments.id, departmentId), eq(departments.companyId, actor.companyId)));
  if (!dep) throw notFound("Bo'lim");
  const data = departmentInput.partial().parse(input);
  // A department head may tune their own department, but never re-assign its head.
  const changesHead = data.headUserId !== undefined && data.headUserId !== dep.headUserId;
  checkAccess(actor, changesHead ? 'settings.company' : 'settings.department', { companyId: actor.companyId, departmentId });
  if (data.headUserId) await assertMember(ctx.db, actor.companyId, data.headUserId);
  const [d] = await ctx.db.update(departments).set(data).where(eq(departments.id, departmentId)).returning();
  if (data.headUserId) await ensureRole(ctx.db, actor.companyId, data.headUserId, 'DEPT_HEAD');
  await audit(ctx.db, actor, 'department.update', 'department', departmentId, data);
  return d!;
}

async function ensureRole(db: Db, companyId: string, userId: string, role: Role) {
  const m = await assertMember(db, companyId, userId);
  if (!m.roles.includes(role)) {
    await db.update(memberships).set({ roles: [...m.roles, role] }).where(eq(memberships.id, m.id));
  }
}

// ------------------------------------------------------------------------------------------
// Invitations
// ------------------------------------------------------------------------------------------

export const invitationInput = z.object({
  role: z.enum(ROLES).default('EMPLOYEE'),
  departmentId: z.string().uuid().nullable().optional(),
  position: z.string().trim().max(60).optional(),
  maxUses: z.number().int().min(1).max(100).default(1),
  days: z.number().int().min(1).max(30).default(7),
});

export async function createInvitation(ctx: Ctx, actor: ResolvedActor, input: z.input<typeof invitationInput>) {
  const data = invitationInput.parse(input);
  checkAccess(actor, 'employee.manage', { companyId: actor.companyId, departmentId: data.departmentId ?? null });
  assertCanGrantRole(actor, data.role);
  if (data.departmentId) {
    const [d] = await ctx.db.select().from(departments).where(and(eq(departments.id, data.departmentId), eq(departments.companyId, actor.companyId)));
    if (!d) throw notFound("Bo'lim");
  }
  const token = randomBytes(12).toString('base64url');
  const [inv] = await ctx.db
    .insert(invitations)
    .values({
      companyId: actor.companyId,
      token,
      role: data.role,
      departmentId: data.departmentId ?? null,
      position: data.position ?? null,
      createdBy: actor.userId,
      maxUses: data.maxUses,
      expiresAt: new Date(ctx.now().getTime() + data.days * 86_400_000),
    })
    .returning();
  await audit(ctx.db, actor, 'invitation.create', 'invitation', inv!.id, { role: data.role, departmentId: data.departmentId });
  return inv!;
}

export async function previewInvitation(ctx: Ctx, token: string) {
  const [row] = await ctx.db
    .select({ inv: invitations, company: companies.name, department: departments.name })
    .from(invitations)
    .innerJoin(companies, eq(companies.id, invitations.companyId))
    .leftJoin(departments, eq(departments.id, invitations.departmentId))
    .where(eq(invitations.token, token));
  if (!row) throw notFound('Taklif');
  const valid = !row.inv.revoked && row.inv.uses < row.inv.maxUses && row.inv.expiresAt > ctx.now();
  return { companyName: row.company, department: row.department, role: row.inv.role, position: row.inv.position, valid };
}

export async function acceptInvitation(ctx: Ctx, userId: string, token: string) {
  return ctx.db.transaction(async (tx) => {
    // Lock the row so two people can't both take the last use.
    const locked = await tx.execute(sql`select id from invitations where token = ${token} for update`);
    const [inv] = await tx.select().from(invitations).where(eq(invitations.token, token));
    if (!inv || !locked) throw notFound('Taklif');
    if (inv.revoked || inv.uses >= inv.maxUses || inv.expiresAt <= ctx.now()) {
      throw new DomainError('VALIDATION', "Taklif muddati o'tgan yoki ishlatilgan");
    }
    const [existing] = await tx.select().from(memberships).where(and(eq(memberships.companyId, inv.companyId), eq(memberships.userId, userId)));
    if (existing?.status === 'ACTIVE') return { companyId: inv.companyId, alreadyMember: true };
    if (existing) {
      // A disabled member re-joins only through an admin, not a stale link.
      throw new DomainError('FORBIDDEN', "Hisobingiz o'chirilgan. Administratorga murojaat qiling");
    }
    await tx.insert(memberships).values({
      companyId: inv.companyId,
      userId,
      roles: [inv.role],
      departmentId: inv.departmentId,
      position: inv.position,
      joinedAt: ctx.now(),
    });
    await tx.update(invitations).set({ uses: inv.uses + 1 }).where(eq(invitations.id, inv.id));
    await audit(tx as unknown as Db, { userId, companyId: inv.companyId }, 'invitation.accept', 'invitation', inv.id, { role: inv.role });
    return { companyId: inv.companyId, alreadyMember: false };
  });
}

export async function listInvitations(ctx: Ctx, actor: ResolvedActor) {
  const rows = await ctx.db.select().from(invitations).where(eq(invitations.companyId, actor.companyId)).orderBy(asc(invitations.createdAt));
  return rows.filter((i) => canAccess(actor, 'employee.manage', { companyId: actor.companyId, departmentId: i.departmentId }));
}

export async function revokeInvitation(ctx: Ctx, actor: ResolvedActor, id: string) {
  const [inv] = await ctx.db.select().from(invitations).where(and(eq(invitations.id, id), eq(invitations.companyId, actor.companyId)));
  if (!inv) throw notFound('Taklif');
  checkAccess(actor, 'employee.manage', { companyId: actor.companyId, departmentId: inv.departmentId });
  await ctx.db.update(invitations).set({ revoked: true }).where(eq(invitations.id, id));
  await audit(ctx.db, actor, 'invitation.revoke', 'invitation', id);
}

// ------------------------------------------------------------------------------------------
// Members
// ------------------------------------------------------------------------------------------

export async function listMembers(ctx: Ctx, actor: ResolvedActor) {
  checkAccess(actor, 'employee.directory', { companyId: actor.companyId });
  const rows = await ctx.db
    .select({ m: memberships, u: users, dept: departments.name })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(departments, eq(departments.id, memberships.departmentId))
    .where(eq(memberships.companyId, actor.companyId))
    .orderBy(asc(users.firstName));
  return rows
    .filter((r) => r.m.status === 'ACTIVE' || canAccess(actor, 'employee.manage', { companyId: actor.companyId, departmentId: r.m.departmentId }))
    .map((r) => {
      const target = { companyId: actor.companyId, departmentId: r.m.departmentId, ownerUserIds: [r.u.id] };
      return {
        userId: r.u.id,
        name: [r.u.firstName, r.u.lastName].filter(Boolean).join(' '),
        username: r.u.username,
        photoUrl: r.u.photoUrl,
        roles: r.m.roles,
        status: r.m.status,
        departmentId: r.m.departmentId,
        department: r.dept,
        position: r.m.position,
        phone: canAccess(actor, 'employee.profile', target) ? r.m.phone : null,
        salary: canAccess(actor, 'salary.view', target) ? r.m.salary : undefined,
        joinedAt: r.m.joinedAt,
      };
    });
}

export const updateMemberInput = z.object({
  roles: z.array(z.enum(ROLES)).min(1).max(7).optional(),
  departmentId: z.string().uuid().nullable().optional(),
  position: z.string().trim().max(60).nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  salary: z.number().int().min(0).max(10_000_000_000).nullable().optional(),
});

/**
 * The single place where roles, department, status and salary change. The old system let any
 * member edit anyone (and themself up to CEO); here every path goes through the hard rules.
 */
export async function updateMember(ctx: Ctx, actor: ResolvedActor, targetUserId: string, input: z.input<typeof updateMemberInput>) {
  const data = updateMemberInput.parse(input);
  const [m] = await ctx.db.select().from(memberships).where(and(eq(memberships.companyId, actor.companyId), eq(memberships.userId, targetUserId)));
  if (!m) throw notFound('Hodim');
  const target = { companyId: actor.companyId, departmentId: m.departmentId, ownerUserIds: [targetUserId] };

  const { salary, ...hrFields } = data;
  if (Object.keys(hrFields).length) {
    checkAccess(actor, 'employee.manage', target);
    assertNotSelf(actor, 'employee.manage', targetUserId);
    // Nobody touches a colleague at or above their own rank.
    if (!actor.roles.includes('OWNER')) {
      const ownRank = Math.max(...actor.roles.map((r) => ROLE_RANK[r]));
      const theirRank = Math.max(...m.roles.map((r) => ROLE_RANK[r as Role] ?? 0));
      if (theirRank >= ownRank) throw new DomainError('ROLE_RANK_TOO_HIGH', "O'zingizdan yuqori yoki teng hodimni o'zgartira olmaysiz");
    }
    if (data.departmentId !== undefined && data.departmentId !== null) {
      // Moving someone into a department requires rights on the destination too.
      checkAccess(actor, 'employee.manage', { companyId: actor.companyId, departmentId: data.departmentId });
      const [d] = await ctx.db.select().from(departments).where(and(eq(departments.id, data.departmentId), eq(departments.companyId, actor.companyId)));
      if (!d) throw notFound("Bo'lim");
    }
    if (data.roles) {
      const added = data.roles.filter((r) => !m.roles.includes(r));
      const removed = m.roles.filter((r) => !data.roles!.includes(r as Role)) as Role[];
      for (const r of [...added, ...removed]) assertCanGrantRole(actor, r);
    }
  }
  if (salary !== undefined) {
    checkAccess(actor, 'salary.manage', target);
    assertNotSelf(actor, 'salary.manage', targetUserId);
  }

  return ctx.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(memberships)
      .set({ ...data, roles: data.roles ? [...new Set(data.roles)] : undefined })
      .where(eq(memberships.id, m.id))
      .returning();
    const [{ owners }] = (await tx
      .select({ owners: sql<number>`count(*)::int` })
      .from(memberships)
      .where(and(eq(memberships.companyId, actor.companyId), eq(memberships.status, 'ACTIVE'), sql`'OWNER' = any(${memberships.roles})`))) as [
      { owners: number },
    ];
    assertOwnerRemains(owners);
    await audit(tx as unknown as Db, actor, 'member.update', 'membership', m.id, {
      targetUserId,
      ...data,
      salary: salary === undefined ? undefined : 'changed',
      before: { roles: m.roles, departmentId: m.departmentId, status: m.status },
    });
    return updated!;
  });
}
