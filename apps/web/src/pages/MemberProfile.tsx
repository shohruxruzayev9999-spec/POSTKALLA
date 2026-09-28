import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { dateShort, KPI_LABEL, money, ROLE, STAGE, time, when } from '../lib/format';
import { useDepartments, useMembers } from '../lib/queries';
import type { AttendanceMonth, Scores, TaskListItem } from '../lib/types';
import { AttendanceCalendar, localToday } from '../ui/Attendance';
import { Avatar, Bar, Icon, Ring, scoreTone, Sheet, Skeleton, StatusPill } from '../ui/kit';
import { go, useApp } from '../ui/state';
import { MemberEdit } from './Team';
import { TaskForm } from './Tasks';

/** One person's page — the same for "Mening profilim" and for a colleague. */
export function MemberProfile({ userId }: { userId: string }) {
  const { session, can, theme, setTheme } = useApp();
  const self = userId === session.user.id;
  const members = useMembers();
  const deps = useDepartments();
  const m = members.data?.find((x) => x.userId === userId);
  const scores = useQuery({ queryKey: ['scores', userId], queryFn: () => api<Scores>(`/members/${userId}/scores`) });
  const tasks = useQuery({ queryKey: ['tasks', { assignee: userId }], queryFn: () => api<TaskListItem[]>('/tasks', { query: { assigneeUserId: userId } }) });
  const month = localToday(session.ctx.company.timezone).slice(0, 7);
  const [calMonth, setCalMonth] = useState(month);
  const att = useQuery({ queryKey: ['attendance', 'month', self ? 'me' : userId, month], queryFn: () => api<AttendanceMonth>('/attendance/month', { query: { month, userId: self ? undefined : userId } }) });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: session.ctx.company.timezone });
  const todayRow = att.data?.days.find((d) => d.date === today);
  const [giving, setGiving] = useState(false);
  const [editing, setEditing] = useState(false);

  if (!m) return <Skeleton h={120} n={4} />;
  const dep = deps.data?.find((d) => d.id === m.departmentId);
  const head = dep?.headUserId ? members.data?.find((x) => x.userId === dep.headUserId) : null;
  const k = scores.data?.kpi;
  const mot = scores.data?.motivation;
  const open = (tasks.data ?? []).filter((t) => !['DONE', 'CANCELLED'].includes(t.status));
  const attPct = att.data && att.data.summary.workDays ? Math.round((100 * att.data.summary.onTime) / att.data.summary.workDays) : null;
  const manageable = !self && (can('employee.manage', 'COMPANY') || (can('employee.manage', 'DEPARTMENT') && !!m.departmentId && session.ctx.headOfDepartmentIds.includes(m.departmentId)));
  const canGive = !self && (can('task.manage', 'COMPANY') || can('task.manage', 'DEPARTMENT') || can('task.manage', 'PROJECT'));

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row small muted" style={{ gap: 6 }}>
        <a href="#/team">Jamoa</a>
        {m.department && <>› <span>{m.department}</span></>}
        › <span className="b" style={{ color: 'var(--text)' }}>{self ? 'Mening profilim' : m.name}</span>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr)', gap: 14 }}>
        <div className="grid profile-grid" style={{ gap: 14, alignItems: 'start' }}>
          {/* left column */}
          <div className="stack" style={{ gap: 14 }}>
            <div className="card stack" style={{ alignItems: 'center', textAlign: 'center', gap: 10, padding: 22 }}>
              <div style={{ position: 'relative' }}>
                <Ring value={k?.score ?? null} size={132} stroke={9} tone={scoreTone(k?.score)}>
                  <Avatar name={m.name} src={m.photoUrl} size={100} />
                </Ring>
                <span className="xs xb" style={{ position: 'absolute', right: -4, bottom: 10, background: 'var(--grad)', color: 'var(--on-accent)', borderRadius: 10, padding: '3px 8px', border: '3px solid var(--surface-solid)' }}>
                  {k?.score ?? '—'}
                </span>
              </div>
              <div>
                <div className="xb" style={{ fontSize: 22 }}>{m.name}</div>
                <div className="small muted">{[m.position, m.department].filter(Boolean).join(' · ') || ROLE[m.roles[0] ?? '']}</div>
              </div>
              <span className="pill small" style={{ color: todayRow?.checkIn ? (todayRow.lateMinutes > 0 ? 'var(--warn)' : 'var(--accent-ink)') : 'var(--muted)', border: '1px solid var(--line-strong)', borderRadius: 999, padding: '3px 10px' }}>
                {todayRow?.checkIn ? `Ishda · keldi ${time(todayRow.checkIn)}` : 'Bugun hali kelmagan'}
              </span>
              <div className="row" style={{ gap: 8, width: '100%', marginTop: 4 }}>
                {canGive && (
                  <button className="btn primary grow" onClick={() => setGiving(true)}>Vazifa berish</button>
                )}
                {!self && m.username && (
                  <a className="btn grow" href={`https://t.me/${m.username}`}>Telegramda yozish</a>
                )}
                {manageable && (
                  <button className="btn icon-btn" onClick={() => setEditing(true)} aria-label="Tahrirlash"><Icon name="settings" size={18} /></button>
                )}
                {self && (
                  <button className="btn grow" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
                    <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} /> Mavzu
                  </button>
                )}
                {self && (can('settings.company') || can('settings.department')) && (
                  <button className="btn grow" onClick={() => go('settings')}>Sozlamalar</button>
                )}
              </div>
            </div>
            <div className="card list" style={{ padding: '2px 16px' }}>
              <Info label="Rahbari" value={head?.name ?? '—'} />
              <Info label="Rol" value={m.roles.map((r) => ROLE[r] ?? r).join(', ')} />
              <Info label="Ishga kirgan" value={dateShort(m.joinedAt)} />
              <Info label="Ish jadvali" value={`${session.ctx.company.workStart}–${session.ctx.company.workEnd}`} />
              {m.username && <Info label="Telegram" value={`@${m.username}`} href={`https://t.me/${m.username}`} />}
              {m.phone && <Info label="Telefon" value={m.phone} />}
              <Info label="Maosh" value={m.salary !== undefined ? money(m.salary) : "Faqat HR, Moliya va o'zi"} muted={m.salary === undefined} />
            </div>
          </div>

          {/* right column */}
          <div className="stack" style={{ gap: 14 }}>
            <div className="grid grid-2 desk-4" style={{ gap: 12 }}>
              <RingStat value={k?.score ?? null} title="KPI" sub={k?.toNextBand ? `90 gacha ${k.toNextBand} ball` : `Bonus ${k?.bonus ?? 0}`} />
              <RingStat value={mot?.score ?? null} title="Motivatsiya" sub={mot?.stage ? (STAGE[mot.stage] ?? '') : "ma'lumot yo'q"} />
              <RingStat value={attPct} title="Davomat" sub={att.data ? `${att.data.summary.late} marta kechikdi` : ''} />
              <RingStat value={k?.components.volume ?? null} title="Hajm" sub="reja bajarilishi" />
            </div>
            <div className="grid desk-2" style={{ gap: 14, alignItems: 'start' }}>
              <div className="card stack" style={{ gap: 12 }}>
                <div className="row between">
                  <div className="section-title">KPI tarkibi</div>
                  <span className="xs muted">avtomatik · oy oxirida yopiladi</span>
                </div>
                {k ? (
                  (['deadline', 'volume', 'attendance'] as const).map((key) => {
                    const v = k.components[key] ?? null;
                    return (
                      <div key={key}>
                        <div className="row between small">
                          <span>{KPI_LABEL[key]} <span className="muted">· vazn {({ deadline: 50, volume: 35, attendance: 15 } as const)[key]}%</span></span>
                          <span className="xb">{v == null ? '—' : Math.round(v)}</span>
                        </div>
                        <div style={{ marginTop: 5 }}><Bar value={v} tone={v != null && v < 50 ? 'danger' : v != null && v < 70 ? 'warn' : undefined} /></div>
                      </div>
                    );
                  })
                ) : (
                  <Skeleton h={30} n={3} />
                )}
              </div>
              <AttendanceCalendar userId={self ? undefined : userId} month={calMonth} onMonth={setCalMonth} />
            </div>
            <div className="card stack" style={{ gap: 4 }}>
              <div className="section-title" style={{ marginBottom: 6 }}>Joriy vazifalar · {open.length}</div>
              {open.length === 0 ? (
                <div className="small muted">Ochiq vazifa yo'q.</div>
              ) : (
                <div className="list">
                  {open.map((t) => (
                    <div key={t.id} className="list-item" onClick={() => go('tasks', t.id)}>
                      <span className={`prio prio-${t.priority}`} style={{ height: 30 }} />
                      <div className="grow" style={{ minWidth: 0 }}>
                        <div className="b small ellipsis">{t.isPrivate ? '1:1 · ' : ''}{t.title}</div>
                        <div className="xs muted">{t.project ?? 'Loyihasiz'}</div>
                      </div>
                      <StatusPill status={t.status} />
                      <span className="small b" style={{ width: 96, textAlign: 'right', color: t.overdue ? 'var(--danger)' : 'var(--muted)' }}>{when(t.deadline)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <Sheet open={giving} onClose={() => setGiving(false)} title={`Vazifa: ${m.name}`}>
        {giving && <TaskForm assigneeUserId={userId} onDone={() => setGiving(false)} />}
      </Sheet>
      <Sheet open={editing} onClose={() => setEditing(false)} title="Hodimni tahrirlash">
        {editing && <MemberEdit m={m} deps={deps.data ?? []} onDone={() => setEditing(false)} />}
      </Sheet>
    </div>
  );
}

function Info({ label, value, href, muted }: { label: string; value: string; href?: string; muted?: boolean }) {
  return (
    <div className="row between" style={{ padding: '11px 0', gap: 12 }}>
      <span className="small muted">{label}</span>
      {href ? (
        <a className="small b" href={href}>{value}</a>
      ) : (
        <span className="small b" style={{ textAlign: 'right', color: muted ? 'var(--muted)' : undefined, fontWeight: muted ? 500 : 700 }}>{value}</span>
      )}
    </div>
  );
}

function RingStat({ value, title, sub }: { value: number | null; title: string; sub: string }) {
  return (
    <div className="card row" style={{ gap: 12, padding: 14 }}>
      <Ring value={value} size={60} stroke={7} tone={scoreTone(value)}>
        <span className="xb" style={{ fontSize: 14 }}>{value == null ? '—' : `${Math.round(value)}`}</span>
      </Ring>
      <div style={{ minWidth: 0 }}>
        <div className="b">{title}</div>
        <div className="xs muted">{sub}</div>
      </div>
    </div>
  );
}
