import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { api } from '../lib/api';
import { useMembers, useProjects } from '../lib/queries';
import type { Shoot, ShootConflict } from '../lib/types';
import { Avatar, Empty, Field, Icon, Sheet, Skeleton } from '../ui/kit';
import { useApp } from '../ui/state';

export const SHOOT_TYPE: Record<string, { label: string; emoji: string }> = {
  VIDEO: { label: 'Video', emoji: '🎥' },
  REELS: { label: 'Reels', emoji: '📱' },
  PHOTO: { label: 'Foto', emoji: '📷' },
  EVENT: { label: 'Tadbir', emoji: '🎉' },
  INTERVIEW: { label: 'Intervyu', emoji: '🎙' },
  PODCAST: { label: 'Podkast', emoji: '🎧' },
};
export const SHOOT_STATUS: Record<string, { label: string; color: string }> = {
  PLANNING: { label: 'Rejada', color: 'var(--muted)' },
  SCHEDULED: { label: 'Belgilangan', color: 'var(--info)' },
  CONFIRMED: { label: 'Tasdiqlangan', color: 'var(--accent-ink)' },
  DONE: { label: "O'tkazildi", color: 'var(--muted)' },
  CANCELLED: { label: 'Bekor', color: 'var(--danger)' },
};

const WD = ['Du', 'Se', 'Ch', 'Pa', 'Ju', 'Sh', 'Ya'];
const MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
const FROM_H = 7;
const TO_H = 23;
const HOUR = 52;

// ------------------------------------------------------------------------------------------ dates (local calendar days as YYYY-MM-DD)

