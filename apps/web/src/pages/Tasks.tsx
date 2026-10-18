import { localParts, zonedTime } from '@retarget/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useDepartments, useMembers, useProjects } from '../lib/queries';
import type { TaskListItem } from '../lib/types';
import { Board } from '../ui/Board';
import { Empty, Icon, Sheet, Skeleton } from '../ui/kit';
import { go, useApp } from '../ui/state';
import { TaskForm } from '../ui/TaskForm';
import { TaskRow } from '../ui/TaskRow';
import { TaskView } from '../ui/TaskView';

export { TaskForm } from '../ui/TaskForm';

type View = 'board' | 'list' | 'calendar';
const MONTHS = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'];

function readView(): View {
  try {
    const v = localStorage.getItem('rt.tasksView');
    if (v === 'board' || v === 'list' || v === 'calendar') return v;
  } catch {
    /* ignore */
  }
  return 'board';
}

export interface TaskFilters {
  q: string;
  projectId: string;
  assigneeUserId: string;
  departmentId: string;
  onlyPrivate: boolean;
}
export const EMPTY_FILTERS: TaskFilters = { q: '', projectId: '', assigneeUserId: '', departmentId: '', onlyPrivate: false };

export function applyFilters(all: TaskListItem[], f: TaskFilters) {
  const needle = f.q.trim().toLowerCase();
  return all.filter(
    (t) =>
      (!needle || `${t.number} ${t.title} ${t.project ?? ''} ${t.assignee.name} ${t.format ?? ''}`.toLowerCase().includes(needle)) &&
      (!f.projectId || t.projectId === f.projectId) &&
      (!f.assigneeUserId || t.assigneeUserId === f.assigneeUserId) &&
      (!f.departmentId || t.departmentId === f.departmentId) &&
      (!f.onlyPrivate || t.isPrivate),
  );
}

/** Search + filter row shared by Tasks, Dizayn and Media. */
export function FilterBar({ f, setF, hideDepartment }: { f: TaskFilters; setF: (f: TaskFilters) => void; hideDepartment?: boolean }) {
  const projects = useProjects();
  const members = useMembers();
  const deps = useDepartments();
  const active = [f.projectId, f.assigneeUserId, f.departmentId, f.onlyPrivate].filter(Boolean).length;
  const sel = { minHeight: 40, padding: '8px 10px', fontSize: 13, width: 'auto', maxWidth: 190 } as const;
  return (
    <div className="filterbar">
      <div className="filterbar-search">
        <input className="input" style={{ minHeight: 40, paddingLeft: 36 }} placeholder="Qidirish…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <span className="faint" style={{ position: 'absolute', left: 11, top: 10 }}><Icon name="search" size={18} /></span>
      </div>
      <div className="filterbar-chips">
      <select className="input" style={sel} value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })} aria-label="Loyiha">
        <option value="">Barcha loyihalar</option>
        {(projects.data ?? []).map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      <select className="input" style={sel} value={f.assigneeUserId} onChange={(e) => setF({ ...f, assigneeUserId: e.target.value })} aria-label="Ijrochi">
        <option value="">Barcha ijrochilar</option>
        {(members.data ?? []).filter((m) => m.status === 'ACTIVE').map((m) => (
          <option key={m.userId} value={m.userId}>{m.name}</option>
        ))}
      </select>
      {!hideDepartment && (
        <select className="input" style={sel} value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })} aria-label="Bo'lim">
          <option value="">Barcha bo'limlar</option>
          {(deps.data ?? []).map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      )}
      <button className={`chip ${f.onlyPrivate ? 'on' : ''}`} style={{ height: 40 }} onClick={() => setF({ ...f, onlyPrivate: !f.onlyPrivate })}>1:1</button>
      {active > 0 && (
        <button className="btn sm ghost" onClick={() => setF({ ...EMPTY_FILTERS, q: f.q })}>Tozalash</button>
      )}
      </div>
    </div>
  );
}

