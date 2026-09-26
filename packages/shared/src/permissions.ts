import { DomainError } from './errors.js';

/**
 * Role-based access with scopes. A role answers "what can you do"; a scope answers
 * "on which data". Every API call goes through {@link checkAccess} — the frontend only hides
 * buttons, it never protects anything.
 */
export const ROLES = ['OWNER', 'ADMIN', 'HR', 'FINANCE', 'PM', 'DEPT_HEAD', 'EMPLOYEE'] as const;
export type Role = (typeof ROLES)[number];

export type Scope = 'COMPANY' | 'DEPARTMENT' | 'PROJECT' | 'OWN';

export const ACTIONS = [
  'dashboard.view',
  'project.view',
  'project.manage',
  'task.view',
  'task.manage',
  'task.review',
  'employee.directory',
  'employee.profile',
  'employee.manage',
  'salary.view',
  'salary.manage',
  'attendance.view',
  'attendance.manage',
  'kpi.view',
  'kpi.rate',
  'kpi.closeMonth',
  'finance.view',
  'finance.manage',
  'client.view',
  'client.manage',
  'settings.company',
  'settings.department',
  'audit.view',
  'billing.manage',
] as const;
export type Action = (typeof ACTIONS)[number];

type Matrix = Record<Role, Partial<Record<Action, Scope[]>>>;

const ALL_COMPANY = Object.fromEntries(ACTIONS.map((a) => [a, ['COMPANY']])) as Record<Action, Scope[]>;
const C: Scope[] = ['COMPANY'];

/** The permission matrix from the product spec ("Rollar va dostuplar"). */
export const PERMISSION_MATRIX: Matrix = {
  OWNER: ALL_COMPANY,
  ADMIN: {
    ...ALL_COMPANY,
    'salary.view': undefined,
    'salary.manage': undefined,
    'finance.view': undefined,
    'finance.manage': undefined,
    'billing.manage': undefined,
  },
  HR: {
    'dashboard.view': C,
    'employee.directory': C,
    'employee.profile': C,
    'employee.manage': C,
    'salary.view': C,
    'salary.manage': C,
    'attendance.view': C,
    'attendance.manage': C,
    'kpi.view': C,
    'kpi.closeMonth': C,
    'audit.view': C,
  },
  FINANCE: {
    'dashboard.view': C,
    'project.view': C,
    'employee.directory': C,
    'employee.profile': C,
    'salary.view': C,
    'salary.manage': C,
    'attendance.view': C,
    'kpi.view': C,
    'finance.view': C,
    'finance.manage': C,
    'client.view': C,
    'audit.view': C,
  },
  PM: {
    'dashboard.view': ['PROJECT'],
    'project.view': ['PROJECT'],
    'project.manage': ['PROJECT'],
    'task.view': ['PROJECT'],
    'task.manage': ['PROJECT'],
    'task.review': ['PROJECT'],
    'employee.directory': C,
    'employee.profile': ['PROJECT'],
    'kpi.view': ['PROJECT'],
    'finance.view': ['PROJECT'],
    'client.view': ['PROJECT'],
    'client.manage': ['PROJECT'],
  },
  DEPT_HEAD: {
    'dashboard.view': ['DEPARTMENT'],
    'project.view': ['DEPARTMENT'],
    'task.view': ['DEPARTMENT'],
    'task.manage': ['DEPARTMENT'],
    'task.review': ['DEPARTMENT'],
    'employee.directory': C,
    'employee.profile': ['DEPARTMENT'],
    'employee.manage': ['DEPARTMENT'],
    'attendance.view': ['DEPARTMENT'],
    'kpi.view': ['DEPARTMENT'],
    'kpi.rate': ['DEPARTMENT'],
    'settings.department': ['DEPARTMENT'],
  },
  EMPLOYEE: {
    'dashboard.view': ['OWN'],
    'project.view': ['PROJECT'],
    'task.view': ['OWN', 'DEPARTMENT'],
    'task.manage': ['OWN'],
    'employee.directory': C,
    'employee.profile': ['OWN'],
    'salary.view': ['OWN'],
    'attendance.view': ['OWN'],
    'kpi.view': ['OWN'],
  },
};

/** Who the actor is, resolved once per request from the database. */
export interface Actor {
  userId: string;
  companyId: string;
  roles: Role[];
  /** Departments the actor belongs to (as member or head). */
  departmentIds: string[];
  /** Departments the actor heads — DEPARTMENT scope for DEPT_HEAD means these. */
  headOfDepartmentIds: string[];
  /** Projects the actor manages or is a team member of. */
  projectIds: string[];
}

