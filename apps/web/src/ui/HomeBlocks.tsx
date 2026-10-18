import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { leftText } from '../lib/format';
import { useProjects } from '../lib/queries';
import type { Dashboard, Shoot, Today } from '../lib/types';
import { Avatar, Bar, Icon } from './kit';
import { go, useApp } from './state';

interface AlertTask {
  id: string;
  number: number;
  title: string;
  deadline: string;
  status: string;
  project: string | null;
  assignee: string;
}
interface HomeAlerts {
  escalations: Array<AlertTask & { level: 'MANAGER' | 'CEO' }>;
  reminders: Array<AlertTask & { sentAt: string; overdue: boolean }>;
}

export const useHomeAlerts = () => useQuery({ queryKey: ['home-alerts'], queryFn: () => api<HomeAlerts>('/home/alerts') });

/** Bugun ishda: came / late / not here yet, for whoever sees the team. */
export function TodayAtWork({ d }: { d: Dashboard }) {
  const today = useQuery({ queryKey: ['today'], queryFn: () => api<Today>('/attendance/today') });
  const t = d.totals;
  const working = today.data?.workingDay ?? true;
  const onTime = Math.max(0, t.presentToday - t.lateToday);
  const missing = working ? Math.max(0, t.people - t.presentToday) : 0;
  return (
    <button className="card stack click" style={{ gap: 12, textAlign: 'left', font: 'inherit', color: 'inherit' }} onClick={() => go('attendance')}>
      <div className="row between">
        <div className="b">Bugun ishda</div>
        <span className="xb">{t.presentToday}/{t.people}</span>
      </div>
      {working ? (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
          <Num v={onTime} l="Vaqtida" color="var(--accent)" />
          <Num v={t.lateToday} l="Kechikdi" color="var(--warn)" />
          <Num v={missing} l="Kelmagan" color="var(--danger)" />
        </div>
      ) : (
        <div className="small muted">Bugun dam olish kuni</div>
      )}
    </button>
  );
}

function Num({ v, l, color }: { v: number; l: string; color: string }) {
  return (
    <div style={{ background: 'var(--surface-2)', borderRadius: 12, padding: '10px 12px' }}>
      <div className="xb" style={{ fontSize: 22, color: v ? color : undefined }}>{v}</div>
      <div className="xs muted">{l}</div>
    </div>
  );
}

/** Eskalatsiya: tasks whose 3rd overdue reminder went to the manager or the CEO. */
export function Escalations() {
  const q = useHomeAlerts();
  const list = q.data?.escalations ?? [];
  if (!list.length) return null;
  return (
    <div className="card stack" style={{ gap: 10, borderColor: 'color-mix(in srgb, var(--danger) 40%, transparent)' }}>
      <div className="row between">
        <div className="b">Eskalatsiya</div>
        <span className="pill" style={{ background: 'var(--danger-bg)', color: 'var(--danger)' }}>{list.length}</span>
      </div>
      {list.slice(0, 5).map((t) => (
        <AlertRow key={t.id} t={t} tag={t.level === 'CEO' ? 'CEO' : 'Rahbar'} />
      ))}
    </div>
  );
}

/** Menga eslatmalar: live reminders the bot left in my Telegram chat. */
export function MyReminders() {
  const q = useHomeAlerts();
  const list = q.data?.reminders ?? [];
  if (!list.length) return null;
  return (
    <div className="card stack" style={{ gap: 10 }}>
      <div className="row between">
        <div className="b">Menga eslatmalar</div>
        <span className="pill s-REVIEW">{list.length}</span>
      </div>
      {list.slice(0, 5).map((t) => (
        <AlertRow key={t.id} t={t} tag={t.overdue ? 'Muddati o‘tdi' : undefined} />
      ))}
    </div>
  );
}

function AlertRow({ t, tag }: { t: AlertTask; tag?: string }) {
  const left = leftText(t.deadline);
  return (
    <div className="row click" style={{ gap: 10, cursor: 'pointer' }} onClick={() => go('tasks', t.id)}>
      <span className="faint"><Icon name="alert" size={18} /></span>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="b ellipsis">#{t.number} · {t.title}</div>
        <div className="xs muted ellipsis">{[t.assignee, t.project, left.text].filter(Boolean).join(' · ')}</div>
      </div>
      {tag && <span className="xs b" style={{ color: 'var(--danger)', whiteSpace: 'nowrap' }}>{tag}</span>}
    </div>
  );
}

/** Loyihalar progressi: done share per active project. */
export function ProjectsProgress() {
  const q = useProjects();
  const list = (q.data ?? []).filter((p) => p.status === 'ACTIVE' && p.taskTotal > 0).sort((a, b) => a.progress - b.progress);
  if (!list.length) return null;
  return (
    <div className="card stack" style={{ gap: 12 }}>
      <div className="row between">
        <div className="b">Loyihalar progressi</div>
        <a href="#/projects" className="small b">Hammasi</a>
      </div>
      {list.slice(0, 6).map((p) => (
        <div key={p.id} className="stack click" style={{ gap: 5, cursor: 'pointer' }} onClick={() => go('projects', p.id)}>
          <div className="row between small">
            <span className="row ellipsis" style={{ gap: 8, minWidth: 0 }}>
              <i style={{ width: 9, height: 9, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
              <span className="ellipsis b">{p.name}</span>
            </span>
            <span className="muted" style={{ whiteSpace: 'nowrap' }}>
              {p.taskDone}/{p.taskTotal}
              {p.taskOverdue > 0 && <b style={{ color: 'var(--danger)' }}> · {p.taskOverdue} kech</b>} · <b>{p.progress}%</b>
            </span>
          </div>
          <Bar value={p.progress} tone={p.taskOverdue > 0 ? 'warn' : undefined} />
        </div>
      ))}
    </div>
  );
}

/** Bugungi syomkalar: where, when and with whom. */
export function TodayShoots() {
  const { session } = useApp();
  const day = new Date().toLocaleDateString('en-CA', { timeZone: session.ctx.company.timezone });
  const q = useQuery({ queryKey: ['shoots', day, day], queryFn: () => api<Shoot[]>('/shoots', { query: { from: day, to: day } }) });
  const list = (q.data ?? []).filter((s) => s.status !== 'CANCELLED');
  if (!list.length) return null;
  return (
    <div className="card stack" style={{ gap: 10 }}>
      <div className="row between">
        <div className="b">Bugungi syomkalar</div>
        <a href="#/shoots" className="small b">Kalendar</a>
      </div>
      {list.map((s) => (
        <div key={s.id} className="row" style={{ gap: 12 }}>
          <div style={{ width: 4, alignSelf: 'stretch', borderRadius: 2, background: s.color }} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="b ellipsis">{s.title}</div>
            <div className="xs muted ellipsis">
              {s.startTime.slice(0, 5)}–{s.endTime.slice(0, 5)}
              {s.location ? ` · ${s.location}` : ''}
              {s.project ? ` · ${s.project}` : ''}
            </div>
          </div>
          <div className="row" style={{ gap: 0 }}>
            {s.crew.slice(0, 3).map((p) => (
              <span key={p.id} style={{ marginLeft: -6 }}>
                <Avatar name={p.name} src={p.photoUrl} size={26} />
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
