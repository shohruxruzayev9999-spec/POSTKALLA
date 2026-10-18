import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { ACTION, dateShort, leftText, PRIORITY, STATUS, when } from '../lib/format';
import type { BoardColumn, TaskDetail } from '../lib/types';
import { Avatar, Empty, Field, Icon, Skeleton, StatusPill } from './kit';
import { useApp } from './state';
import { useMembers } from '../lib/queries';
import { DeadlineEditor } from './TaskForm';
import { RECURRENCES, RECURRENCE_LABEL, type Recurrence } from '@retarget/shared';

export function TaskView({ id, board = 'main' }: { id: string; board?: string }) {
  const { fail, toast, session } = useApp();
  const qc = useQueryClient();
  const members = useMembers();
  const task = useQuery({ queryKey: ['task', id], queryFn: () => api<TaskDetail>(`/tasks/${id}`) });
  const [commentFor, setCommentFor] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [editDeadline, setEditDeadline] = useState(false);

  const act = useMutation({
    mutationFn: (v: { action: string; comment?: string }) => api(`/tasks/${id}/actions`, { method: 'POST', body: v }),
    onSuccess: (_d, v) => {
      toast(`${ACTION[v.action]?.label ?? v.action} ✓`);
      setCommentFor(null);
      setComment('');
      void qc.invalidateQueries({ queryKey: ['task', id] });
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: fail,
  });

  if (task.isPending) return <Skeleton h={80} n={4} />;
  if (task.isError || !task.data) return <Empty icon="🔒" title="Vazifa topilmadi yoki ko‘rishga ruxsat yo‘q" />;
  const t = task.data;
  const left = leftText(t.deadline);
  const closed = t.status === 'DONE' || t.status === 'CANCELLED';
  const moved = +new Date(t.deadline) !== +new Date(t.originalDeadline);
  const tz = session.ctx.company.timezone;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="stack" style={{ gap: 8 }}>
        <div className="row" style={{ gap: 8 }}>
          <span className="faint b">#{t.number}</span>
          <StatusPill status={t.status} />
          {t.revision > 1 && <span className="xs xb" style={{ color: 'var(--warn)' }}>R{t.revision}</span>}
          <span className="grow" />
          <span className={`xs b`} style={{ color: t.priority === 'HIGH' ? 'var(--danger)' : 'var(--muted)' }}>● {PRIORITY[t.priority]}</span>
        </div>
        <h2 style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.25 }}>{t.title}</h2>
        {!closed && (
          <div className={`banner ${t.overdue ? 'danger' : 'warn'}`} style={{ padding: '10px 12px' }}>
            <Icon name="clock" size={18} />
            <div>
              {t.overdue ? <b>Muddati o‘tdi — {left.text}</b> : <>Muddatigacha <b>{left.text}</b></>} · {when(t.deadline, tz)}
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-2" style={{ gap: 10 }}>
        <Meta label="Ijrochi" value={t.assignee.name} />
        <Meta label="Tekshiruvchi" value={t.reviewer?.name ?? '—'} />
        <Meta label="Loyiha" value={t.project ?? '—'} />
        <Meta label="Bo‘lim" value={t.department ?? '—'} />
        <Meta label="Deadline" value={`${when(t.deadline, tz)}${moved ? ` (asl: ${dateShort(t.originalDeadline, tz)})` : ''}`} />
        <Meta label="Ball" value={String(t.points)} />
      </div>

      {t.description && <div className="card" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5, fontSize: 14 }}>{t.description}</div>}

      {t.actions.length > 0 && (
        <div className="stack" style={{ gap: 8 }}>
          {commentFor ? (
            <>
              <Field label={commentFor === 'RETURN' ? 'Nima tuzatilsin?' : 'Nima to‘sqinlik qilyapti?'}>
                <textarea className="input" autoFocus value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} />
              </Field>
              <div className="row">
                <button className="btn grow" onClick={() => setCommentFor(null)}>Bekor</button>
                <button className="btn primary grow" disabled={!comment.trim() || act.isPending} onClick={() => act.mutate({ action: commentFor, comment })}>
                  {ACTION[commentFor]?.label}
                </button>
              </div>
            </>
          ) : (
            <div className="row wrap" style={{ gap: 8 }}>
              {t.actions.map((a) => (
                <button
                  key={a}
                  className={`btn grow ${ACTION[a]?.tone === 'primary' ? 'primary' : ''} ${ACTION[a]?.tone === 'danger' ? 'danger' : ''}`}
                  disabled={act.isPending}
                  onClick={() => (a === 'RETURN' || a === 'BLOCK' ? setCommentFor(a) : act.mutate({ action: a }))}
                >
                  {ACTION[a]?.label ?? a}
                </button>
              ))}
            </div>
          )}
          {t.actions.includes('SUBMIT') && (
            <div className="xs muted">📎 Natija faylini Telegram guruhidagi vazifa xabariga javob (reply) qilib yuboring — u avtomatik biriktiriladi.</div>
          )}
        </div>
      )}

      <ColumnMove task={t} board={board} />

      {(t.format || t.platform) && (
        <div className="row wrap" style={{ gap: 6 }}>
          {t.format && <span className="chip" style={{ height: 28 }}>{t.format}</span>}
          {t.platform && <span className="chip" style={{ height: 28 }}>{t.platform}</span>}
        </div>
      )}

      <Checklist task={t} />
      <Links task={t} />
      <Repeat task={t} closed={closed} />

      {t.canEdit && !closed && (
        editDeadline ? (
          <DeadlineEditor task={t} onDone={() => setEditDeadline(false)} />
        ) : (
          <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setEditDeadline(true)}>
            <Icon name="clock" size={16} /> Deadline’ni o‘zgartirish
          </button>
        )
      )}

      <div className="stack" style={{ gap: 8 }}>
        <div className="section-title">Fayllar</div>
        {t.files.length === 0 ? (
          <div className="small muted">Hali fayl yo‘q.</div>
        ) : (
          t.files.map((f) => (
            <div key={f.id} className="card tight row small">
              <Icon name="file" size={18} />
              <span className="grow ellipsis">{f.fileName ?? f.kind}</span>
              <span className="faint">R{f.revision}</span>
            </div>
          ))
        )}
      </div>

      <Comments task={t} />

      <div className="stack" style={{ gap: 10 }}>
        <div className="section-title">Tarix</div>
        <div className="timeline">
          {t.events.map((e) => (
            <div key={e.id} className="ev small">
              <div>
                <b>{e.actorName ?? 'Tizim'}</b> <span className="muted">{eventText(e)}</span>
              </div>
              {typeof e.data?.after?.deadline === 'string' && <div className="xs muted">{when(String(e.data.before?.deadline), tz)} → {when(String(e.data.after.deadline), tz)}</div>}
              {typeof e.data?.after?.assigneeUserId === 'string' && <div className="xs muted">Ijrochi: {members.data?.find(m => m.userId === e.data?.before?.assigneeUserId)?.name ?? '—'} → {members.data?.find(m => m.userId === e.data?.after?.assigneeUserId)?.name ?? '—'}</div>}
              {e.comment && <div style={{ marginTop: 3 }}>💬 {e.comment}</div>}
              <div className="xs faint">{when(e.createdAt, tz)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function eventText(e: TaskDetail['events'][number]) {
  switch (e.action) {
    case 'CREATE':
      return e.data && 'repeatedFromId' in e.data ? 'takroriy vazifani yaratdi 🔁' : 'vazifani yaratdi';
    case 'DEADLINE_CHANGE':
      return 'deadline’ni o‘zgartirdi';
    case 'EDIT':
      return 'tahrirladi';
    case 'FILE':
      return 'fayl biriktirdi';
    case 'REPEAT_STOPPED':
      return 'takrorlanish to‘xtadi';
    default:
      return `${ACTION[e.action]?.label.toLowerCase() ?? e.action} → ${STATUS[e.toStatus ?? ''] ?? ''}`;
  }
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="card tight">
      <div className="xs muted">{label}</div>
      <div className="b small ellipsis" style={{ marginTop: 2 }}>{value}</div>
    </div>
  );
}

//


function useRefresh(id: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['task', id] });
    void qc.invalidateQueries({ queryKey: ['tasks'] });
  };
}

