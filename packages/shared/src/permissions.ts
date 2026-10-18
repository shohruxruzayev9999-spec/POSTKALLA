import { DomainError } from './errors.js';

/**
 * Role-based access with scopes. A role answers "what can you do"; a scope answers
 * "on which data". Every API call goes through {@link checkAccess} — the frontend only hides
 * buttons, it never protects anything.
 */
export const ROLES = ['OWNER', 'ADMIN', 'HR', 'FINANCE', 'MARKETER', 'PM', 'DEPT_HEAD', 'EMPLOYEE'] as const;
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
  'shoot.manage',
  'onboarding.manage',
  'report.view',
] as const;
export type Action = (typeof ACTIONS)[number];

type Matrix = Record<Role, Partial<Record<Action, Scope[]>>>;

const ALL_COMPANY = Object.fromEntries(ACTIONS.map((a) => [a, ['COMPANY']])) as Record<Action, Scope[]>;
const C: Scope[] = ['COMPANY'];

/**
 * Visibility policy (CEO decision, 29 Sep 2026): everyone sees the whole company's work —
 * dashboard, projects, tasks, team, attendance, KPI — EXCEPT money. Finance is CEO-only
 * (plus the Finance role); a salary is visible to its owner, HR and Finance. Private 1:1 tasks
 * are filtered separately in the task service (only giver, assignee, reviewer and Owner).
 * Managing stays narrow: a role changes only what it is responsible for.
 */
const SEE_ALL: Partial<Record<Action, Scope[]>> = {
  'dashboard.view': C,
  'project.view': C,
  'task.view': C,
  'employee.directory': C,
  'employee.profile': C,
  'attendance.view': C,
  'kpi.view': C,
  'client.view': C,
  'salary.view': ['OWN'],
};

export const PERMISSION_MATRIX: Matrix = {
  OWNER: ALL_COMPANY,
  ADMIN: {
    ...ALL_COMPANY,
    'salary.view': ['OWN'],
    'salary.manage': undefined,
    'finance.view': undefined,
    'finance.manage': undefined,
    'billing.manage': undefined,
  },
  HR: {
    ...SEE_ALL,
    'employee.manage': C,
    'salary.view': C,
    'salary.manage': C,
    'attendance.manage': C,
    'kpi.closeMonth': C,
    'audit.view': C,
    'onboarding.manage': C,
  },
  FINANCE: {
    ...SEE_ALL,
    'salary.view': C,
    'salary.manage': C,
    'finance.view': C,
    'finance.manage': C,
    'audit.view': C,
  },
  MARKETER: {
    ...SEE_ALL,
    'project.manage': ['PROJECT'],
    'task.manage': C,
    'task.review': C,
    'client.manage': ['PROJECT'],
    'shoot.manage': C,
    'report.view': C,
  },
  PM: {
    ...SEE_ALL,
    'project.manage': ['PROJECT'],
    'task.manage': ['PROJECT'],
    'task.review': ['PROJECT'],
    'client.manage': ['PROJECT'],
    'shoot.manage': ['PROJECT'],
    'report.view': ['PROJECT'],
  },
  DEPT_HEAD: {
    ...SEE_ALL,
    'task.manage': ['DEPARTMENT'],
    'task.review': ['DEPARTMENT'],
    'employee.manage': ['DEPARTMENT'],
    'kpi.rate': ['DEPARTMENT'],
    'settings.department': ['DEPARTMENT'],
    // Media/design heads plan shoots for any project.
    'shoot.manage': C,
  },
  EMPLOYEE: {
    ...SEE_ALL,
    'task.manage': ['OWN'],
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
  /** Per-member switches set by a manager on top of the role (see {@link MemberPerms}). */
  perms?: MemberPerms;
}

/**
 * Per-member switches a manager sets on top of the role. A missing key means "as the role
 * says". They never apply to an Owner or Admin — the company leaders are never restricted.
 */
export interface MemberPerms {
  /** May create tasks for themself. Default: yes. */
  createTasks?: boolean;
  /** May give tasks to other people. Default: whatever the role allows. */
  assignTasks?: boolean;
  /** Which projects they see: every project, or only the ones they are on. Default: ALL. */
  projectsView?: 'ALL' | 'OWN';
}

export const MEMBER_PERM_KEYS = ['createTasks', 'assignTasks', 'projectsView'] as const;

function leader(actor: Actor): boolean {
  return actor.roles.includes('OWNER') || actor.roles.includes('ADMIN');
}

/** Effective switches, with role defaults filled in — what the UI shows as on/off. */
export function effectivePerms(actor: Actor): Required<MemberPerms> {
  const p = leader(actor) ? {} : (actor.perms ?? {});
  const roleAssigns = actor.roles.some((r) => (PERMISSION_MATRIX[r]['task.manage'] ?? []).some((s) => s !== 'OWN'));
  return {
    createTasks: p.createTasks ?? true,
    assignTasks: p.assignTasks ?? roleAssigns,
    projectsView: p.projectsView ?? 'ALL',
  };
}

/**
 * Creating a task: for oneself it takes the `createTasks` switch; for someone else either the
 * role's task.manage scope or the `assignTasks` switch, which a manager can also turn off.
 */
export function canCreateTask(actor: Actor, target: Target, assigneeUserId: string): boolean {
  if (actor.companyId !== target.companyId) return false;
  if (leader(actor)) return canAccess(actor, 'task.manage', target);
  const p = actor.perms ?? {};
  if (assigneeUserId === actor.userId) return p.createTasks !== false && canAccess(actor, 'task.manage', target);
  if (p.assignTasks === false) return false;
  if (p.assignTasks === true) return true;
  return canAccess(actor, 'task.manage', { ...target, ownerUserIds: [] });
}

export function checkCreateTask(actor: Actor, target: Target, assigneeUserId: string): void {
  if (!canCreateTask(actor, target, assigneeUserId)) {
    throw new DomainError('FORBIDDEN', assigneeUserId === actor.userId ? "Ruxsat yo'q: sizga vazifa yaratish ruxsat etilmagan" : "Ruxsat yo'q: sizga boshqalarga vazifa berish ruxsat etilmagan");
  }
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
  // "Only my projects": a project — and a project's task — is visible only when the actor is on
  // that project or owns the task. Tasks outside any project stay visible as before.
  if (actor.perms?.projectsView === 'OWN' && !leader(actor) && (action === 'project.view' || action === 'task.view')) {
    if (action === 'project.view' && target.projectId === undefined) return false;
    if (target.projectId && !actor.projectIds.includes(target.projectId) && !target.ownerUserIds?.includes(actor.userId)) return false;
    if (action === 'project.view' && target.projectId === null) return false;
  }
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
  MARKETER: 50,
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
