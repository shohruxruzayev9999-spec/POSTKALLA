import { localParts, zonedTime } from '@retarget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { ACTION, dateShort, leftText, PRIORITY, STATUS, when } from '../lib/format';
import { useMembers, useProjects } from '../lib/queries';
import type { TaskDetail, TaskListItem } from '../lib/types';
import { Empty, Field, Icon, Sheet, Skeleton, StatusPill } from '../ui/kit';
import { go, useApp } from '../ui/state';
import { TaskRow } from '../ui/TaskRow';

type View = 'mine' | 'all';
const FILTERS: Array<{ key: string; label: string; statuses: string[] }> = [
  { key: 'open', label: 'Ochiq', statuses: ['NEW', 'IN_PROGRESS', 'RETURNED', 'BLOCKED', 'REVIEW'] },
  { key: 'overdue', label: 'Kechikkan', statuses: [] },
  { key: 'REVIEW', label: 'Tekshiruvda', statuses: ['REVIEW'] },
  { key: 'DONE', label: 'Bajarilgan', statuses: ['DONE'] },
];
const COLUMNS: Array<{ title: string; statuses: string[] }> = [
  { title: 'Yangi', statuses: ['NEW', 'RETURNED'] },
  { title: 'Jarayonda', statuses: ['IN_PROGRESS', 'BLOCKED'] },
  { title: 'Tekshiruvda', statuses: ['REVIEW'] },
  { title: 'Bajarildi', statuses: ['DONE'] },
];

export function Tasks({ openId }: { openId?: string }) {
  const { isManager, can } = useApp();
  const [view, setView] = useState<View>(isManager ? 'all' : 'mine');
  const [filter, setFilter] = useState('open');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const tasks = useQuery({
    queryKey: ['tasks', { mine: view === 'mine', closed: true }],
    queryFn: () => api<TaskListItem[]>('/tasks', { query: { mine: view === 'mine' || undefined, includeClosed: true } }),
  });

  const all = tasks.data ?? [];
  const shown = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter)!;
    const needle = q.trim().toLowerCase();
    return all
      .filter((t) => (filter === 'overdue' ? t.overdue : f.statuses.includes(t.status)))
      .filter((t) => !needle || `${t.number} ${t.title} ${t.project ?? ''} ${t.assignee.name}`.toLowerCase().includes(needle));
  }, [all, filter, q]);
  const count = (k: string) => (k === 'overdue' ? all.filter((t) => t.overdue).length : all.filter((t) => FILTERS.find((x) => x.key === k)!.statuses.includes(t.status)).length);
  const desktop = typeof window !== 'undefined' && window.matchMedia('(min-width: 900px)').matches;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row between">
        <h1 className="page-title">Vazifalar</h1>
        {can('task.manage') && (
          <button className="btn primary sm" onClick={() => setCreating(true)}>
            <Icon name="plus" size={16} /> Yangi
          </button>
        )}
      </div>

      <div className="row wrap" style={{ gap: 10 }}>
        <div className="seg" style={{ width: 220 }}>
          <button className={view === 'mine' ? 'on' : ''} onClick={() => setView('mine')}>Mening</button>
          <button className={view === 'all' ? 'on' : ''} onClick={() => setView('all')}>Jamoa</button>
        </div>
        <div className="grow" style={{ minWidth: 180, position: 'relative' }}>
          <input className="input" style={{ minHeight: 42, paddingLeft: 38 }} placeholder="Qidirish…" value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="faint" style={{ position: 'absolute', left: 12, top: 11 }}>
            <Icon name="search" size={18} />
          </span>
        </div>
      </div>

      {!desktop && (
        <div className="chips">
          {FILTERS.map((f) => (
            <button key={f.key} className={`chip ${filter === f.key ? 'on' : ''}`} onClick={() => setFilter(f.key)}>
              {f.label} <span className="count">{count(f.key)}</span>
            </button>
          ))}
        </div>
      )}

      {tasks.isPending ? (
        <Skeleton n={5} />
      ) : desktop ? (
        <div className="kanban">
          {COLUMNS.map((col) => {
            const items = all.filter((t) => col.statuses.includes(t.status)).filter((t) => !q || `${t.number} ${t.title} ${t.project ?? ''} ${t.assignee.name}`.toLowerCase().includes(q.toLowerCase()));
            return (
              <div key={col.title} className="col">
                <div className="col-h">
                  <span>{col.title}</span>
                  <span className="muted">{items.length}</span>
                </div>
                {items.map((t) => (
                  <TaskRow key={t.id} t={t} showAssignee={view === 'all'} />
                ))}
              </div>
            );
          })}
        </div>
      ) : shown.length === 0 ? (
        <div className="card">
          <Empty icon="🗂️" title="Bu yerda hozircha bo‘sh" />
        </div>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          {shown.map((t) => (
            <TaskRow key={t.id} t={t} showAssignee={view === 'all'} />
          ))}
        </div>
      )}

      <Sheet open={!!openId} onClose={() => go('tasks')} title={null} wide>
        {openId && <TaskView id={openId} />}
      </Sheet>
      <Sheet open={creating} onClose={() => setCreating(false)} title="Yangi vazifa">
        {creating && <TaskForm onDone={() => setCreating(false)} />}
      </Sheet>
    </div>
  );
}

