import { useQuery } from '@tanstack/react-query';
import { AttendanceCard } from '../ui/Attendance';
import { api } from '../lib/api';
import { leftText, STAGE, todayLong } from '../lib/format';
import type { Dashboard, TaskListItem } from '../lib/types';
import { Avatar, Bar, Empty, Icon, Ring, scoreTone, Skeleton } from '../ui/kit';
import { go, useApp } from '../ui/state';
import { TaskRow } from '../ui/TaskRow';
import { DigestPanel, LEAD_ROLES } from './Digest';
import { planStatus } from '@retarget/shared';

export function Home() {
  const { session, theme, setTheme, switchCompany } = useApp();
  const dash = useQuery({ queryKey: ['dashboard'], queryFn: () => api<Dashboard>('/dashboard') });
  const mine = useQuery({ queryKey: ['tasks', { mine: true }], queryFn: () => api<TaskListItem[]>('/tasks', { query: { mine: true } }) });
  const u = session.user;
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ');

  const open = (mine.data ?? []).filter((t) => !['DONE', 'CANCELLED'].includes(t.status) && t.assigneeUserId === u.id);
  const toReview = (mine.data ?? []).filter((t) => t.status === 'REVIEW' && t.reviewerUserId === u.id);
  const overdue = open.filter((t) => t.overdue);
  const next = open.filter((t) => !t.overdue).sort((a, b) => +new Date(a.deadline) - +new Date(b.deadline))[0];
  const others = session.companies.filter((c) => c.id !== session.ctx.company.id && c.status === 'ACTIVE');
  const docs = useQuery({ queryKey: ['onboarding'], queryFn: () => api<Array<{ id: string; forMe: boolean; acked: boolean }>>('/onboarding') });
  const toRead = (docs.data ?? []).filter((d) => d.forMe && !d.acked);
  const company = session.ctx.company;
  const plan = planStatus(company.plan, company.planUntil, new Date().toLocaleDateString('en-CA', { timeZone: company.timezone }));
  const planAlert = session.ctx.roles.includes('OWNER') && (plan.status === 'EXPIRED' || ((plan.status === 'TRIAL' || plan.status === 'ACTIVE') && (plan.daysLeft ?? 99) <= 5));

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

      {planAlert && (
        <button className={`banner ${plan.status === 'EXPIRED' ? 'danger' : 'warn'}`} style={{ font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer' }} onClick={() => go('billing')}>
          <Icon name="crown" size={20} />
          <div className="grow">
            {plan.status === 'EXPIRED' ? <b>Obuna muddati tugagan.</b> : <b>{plan.status === 'TRIAL' ? 'Sinov davri' : 'Obuna'} {plan.daysLeft} kundan keyin tugaydi.</b>} Tarifni tanlang — ish to‘xtamaydi.
          </div>
          <Icon name="chevron" size={18} />
        </button>
      )}

      {toRead.length > 0 && (
        <button className="card row click" style={{ gap: 12, textAlign: 'left', font: 'inherit', color: 'inherit', borderColor: 'color-mix(in srgb, var(--warn) 40%, transparent)' }} onClick={() => go('onboarding', toRead.length === 1 ? toRead[0]!.id : undefined)}>
          <span style={{ fontSize: 24 }}>📘</span>
          <div className="grow">
            <div className="b">Onboarding: {toRead.length} ta hujjat o‘qilmagan</div>
            <div className="xs muted">O‘qib chiqib, «Tanishdim» ni bosing</div>
          </div>
          <Icon name="chevron" size={18} />
        </button>
      )}

      <div className="grid desk-2" style={{ alignItems: 'start' }}>
        <div className="stack" style={{ gap: 14 }}>
          {(session.ctx.roles.some((r) => LEAD_ROLES.includes(r)) || session.ctx.headOfDepartmentIds.length > 0) && <DigestPanel />}
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

        {dash.data && dash.data.team.length > 1 && <TeamPanel d={dash.data} />}
      </div>

      {dash.data && <MotivationPanel d={dash.data} />}
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

const STAGES: Array<[string, number, number]> = [
  ['Past', 0, 30],
  ['Xavf', 30, 50],
  ['Nazorat', 50, 70],
  ['Yaxshi', 70, 85],
  ["A'lo", 85, 101],
];
const STAGE_NOTE: Record<string, string> = {
  Past: 'Jiddiy muammo — zudlik bilan aralashish kerak',
  Xavf: 'Kechikishlar ko‘p — rahbar nazorati kerak',
  Nazorat: 'Jarayon nazoratda',
  Yaxshi: 'Jamoa deadline’larni yaxshi ushlayapti',
  "A'lo": 'A’lo intizom',
};

/** Company-wide deadline discipline — the big panel at the bottom of the dashboard (variant A). */
function MotivationPanel({ d }: { d: Dashboard }) {
  const v = d.totals.avgMotivation;
  const stage = v == null ? null : STAGES.find(([, a, b]) => v >= a && v < b)![0];
  const on = d.team.reduce((s, t) => s + t.motivation.onTime, 0);
  const all = d.team.reduce((s, t) => s + t.motivation.onTime + t.motivation.doneLate + t.motivation.openOverdue, 0);
  const lateN = d.team.reduce((s, t) => s + t.motivation.doneLate + t.motivation.openOverdue, 0);
  const lateH = lateN ? d.team.reduce((s, t) => s + t.motivation.averageLateHours * (t.motivation.doneLate + t.motivation.openOverdue), 0) / lateN : 0;
  const color = v == null ? 'var(--muted)' : v >= 70 ? 'var(--accent-ink)' : v >= 50 ? 'var(--warn)' : 'var(--danger)';
  return (
    <div className="card stack" style={{ gap: 18, padding: '20px 22px' }}>
      <div className="row wrap" style={{ alignItems: 'flex-start', gap: 12 }}>
        <div className="grow" style={{ minWidth: 220 }}>
          <div className="xb" style={{ fontSize: 20 }}>Motivatsion ko'rsatkich</div>
          <div className="small muted" style={{ marginTop: 3 }}>Deadline bajarilishi, kechikkan vazifalar va kechikish soatlariga qarab · oxirgi 30 kun</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="xb" style={{ fontSize: 48, lineHeight: 1, color }}>{v == null ? '—' : `${v}%`}</div>
          {stage && <div className="small b" style={{ color, marginTop: 4 }}>{stage} · {STAGE_NOTE[stage]}</div>}
        </div>
      </div>
      <div style={{ position: 'relative', height: 30, marginTop: 8 }}>
        <div style={{ position: 'absolute', left: 0, right: 0, top: 4, height: 20, borderRadius: 10, background: 'linear-gradient(90deg, #F43F5E 0%, #FB923C 30%, #F59E0B 50%, #A3E635 70%, #34D399 85%, #14B8A6 100%)' }} />
        {v != null && (
          <div style={{ position: 'absolute', left: `calc(${Math.min(99, Math.max(1, v))}% - 4px)`, top: -3, width: 8, height: 34, borderRadius: 4, background: 'var(--text)', boxShadow: '0 0 0 3px var(--surface-solid)' }} />
        )}
      </div>
      <div style={{ position: 'relative', height: 30 }}>
        {STAGES.map(([n, a, b]) => (
          <div key={n} className="xs" style={{ position: 'absolute', left: `${a}%`, width: `${Math.min(100, b) - a}%`, fontWeight: n === stage ? 800 : 600, color: n === stage ? 'var(--text)' : 'var(--faint)' }}>
            {n}
            <div style={{ fontWeight: 500 }}>{a}–{Math.min(100, b)}</div>
          </div>
        ))}
      </div>
      <div className="grid grid-2 desk-4" style={{ gap: 10 }}>
        <Driver label="Muddatida bajarilgan" value={all ? `${Math.round((100 * on) / all)}%` : '—'} tone="ok" />
        <Driver label="Kechikkan vazifalar" value={`${d.totals.overdue} ta`} tone={d.totals.overdue ? 'bad' : 'ok'} />
        <Driver label="O'rtacha kechikish" value={lateN ? `${lateH.toFixed(1)} ish soati` : '—'} tone={lateH > 4 ? 'warn' : 'ok'} />
        <Driver label="Xavf ostidagi hodimlar" value={`${d.totals.atRisk} kishi`} tone={d.totals.atRisk ? 'bad' : 'ok'} />
      </div>
    </div>
  );
}

function Driver({ label, value, tone }: { label: string; value: string; tone: 'ok' | 'warn' | 'bad' }) {
  const c = tone === 'ok' ? 'var(--accent-ink)' : tone === 'warn' ? 'var(--warn)' : 'var(--danger)';
  return (
    <div style={{ borderRadius: 14, padding: '10px 14px', background: 'var(--surface-2)', border: '1px solid var(--line)' }}>
      <div className="xs muted">{label}</div>
      <div className="xb" style={{ fontSize: 18, color: c }}>{value}</div>
    </div>
  );
}
