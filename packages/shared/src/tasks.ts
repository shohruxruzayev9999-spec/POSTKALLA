import { DomainError } from './errors.js';

/**
 * The five system states every department column maps onto (plus BLOCKED and CANCELLED).
 * Departments rename and add columns, but each column points at one of these, so KPI and
 * reports work identically across departments and companies.
 */
export const TASK_STATUSES = ['NEW', 'IN_PROGRESS', 'REVIEW', 'RETURNED', 'DONE', 'BLOCKED', 'CANCELLED'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export type TaskAction = 'START' | 'BLOCK' | 'SUBMIT' | 'APPROVE' | 'RETURN' | 'REOPEN' | 'CANCEL';

/** How the actor relates to this particular task. Resolved by the caller from the database. */
export interface TaskActorRelation {
  isAssignee: boolean;
  isReviewer: boolean;
  /** Has `task.review` on this task's department/project (dept head, PM, admin, owner). */
  canReview: boolean;
  /** Has `task.manage` beyond their own tasks (can cancel, unblock). */
  canManage: boolean;
}

export interface TaskTransitionInput {
  status: TaskStatus;
  revision: number;
  /** Files attached to the current revision. */
  currentRevisionFileCount: number;
  /** Department setting: submitting for review requires a result file. */
  requireFileOnSubmit: boolean;
}

export interface TaskTransitionResult {
  status: TaskStatus;
  revision: number;
}

interface Rule {
  from: readonly TaskStatus[];
  to: TaskStatus;
  who: (r: TaskActorRelation) => boolean;
  commentRequired?: boolean;
}

const assigneeOrManager = (r: TaskActorRelation) => r.isAssignee || r.canManage;
const reviewerNotAssignee = (r: TaskActorRelation) => (r.isReviewer || r.canReview) && !r.isAssignee;

const RULES: Record<TaskAction, Rule> = {
  START: { from: ['NEW', 'RETURNED', 'BLOCKED'], to: 'IN_PROGRESS', who: assigneeOrManager },
  BLOCK: { from: ['IN_PROGRESS'], to: 'BLOCKED', who: assigneeOrManager, commentRequired: true },
  SUBMIT: { from: ['IN_PROGRESS'], to: 'REVIEW', who: (r) => r.isAssignee },
  // Nobody approves their own work — even a department head who assigned the task to themself.
  APPROVE: { from: ['REVIEW'], to: 'DONE', who: reviewerNotAssignee },
  RETURN: { from: ['REVIEW'], to: 'RETURNED', who: reviewerNotAssignee, commentRequired: true },
  REOPEN: { from: ['DONE'], to: 'IN_PROGRESS', who: (r) => r.isReviewer || r.canReview },
  CANCEL: { from: ['NEW', 'IN_PROGRESS', 'REVIEW', 'RETURNED', 'BLOCKED'], to: 'CANCELLED', who: (r) => r.canManage },
};

export function allowedActions(input: TaskTransitionInput, rel: TaskActorRelation): TaskAction[] {
  return (Object.keys(RULES) as TaskAction[]).filter((a) => {
    const rule = RULES[a];
    return rule.from.includes(input.status) && rule.who(rel);
  });
}

export function applyTaskAction(
  input: TaskTransitionInput,
  action: TaskAction,
  rel: TaskActorRelation,
  comment?: string | null,
): TaskTransitionResult {
  const rule = RULES[action];
  if (!rule.from.includes(input.status)) {
    throw new DomainError('INVALID_TRANSITION', `${input.status} holatidan ${action} qilib bo'lmaydi`);
  }
  if (!rule.who(rel)) {
    throw new DomainError('FORBIDDEN', `Bu amal uchun ruxsat yo'q: ${action}`);
  }
  if (rule.commentRequired && !comment?.trim()) {
    throw new DomainError('COMMENT_REQUIRED', 'Izoh yozish majburiy');
  }
  if (action === 'SUBMIT' && input.requireFileOnSubmit && input.currentRevisionFileCount < 1) {
    throw new DomainError('FILE_REQUIRED', 'Tekshiruvga yuborishdan oldin natija faylini yuklang');
  }
  // Every return opens a new revision (R1 → R2); it feeds the quality component of KPI.
  const revision = action === 'RETURN' ? input.revision + 1 : input.revision;
  return { status: rule.to, revision };
}

/** Statuses in which a task still counts against its deadline. */
export function isOpen(status: TaskStatus): boolean {
  return status !== 'DONE' && status !== 'CANCELLED';
}