export function Tasks({ openId }: { openId?: string }) {
  const { can, session } = useApp();
  const [view, setViewState] = useState<View>(readView);
  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem('rt.tasksView', v);
    } catch {
      /* ignore */
    }
  };
  const [mine, setMine] = useState(false);
  const [f, setF] = useState<TaskFilters>(EMPTY_FILTERS);
  const [creating, setCreating] = useState(false);
  const tasks = useQuery({
    queryKey: ['tasks', { mine, closed: true }],
    queryFn: () => api<TaskListItem[]>('/tasks', { query: { mine: mine || undefined, includeClosed: true } }),
  });
  const shown = useMemo(() => applyFilters(tasks.data ?? [], f), [tasks.data, f]);

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row wrap between" style={{ gap: 10 }}>
        <h1 className="page-title">Vazifalar</h1>
        <div className="row" style={{ gap: 8 }}>
          <div className="seg" style={{ width: 250 }}>
            <button className={view === 'board' ? 'on' : ''} onClick={() => setView('board')}>Doska</button>
            <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>Ro'yxat</button>
            <button className={view === 'calendar' ? 'on' : ''} onClick={() => setView('calendar')}>Kalendar</button>
          </div>
          {(session.ctx.perms.createTasks || session.ctx.perms.assignTasks) && (
            <button className="btn primary sm" onClick={() => setCreating(true)}>
              <Icon name="plus" size={16} /> Yangi
            </button>
          )}
        </div>
      </div>

      <div className="row wrap" style={{ gap: 8 }}>
        <div className="seg" style={{ width: 200 }}>
          <button className={!mine ? 'on' : ''} onClick={() => setMine(false)}>Hammasi</button>
          <button className={mine ? 'on' : ''} onClick={() => setMine(true)}>Meniki</button>
        </div>
        <div style={{ flex: '1 1 320px', minWidth: 0 }}><FilterBar f={f} setF={setF} /></div>
      </div>

      {tasks.isPending ? (
        <Skeleton n={5} />
      ) : view === 'board' ? (
        <Board board="main" tasks={shown.filter((t) => t.status !== 'CANCELLED')} />
      ) : view === 'list' ? (
        <TaskList tasks={shown} />
      ) : (
        <TaskCalendar tasks={shown} />
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

// ------------------------------------------------------------------------------------------ list

export function dayKey(d: Date | string, tz: string) {
  return new Date(d).toLocaleDateString('en-CA', { timeZone: tz });
}

export function TaskList({ tasks, openRoute }: { tasks: TaskListItem[]; openRoute?: string }) {
  const { session } = useApp();
  const tz = session.ctx.company.timezone;
  const today = dayKey(new Date(), tz);
  const tomorrow = dayKey(new Date(Date.now() + 86_400_000), tz);
  const week = dayKey(new Date(Date.now() + 7 * 86_400_000), tz);
  const open = tasks.filter((t) => !['DONE', 'CANCELLED'].includes(t.status));
  const groups: Array<[string, TaskListItem[]]> = [
    ["Muddati o'tgan", open.filter((t) => t.overdue)],
    ['Bugun', open.filter((t) => !t.overdue && dayKey(t.deadline, tz) === today)],
    ['Ertaga', open.filter((t) => dayKey(t.deadline, tz) === tomorrow)],
    ['Shu hafta', open.filter((t) => { const k = dayKey(t.deadline, tz); return k > tomorrow && k <= week; })],
    ['Keyinroq', open.filter((t) => dayKey(t.deadline, tz) > week)],
    ['Bajarilgan (14 kun)', tasks.filter((t) => t.status === 'DONE')],
  ];
  if (!tasks.length) return <div className="card"><Empty icon="🗂️" title="Vazifa topilmadi" /></div>;
  return (
    <div className="stack" style={{ gap: 16 }}>
      {groups.filter(([, items]) => items.length).map(([title, items]) => (
        <div key={title} className="stack" style={{ gap: 8 }}>
          <div className="row between">
            <div className="section-title" style={{ color: title.startsWith('Muddati') ? 'var(--danger)' : undefined }}>{title}</div>
            <span className="small muted">{items.length}</span>
          </div>
          <div className="grid grid-auto" style={{ gap: 8 }}>
            {[...items].sort((a, b) => +new Date(a.deadline) - +new Date(b.deadline)).map((t) => (
              <TaskRow key={t.id} t={t} showAssignee openRoute={openRoute} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------------ calendar

export function TaskCalendar({ tasks }: { tasks: TaskListItem[] }) {
  const { session } = useApp();
  const tz = session.ctx.company.timezone;
  const now = localParts(new Date(), tz);
  const [ym, setYm] = useState<[number, number]>([now.year, now.month]);
  const [day, setDay] = useState<string | null>(null);
  const [y, m] = ym;
  const startWd = localParts(zonedTime(y, m, 1, 12, 0, tz), tz).weekday; // 1..7
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const today = dayKey(new Date(), tz);
  const byDay = new Map<string, TaskListItem[]>();
  for (const t of tasks.filter((t) => t.status !== 'CANCELLED')) {
    const k = dayKey(t.deadline, tz);
    byDay.set(k, [...(byDay.get(k) ?? []), t]);
  }
  const shift = (d: number) => {
    const dt = new Date(Date.UTC(y, m - 1 + d, 1));
    setYm([dt.getUTCFullYear(), dt.getUTCMonth() + 1]);
  };
  const key = (d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const dayTasks = day ? byDay.get(day) ?? [] : [];
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row between">
        <div className="section-title">{MONTHS[m - 1]} {y}</div>
        <div className="row" style={{ gap: 4 }}>
          <button className="btn sm ghost" aria-label="Oldingi oy" onClick={() => shift(-1)}>‹</button>
          <button className="btn sm ghost" onClick={() => setYm([now.year, now.month])}>Bugun</button>
          <button className="btn sm ghost" aria-label="Keyingi oy" onClick={() => shift(1)}>›</button>
        </div>
      </div>
      <div className="cal">
        {['Du', 'Se', 'Ch', 'Pa', 'Ju', 'Sh', 'Ya'].map((w) => (
          <div key={w} className="cal-h">{w}</div>
        ))}
        {Array.from({ length: startWd - 1 }, (_, i) => (
          <div key={`e${i}`} />
        ))}
        {Array.from({ length: days }, (_, i) => {
          const k = key(i + 1);
          const items = byDay.get(k) ?? [];
          return (
            <div key={k} className={`cal-d ${k === today ? 'today' : ''}`} onClick={() => setDay(k)} role="button" tabIndex={0}>
              <div className="xs b" style={{ color: k === today ? 'var(--accent-ink)' : 'var(--muted)' }}>{i + 1}</div>
              {items.slice(0, 3).map((t) => (
                <div key={t.id} className="cal-chip" style={{ borderLeftColor: t.overdue ? 'var(--danger)' : t.status === 'DONE' ? 'var(--accent)' : 'var(--info)' }}>{t.title}</div>
              ))}
              {items.length > 3 && <div className="xs muted">+{items.length - 3}</div>}
            </div>
          );
        })}
      </div>
      <Sheet open={!!day} onClose={() => setDay(null)} title={day ? day.split('-').reverse().join('.') : ''}>
        {dayTasks.length === 0 ? (
          <Empty icon="📅" title="Bu kunga vazifa yo'q" />
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            {dayTasks.map((t) => (
              <TaskRow key={t.id} t={t} showAssignee />
            ))}
          </div>
        )}
      </Sheet>
    </div>
  );
}