/** Move to another column of the board — the mobile alternative to drag & drop. */
function ColumnMove({ task, board }: { task: TaskDetail; board: string }) {
  const { fail, toast } = useApp();
  const refresh = useRefresh(task.id);
  const cols = useQuery({ queryKey: ['columns', board], queryFn: () => api<BoardColumn[]>(`/boards/${board}/columns`) });
  const [pending, setPending] = useState<BoardColumn | null>(null);
  const [comment, setComment] = useState('');
  const move = useMutation({
    mutationFn: (v: { col: BoardColumn; comment?: string }) => api(`/tasks/${task.id}/move`, { method: 'POST', body: { columnId: v.col.id, comment: v.comment } }),
    onSuccess: (_d, v) => {
      toast(`«${v.col.name}» ustuniga o'tkazildi`);
      setPending(null);
      setComment('');
      refresh();
    },
    onError: (e, v) => (e instanceof ApiError && e.code === 'COMMENT_REQUIRED' ? setPending(v.col) : fail(e)),
  });
  if (!cols.data || task.status === 'CANCELLED') return null;
  const current = cols.data.find((c) => c.id === task.columnId) ?? cols.data.find((c) => c.status === task.status);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="chips" style={{ flexWrap: 'wrap' }}>
        {cols.data.map((c) => (
          <button
            key={c.id}
            className={`chip ${current?.id === c.id ? 'on' : ''}`}
            style={{ height: 30 }}
            disabled={move.isPending || current?.id === c.id}
            onClick={() => move.mutate({ col: c })}
          >
            <span style={{ width: 7, height: 7, borderRadius: 4, background: c.color }} />
            {c.name}
          </button>
        ))}
      </div>
      {pending && (
        <div className="card stack">
          <Field label={`«${pending.name}» — izoh majburiy`}>
            <textarea className="input" autoFocus value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} />
          </Field>
          <div className="row">
            <button className="btn grow" onClick={() => setPending(null)}>Bekor</button>
            <button className="btn primary grow" disabled={!comment.trim() || move.isPending} onClick={() => move.mutate({ col: pending, comment })}>O'tkazish</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Checklist({ task }: { task: TaskDetail }) {
  const { fail } = useApp();
  const refresh = useRefresh(task.id);
  const [text, setText] = useState('');
  const add = useMutation({
    mutationFn: () => api(`/tasks/${task.id}/checklist`, { method: 'POST', body: { text } }),
    onSuccess: () => {
      setText('');
      refresh();
    },
    onError: fail,
  });
  const toggle = useMutation({
    mutationFn: (v: { id: string; done: boolean }) => api(`/tasks/${task.id}/checklist/${v.id}`, { method: 'PATCH', body: { done: v.done } }),
    onSuccess: refresh,
    onError: fail,
  });
  const del = useMutation({ mutationFn: (itemId: string) => api(`/tasks/${task.id}/checklist/${itemId}`, { method: 'DELETE' }), onSuccess: refresh, onError: fail });
  const done = task.checklist.filter((i) => i.done).length;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row between">
        <div className="section-title">Checklist</div>
        {task.checklist.length > 0 && <span className="small muted">{done}/{task.checklist.length}</span>}
      </div>
      {task.checklist.map((i) => (
        <div key={i.id} className="row" style={{ gap: 10 }}>
          <input type="checkbox" checked={i.done} onChange={(e) => toggle.mutate({ id: i.id, done: e.target.checked })} style={{ width: 18, height: 18, accentColor: 'var(--accent)' }} aria-label={i.text} />
          <span className="grow small" style={{ textDecoration: i.done ? 'line-through' : undefined, color: i.done ? 'var(--muted)' : undefined }}>{i.text}</span>
          <button className="btn sm ghost" aria-label="O'chirish" onClick={() => del.mutate(i.id)}><Icon name="close" size={14} /></button>
        </div>
      ))}
      <form className="row" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); if (text.trim()) add.mutate(); }}>
        <input className="input" style={{ minHeight: 40 }} placeholder="Yangi band…" value={text} onChange={(e) => setText(e.target.value)} maxLength={300} />
        <button className="btn sm" disabled={!text.trim() || add.isPending}>Qo'shish</button>
      </form>
    </div>
  );
}

