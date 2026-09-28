import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { time } from '../lib/format';
import type { AttendanceDay, AttendanceMonth, Today } from '../lib/types';
import { getLocation } from '../lib/tg';
import { Icon, Ring, Skeleton } from './kit';
import { useApp } from './state';

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const pad = (n: number) => String(n).padStart(2, '0');
function hms(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** "Keldim / Ketdim" with a live countdown to the end of the working day. */
export function AttendanceCard({ big }: { big?: boolean }) {
  const { fail, toast } = useApp();
  const qc = useQueryClient();
  const today = useQuery({ queryKey: ['today'], queryFn: () => api<Today>('/attendance/today') });
  const now = useNow();
  const mark = useMutation({
    mutationFn: async (kind: 'check-in' | 'check-out') => {
      const loc = today.data?.needsLocation ? await getLocation() : null;
      if (today.data?.needsLocation && !loc) throw new Error('Joylashuvga ruxsat bering');
      return api(`/attendance/${kind}`, { method: 'POST', body: loc ?? {} });
    },
    onSuccess: (_d, kind) => {
      toast(kind === 'check-in' ? 'Xush kelibsiz! Ish kuni boshlandi' : 'Rahmat! Yaxshi dam oling');
      void qc.invalidateQueries({ queryKey: ['today'] });
      void qc.invalidateQueries({ queryKey: ['attendance'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (e) => (e instanceof ApiError ? fail(e) : toast((e as Error).message, 'error')),
  });
  const d = today.data;
  if (!d) return <Skeleton h={big ? 180 : 68} n={1} />;

  const inside = !!d.checkIn && !d.checkOut;
  const start = new Date(d.startsAt).getTime();
  const end = new Date(d.endsAt).getTime();
  const left = end - now;
  const total = end - Math.min(start, d.checkIn ? new Date(d.checkIn).getTime() : start);
  const progress = inside ? Math.min(100, Math.max(0, (100 * (now - (end - total))) / total)) : d.checkOut ? 100 : 0;
  const overtime = inside && left < 0;

  const status = !d.checkIn
    ? d.workingDay
      ? 'Hali kelmadingiz'
      : 'Bugun dam olish kuni'
    : inside
      ? overtime
        ? 'Ish vaqti tugadi'
        : 'Ish kuni davom etmoqda'
      : `Kun yakunlandi · ${time(d.checkIn!)}–${time(d.checkOut!)}`;
  const sub = d.checkIn
    ? d.lateMinutes > 0
      ? `${time(d.checkIn)} da keldingiz · ${d.lateMinutes} daqiqa kechikish`
      : `${time(d.checkIn)} da keldingiz · o'z vaqtida`
    : d.needsLocation
      ? 'Ofis hududida belgilanadi'
      : `Ish ${time(d.startsAt)} da boshlanadi`;

  const button = !d.checkIn ? (
    <button className="btn primary" disabled={mark.isPending} onClick={() => mark.mutate('check-in')}>
      <Icon name="pin" size={17} /> Keldim
    </button>
  ) : inside ? (
    <button className="btn" disabled={mark.isPending} onClick={() => mark.mutate('check-out')}>
      Ketdim
    </button>
  ) : null;

  if (!big) {
    return (
      <div className="card row" style={{ gap: 12, padding: '14px 16px' }}>
        <span className={inside ? 'dot-live' : 'dot-off'} />
        <div className="grow">
          <div className="b" style={{ fontSize: 15 }}>
            {inside && !overtime ? <>Tugashiga <span className="grad-text">{hms(left)}</span></> : status}
          </div>
          <div className="small" style={{ color: d.lateMinutes > 0 ? 'var(--warn)' : 'var(--muted)' }}>{sub}</div>
        </div>
        {button && <div style={{ transform: 'scale(.92)', transformOrigin: 'right center' }}>{button}</div>}
      </div>
    );
  }

  return (
    <div className="card row wrap" style={{ gap: 20, padding: 20 }}>
      <Ring value={progress} size={128} stroke={12} tone={overtime ? 'amber' : 'green'}>
        <div style={{ textAlign: 'center' }}>
          <div className="xb" style={{ fontSize: 20, fontVariantNumeric: 'tabular-nums' }}>{inside ? hms(Math.abs(left)) : d.checkOut ? '✓' : '—'}</div>
          <div className="xs muted">{inside ? (overtime ? "qo'shimcha" : 'qoldi') : d.checkOut ? 'yakunlandi' : 'boshlanmagan'}</div>
        </div>
      </Ring>
      <div className="stack grow" style={{ gap: 6, minWidth: 180 }}>
        <div className="row" style={{ gap: 8 }}>
          <span className={inside ? 'dot-live' : 'dot-off'} />
          <span className="xb" style={{ fontSize: 18 }}>{status}</span>
        </div>
        <div className="small" style={{ color: d.lateMinutes > 0 ? 'var(--warn)' : 'var(--muted)' }}>{sub}</div>
        <div className="small muted">
          Ish vaqti: {time(d.startsAt)}–{time(d.endsAt)}
        </div>
        {button && <div style={{ marginTop: 6 }}>{button}</div>}
      </div>
    </div>
  );
}

const WD = ['Du', 'Se', 'Ch', 'Pa', 'Ju', 'Sh', 'Ya'];
const MONTHS = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'];

const CELL: Record<AttendanceDay['status'], { bg: string; fg: string; border?: string }> = {
  ON_TIME: { bg: 'color-mix(in srgb, var(--accent) 18%, transparent)', fg: 'var(--accent-ink)' },
  LATE: { bg: 'color-mix(in srgb, #F59E0B 20%, transparent)', fg: 'var(--warn)', border: 'color-mix(in srgb, #F59E0B 45%, transparent)' },
  ABSENT: { bg: 'var(--danger-bg)', fg: 'var(--danger)' },
  OFF: { bg: 'transparent', fg: 'var(--faint)' },
  FUTURE: { bg: 'var(--surface-2)', fg: 'var(--muted)' },
  BEFORE_JOIN: { bg: 'transparent', fg: 'var(--faint)' },
};

export function localToday(tz: string) {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

export function shiftMonth(ym: string, delta: number) {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

/** Month calendar: green on time, amber late, red absent. */
export function AttendanceCalendar({ userId, month, onMonth }: { userId?: string; month: string; onMonth?: (m: string) => void }) {
  const q = useQuery({
    queryKey: ['attendance', 'month', userId ?? 'me', month],
    queryFn: () => api<AttendanceMonth>('/attendance/month', { query: { month, userId } }),
  });
  const [selected, setSelected] = useState<AttendanceDay | null>(null);
  const { session } = useApp();
  const today = localToday(session.ctx.company.timezone);
  const [y, m] = month.split('-').map(Number) as [number, number];

  return (
    <div className="card stack" style={{ gap: 12 }}>
      <div className="row between">
        <div className="section-title">Davomat · {MONTHS[m - 1]} {y}</div>
        {onMonth ? (
          <div className="row" style={{ gap: 4 }}>
            <button className="btn sm ghost" aria-label="Oldingi oy" onClick={() => onMonth(shiftMonth(month, -1))}>‹</button>
            <button className="btn sm ghost" aria-label="Keyingi oy" onClick={() => onMonth(shiftMonth(month, 1))}>›</button>
          </div>
        ) : (
          q.data && <span className="xs muted">{q.data.summary.onTime + q.data.summary.late}/{q.data.summary.workDays} kun</span>
        )}
      </div>
      {!q.data ? (
        <Skeleton h={220} n={1} />
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 6 }}>
            {WD.map((w) => (
              <div key={w} className="xs muted b" style={{ textAlign: 'center' }}>{w}</div>
            ))}
            {Array.from({ length: (q.data.days[0]?.weekday ?? 1) - 1 }, (_, i) => (
              <div key={`e${i}`} />
            ))}
            {q.data.days.map((d) => {
              const c = CELL[d.status];
              const isToday = d.date === today;
              return (
                <button
                  key={d.date}
                  onClick={() => setSelected(d)}
                  style={{
                    aspectRatio: '1 / 1',
                    maxHeight: 46,
                    borderRadius: 10,
                    border: `1.5px solid ${isToday ? 'var(--accent)' : c.border ?? 'transparent'}`,
                    background: c.bg,
                    color: c.fg,
                    fontWeight: 700,
                    fontSize: 13,
                    cursor: 'pointer',
                    padding: 0,
                  }}
                  aria-label={d.date}
                >
                  {Number(d.date.slice(8))}
                </button>
              );
            })}
          </div>
          <div className="row wrap xs muted" style={{ gap: 12 }}>
            <Legend color="var(--accent)" label={`O'z vaqtida ${q.data.summary.onTime}`} />
            <Legend color="#F59E0B" label={`Kechikdi ${q.data.summary.late}`} />
            <Legend color="var(--danger)" label={`Kelmadi ${q.data.summary.absent}`} />
          </div>
          {selected && (
            <div className="card tight small row between">
              <span className="b">{selected.date.split('-').reverse().join('.')}</span>
              <span className="muted">
                {selected.checkIn ? `${time(selected.checkIn)}${selected.checkOut ? `–${time(selected.checkOut)}` : ''}` : selected.status === 'OFF' ? 'Dam olish' : selected.status === 'ABSENT' ? 'Kelmagan' : '—'}
                {selected.lateMinutes > 0 ? ` · ${selected.lateMinutes} daq kechikdi` : ''}
                {selected.note ? ` · ${selected.note}` : ''}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="row" style={{ gap: 5 }}>
      <span style={{ width: 8, height: 8, borderRadius: 4, background: color }} />
      {label}
    </span>
  );
}
