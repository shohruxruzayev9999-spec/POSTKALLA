import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useDepartments, useMembers } from '../lib/queries';
import type { TaskListItem } from '../lib/types';
import { Board } from '../ui/Board';
import { Avatar, Bar, Empty, Icon, Ring, Sheet, Skeleton } from '../ui/kit';
import { go, useApp } from '../ui/state';
import { TaskForm } from '../ui/TaskForm';
import { TaskView } from '../ui/TaskView';
import { applyFilters, EMPTY_FILTERS, FilterBar, TaskList, type TaskFilters } from './Tasks';

const MONTHS = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'];

export const SECTIONS = {
  DESIGN: { route: 'design', title: 'Dizayn', unit: 'TZ', people: 'Dizaynerlar', empty: 'Dizayn bo‘limi yo‘q' },
  MEDIA: { route: 'media', title: 'Media', unit: 'vazifa', people: 'Media jamoasi', empty: 'Media bo‘limi yo‘q' },
} as const;
type SectionKey = keyof typeof SECTIONS;

const monthOf = (d: string, tz: string) => new Date(d).toLocaleDateString('en-CA', { timeZone: tz }).slice(0, 7);
const OPEN = ['NEW', 'IN_PROGRESS', 'RETURNED', 'REVIEW', 'BLOCKED'];

/**
 * Dizayn / Media: the department board plus the numbers a lead looks at every morning —
 * completion, what waits for approval, who is overloaded, which projects lag, how many rounds of edits.
 */
