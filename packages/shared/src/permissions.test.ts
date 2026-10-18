import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.js';
import { assertCanGrantRole, assertNotSelf, assertOwnerRemains, canAccess, canCreateTask, effectivePerms, type Actor } from './permissions.js';

const base = { companyId: 'c1', departmentIds: [], headOfDepartmentIds: [], projectIds: [] };
const employee: Actor = { ...base, userId: 'u-emp', roles: ['EMPLOYEE'], departmentIds: ['d-design'] };
const head: Actor = { ...base, userId: 'u-head', roles: ['DEPT_HEAD'], departmentIds: ['d-design'], headOfDepartmentIds: ['d-design'] };
const pm: Actor = { ...base, userId: 'u-pm', roles: ['PM'], projectIds: ['p-kafe'] };
const hr: Actor = { ...base, userId: 'u-hr', roles: ['HR'] };
const admin: Actor = { ...base, userId: 'u-admin', roles: ['ADMIN'] };
const owner: Actor = { ...base, userId: 'u-owner', roles: ['OWNER'] };
const marketer: Actor = { ...base, userId: 'u-mkt', roles: ['MARKETER'] };

describe('permissions — the security holes found in the old system stay closed', () => {
  it('an employee cannot see company finance', () => {
    expect(canAccess(employee, 'finance.view', { companyId: 'c1' })).toBe(false);
  });

  it('an employee cannot manage employees (so cannot promote themself)', () => {
    expect(canAccess(employee, 'employee.manage', { companyId: 'c1', departmentId: 'd-design', ownerUserIds: ['u-emp'] })).toBe(false);
  });

  it('an employee sees only their own salary', () => {
    expect(canAccess(employee, 'salary.view', { companyId: 'c1', ownerUserIds: ['u-emp'] })).toBe(true);
    expect(canAccess(employee, 'salary.view', { companyId: 'c1', ownerUserIds: ['u-other'] })).toBe(false);
  });

  it('an employee sees their department board but manages only own tasks', () => {
    expect(canAccess(employee, 'task.view', { companyId: 'c1', departmentId: 'd-design', ownerUserIds: ['u-x'] })).toBe(true);
    expect(canAccess(employee, 'task.manage', { companyId: 'c1', departmentId: 'd-design', ownerUserIds: ['u-x'] })).toBe(false);
    expect(canAccess(employee, 'task.manage', { companyId: 'c1', ownerUserIds: ['u-emp'] })).toBe(true);
  });

  it('a department head reviews only in the department they head', () => {
    expect(canAccess(head, 'task.review', { companyId: 'c1', departmentId: 'd-design' })).toBe(true);
    expect(canAccess(head, 'task.review', { companyId: 'c1', departmentId: 'd-video' })).toBe(false);
  });

  it('a PM works inside their own projects only', () => {
    expect(canAccess(pm, 'project.manage', { companyId: 'c1', projectId: 'p-kafe' })).toBe(true);
    expect(canAccess(pm, 'project.manage', { companyId: 'c1', projectId: 'p-other' })).toBe(false);
  });

  it('admin runs the company but never sees salaries or finance', () => {
    expect(canAccess(admin, 'employee.manage', { companyId: 'c1' })).toBe(true);
    expect(canAccess(admin, 'salary.view', { companyId: 'c1', ownerUserIds: ['u-emp'] })).toBe(false);
    expect(canAccess(admin, 'finance.view', { companyId: 'c1' })).toBe(false);
  });

  it('nobody crosses tenants, not even an owner', () => {
    expect(canAccess(owner, 'task.view', { companyId: 'c2' })).toBe(false);
  });
});

describe('visibility policy: everyone sees the work, only the CEO sees the money', () => {
  it('an employee sees every department and project, but never finance or others\' salaries', () => {
    expect(canAccess(employee, 'task.view', { companyId: 'c1', departmentId: 'd-video' })).toBe(true);
    expect(canAccess(employee, 'project.view', { companyId: 'c1', projectId: 'p-any' })).toBe(true);
    expect(canAccess(employee, 'kpi.view', { companyId: 'c1', ownerUserIds: ['u-other'] })).toBe(true);
    expect(canAccess(employee, 'finance.view', { companyId: 'c1' })).toBe(false);
    expect(canAccess(employee, 'salary.view', { companyId: 'c1', ownerUserIds: ['u-other'] })).toBe(false);
  });

  it('a marketer and a PM see everything except finance', () => {
    for (const a of [marketer, pm]) {
      expect(canAccess(a, 'dashboard.view', { companyId: 'c1' })).toBe(true);
      expect(canAccess(a, 'attendance.view', { companyId: 'c1', ownerUserIds: ['u-x'] })).toBe(true);
      expect(canAccess(a, 'finance.view', { companyId: 'c1' })).toBe(false);
      expect(canAccess(a, 'salary.view', { companyId: 'c1', ownerUserIds: ['u-x'] })).toBe(false);
    }
    expect(canAccess(owner, 'finance.view', { companyId: 'c1' })).toBe(true);
  });

  it('seeing is not managing', () => {
    expect(canAccess(employee, 'task.manage', { companyId: 'c1', departmentId: 'd-video', ownerUserIds: ['u-x'] })).toBe(false);
    expect(canAccess(marketer, 'task.manage', { companyId: 'c1', ownerUserIds: ['u-x'] })).toBe(true);
    expect(canAccess(marketer, 'employee.manage', { companyId: 'c1' })).toBe(false);
  });
});

