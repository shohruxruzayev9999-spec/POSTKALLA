import { describe, expect, it } from 'vitest';
import { allowedActions, applyTaskAction, type TaskActorRelation, type TaskTransitionInput } from './tasks.js';

const assignee: TaskActorRelation = { isAssignee: true, isReviewer: false, canReview: false, canManage: false };
const reviewer: TaskActorRelation = { isAssignee: false, isReviewer: true, canReview: false, canManage: false };
const headWhoIsAssignee: TaskActorRelation = { isAssignee: true, isReviewer: false, canReview: true, canManage: true };
const stranger: TaskActorRelation = { isAssignee: false, isReviewer: false, canReview: false, canManage: false };

const task = (status: TaskTransitionInput['status'], extra: Partial<TaskTransitionInput> = {}): TaskTransitionInput => ({
  status,
  revision: 1,
  currentRevisionFileCount: 1,
  requireFileOnSubmit: true,
  ...extra,
});

describe('task lifecycle', () => {
  it('assignee walks NEW → IN_PROGRESS → REVIEW', () => {
    expect(applyTaskAction(task('NEW'), 'START', assignee).status).toBe('IN_PROGRESS');
    expect(applyTaskAction(task('IN_PROGRESS'), 'SUBMIT', assignee).status).toBe('REVIEW');
  });

  it('submitting needs a result file when the department requires it', () => {
    expect(() => applyTaskAction(task('IN_PROGRESS', { currentRevisionFileCount: 0 }), 'SUBMIT', assignee)).toThrow(/faylini/);
    expect(applyTaskAction(task('IN_PROGRESS', { currentRevisionFileCount: 0, requireFileOnSubmit: false }), 'SUBMIT', assignee).status).toBe('REVIEW');
  });

  it('reviewer returns with a mandatory comment and the revision goes up', () => {
    expect(() => applyTaskAction(task('REVIEW'), 'RETURN', reviewer)).toThrow(/Izoh/);
    const r = applyTaskAction(task('REVIEW', { revision: 1 }), 'RETURN', reviewer, 'Logotip kichik');
    expect(r).toEqual({ status: 'RETURNED', revision: 2 });
  });

  it('nobody approves their own work — not even a department head', () => {
    expect(() => applyTaskAction(task('REVIEW'), 'APPROVE', assignee)).toThrow(/ruxsat/);
    expect(() => applyTaskAction(task('REVIEW'), 'APPROVE', headWhoIsAssignee)).toThrow(/ruxsat/);
    expect(applyTaskAction(task('REVIEW'), 'APPROVE', reviewer).status).toBe('DONE');
  });

  it('a stranger in the Telegram group can do nothing', () => {
    expect(allowedActions(task('NEW'), stranger)).toEqual([]);
    expect(() => applyTaskAction(task('NEW'), 'START', stranger)).toThrow(/ruxsat/);
  });

  it('rejects impossible transitions', () => {
    expect(() => applyTaskAction(task('DONE'), 'SUBMIT', assignee)).toThrow(/holatidan/);
  });

  it('offers the right buttons for each person', () => {
    expect(allowedActions(task('IN_PROGRESS'), assignee)).toEqual(['BLOCK', 'SUBMIT']);
    expect(allowedActions(task('REVIEW'), reviewer)).toEqual(['APPROVE', 'RETURN']);
  });
});