/** What the action touches. Fields that don't apply are left out. */
export interface Target {
  companyId: string;
  departmentId?: string | null;
  projectId?: string | null;
  /** Users who "own" the record: task assignees, the employee a salary row belongs to, … */
  ownerUserIds?: string[];
}

export function scopesFor(roles: readonly Role[], action: Action): Scope[] {
  const set = new Set<Scope>();
  for (const role of roles) {
    for (const scope of PERMISSION_MATRIX[role][action] ?? []) set.add(scope);
  }
  return [...set];
}

function scopeMatches(scope: Scope, actor: Actor, target: Target, roles: readonly Role[]): boolean {
  switch (scope) {
    case 'COMPANY':
      return true;
    case 'DEPARTMENT': {
      if (!target.departmentId) return false;
      // A department head acts on the departments they head; an employee's DEPARTMENT scope
      // (read-only board view) covers the departments they are a member of.
      const pool = roles.includes('DEPT_HEAD') ? [...actor.headOfDepartmentIds, ...actor.departmentIds] : actor.departmentIds;
      return pool.includes(target.departmentId);
    }
    case 'PROJECT':
      return !!target.projectId && actor.projectIds.includes(target.projectId);
    case 'OWN':
      return !!target.ownerUserIds?.includes(actor.userId);
  }
}

export function canAccess(actor: Actor, action: Action, target: Target): boolean {
  if (actor.companyId !== target.companyId) return false; // hard tenant isolation
  for (const role of actor.roles) {
    for (const scope of PERMISSION_MATRIX[role][action] ?? []) {
      // Scope checks are evaluated per role so DEPT_HEAD's wider DEPARTMENT pool never leaks
      // into another role's DEPARTMENT entry.
      if (scopeMatches(scope, actor, target, [role])) return true;
    }
  }
  return false;
}

export function checkAccess(actor: Actor, action: Action, target: Target): void {
  if (!canAccess(actor, action, target)) {
    throw new DomainError('FORBIDDEN', `Ruxsat yo'q: ${action}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Hard rules that no role configuration can override.
// ---------------------------------------------------------------------------------------------

/** Actions nobody may perform on their own record, whatever their role. */
export const SELF_FORBIDDEN_ACTIONS: readonly Action[] = [
  'employee.manage',
  'salary.manage',
  'attendance.manage',
  'kpi.rate',
];

export function assertNotSelf(actor: Actor, action: Action, targetUserId: string): void {
  if (SELF_FORBIDDEN_ACTIONS.includes(action) && actor.userId === targetUserId) {
    throw new DomainError('SELF_ACTION_FORBIDDEN', "O'z ma'lumotingizni o'zgartira olmaysiz");
  }
}

export const ROLE_RANK: Record<Role, number> = {
  OWNER: 100,
  ADMIN: 90,
  HR: 70,
  FINANCE: 70,
  PM: 50,
  DEPT_HEAD: 50,
  EMPLOYEE: 10,
};

/**
 * Nobody grants a role at or above their own rank (an Owner may appoint another Owner — that
 * is how ownership is shared). A department head may only invite plain employees.
 */
export function assertCanGrantRole(actor: Actor, role: Role): void {
  if (actor.roles.includes('OWNER')) return;
  const onlyDeptHead = actor.roles.every((r) => r === 'DEPT_HEAD' || r === 'EMPLOYEE');
  if (onlyDeptHead) {
    if (role !== 'EMPLOYEE') throw new DomainError('ROLE_RANK_TOO_HIGH', "Bo'lim boshlig'i faqat Hodim rolini bera oladi");
    return;
  }
  const ownRank = Math.max(...actor.roles.map((r) => ROLE_RANK[r]));
  if (ROLE_RANK[role] >= ownRank) {
    throw new DomainError('ROLE_RANK_TOO_HIGH', "O'zingizdan yuqori yoki teng rol bera olmaysiz");
  }
}

/** A company must always keep at least one active Owner. */
export function assertOwnerRemains(remainingOwnerCount: number): void {
  if (remainingOwnerCount < 1) {
    throw new DomainError('LAST_OWNER', 'Kompaniyada kamida bitta Owner qolishi kerak');
  }
}