export function Section({ section, openId }: { section: SectionKey; openId?: string }) {
  const cfg = SECTIONS[section];
  const { session, can } = useApp();
  const tz = session.ctx.company.timezone;
  const nowMonth = new Date().toLocaleDateString('en-CA', { timeZone: tz }).slice(0, 7);
  const [month, setMonth] = useState(nowMonth);
  const [view, setView] = useState<'board' | 'list'>('board');
  const [mobileTab, setMobileTab] = useState<'work' | 'team' | 'projects'>('work');
  const [f, setF] = useState<TaskFilters>(EMPTY_FILTERS);
  const [creating, setCreating] = useState(false);
  const deps = useDepartments();
  const members = useMembers();
  const tasks = useQuery({ queryKey: ['tasks', { section, closed: true }], queryFn: () => api<TaskListItem[]>('/tasks', { query: { section, includeClosed: true } }) });

  const sectionDeps = (deps.data ?? []).filter((d) => d.section === section);
  const depIds = sectionDeps.map((d) => d.id);
  const people = (members.data ?? []).filter((m) => m.status === 'ACTIVE' && m.departmentId && depIds.includes(m.departmentId));

  // Tasks of the month: deadline in the month; the current month also carries unfinished work from before.
  const inMonth = useMemo(() => {
    return (tasks.data ?? []).filter((t) => {
      if (t.status === 'CANCELLED') return false;
      const m = monthOf(t.deadline, tz);
      if (m === month) return true;
      if (t.completedAt && monthOf(t.completedAt, tz) === month) return true;
      return month === nowMonth && m < month && OPEN.includes(t.status);
    });
  }, [tasks.data, month, nowMonth, tz]);
  const shown = useMemo(() => applyFilters(inMonth, f), [inMonth, f]);

  const s = useMemo(() => {
    const total = inMonth.length;
    const done = inMonth.filter((t) => t.status === 'DONE').length;
    const review = inMonth.filter((t) => t.status === 'REVIEW');
    const doing = inMonth.filter((t) => ['IN_PROGRESS', 'RETURNED', 'BLOCKED'].includes(t.status)).length;
    const fresh = inMonth.filter((t) => t.status === 'NEW').length;
    const overdue = inMonth.filter((t) => t.overdue).length;
    const doneOnTime = inMonth.filter((t) => t.status === 'DONE' && t.completedAt && new Date(t.completedAt) <= new Date(t.originalDeadline)).length;
    const rounds = inMonth.filter((t) => t.status === 'DONE');
    const avgRev = rounds.length ? rounds.reduce((a, t) => a + t.revision, 0) / rounds.length : null;
    return { total, done, review, doing, fresh, overdue, doneOnTime, avgRev, pct: total ? Math.round((done / total) * 100) : null };
  }, [inMonth]);

  const byProject = useMemo(() => {
    const m = new Map<string, { name: string; color: string; total: number; done: number; overdue: number }>();
    for (const t of inMonth) {
      const k = t.projectId ?? '—';
      if (!m.has(k)) m.set(k, { name: t.project ?? 'Loyihasiz', color: t.projectColor ?? '#9CA1AB', total: 0, done: 0, overdue: 0 });
      const r = m.get(k)!;
      r.total++;
      if (t.status === 'DONE') r.done++;
      if (t.overdue) r.overdue++;
    }
    return [...m.values()].sort((a, b) => b.total - a.total);
  }, [inMonth]);

  const byPerson = useMemo(() => {
    const openAll = inMonth.filter((t) => OPEN.includes(t.status));
    const totalOpenPts = openAll.reduce((a, t) => a + t.points, 0) || 1;
    const ids = new Set([...people.map((p) => p.userId), ...inMonth.map((t) => t.assigneeUserId)]);
    return [...ids]
      .map((id) => {
        const mine = inMonth.filter((t) => t.assigneeUserId === id);
        const open = mine.filter((t) => OPEN.includes(t.status));
        const done = mine.filter((t) => t.status === 'DONE');
        const person = people.find((p) => p.userId === id);
        const any = mine[0]?.assignee;
        return {
          id,
          name: person?.name ?? any?.name ?? '—',
          photoUrl: person?.photoUrl ?? any?.photoUrl ?? null,
          position: person?.position ?? null,
          open: open.length,
          overdue: open.filter((t) => t.overdue).length,
          done: done.length,
          load: Math.round((open.reduce((a, t) => a + t.points, 0) / totalOpenPts) * 100),
          avgRev: done.length ? done.reduce((a, t) => a + t.revision, 0) / done.length : null,
        };
      })
      .sort((a, b) => b.open - a.open || b.done - a.done);
  }, [inMonth, people]);

  const shift = (n: number) => {
    const [y, m] = month.split('-').map(Number) as [number, number];
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    setMonth(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  };
  const [y, mm] = month.split('-').map(Number) as [number, number];

  if (deps.data && !sectionDeps.length) {
    return (
      <div className="stack">
        <h1 className="page-title">{cfg.title}</h1>
        <div className="card">
          <Empty icon={section === 'DESIGN' ? '🎨' : '🎬'} title={cfg.empty}>
            <div className="small muted">Sozlamalar → Bo‘limlar’da bo‘lim uchun «{cfg.title}» doskasini tanlang.</div>
            {can('settings.company') && <button className="btn sm" onClick={() => go('settings')}>Sozlamalar</button>}
          </Empty>
        </div>
      </div>
    );
  }

  const teamPanel = (
    <div className="card stack" style={{ gap: 12 }}>
      <div className="row between">
        <div className="section-title">{cfg.people}</div>
        <span className="xs muted" title="Ochiq ishlarning shu odamdagi ulushi (ball bo‘yicha)">ish ulushi</span>
      </div>
      {byPerson.length === 0 && <div className="small muted">Bo‘limda hali hodim yo‘q</div>}
      {byPerson.map((p) => (
        <button key={p.id} className="row sec-person" onClick={() => setF({ ...EMPTY_FILTERS, assigneeUserId: f.assigneeUserId === p.id ? '' : p.id })} style={{ outline: f.assigneeUserId === p.id ? '2px solid var(--accent)' : undefined }}>
          <Avatar name={p.name} src={p.photoUrl} size={34} />
          <div className="grow stack" style={{ gap: 4, minWidth: 0 }}>
            <div className="row between" style={{ gap: 6 }}>
              <span className="b small ellipsis">{p.name}</span>
              <span className="xs b" style={{ color: byPerson.length > 1 && p.load >= 60 ? 'var(--warn)' : 'var(--muted)' }}>{p.load}%</span>
            </div>
            <Bar value={p.load} tone={byPerson.length > 1 && p.load >= 60 ? 'warn' : undefined} />
            <div className="row xs muted" style={{ gap: 10 }}>
              <span>{p.open} ochiq</span>
              {p.overdue > 0 && <span style={{ color: 'var(--danger)', fontWeight: 700 }}>{p.overdue} kechikkan</span>}
              <span>✓ {p.done}</span>
              {p.avgRev != null && <span>R {p.avgRev.toFixed(1)}</span>}
            </div>
          </div>
        </button>
      ))}
    </div>
  );

  const projectPanel = (
    <div className="card stack" style={{ gap: 12 }}>
      <div className="section-title">Loyihalar bo‘yicha</div>
      {byProject.length === 0 && <div className="small muted">Bu oyda {cfg.unit} yo‘q</div>}
      {byProject.map((p) => {
        const pct = Math.round((p.done / p.total) * 100);
        return (
          <div key={p.name} className="stack" style={{ gap: 5 }}>
            <div className="row between small" style={{ gap: 8 }}>
              <span className="row b ellipsis" style={{ gap: 7, minWidth: 0 }}><span style={{ width: 8, height: 8, borderRadius: 4, background: p.color, flexShrink: 0 }} />{p.name}</span>
              <span className="muted xs">{p.done}/{p.total}{p.overdue ? <b style={{ color: 'var(--danger)' }}> · {p.overdue}!</b> : null}</span>
            </div>
            <div className="bar"><i style={{ width: `${pct}%`, background: p.color }} /></div>
          </div>
        );
      })}
    </div>
  );

  const reviewPanel = s.review.length > 0 && (
    <div className="card stack" style={{ gap: 10 }}>
      <div className="row between">
        <div className="section-title">Tasdiq kutmoqda</div>
        <span className="pill s-REVIEW">{s.review.length}</span>
      </div>
      {s.review.slice(0, 6).map((t) => <ReviewRow key={t.id} t={t} route={cfg.route} />)}
    </div>
  );

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row wrap between" style={{ gap: 10 }}>
        <h1 className="page-title">{cfg.title}</h1>
        <div className="row" style={{ gap: 8 }}>
          <div className="row month-pick">
            <button className="btn sm ghost" aria-label="Oldingi oy" onClick={() => shift(-1)}>‹</button>
            <span className="b small" style={{ minWidth: 110, textAlign: 'center' }}>{MONTHS[mm - 1]} {y}</span>
            <button className="btn sm ghost" aria-label="Keyingi oy" onClick={() => shift(1)}>›</button>
          </div>
          {can('task.manage') && (
            <button className="btn primary sm" onClick={() => setCreating(true)}>
              <Icon name="plus" size={16} /> {cfg.unit === 'TZ' ? 'TZ' : 'Vazifa'}
            </button>
          )}
        </div>
      </div>

      {tasks.isPending ? (
        <Skeleton n={3} h={90} />
      ) : (
        <div className="sec-stats">
          <div className="card row sec-ring">
            <Ring value={s.pct} size={76} stroke={9} tone={s.pct == null || s.pct >= 70 ? 'green' : s.pct >= 40 ? 'amber' : 'coral'}>
              <div className="xb" style={{ fontSize: 20 }}>{s.pct == null ? '—' : `${s.pct}%`}</div>
            </Ring>
            <div className="stack" style={{ gap: 2 }}>
              <div className="b">Bajarilish</div>
              <div className="xs muted">{s.done} / {s.total} {cfg.unit}</div>
              <div className="xs muted">O‘z vaqtida: {s.done ? Math.round((s.doneOnTime / s.done) * 100) : 0}%</div>
            </div>
          </div>
          <Stat label={`Jami ${cfg.unit}`} v={s.total} />
          <Stat label="Jarayonda" v={s.doing} sub={s.fresh ? `+${s.fresh} yangi` : undefined} tone="var(--info)" />
          <Stat label="Tasdiq kutmoqda" v={s.review.length} tone="var(--review)" />
          <Stat label="Yakunlandi" v={s.done} tone="var(--accent-ink)" />
          <Stat label="Muddati o‘tgan" v={s.overdue} tone={s.overdue ? 'var(--danger)' : undefined} />
          <Stat label="O‘rtacha tahrir" v={s.avgRev == null ? '—' : s.avgRev.toFixed(1)} sub="raund / ish" />
        </div>
      )}

      <div className="seg sec-mobile-tabs">
        <button className={mobileTab === 'work' ? 'on' : ''} onClick={() => setMobileTab('work')}>Ishlar</button>
        <button className={mobileTab === 'team' ? 'on' : ''} onClick={() => setMobileTab('team')}>Jamoa</button>
        <button className={mobileTab === 'projects' ? 'on' : ''} onClick={() => setMobileTab('projects')}>Loyihalar</button>
      </div>

      <div className="sec-layout">
        <div className={`stack sec-main ${mobileTab === 'work' ? '' : 'm-hide'}`} style={{ gap: 12, minWidth: 0 }}>
          <div className="row wrap" style={{ gap: 8 }}>
            <div className="seg" style={{ width: 170 }}>
              <button className={view === 'board' ? 'on' : ''} onClick={() => setView('board')}>Doska</button>
              <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>Ro'yxat</button>
            </div>
            <div style={{ flex: '1 1 320px', minWidth: 0 }}><FilterBar f={f} setF={setF} hideDepartment /></div>
          </div>
          {tasks.isPending ? <Skeleton n={4} /> : view === 'board' ? <Board board={section} tasks={shown} departmentId={depIds[0]} openRoute={cfg.route} /> : <TaskList tasks={shown} openRoute={cfg.route} />}
        </div>
        <div className={`stack sec-side ${mobileTab === 'work' ? 'm-hide' : ''}`} style={{ gap: 12 }}>
          <div className={mobileTab === 'projects' ? 'm-hide' : ''}>{reviewPanel}</div>
          <div className={mobileTab === 'projects' ? 'm-hide' : ''}>{teamPanel}</div>
          <div className={mobileTab === 'team' ? 'm-hide' : ''}>{projectPanel}</div>
        </div>
      </div>

      <Sheet open={!!openId} onClose={() => go(cfg.route)} title={null} wide>
        {openId && <TaskView id={openId} board={section} />}
      </Sheet>
      <Sheet open={creating} onClose={() => setCreating(false)} title={cfg.unit === 'TZ' ? 'Yangi TZ' : 'Yangi vazifa'}>
        {creating && <TaskForm departmentId={depIds[0]} onDone={() => setCreating(false)} />}
      </Sheet>
    </div>
  );
}