describe('hard rules', () => {
  it('nobody edits their own role, salary, attendance or KPI rating', () => {
    expect(() => assertNotSelf(hr, 'salary.manage', 'u-hr')).toThrow(DomainError);
    expect(() => assertNotSelf(head, 'kpi.rate', 'u-head')).toThrow(DomainError);
    expect(() => assertNotSelf(admin, 'employee.manage', 'u-admin')).toThrow(DomainError);
    expect(() => assertNotSelf(hr, 'salary.manage', 'u-emp')).not.toThrow();
  });

  it('nobody grants a role at or above their own rank', () => {
    expect(() => assertCanGrantRole(admin, 'OWNER')).toThrow(DomainError);
    expect(() => assertCanGrantRole(admin, 'ADMIN')).toThrow(DomainError);
    expect(() => assertCanGrantRole(admin, 'HR')).not.toThrow();
    expect(() => assertCanGrantRole(hr, 'HR')).toThrow(DomainError);
    expect(() => assertCanGrantRole(hr, 'PM')).not.toThrow();
    expect(() => assertCanGrantRole(owner, 'OWNER')).not.toThrow();
  });

  it('a department head may invite only plain employees', () => {
    expect(() => assertCanGrantRole(head, 'EMPLOYEE')).not.toThrow();
    expect(() => assertCanGrantRole(head, 'PM')).toThrow(DomainError);
  });

  it('the last owner cannot be removed', () => {
    expect(() => assertOwnerRemains(0)).toThrow(DomainError);
    expect(() => assertOwnerRemains(1)).not.toThrow();
  });
});

describe('per-member switches (createTasks / assignTasks / projectsView)', () => {
  const t = { companyId: 'c1', departmentId: 'd-design', projectId: 'p-kafe' };
  it('defaults follow the role', () => {
    expect(canCreateTask(employee, { ...t, ownerUserIds: ['u-emp'] }, 'u-emp')).toBe(true);
    expect(canCreateTask(employee, { ...t, ownerUserIds: ['u-x'] }, 'u-x')).toBe(false);
    expect(canCreateTask(head, { ...t, ownerUserIds: ['u-x'] }, 'u-x')).toBe(true);
    expect(effectivePerms(employee)).toEqual({ createTasks: true, assignTasks: false, projectsView: 'ALL' });
    expect(effectivePerms(head).assignTasks).toBe(true);
  });
  it('createTasks=false blocks creating for oneself', () => {
    const e = { ...employee, perms: { createTasks: false } };
    expect(canCreateTask(e, { ...t, ownerUserIds: ['u-emp'] }, 'u-emp')).toBe(false);
  });
  it('assignTasks=true lets an employee give tasks; =false takes it from a head', () => {
    expect(canCreateTask({ ...employee, perms: { assignTasks: true } }, { ...t, ownerUserIds: ['u-x'] }, 'u-x')).toBe(true);
    expect(canCreateTask({ ...head, perms: { assignTasks: false } }, { ...t, ownerUserIds: ['u-x'] }, 'u-x')).toBe(false);
  });
  it('assignTasks=true does not widen managing other tasks', () => {
    expect(canAccess({ ...employee, perms: { assignTasks: true } }, 'task.manage', { ...t, ownerUserIds: [] })).toBe(false);
  });
  it('projectsView=OWN hides other projects and their tasks, but not own tasks', () => {
    const e = { ...employee, projectIds: ['p-mine'], perms: { projectsView: 'OWN' as const } };
    expect(canAccess(e, 'project.view', { companyId: 'c1', projectId: 'p-mine' })).toBe(true);
    expect(canAccess(e, 'project.view', { companyId: 'c1', projectId: 'p-kafe' })).toBe(false);
    expect(canAccess(e, 'project.view', { companyId: 'c1', departmentId: 'd-design' })).toBe(false);
    expect(canAccess(e, 'task.view', { companyId: 'c1', projectId: 'p-kafe', ownerUserIds: ['u-x'] })).toBe(false);
    expect(canAccess(e, 'task.view', { companyId: 'c1', projectId: 'p-kafe', ownerUserIds: ['u-emp'] })).toBe(true);
    expect(canAccess(e, 'task.view', { companyId: 'c1', projectId: null, ownerUserIds: ['u-x'] })).toBe(true);
  });
  it('switches never restrict an Owner or Admin', () => {
    const o = { ...owner, perms: { createTasks: false, assignTasks: false, projectsView: 'OWN' as const } };
    expect(canCreateTask(o, { ...t, ownerUserIds: ['u-x'] }, 'u-x')).toBe(true);
    expect(canAccess(o, 'project.view', { companyId: 'c1', projectId: 'p-kafe' })).toBe(true);
    expect(effectivePerms({ ...admin, perms: { createTasks: false } }).createTasks).toBe(true);
  });
});
