import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type DragEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { STATUS, when } from '../lib/format';
import type { BoardColumn, TaskListItem } from '../lib/types';
import { Avatar, Field, Icon, Sheet } from './kit';
import { go, useApp } from './state';
import { TaskForm } from './TaskForm';

const COLORS = ['#9CA1AB', '#7AA7FF', '#A3E635', '#34D399', '#14B8A6', '#B69BFF', '#F59E0B', '#FB7185', '#F472B6'];
const STATUS_ORDER = ['NEW', 'IN_PROGRESS', 'RETURNED', 'REVIEW', 'BLOCKED', 'DONE'];

/** Which column a card sits in on this board. */
export function columnOf(t: TaskListItem, cols: BoardColumn[]): BoardColumn | undefined {
  return cols.find((c) => c.id === t.columnId) ?? cols.find((c) => c.status === t.status);
}

export function useColumns(board: string) {
  return useQuery({ queryKey: ['columns', board], queryFn: () => api<BoardColumn[]>(`/boards/${board}/columns`) });
}

/** Kanban board with editable columns. Drag = the same action as a button (server decides). */
export function Board({ board, tasks, showAssignee = true, departmentId }: { board: string; tasks: TaskListItem[]; showAssignee?: boolean; departmentId?: string }) {
  const { can, fail, toast } = useApp();
  const qc = useQueryClient();
  const cols = useColumns(board);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [needComment, setNeedComment] = useState<{ taskId: string; col: BoardColumn } | null>(null);
  const [comment, setComment] = useState('');
  const [editCol, setEditCol] = useState<BoardColumn | 'new' | null>(null);
  const [addTo, setAddTo] = useState<BoardColumn | null>(null);
  const canEdit = can('task.manage', 'COMPANY') || can('task.manage', 'DEPARTMENT') || can('task.manage', 'PROJECT');

  const move = useMutation({
    mutationFn: (v: { taskId: string; col: BoardColumn; comment?: string }) => api(`/tasks/${v.taskId}/move`, { method: 'POST', body: { columnId: v.col.id, comment: v.comment } }),
    onMutate: async (v) => {
      // Optimistic: the card jumps immediately; a refusal puts it back.
      const keys = qc.getQueriesData<TaskListItem[]>({ queryKey: ['tasks'] });
      for (const [k, data] of keys) {
        if (Array.isArray(data)) qc.setQueryData(k, data.map((t) => (t.id === v.taskId ? { ...t, columnId: v.col.id, status: v.col.status } : t)));
      }
      return { keys };
    },
    onError: (e, v, c) => {
      for (const [k, data] of c?.keys ?? []) qc.setQueryData(k, data);
      if (e instanceof ApiError && e.code === 'COMMENT_REQUIRED') setNeedComment({ taskId: v.taskId, col: v.col });
      else fail(e);
    },
    onSuccess: () => {
      setNeedComment(null);
      setComment('');
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  if (!cols.data) return <div className="skeleton" style={{ height: 300 }} />;
  const byCol = new Map<string, TaskListItem[]>();
  for (const c of cols.data) byCol.set(c.id, []);
  for (const t of tasks) {
    const c = columnOf(t, cols.data);
    if (c) byCol.get(c.id)!.push(t);
  }

  const onDrop = (e: DragEvent, col: BoardColumn) => {
    e.preventDefault();
    setOver(null);
    const id = e.dataTransfer.getData('text/task') || dragId;
    setDragId(null);
    const t = tasks.find((x) => x.id === id);
    if (!t || columnOf(t, cols.data!)?.id === col.id) return;
    move.mutate({ taskId: t.id, col });
  };

  return (
    <>
      <div className="board">
        {cols.data.map((col) => {
          const items = byCol.get(col.id) ?? [];
          return (
            <div
              key={col.id}
              className={`board-col ${over === col.id ? 'over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(col.id);
              }}
              onDragLeave={() => setOver((o) => (o === col.id ? null : o))}
              onDrop={(e) => onDrop(e, col)}
            >
              <div className="board-col-h">
                <span style={{ width: 9, height: 9, borderRadius: 5, background: col.color, flexShrink: 0 }} />
                <span className="grow ellipsis" title={STATUS[col.status]}>{col.name}</span>
                <span className="muted">{items.length}</span>
                {canEdit && (
                  <button className="btn sm ghost icon-btn" style={{ width: 28, height: 28 }} aria-label="Ustun sozlamasi" onClick={() => setEditCol(col)}>
                    <Icon name="settings" size={14} />
                  </button>
                )}
              </div>
              <div className="board-col-body">
                {items.map((t) => (
                  <BoardCard key={t.id} t={t} showAssignee={showAssignee} onDragStart={(e) => {
                    e.dataTransfer.setData('text/task', t.id);
                    setDragId(t.id);
                  }} />
                ))}
                {col.status === 'NEW' && canEdit && (
                  <button className="btn sm ghost" style={{ justifyContent: 'flex-start', color: 'var(--muted)' }} onClick={() => setAddTo(col)}>
                    <Icon name="plus" size={15} /> Vazifa qo'shish
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {canEdit && (
          <button className="board-add" onClick={() => setEditCol('new')}>
            <Icon name="plus" size={18} /> Ustun
          </button>
        )}
      </div>

      <Sheet open={!!needComment} onClose={() => setNeedComment(null)} title={needComment ? `«${needComment.col.name}» — izoh` : ''}>
        {needComment && (
          <div className="stack">
            <Field label={needComment.col.status === 'RETURNED' ? 'Nima tuzatilsin?' : 'Nima to‘sqinlik qilyapti?'}>
              <textarea className="input" autoFocus value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} />
            </Field>
            <button className="btn primary block" disabled={!comment.trim() || move.isPending} onClick={() => move.mutate({ ...needComment, comment })}>O'tkazish</button>
          </div>
        )}
      </Sheet>
      <Sheet open={!!editCol} onClose={() => setEditCol(null)} title={editCol === 'new' ? 'Yangi ustun' : 'Ustun'}>
        {editCol && <ColumnForm board={board} col={editCol === 'new' ? null : editCol} onDone={() => setEditCol(null)} />}
      </Sheet>
      <Sheet open={!!addTo} onClose={() => setAddTo(null)} title="Yangi vazifa">
        {addTo && (
          <TaskForm
            columnId={addTo.id}
            departmentId={departmentId}
            onDone={() => {
              setAddTo(null);
              toast('Vazifa yaratildi');
            }}
          />
        )}
      </Sheet>
    </>
  );
}

export function BoardCard({ t, showAssignee, onDragStart }: { t: TaskListItem; showAssignee?: boolean; onDragStart?: (e: DragEvent) => void }) {
  const closed = t.status === 'DONE' || t.status === 'CANCELLED';
  return (
    <div className="board-card" draggable={!!onDragStart} onDragStart={onDragStart} onClick={() => go('tasks', t.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && go('tasks', t.id)}>
      <div className="row" style={{ gap: 6, alignItems: 'flex-start' }}>
        <span className={`prio prio-${t.priority}`} style={{ height: 16, marginTop: 2 }} />
        <div className="grow b small" style={{ lineHeight: 1.35 }}>
          {t.isPrivate && <span className="xs" style={{ color: 'var(--review)' }}>1:1 · </span>}
          {t.title}
        </div>
        {t.revision > 1 && <span className="xs xb" style={{ color: 'var(--warn)' }}>R{t.revision}</span>}
      </div>
      <div className="row wrap xs muted" style={{ gap: 6 }}>
        <span className="faint">#{t.number}</span>
        {t.format && <span className="tag">{t.format}</span>}
        {t.project && <span className="ellipsis" style={{ maxWidth: 120 }}>{t.project}</span>}
      </div>
      <div className="row xs" style={{ gap: 8 }}>
        {showAssignee && <Avatar name={t.assignee.name} src={t.assignee.photoUrl} size={20} />}
        <span style={{ color: !closed && t.overdue ? 'var(--danger)' : 'var(--muted)', fontWeight: 700 }}>{when(t.deadline)}</span>
        <span className="grow" />
        {t.checklistTotal > 0 && (
          <span className="row" style={{ gap: 3, color: t.checklistDone === t.checklistTotal ? 'var(--accent-ink)' : 'var(--muted)' }}><Icon name="tasks" size={12} />{t.checklistDone}/{t.checklistTotal}</span>
        )}
        {t.comments > 0 && <span className="row muted" style={{ gap: 3 }}><Icon name="chat" size={12} />{t.comments}</span>}
      </div>
    </div>
  );
}

function ColumnForm({ board, col, onDone }: { board: string; col: BoardColumn | null; onDone: () => void }) {
  const { fail, toast } = useApp();
  const qc = useQueryClient();
  const [name, setName] = useState(col?.name ?? '');
  const [status, setStatus] = useState(col?.status ?? 'IN_PROGRESS');
  const [color, setColor] = useState(col?.color ?? COLORS[2]!);
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['columns', board] });
    void qc.invalidateQueries({ queryKey: ['tasks'] });
    onDone();
  };
  const save = useMutation({
    mutationFn: () => (col ? api(`/columns/${col.id}`, { method: 'PATCH', body: { name, color } }) : api(`/boards/${board}/columns`, { method: 'POST', body: { name, status, color } })),
    onSuccess: () => {
      toast('Saqlandi');
      done();
    },
    onError: fail,
  });
  const del = useMutation({
    mutationFn: () => api(`/columns/${col!.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast("Ustun o'chirildi — vazifalar shu holatdagi birinchi ustunga o'tdi");
      done();
    },
    onError: fail,
  });
  return (
    <div className="stack">
      <Field label="Nomi">
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Masalan: Ssenariy, Syomka, Montajda" />
      </Field>
      <Field label="Qaysi holatga tegishli" hint="Kartani shu ustunga surish — vazifani shu holatga o'tkazish degani.">
        <select className="input" value={status} disabled={!!col} onChange={(e) => setStatus(e.target.value)}>
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>{STATUS[s]}</option>
          ))}
        </select>
      </Field>
      <div className="field">
        <span>Rang</span>
        <div className="row wrap" style={{ gap: 8 }}>
          {COLORS.map((c) => (
            <button key={c} type="button" aria-label={c} onClick={() => setColor(c)} style={{ width: 28, height: 28, borderRadius: 14, background: c, border: color === c ? '3px solid var(--text)' : '0', cursor: 'pointer' }} />
          ))}
        </div>
      </div>
      <button className="btn primary block" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>Saqlash</button>
      {col && (
        <button className="btn danger block" disabled={del.isPending} onClick={() => del.mutate()}>Ustunni o'chirish</button>
      )}
    </div>
  );
}