function Links({ task }: { task: TaskDetail }) {
  const { fail, toast } = useApp();
  const refresh = useRefresh(task.id);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(task.links.join('\n'));
  const save = useMutation({
    mutationFn: () => api(`/tasks/${task.id}`, { method: 'PATCH', body: { links: value.split(/\s+/).filter((l) => /^https?:\/\//.test(l)).slice(0, 5) } }),
    onSuccess: () => {
      toast('Havolalar saqlandi');
      setEditing(false);
      refresh();
    },
    onError: fail,
  });
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row between">
        <div className="section-title">Havolalar</div>
        <button className="btn sm ghost" onClick={() => setEditing(!editing)}>{editing ? 'Bekor' : 'Tahrirlash'}</button>
      </div>
      {editing ? (
        <div className="stack" style={{ gap: 8 }}>
          <textarea className="input" value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://…" />
          <button className="btn primary sm" style={{ alignSelf: 'flex-end' }} disabled={save.isPending} onClick={() => save.mutate()}>Saqlash</button>
        </div>
      ) : task.links.length === 0 ? (
        <div className="small muted">Havola yo'q.</div>
      ) : (
        task.links.map((l) => (
          <a key={l} className="card tight row small" href={l} target="_blank" rel="noreferrer">
            <Icon name="link" size={16} />
            <span className="grow ellipsis">{l.replace(/^https?:\/\//, '')}</span>
          </a>
        ))
      )}
    </div>
  );
}

/** Repeating: who gave the task (or a manager) can switch it on, change or stop it. */
function Repeat({ task, closed }: { task: TaskDetail; closed: boolean }) {
  const { fail, toast, session } = useApp();
  const refresh = useRefresh(task.id);
  const editable = !closed && (task.canEdit || task.createdBy === session.user.id);
  const save = useMutation({
    mutationFn: (recurrence: string) => api(`/tasks/${task.id}`, { method: 'PATCH', body: { recurrence: recurrence || null } }),
    onSuccess: (_d, r) => {
      toast(r ? `🔁 ${RECURRENCE_LABEL[r as Recurrence]}` : 'Takrorlanish o‘chirildi');
      refresh();
    },
    onError: fail,
  });
  if (!task.recurrence && !editable) return null;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="section-title">Takrorlanish</div>
      {editable ? (
        <select className="input" value={task.recurrence ?? ''} disabled={save.isPending} onChange={(e) => save.mutate(e.target.value)}>
          <option value="">Takrorlanmaydi</option>
          {RECURRENCES.map((r) => (
            <option key={r} value={r}>🔁 {RECURRENCE_LABEL[r]}</option>
          ))}
        </select>
      ) : (
        <div className="small">🔁 {RECURRENCE_LABEL[task.recurrence as Recurrence] ?? task.recurrence}</div>
      )}
      {task.recurrence && <div className="xs muted">Muddati kelganda yoki yopilganda keyingi vazifa o‘zi yaratiladi.</div>}
    </div>
  );
}

function Comments({ task }: { task: TaskDetail }) {
  const { fail, session } = useApp();
  const refresh = useRefresh(task.id);
  const [body, setBody] = useState('');
  const send = useMutation({
    mutationFn: () => api(`/tasks/${task.id}/comments`, { method: 'POST', body: { body } }),
    onSuccess: () => {
      setBody('');
      refresh();
    },
    onError: fail,
  });
  const tz = session.ctx.company.timezone;
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="section-title">Izohlar · {task.comments.length}</div>
      {task.comments.map((c) => (
        <div key={c.id} className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
          <Avatar name={c.name} src={c.photoUrl} size={30} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="small"><b>{c.name}</b> <span className="xs faint">{when(c.createdAt, tz)}</span></div>
            <div className="small" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>{c.body}</div>
          </div>
        </div>
      ))}
      <form className="row" style={{ gap: 8, alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); if (body.trim()) send.mutate(); }}>
        <textarea className="input" style={{ minHeight: 44 }} placeholder="Izoh yozing…" value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} />
        <button className="btn primary sm" disabled={!body.trim() || send.isPending}>Yuborish</button>
      </form>
    </div>
  );
}