// ------------------------------------------------------------------------------------------

function TaskView({ id }: { id: string }) {
  const { fail, toast, session } = useApp();
  const qc = useQueryClient();
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

      <div className="stack" style={{ gap: 10 }}>
        <div className="section-title">Tarix</div>
        <div className="timeline">
          {t.events.map((e) => (
            <div key={e.id} className="ev small">
              <div>
                <b>{e.actorName ?? 'Tizim'}</b> <span className="muted">{eventText(e)}</span>
              </div>
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
      return 'vazifani yaratdi';
    case 'DEADLINE_CHANGE':
      return 'deadline’ni o‘zgartirdi';
    case 'EDIT':
      return 'tahrirladi';
    case 'FILE':
      return 'fayl biriktirdi';
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

// ------------------------------------------------------------------------------------------

function toLocalInput(d: Date, tz: string) {
  const p = localParts(d, tz);
  const z = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${z(p.month)}-${z(p.day)}T${z(p.hour)}:${z(p.minute)}`;
}
function fromLocalInput(v: string, tz: string): Date {
  const [date, hm] = v.split('T');
  const [y, m, d] = date!.split('-').map(Number) as [number, number, number];
  const [h, mi] = (hm ?? '18:00').split(':').map(Number) as [number, number];
  return zonedTime(y, m, d, h, mi, tz);
}

function DeadlineEditor({ task, onDone }: { task: TaskDetail; onDone: () => void }) {
  const { session, fail, toast } = useApp();
  const tz = session.ctx.company.timezone;
  const qc = useQueryClient();
  const [value, setValue] = useState(toLocalInput(new Date(task.deadline), tz));
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () => api(`/tasks/${task.id}`, { method: 'PATCH', body: { deadline: fromLocalInput(value, tz).toISOString(), reason } }),
    onSuccess: () => {
      toast('Deadline yangilandi');
      void qc.invalidateQueries({ queryKey: ['task', task.id] });
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      onDone();
    },
    onError: fail,
  });
  return (
    <div className="card stack">
      <Field label="Yangi deadline">
        <input className="input" type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
      <Field label="Sabab" hint="Motivatsiya asl deadline bo‘yicha hisoblanadi.">
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Masalan: mijoz materialni kech berdi" />
      </Field>
      <div className="row">
        <button className="btn grow" onClick={onDone}>Bekor</button>
        <button className="btn primary grow" disabled={!reason.trim() || save.isPending} onClick={() => save.mutate()}>Saqlash</button>
      </div>
    </div>
  );
}

function defaultDeadline(tz: string) {
  const now = new Date();
  const p = localParts(new Date(now.getTime() + 86_400_000), tz);
  return zonedTime(p.year, p.month, p.day, 18, 0, tz);
}

export function TaskForm({ onDone, projectId }: { onDone: () => void; projectId?: string }) {
  const { session, fail, toast, can } = useApp();
  const tz = session.ctx.company.timezone;
  const qc = useQueryClient();
  const members = useMembers();
  const projects = useProjects();
  const onlySelf = !can('task.manage', 'COMPANY') && !can('task.manage', 'DEPARTMENT') && !can('task.manage', 'PROJECT');
  const [form, setForm] = useState({
    title: '',
    description: '',
    projectId: projectId ?? '',
    assigneeUserId: onlySelf ? session.user.id : '',
    deadline: toLocalInput(defaultDeadline(tz), tz),
    priority: 'MEDIUM',
    points: 1,
  });
  const set = (k: keyof typeof form, v: string | number) => setForm((f) => ({ ...f, [k]: v }));
  const create = useMutation({
    mutationFn: () =>
      api<{ id: string }>('/tasks', {
        method: 'POST',
        body: {
          title: form.title,
          description: form.description || undefined,
          projectId: form.projectId || null,
          assigneeUserId: form.assigneeUserId,
          deadline: fromLocalInput(form.deadline, tz).toISOString(),
          priority: form.priority,
          points: Number(form.points),
        },
      }),
    onSuccess: (t) => {
      toast('Vazifa yaratildi');
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: ['projects'] });
      onDone();
      go('tasks', t.id);
    },
    onError: fail,
  });
  const active = (members.data ?? []).filter((m) => m.status === 'ACTIVE');
  const project = projects.data?.find((p) => p.id === form.projectId);
  const candidates = project ? active.filter((m) => project.memberUserIds.includes(m.userId)) : active;

  return (
    <div className="stack">
      <Field label="Nima qilish kerak?">
        <input className="input" autoFocus value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="Masalan: Oktabr aksiyasi uchun banner" maxLength={200} />
      </Field>
      <Field label="Loyiha">
        <select className="input" value={form.projectId} onChange={(e) => set('projectId', e.target.value)}>
          <option value="">— Loyihasiz —</option>
          {(projects.data ?? []).filter((p) => p.status === 'ACTIVE').map((p) => (
            <option key={p.id} value={p.id}>{p.name}{p.telegramChatId ? ' · 💬' : ''}</option>
          ))}
        </select>
      </Field>
      {!onlySelf && (
        <Field label="Ijrochi">
          <select className="input" value={form.assigneeUserId} onChange={(e) => set('assigneeUserId', e.target.value)}>
            <option value="">— Tanlang —</option>
            {candidates.map((m) => (
              <option key={m.userId} value={m.userId}>{m.name}{m.department ? ` · ${m.department}` : ''}</option>
            ))}
          </select>
        </Field>
      )}
      <div className="grid grid-2">
        <Field label="Deadline">
          <input className="input" type="datetime-local" value={form.deadline} onChange={(e) => set('deadline', e.target.value)} />
        </Field>
        <Field label="Muhimlik">
          <select className="input" value={form.priority} onChange={(e) => set('priority', e.target.value)}>
            <option value="HIGH">🔴 Yuqori</option>
            <option value="MEDIUM">🟡 O‘rta</option>
            <option value="LOW">🟢 Past</option>
          </select>
        </Field>
      </div>
      <Field label="Izoh (ixtiyoriy)">
        <textarea className="input" value={form.description} onChange={(e) => set('description', e.target.value)} maxLength={4000} placeholder="Texnik topshiriq, havolalar, o‘lchamlar…" />
      </Field>
      <Field label="Ball (hajm)" hint="Oylik reja va KPI “hajm” ko‘rsatkichi uchun. Oddiy vazifa — 1.">
        <input className="input" type="number" min={1} max={20} value={form.points} onChange={(e) => set('points', Number(e.target.value))} />
      </Field>
      {project && !project.telegramChatId && <div className="xs muted">💡 Loyihaga Telegram guruh ulansa, vazifa guruhga tugmalari bilan tushadi.</div>}
      <button className="btn primary block" disabled={form.title.trim().length < 2 || !form.assigneeUserId || create.isPending} onClick={() => create.mutate()}>
        {create.isPending ? 'Yaratilmoqda…' : 'Vazifani berish'}
      </button>
    </div>
  );
}