function Stat({ label, v, sub, tone }: { label: string; v: number | string; sub?: string; tone?: string }) {
  return (
    <div className="card stat">
      <span className="v" style={{ color: tone }}>{v}</span>
      <span className="l">{label}</span>
      {sub && <span className="xs faint">{sub}</span>}
    </div>
  );
}

function ReviewRow({ t, route }: { t: TaskListItem; route: string }) {
  const { toast, fail } = useApp();
  const qc = useQueryClient();
  const [returning, setReturning] = useState(false);
  const [comment, setComment] = useState('');
  const act = useMutation({
    mutationFn: (v: { action: string; comment?: string }) => api(`/tasks/${t.id}/actions`, { method: 'POST', body: v }),
    onSuccess: (_d, v) => {
      toast(v.action === 'APPROVE' ? 'Tasdiqlandi' : 'Qaytarildi');
      setReturning(false);
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: fail,
  });
  const canApprove = t.actions.includes('APPROVE');
  return (
    <div className="stack" style={{ gap: 6, paddingBottom: 8, borderBottom: '1px solid var(--line)' }}>
      <button className="row" style={{ gap: 8, background: 'none', border: 0, padding: 0, color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer' }} onClick={() => go(route, t.id)}>
        <Avatar name={t.assignee.name} src={t.assignee.photoUrl} size={26} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="b small ellipsis">{t.title}</div>
          <div className="xs muted ellipsis">{t.assignee.name}{t.project ? ` · ${t.project}` : ''}{t.revision > 1 ? ` · R${t.revision}` : ''}</div>
        </div>
      </button>
      {canApprove && !returning && (
        <div className="row" style={{ gap: 6 }}>
          <button className="btn sm primary" style={{ flex: 1 }} disabled={act.isPending} onClick={() => act.mutate({ action: 'APPROVE' })}>Tasdiqlash</button>
          <button className="btn sm" style={{ flex: 1 }} disabled={act.isPending} onClick={() => setReturning(true)}>Qaytarish</button>
        </div>
      )}
      {returning && (
        <div className="stack" style={{ gap: 6 }}>
          <textarea className="input" autoFocus placeholder="Nima tuzatilsin?" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} style={{ minHeight: 70 }} />
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm danger" style={{ flex: 1 }} disabled={!comment.trim() || act.isPending} onClick={() => act.mutate({ action: 'RETURN', comment })}>Qaytarish</button>
            <button className="btn sm ghost" onClick={() => setReturning(false)}>Bekor</button>
          </div>
        </div>
      )}
    </div>
  );
}
