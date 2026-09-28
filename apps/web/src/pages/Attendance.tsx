import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { time } from '../lib/format';
import { useMembers } from '../lib/queries';
import { AttendanceCalendar, AttendanceCard, localToday } from '../ui/Attendance';
import { Avatar, Skeleton } from '../ui/kit';
import { go, useApp } from '../ui/state';

interface Row {
  userId: string;
  name: string;
  checkIn: string | null;
  checkOut: string | null;
  lateMinutes: number;
}

export function Attendance() {
  const { session } = useApp();
  const [month, setMonth] = useState(() => localToday(session.ctx.company.timezone).slice(0, 7));
  const today = new Date().toLocaleDateString('en-CA', { timeZone: session.ctx.company.timezone });
  const rows = useQuery({ queryKey: ['attendance', 'day', today], queryFn: () => api<Row[]>('/attendance', { query: { from: today, to: today } }) });
  const members = useMembers();
  const active = (members.data ?? []).filter((m) => m.status === 'ACTIVE');
  const present = rows.data ?? [];
  const absent = active.filter((m) => !present.some((r) => r.userId === m.userId));

  return (
    <div className="stack" style={{ gap: 14 }}>
      <h1 className="page-title">Davomat</h1>
      <div className="grid desk-2" style={{ alignItems: 'start' }}>
        <div className="stack" style={{ gap: 14 }}>
          <AttendanceCard big />
          <AttendanceCalendar month={month} onMonth={setMonth} />
        </div>
        <div className="card stack" style={{ gap: 6 }}>
          <div className="row between">
            <div className="section-title">Bugun jamoa</div>
            <span className="small muted">{present.length}/{active.length} keldi</span>
          </div>
          {!rows.data || !members.data ? (
            <Skeleton h={48} n={5} />
          ) : (
            <div className="list">
              {[...present].sort((a, b) => +new Date(a.checkIn ?? 0) - +new Date(b.checkIn ?? 0)).map((r) => {
                const m = active.find((x) => x.userId === r.userId);
                return (
                  <div key={r.userId} className="list-item" onClick={() => go('team', r.userId)}>
                    <Avatar name={r.name} src={m?.photoUrl} />
                    <div className="grow">
                      <div className="b small">{r.name}</div>
                      <div className="xs muted">{m?.position ?? m?.department ?? ''}</div>
                    </div>
                    <div className="small b" style={{ color: r.lateMinutes > 0 ? 'var(--warn)' : 'var(--accent-ink)', textAlign: 'right' }}>
                      {r.checkIn ? time(r.checkIn) : '—'}
                      {r.checkOut ? <span className="muted"> – {time(r.checkOut)}</span> : null}
                      {r.lateMinutes > 0 && <div className="xs">{r.lateMinutes} daq kechikdi</div>}
                    </div>
                  </div>
                );
              })}
              {absent.map((m) => (
                <div key={m.userId} className="list-item" onClick={() => go('team', m.userId)} style={{ opacity: 0.6 }}>
                  <Avatar name={m.name} src={m.photoUrl} />
                  <div className="grow">
                    <div className="b small">{m.name}</div>
                    <div className="xs muted">{m.position ?? m.department ?? ''}</div>
                  </div>
                  <span className="xs muted">hali kelmadi</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
