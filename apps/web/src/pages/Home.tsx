import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { leftText, STAGE, time, todayLong } from '../lib/format';
import type { Dashboard, TaskListItem, Today } from '../lib/types';
import { getLocation } from '../lib/tg';
import { Avatar, Bar, Empty, Icon, Ring, scoreTone, Skeleton } from '../ui/kit';
import { go, useApp } from '../ui/state';
import { TaskRow } from '../ui/TaskRow';

export function Home() {
  const { session, isManager, theme, setTheme, switchCompany } = useApp();
  const dash = useQuery({ queryKey: ['dashboard'], queryFn: () => api<Dashboard>('/dashboard') });
  const mine = useQuery({ queryKey: ['tasks', { mine: true }], queryFn: () => api<TaskListItem[]>('/tasks', { query: { mine: true } }) });
  const u = session.user;
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ');

  const open = (mine.data ?? []).filter((t) => !['DONE', 'CANCELLED'].includes(t.status) && t.assigneeUserId === u.id);
  const toReview = (mine.data ?? []).filter((t) => t.status === 'REVIEW' && t.reviewerUserId === u.id);
  const overdue = open.filter((t) => t.overdue);
  const next = open.filter((t) => !t.overdue).sort((a, b) => +new Date(a.deadline) - +new Date(b.deadline))[0];
  const others = session.companies.filter((c) => c.id !== session.ctx.company.id && c.status === 'ACTIVE');

  return (
    <div className="stack" style={{ gap: 14 }}>
      <header className="row between">
        <div className="row" style={{ gap: 12 }}>
          <Avatar name={name} src={u.photoUrl} size={44} />
          <div>
            <div className="small muted">{todayLong(session.ctx.company.timezone)}</div>
            <div style={{ fontSize: 20, fontWeight: 800 }}>Salom, {u.firstName}</div>
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {others.length > 0 && (
            <select className="input" style={{ width: 'auto', minHeight: 40, padding: '6px 10px', fontSize: 13 }} value={session.ctx.company.id} onChange={(e) => switchCompany(e.target.value)} aria-label="Kompaniya">
              <option value={session.ctx.company.id}>{session.ctx.company.name}</option>
              {others.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          )}
          <button className="btn icon-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Mavzu">
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={19} />
          </button>
        </div>
      </header>

      <div className="grid desk-2" style={{ alignItems: 'start' }}>
        <div className="stack" style={{ gap: 14 }}>
          <AttendanceCard />

          {dash.isPending ? (
            <Skeleton h={150} n={1} />
          ) : dash.data && session.ctx.roles.includes('OWNER') && dash.data.team.length > 1 ? (
            <div className="card row" style={{ gap: 16 }}>
              <Ring value={dash.data.totals.avgMotivation} tone={scoreTone(dash.data.totals.avgMotivation)} label="jamoa motivatsiyasi" />
              <div className="stack grow" style={{ gap: 10 }}>
                <Metric label="Bugun ishda" value={dash.data.totals.people ? (100 * dash.data.totals.presentToday) / dash.data.totals.people : null} pct />
                <Metric label="Jamoa KPI (o‘rtacha)" value={avg(dash.data.team.map((t) => t.kpi.score))} />
                <Metric label="Muddatida bajarilish" value={onTimeShare(dash.data)} pct />
              </div>
            </div>
          ) : dash.data ? (
            <div className="card row click" style={{ gap: 16 }} onClick={() => go('profile')}>
              <Ring value={dash.data.me.kpi.score} tone={scoreTone(dash.data.me.kpi.score)} label="mening KPI" />
              <div className="stack grow" style={{ gap: 10 }}>
                <Metric label="Motivatsiya" value={dash.data.me.motivation.score} suffix={dash.data.me.motivation.stage ? ` · ${STAGE[dash.data.me.motivation.stage]}` : ''} />
                <Metric label="Davomat" value={dash.data.me.kpi.components.attendance ?? null} pct />
                <Metric label="Oylik reja" value={dash.data.me.kpi.components.volume ?? null} pct />
              </div>
            </div>
          ) : null}

          {overdue.length > 0 ? (
            <div className="banner danger">
              <span className="xb" style={{ fontSize: 20, color: 'var(--danger)' }}>{overdue.length}</span>
              <div>
                ta vazifa muddati o‘tgan. Eng eskisi: <b>{overdue[0]!.title}</b> — {leftText(overdue[0]!.deadline).text}.
              </div>
            </div>
          ) : next ? (
            <div className="banner warn">
              <span className="xb" style={{ fontSize: 18, color: 'var(--warn)', whiteSpace: 'nowrap' }}>{leftText(next.deadline).text}</span>
              <div>
                <b>{next.title}</b> muddatigacha qoldi.
              </div>
            </div>
          ) : null}

          {toReview.length > 0 && (
            <>
              <div className="row between">
                <div className="section-title">Tekshirishingiz kerak</div>
                <span className="pill s-REVIEW">{toReview.length}</span>
              </div>
              <div className="stack" style={{ gap: 8 }}>
                {toReview.slice(0, 4).map((t) => (
                  <TaskRow key={t.id} t={t} showAssignee />
                ))}
              </div>
            </>
          )}

          <div className="row between" style={{ alignItems: 'baseline' }}>
            <div className="section-title">Mening vazifalarim</div>
            <a href="#/tasks" className="small b">Hammasi {open.length}</a>
          </div>
          {mine.isPending ? (
            <Skeleton />
          ) : open.length === 0 ? (
            <div className="card">
              <Empty icon="🎉" title="Ochiq vazifa yo‘q">Yangi vazifa kelsa, Telegram guruhingizda va shu yerda ko‘rinadi.</Empty>
            </div>
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              {open.slice(0, 6).map((t) => (
                <TaskRow key={t.id} t={t} />
              ))}
            </div>
          )}
        </div>

        {isManager && dash.data && dash.data.team.length > 1 && <TeamPanel d={dash.data} />}
      </div>
    </div>
  );
}

function avg(xs: Array<number | null>): number | null {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function onTimeShare(d: Dashboard): number | null {
  const on = d.team.reduce((s, t) => s + t.motivation.onTime, 0);
  const all = d.team.reduce((s, t) => s + t.motivation.onTime + t.motivation.doneLate + t.motivation.openOverdue, 0);
  return all ? (100 * on) / all : null;
}

function Metric({ label, value, pct, suffix }: { label: string; value: number | null; pct?: boolean; suffix?: string }) {
  const v = value == null ? null : Math.round(value);
  return (
    <div>
      <div className="row between small">
        <span className="muted">{label}</span>
        <span className="xb">
          {v == null ? '—' : `${v}${pct ? '%' : ''}`}
          <span className="muted" style={{ fontWeight: 600 }}>{suffix}</span>
        </span>
      </div>
      <div style={{ marginTop: 4 }}>
        <Bar value={v} tone={v != null && v < 50 ? 'danger' : v != null && v < 70 ? 'warn' : undefined} />
      </div>
    </div>
  );
}

function TeamPanel({ d }: { d: Dashboard }) {
  const t = d.totals;
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="grid grid-2">
        <Stat v={`${t.presentToday}/${t.people}`} l={`Bugun ishda${t.lateToday ? ` · ${t.lateToday} kechikdi` : ''}`} />
        <Stat v={t.avgMotivation ?? '—'} l="O‘rtacha motivatsiya" />
        <Stat v={t.overdue} l="Muddati o‘tgan" danger={t.overdue > 0} />
        <Stat v={t.doneThisMonth} l="Shu oy bajarildi" />
      </div>
      <div className="card">
        <div className="row between" style={{ marginBottom: 6 }}>
          <div className="section-title">Jamoa holati</div>
          {t.atRisk > 0 && <span className="xs xb" style={{ color: 'var(--danger)' }}>{t.atRisk} xavf ostida</span>}
        </div>
        <div className="list">
          {d.team.slice(0, 8).map((m) => (
            <div key={m.userId} className="list-item" onClick={() => go('team', m.userId)}>
              <Avatar name={m.name} src={m.photoUrl} />
              <div className="grow">
                <div className="b ellipsis" style={{ fontSize: 14 }}>{m.name}</div>
                <div className="xs muted">
                  {m.counts.open} ochiq{m.counts.overdue ? ` · ${m.counts.overdue} kechikkan` : ''}
                </div>
              </div>
              <Ring value={m.motivation.score} size={42} stroke={5} tone={scoreTone(m.motivation.score)}>
                <span className="xb" style={{ fontSize: 12 }}>{m.motivation.score ?? '—'}</span>
              </Ring>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({ v, l, danger }: { v: string | number; l: string; danger?: boolean }) {
  return (
    <div className="card stat">
      <span className="v" style={danger ? { color: 'var(--danger)' } : undefined}>{v}</span>
      <span className="l">{l}</span>
    </div>
  );
}

function AttendanceCard() {
  const { fail, toast } = useApp();
  const qc = useQueryClient();
  const today = useQuery({ queryKey: ['today'], queryFn: () => api<Today>('/attendance/today') });
  const mark = useMutation({
    mutationFn: async (kind: 'check-in' | 'check-out') => {
      const loc = today.data?.needsLocation ? await getLocation() : null;
      if (today.data?.needsLocation && !loc) throw new Error('Joylashuvga ruxsat bering');
      return api(`/attendance/${kind}`, { method: 'POST', body: loc ?? {} });
    },
    onSuccess: (_d, kind) => {
      toast(kind === 'check-in' ? 'Xush kelibsiz! Ish kuni boshlandi' : 'Rahmat! Yaxshi dam oling');
      void qc.invalidateQueries({ queryKey: ['today'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (e) => (e instanceof Error && !('status' in e) ? toast(e.message, 'error') : fail(e)),
  });
  const d = today.data;
  if (!d) return <Skeleton h={68} n={1} />;
  const inside = d.checkIn && !d.checkOut;
  return (
    <div className="card row" style={{ gap: 12, padding: '14px 16px' }}>
      <span className={inside ? 'dot-live' : 'dot-off'} />
      <div className="grow">
        <div className="b" style={{ fontSize: 15 }}>
          {!d.checkIn ? 'Hali kelmadingiz' : inside ? `Ishdasiz · ${time(d.checkIn)} dan` : `Kun yakunlandi · ${time(d.checkIn)}–${time(d.checkOut!)}`}
        </div>
        <div className="small" style={{ color: d.lateMinutes > 0 ? 'var(--warn)' : 'var(--accent-ink)' }}>
          {d.checkIn ? (d.lateMinutes > 0 ? `${d.lateMinutes} daqiqa kechikish` : "O'z vaqtida") : d.needsLocation ? 'Ofis hududida belgilanadi' : 'Bir bosishda belgilang'}
        </div>
      </div>
      {!d.checkIn && (
        <button className="btn primary sm" disabled={mark.isPending} onClick={() => mark.mutate('check-in')}>
          <Icon name="pin" size={16} /> Keldim
        </button>
      )}
      {inside && (
        <button className="btn sm" disabled={mark.isPending} onClick={() => mark.mutate('check-out')}>
          Ketdim
        </button>
      )}
    </div>
  );
}