const pad = (n: number) => String(n).padStart(2, '0');
const toKey = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const fromKey = (k: string) => new Date(`${k}T00:00:00Z`);
export const addDays = (k: string, n: number) => toKey(new Date(fromKey(k).getTime() + n * 86_400_000));
const weekday = (k: string) => ((fromKey(k).getUTCDay() + 6) % 7) + 1; // 1 = Mon
export const weekStart = (k: string) => addDays(k, 1 - weekday(k));
export const todayKey = (tz: string) => new Date().toLocaleDateString('en-CA', { timeZone: tz });
const dayTitle = (k: string) => {
  const d = fromKey(k);
  return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}`;
};
const mins = (hm: string) => {
  const [h, m] = hm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

function useIsMobile() {
  const q = '(max-width: 899px)';
  const [m, setM] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return m;
}

/** Side-by-side lanes for overlapping shoots in one column. */
function layout(items: Shoot[]) {
  const sorted = [...items].sort((a, b) => a.startTime.localeCompare(b.startTime) || b.endTime.localeCompare(a.endTime));
  const out: Array<{ s: Shoot; lane: number; lanes: number }> = [];
  let cluster: typeof out = [];
  let clusterEnd = -1;
  const flush = () => {
    const lanes = Math.max(1, ...cluster.map((c) => c.lane + 1));
    for (const c of cluster) out.push({ ...c, lanes });
    cluster = [];
  };
  for (const s of sorted) {
    if (mins(s.startTime) >= clusterEnd && cluster.length) flush();
    const used = new Set(cluster.filter((c) => mins(c.s.endTime) > mins(s.startTime)).map((c) => c.lane));
    let lane = 0;
    while (used.has(lane)) lane++;
    cluster.push({ s, lane, lanes: 1 });
    clusterEnd = Math.max(clusterEnd, mins(s.endTime));
  }
  if (cluster.length) flush();
  return out;
}

// ------------------------------------------------------------------------------------------ page

type View = 'week' | 'day';
type Group = 'crew' | 'location';

export function Shoots() {
  const { session, can } = useApp();
  const tz = session.ctx.company.timezone;
  const mobile = useIsMobile();
  const today = todayKey(tz);
  const [view, setView] = useState<View>(() => (localStorage.getItem('rt.shootView') as View) || 'week');
  const [group, setGroup] = useState<Group>('crew');
  const [anchor, setAnchor] = useState(today);
  const [open, setOpen] = useState<Shoot | null>(null);
  const [draft, setDraft] = useState<Partial<Shoot> | null>(null);
  const canCreate = can('shoot.manage');

  const from = view === 'week' ? weekStart(anchor) : anchor;
  const to = view === 'week' ? addDays(from, 6) : anchor;
  const q = useQuery({ queryKey: ['shoots', from, to], queryFn: () => api<Shoot[]>('/shoots', { query: { from, to } }) });
  const setV = (v: View) => {
    setView(v);
    try {
      localStorage.setItem('rt.shootView', v);
    } catch {
      /* ignore */
    }
  };
  const step = (n: number) => setAnchor(addDays(anchor, view === 'week' ? 7 * n : n));
  const title = view === 'week' ? `${dayTitle(from)} – ${dayTitle(to)}` : `${dayTitle(anchor)}, ${WD[weekday(anchor) - 1]}`;
  const newAt = (day: string, startTime = '10:00') => canCreate && setDraft({ day, startTime, endTime: `${pad(Math.min(23, Math.floor(mins(startTime) / 60) + 2))}:${startTime.slice(3)}` });

  const shoots = q.data ?? [];
  const live = shoots.filter((s) => s.status !== 'CANCELLED');
  const stats = { total: live.length, confirmed: live.filter((s) => s.status === 'CONFIRMED').length, hours: live.reduce((a, s) => a + (mins(s.endTime) - mins(s.startTime)) / 60, 0) };

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row wrap between" style={{ gap: 10 }}>
        <h1 className="page-title">Syomka</h1>
        <div className="row" style={{ gap: 8 }}>
          <div className="seg" style={{ width: 170 }}>
            <button className={view === 'week' ? 'on' : ''} onClick={() => setV('week')}>Hafta</button>
            <button className={view === 'day' ? 'on' : ''} onClick={() => setV('day')}>Kun</button>
          </div>
          {canCreate && (
            <button className="btn primary sm" onClick={() => newAt(view === 'day' ? anchor : today >= from && today <= to ? today : from)}>
              <Icon name="plus" size={16} /> Syomka
            </button>
          )}
        </div>
      </div>

      <div className="row wrap between" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 4 }}>
          <button className="btn sm ghost" aria-label="Oldingi" onClick={() => step(-1)}>‹</button>
          <button className="btn sm ghost" onClick={() => setAnchor(today)}>Bugun</button>
          <button className="btn sm ghost" aria-label="Keyingi" onClick={() => step(1)}>›</button>
          <div className="b" style={{ marginLeft: 6 }}>{title}</div>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <span className="tag">{stats.total} ta syomka</span>
          <span className="tag">{stats.confirmed} tasdiqlangan</span>
          <span className="tag">{Math.round(stats.hours)} soat</span>
          {view === 'day' && (
            <div className="seg" style={{ width: 190 }}>
              <button className={group === 'crew' ? 'on' : ''} onClick={() => setGroup('crew')}>Operator</button>
              <button className={group === 'location' ? 'on' : ''} onClick={() => setGroup('location')}>Joy</button>
            </div>
          )}
        </div>
      </div>

      {view === 'week' && (
        <div className="shoot-strip">
          {Array.from({ length: 7 }, (_, i) => addDays(from, i)).map((k) => {
            const n = shoots.filter((s) => s.day === k && s.status !== 'CANCELLED').length;
            return (
              <button key={k} className={`shoot-strip-d ${k === today ? 'today' : ''}`} onClick={() => { setAnchor(k); setV('day'); }}>
                <span className="xs muted">{WD[weekday(k) - 1]}</span>
                <span className="b">{fromKey(k).getUTCDate()}</span>
                <span className="shoot-dots">{Array.from({ length: Math.min(n, 4) }, (_, j) => <i key={j} />)}</span>
              </button>
            );
          })}
        </div>
      )}

      {q.isPending ? (
        <Skeleton n={4} />
      ) : view === 'week' ? (
        mobile ? (
          <Agenda from={from} shoots={shoots} today={today} onOpen={setOpen} onNew={canCreate ? newAt : undefined} />
        ) : (
          <TimeGrid
            columns={Array.from({ length: 7 }, (_, i) => {
              const k = addDays(from, i);
              return { key: k, title: `${WD[i]} ${fromKey(k).getUTCDate()}`, today: k === today, items: shoots.filter((s) => s.day === k), day: k };
            })}
            onOpen={setOpen}
            onNew={canCreate ? newAt : undefined}
          />
        )
      ) : (
        <DayColumns day={anchor} shoots={shoots} group={group} onOpen={setOpen} onNew={canCreate ? newAt : undefined} />
      )}

      <Sheet open={!!open} onClose={() => setOpen(null)} title={null} wide>
        {open && <ShootView s={open} onEdit={() => { setDraft(open); setOpen(null); }} />}
      </Sheet>
      <Sheet open={!!draft} onClose={() => setDraft(null)} title={draft?.id ? 'Syomkani tahrirlash' : 'Yangi syomka'}>
        {draft && <ShootForm key={draft.id ?? `${draft.day}-${draft.startTime}`} draft={draft} onDone={() => setDraft(null)} />}
      </Sheet>
    </div>
  );
}

// ------------------------------------------------------------------------------------------ views

function ShootBlock({ s, style, onOpen, compact }: { s: Shoot; style?: CSSProperties; onOpen: (s: Shoot) => void; compact?: boolean }) {
  const st = SHOOT_STATUS[s.status];
  return (
    <button
      className={`shoot-block st-${s.status}`}
      style={{ ...style, ['--c' as string]: s.color }}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(s);
      }}
      title={`${s.title} · ${s.startTime}–${s.endTime}`}
    >
      <div className="row" style={{ gap: 4, alignItems: 'flex-start' }}>
        <span className="grow b xs ellipsis2">{SHOOT_TYPE[s.type]?.emoji} {s.title}</span>
        {s.status === 'CONFIRMED' && <span style={{ color: 'var(--accent-ink)' }}><Icon name="check" size={13} /></span>}
      </div>
      <div className="xs muted">{s.startTime}–{s.endTime}{!compact && s.location ? ` · ${s.location}` : ''}</div>
      {!compact && s.project && <div className="xs ellipsis" style={{ color: 'var(--c)', fontWeight: 700 }}>{s.project}</div>}
      {!compact && s.crew.length > 0 && (
        <div className="row" style={{ gap: 0, marginTop: 2 }}>
          {s.crew.slice(0, 4).map((c) => (
            <span key={c.id} style={{ marginRight: -5 }}><Avatar name={c.name} src={c.photoUrl} size={18} /></span>
          ))}
          {s.crew.length > 4 && <span className="xs muted" style={{ marginLeft: 8 }}>+{s.crew.length - 4}</span>}
        </div>
      )}
      {st && s.status !== 'CONFIRMED' && s.status !== 'SCHEDULED' && <div className="xs" style={{ color: st.color, fontWeight: 700 }}>{st.label}</div>}
    </button>
  );
}

interface Col {
  key: string;
  title: string;
  sub?: string;
  today?: boolean;
  items: Shoot[];
  day: string;
}

function TimeGrid({ columns, onOpen, onNew, minCol = 0 }: { columns: Col[]; onOpen: (s: Shoot) => void; onNew?: (day: string, start: string) => void; minCol?: number }) {
  const hours = Array.from({ length: TO_H - FROM_H }, (_, i) => FROM_H + i);
  const tpl = `52px repeat(${columns.length}, minmax(${minCol}px, 1fr))`;
  return (
    <div className="tgrid-wrap">
      <div className="tgrid" style={{ gridTemplateColumns: tpl, minWidth: minCol ? 52 + columns.length * minCol : undefined }}>
        <div className="tgrid-h" />
        {columns.map((c) => (
          <div key={c.key} className={`tgrid-h ${c.today ? 'today' : ''}`}>
            <div className="b small ellipsis">{c.title}</div>
            {c.sub && <div className="xs muted ellipsis">{c.sub}</div>}
          </div>
        ))}
        <div className="tgrid-times">
          {hours.map((h) => (
            <div key={h} style={{ height: HOUR }} className="xs faint">{pad(h)}:00</div>
          ))}
        </div>
        {columns.map((c) => (
          <div
            key={c.key}
            className={`tgrid-col ${c.today ? 'today' : ''}`}
            style={{ height: hours.length * HOUR }}
            onClick={(e) => {
              if (!onNew) return;
              const y = e.clientY - (e.currentTarget as HTMLElement).getBoundingClientRect().top;
              const h = Math.min(TO_H - 1, FROM_H + Math.floor(y / HOUR));
              onNew(c.day, `${pad(h)}:00`);
            }}
          >
            {layout(c.items).map(({ s, lane, lanes }) => {
              const top = ((Math.max(mins(s.startTime), FROM_H * 60) - FROM_H * 60) / 60) * HOUR;
              const bottom = ((Math.min(mins(s.endTime), TO_H * 60) - FROM_H * 60) / 60) * HOUR;
              const h = Math.max(26, bottom - top - 3);
              return (
                <ShootBlock
                  key={s.id}
                  s={s}
                  onOpen={onOpen}
                  compact={h < 70}
                  style={{ top: top + 1, height: h, left: `calc(${(lane / lanes) * 100}% + 3px)`, width: `calc(${100 / lanes}% - 6px)` }}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function DayColumns({ day, shoots, group, onOpen, onNew }: { day: string; shoots: Shoot[]; group: Group; onOpen: (s: Shoot) => void; onNew?: (day: string, start: string) => void }) {
  const items = shoots.filter((s) => s.day === day);
  const columns: Col[] = useMemo(() => {
    const map = new Map<string, Col>();
    const add = (key: string, title: string, s: Shoot, sub?: string) => {
      if (!map.has(key)) map.set(key, { key, title, sub, items: [], day });
      map.get(key)!.items.push(s);
    };
    for (const s of items) {
      if (group === 'location') add(`loc:${s.location ?? ''}`, s.location || 'Joy ko‘rsatilmagan', s);
      else if (!s.crew.length) add('none', 'Operator tayinlanmagan', s);
      else for (const c of s.crew) add(c.id, c.name, s);
    }
    const cols = [...map.values()].sort((a, b) => a.title.localeCompare(b.title));
    for (const c of cols) c.sub = `${c.items.length} ta · ${Math.round(c.items.reduce((a, s) => a + (mins(s.endTime) - mins(s.startTime)) / 60, 0) * 10) / 10} soat`;
    return cols;
  }, [items, group, day]);
  if (!columns.length) {
    return (
      <Empty icon="🎬" title="Bu kunga syomka yo'q">
        {onNew && <button className="btn primary sm" onClick={() => onNew(day, '10:00')}><Icon name="plus" size={15} /> Syomka qo'shish</button>}
      </Empty>
    );
  }
  return <TimeGrid columns={columns} onOpen={onOpen} onNew={onNew} minCol={170} />;
}

function Agenda({ from, shoots, today, onOpen, onNew }: { from: string; shoots: Shoot[]; today: string; onOpen: (s: Shoot) => void; onNew?: (day: string, start: string) => void }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  return (
    <div className="stack" style={{ gap: 14 }}>
      {days.map((k) => {
        const items = shoots.filter((s) => s.day === k).sort((a, b) => a.startTime.localeCompare(b.startTime));
        return (
          <div key={k} className="stack" style={{ gap: 8 }}>
            <div className="row between">
              <div className="b" style={{ color: k === today ? 'var(--accent-ink)' : undefined }}>
                {WD[weekday(k) - 1]}, {dayTitle(k)} {k === today && <span className="tag" style={{ marginLeft: 6 }}>Bugun</span>}
              </div>
              {onNew && <button className="btn sm ghost icon-btn" style={{ width: 32, height: 32 }} aria-label="Qo'shish" onClick={() => onNew(k, '10:00')}><Icon name="plus" size={16} /></button>}
            </div>
            {items.length === 0 ? (
              <div className="xs faint" style={{ padding: '0 2px 4px' }}>Syomka yo'q</div>
            ) : (
              items.map((s) => <ShootBlock key={s.id} s={s} onOpen={onOpen} style={{ position: 'relative' }} />)
            )}
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------------------------------ detail & form

function ShootView({ s, onEdit }: { s: Shoot; onEdit: () => void }) {
  const { toast, fail } = useApp();
  const qc = useQueryClient();
  const setStatus = useMutation({
    mutationFn: (status: string) => api(`/shoots/${s.id}`, { method: 'PATCH', body: { status } }),
    onSuccess: () => {
      toast('Saqlandi');
      void qc.invalidateQueries({ queryKey: ['shoots'] });
    },
    onError: fail,
  });
  const st = SHOOT_STATUS[s.status];
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="stack" style={{ gap: 6 }}>
        <div className="row" style={{ gap: 8 }}>
          <span className="tag">{SHOOT_TYPE[s.type]?.emoji} {SHOOT_TYPE[s.type]?.label}</span>
          <span className="tag" style={{ color: st?.color }}>{st?.label}</span>
        </div>
        <div className="xb" style={{ fontSize: 22, lineHeight: 1.2 }}>{s.title}</div>
        {s.project && <div className="b small" style={{ color: s.color }}>📁 {s.project}</div>}
      </div>
      <div className="card stack" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 10 }}><Icon name="clock" size={18} /><span className="b">{dayTitle(s.day)}, {WD[weekday(s.day) - 1]} · {s.startTime}–{s.endTime}</span></div>
        {s.location && <div className="row" style={{ gap: 10 }}><Icon name="pin" size={18} /><span>{s.location}</span></div>}
        {s.notes && <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{s.notes}</div>}
      </div>
      <div className="stack" style={{ gap: 8 }}>
        <div className="section-title">Jamoa</div>
        {s.crew.length === 0 ? (
          <div className="muted small">Hali hech kim tayinlanmagan</div>
        ) : (
          <div className="row wrap" style={{ gap: 8 }}>
            {s.crew.map((c) => (
              <span key={c.id} className="chip" style={{ height: 36, gap: 6 }}><Avatar name={c.name} src={c.photoUrl} size={22} />{c.name}</span>
            ))}
          </div>
        )}
      </div>
      {s.canEdit && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row wrap" style={{ gap: 8 }}>
            {s.status !== 'CONFIRMED' && s.status !== 'DONE' && <button className="btn sm" disabled={setStatus.isPending} onClick={() => setStatus.mutate('CONFIRMED')}>✅ Tasdiqlash</button>}
            {s.status !== 'DONE' && <button className="btn sm" disabled={setStatus.isPending} onClick={() => setStatus.mutate('DONE')}>🎬 O'tkazildi</button>}
            {s.status !== 'CANCELLED' && <button className="btn sm danger" disabled={setStatus.isPending} onClick={() => setStatus.mutate('CANCELLED')}>Bekor qilish</button>}
          </div>
          <button className="btn primary block" onClick={onEdit}>Tahrirlash</button>
        </div>
      )}
    </div>
  );
}

function ShootForm({ draft, onDone }: { draft: Partial<Shoot>; onDone: () => void }) {
  const { toast, fail, can, session } = useApp();
  const qc = useQueryClient();
  const projects = useProjects();
  const members = useMembers();
  const companyWide = can('shoot.manage', 'COMPANY');
  const [f, setF] = useState({
    title: draft.title ?? '',
    projectId: draft.projectId ?? '',
    type: draft.type ?? 'VIDEO',
    status: draft.status ?? 'SCHEDULED',
    day: draft.day ?? todayKey(session.ctx.company.timezone),
    startTime: draft.startTime ?? '10:00',
    endTime: draft.endTime ?? '12:00',
    location: draft.location ?? '',
    notes: draft.notes ?? '',
    crew: draft.crew?.map((c) => c.id) ?? [],
  });
  const [conflicts, setConflicts] = useState<ShootConflict[]>([]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const projectOptions = (projects.data ?? []).filter((p) => p.status !== 'DONE' && (companyWide || session.ctx.projectIds.includes(p.id)));
  const active = (members.data ?? []).filter((m) => m.status === 'ACTIVE');
  const invalid = !f.title.trim() || f.startTime >= f.endTime || (!companyWide && !f.projectId);

  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, projectId: f.projectId || null, location: f.location || null, notes: f.notes || null };
      return draft.id ? api<{ conflicts: ShootConflict[] }>(`/shoots/${draft.id}`, { method: 'PATCH', body }) : api<{ conflicts: ShootConflict[] }>('/shoots', { method: 'POST', body });
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['shoots'] });
      if (r.conflicts.length) {
        setConflicts(r.conflicts);
        toast('Saqlandi — lekin vaqt to‘qnashuvi bor', 'error');
      } else {
        toast('Saqlandi');
        onDone();
      }
    },
    onError: fail,
  });
  const del = useMutation({
    mutationFn: () => api(`/shoots/${draft.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['shoots'] });
      toast("O'chirildi");
      onDone();
    },
    onError: fail,
  });
  const nameOf = (id: string) => active.find((m) => m.userId === id)?.name ?? '—';

  return (
    <div className="stack">
      <Field label="Nomi">
        <input className="input" autoFocus value={f.title} onChange={(e) => set('title', e.target.value)} maxLength={120} placeholder="Masalan: Menyu fotosessiyasi" />
      </Field>
      <Field label="Loyiha" hint={companyWide ? undefined : 'Faqat o‘zingiz boshqaradigan loyihalar'}>
        <select className="input" value={f.projectId} onChange={(e) => set('projectId', e.target.value)}>
          {companyWide && <option value="">— Loyihasiz —</option>}
          {!companyWide && <option value="">Tanlang…</option>}
          {projectOptions.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </Field>
      <div className="field">
        <span>Turi</span>
        <div className="row wrap" style={{ gap: 6 }}>
          {Object.entries(SHOOT_TYPE).map(([k, v]) => (
            <button key={k} type="button" className={`chip ${f.type === k ? 'on' : ''}`} onClick={() => set('type', k)}>{v.emoji} {v.label}</button>
          ))}
        </div>
      </div>
      <Field label="Sana"><input className="input" type="date" value={f.day} onChange={(e) => set('day', e.target.value)} /></Field>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 8 }}>
        <Field label="Boshlanish"><input className="input" type="time" value={f.startTime} onChange={(e) => set('startTime', e.target.value)} /></Field>
        <Field label="Tugash"><input className="input" type="time" value={f.endTime} onChange={(e) => set('endTime', e.target.value)} /></Field>
      </div>
      {f.startTime >= f.endTime && <div className="xs" style={{ color: 'var(--danger)' }}>Tugash vaqti boshlanishdan keyin bo‘lsin</div>}
      <Field label="Joy">
        <input className="input" value={f.location} onChange={(e) => set('location', e.target.value)} maxLength={200} placeholder="Manzil yoki studiya" />
      </Field>
      <div className="field">
        <span>Jamoa (operator, fotograf, mobilograf…)</span>
        <div className="row wrap" style={{ gap: 6 }}>
          {active.map((m) => {
            const on = f.crew.includes(m.userId);
            const busy = conflicts.some((c) => c.userId === m.userId);
            return (
              <button
                key={m.userId}
                type="button"
                className={`chip ${on ? 'on' : ''}`}
                style={busy ? { outline: '2px solid var(--danger)' } : undefined}
                onClick={() => set('crew', on ? f.crew.filter((x) => x !== m.userId) : [...f.crew, m.userId])}
              >
                {m.name}
              </button>
            );
          })}
        </div>
      </div>
      <Field label="Holat">
        <select className="input" value={f.status} onChange={(e) => set('status', e.target.value)}>
          {Object.entries(SHOOT_STATUS).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
      </Field>
      <Field label="Izoh" hint="Ssenariy, rekvizit, kiyim, texnika…">
        <textarea className="input" value={f.notes} onChange={(e) => set('notes', e.target.value)} maxLength={4000} />
      </Field>
      {conflicts.length > 0 && (
        <div className="card stack" style={{ gap: 6, borderColor: 'var(--danger)' }}>
          <div className="b small" style={{ color: 'var(--danger)' }}>⚠️ Vaqt to‘qnashuvi</div>
          {conflicts.map((c, i) => (
            <div key={i} className="xs">{nameOf(c.userId)} — «{c.title}» {c.startTime}–{c.endTime}</div>
          ))}
          <button className="btn sm" onClick={onDone}>Baribir qoldirish</button>
        </div>
      )}
      <div className="xs muted">Jamoaga Telegram’da xabar boradi; eslatma — bir kun oldin va 2 soat oldin.</div>
      <button className="btn primary block" disabled={invalid || save.isPending} onClick={() => save.mutate()}>Saqlash</button>
      {draft.id && (
        <button className="btn danger block" disabled={del.isPending} onClick={() => del.mutate()}>
          <Icon name="trash" size={16} /> O'chirish
        </button>
      )}
    </div>
  );
}
