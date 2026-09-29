import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Empty, Icon, Skeleton } from '../ui/kit';
import { go, useApp } from '../ui/state';

type Severity = 'HIGH' | 'MEDIUM' | 'LOW';
interface Item {
  kind: string;
  severity: Severity;
  text: string;
  taskId?: string;
  projectId?: string;
  userId?: string;
  finance?: boolean;
}
interface TaskRef {
  taskId: string;
  number: number;
  title: string;
  assignee: string;
  project: string | null;
}
export interface DigestView {
  day: string;
  company: string;
  yesterday: { day: string | null; done: number; onTime: number; created: number; present: number; late: number; absent: number; tracked: boolean };
  totals: { open: number; overdue: number; review: number; blocked: number; dueToday: number };
  overdue: Array<TaskRef & { daysLate: number; priority: string }>;
  dueToday: Array<TaskRef & { deadline: string; status: string }>;
  review: Array<TaskRef & { reviewer: string | null; hours: number }>;
  blocked: Array<TaskRef & { reason: string | null }>;
  load: Array<{ userId: string; name: string; open: number; overdue: number; points: number; share: number }>;
  clients: Array<{ projectId: string; project: string; lastClientAt: string | null; waitingHours: number | null; silentDays: number | null; lastText: string | null }>;
  shoots: Array<{ day: string; start: string; title: string; project: string | null; location: string | null }>;
  finance: { overdueCount: number; overdueAmount: number; parties: Array<{ party: string; debt: number }> } | null;
  items: Item[];
  ai: string[] | null;
  stored: boolean;
  generatedAt: string;
  aiAvailable: boolean;
}

const MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
const SEV: Record<Severity, { label: string; color: string }> = {
  HIGH: { label: 'Muhim', color: 'var(--danger)' },
  MEDIUM: { label: 'E’tibor bering', color: 'var(--warn)' },
  LOW: { label: 'Ma’lumot', color: 'var(--accent)' },
};
const dayLabel = (iso: string) => {
  const [, m, d] = iso.split('-').map(Number) as [number, number, number];
  return `${d}-${MONTHS[m - 1]}`;
};

export const LEAD_ROLES = ['OWNER', 'ADMIN', 'PM', 'MARKETER'];
export const useDigest = (enabled = true) => useQuery({ queryKey: ['digest'], queryFn: () => api<DigestView>('/digest'), enabled, staleTime: 5 * 60_000 });

export function openItem(i: Item) {
  if (i.taskId) go('tasks', i.taskId);
  else if (i.projectId) go('reports', i.projectId);
  else if (i.kind === 'DEBT') go('finance');
  else if (i.kind === 'SHOOT') go('shoots');
  else if (i.kind === 'LATE' || i.kind === 'ABSENT') go('attendance');
  else if (i.userId) go('team', i.userId);
}

export function ItemRow({ i }: { i: Item }) {
  const clickable = !!(i.taskId || i.projectId || i.userId || ['DEBT', 'SHOOT', 'LATE', 'ABSENT'].includes(i.kind));
  return (
    <button className={`dg-item ${clickable ? 'click' : ''}`} style={{ borderLeftColor: SEV[i.severity].color }} onClick={() => clickable && openItem(i)} disabled={!clickable}>
      <span className="small" style={{ lineHeight: 1.45 }}>{i.text}</span>
      {clickable && <Icon name="chevron" size={16} />}
    </button>
  );
}

/** Kunlik tahlil: the morning digest for leads — numbers, recommendations, optional AI advice. Read-only. */
export function Digest() {
  const { session, fail, toast } = useApp();
  const qc = useQueryClient();
  const d = useDigest();
  const canRefresh = session.ctx.roles.includes('OWNER') || session.ctx.roles.includes('ADMIN');
  const refresh = useMutation({
    mutationFn: () => api<DigestView>('/digest/refresh', { method: 'POST' }),
    onSuccess: (data) => {
      qc.setQueryData(['digest'], data);
      toast('Tahlil yangilandi');
    },
    onError: fail,
  });

  if (d.isPending) return <Skeleton n={4} h={110} />;
  if (d.isError) return <div className="banner danger">{(d.error as Error).message}</div>;
  const g = d.data;
  const y = g.yesterday;
  const time = new Date(g.generatedAt).toLocaleTimeString('ru-RU', { timeZone: session.ctx.company.timezone, hour: '2-digit', minute: '2-digit' });
  const groups = (['HIGH', 'MEDIUM', 'LOW'] as const).map((s) => [s, g.items.filter((i) => i.severity === s)] as const).filter(([, xs]) => xs.length);
  const waiting = g.clients.filter((c) => c.waitingHours !== null);
  const silent = g.clients.filter((c) => c.waitingHours === null && (c.silentDays ?? 0) >= 7);

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row between wrap" style={{ gap: 10 }}>
        <div>
          <h1 className="page-title">Kunlik tahlil</h1>
          <div className="small muted">
            {dayLabel(g.day)} · {g.stored ? `tuzildi ${time}` : 'jonli ko‘rinish'} · tavsiyalar maʼlumotni o‘zgartirmaydi
          </div>
        </div>
        {canRefresh && (
          <button className="btn sm" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
            <Icon name="sparkle" size={15} /> {refresh.isPending ? 'Tahlil qilinmoqda…' : 'Yangilash'}
          </button>
        )}
      </div>

      <div className="rep-tiles">
        <div className="card stat rep-tile">
          <span className="v">{y.done}</span>
          <span className="l">Kecha yopildi</span>
          <span className="xs faint">{y.done ? `${Math.round((y.onTime / y.done) * 100)}% muddatida` : y.day ? dayLabel(y.day) : '—'}</span>
        </div>
        <div className="card stat rep-tile">
          <span className="v" style={{ color: g.totals.overdue ? 'var(--danger)' : undefined }}>{g.totals.overdue}</span>
          <span className="l">Muddati o‘tgan</span>
          <span className="xs faint">{g.totals.open} ta ochiq</span>
        </div>
        <div className="card stat rep-tile">
          <span className="v">{g.totals.review}</span>
          <span className="l">Tekshiruvda</span>
          <span className="xs faint">{g.totals.blocked} ta bloklangan</span>
        </div>
        <div className="card stat rep-tile">
          <span className="v">{g.totals.dueToday}</span>
          <span className="l">Bugun muddat</span>
          <span className="xs faint">{g.shoots.length} ta syomka</span>
        </div>
      </div>

      {g.ai && g.ai.length > 0 && (
        <div className="card rep-ai" style={{ padding: 16 }}>
          <div className="row xs xb" style={{ gap: 6, color: 'var(--review)' }}>
            <Icon name="sparkle" size={15} /> AI TAVSIYASI — qaror sizda
          </div>
          <ul className="rep-bullets">
            {g.ai.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>
      )}
      {!g.ai && g.aiAvailable && canRefresh && !g.stored && <div className="small muted">AI tavsiyasi ish boshlanganda keladi yoki «Yangilash» ni bosing.</div>}

      <div className="grid desk-2" style={{ alignItems: 'start' }}>
        <div className="stack" style={{ gap: 14 }}>
          <div className="card stack" style={{ gap: 12 }}>
            <div className="section-title">Tavsiyalar</div>
            {groups.length === 0 && <Empty icon="🙌" title="Bugun muammo ko‘rinmayapti" />}
            {groups.map(([s, xs]) => (
              <div key={s} className="stack" style={{ gap: 6 }}>
                <div className="xs xb" style={{ color: SEV[s].color, letterSpacing: '.04em' }}>{SEV[s].label.toUpperCase()} · {xs.length}</div>
                {xs.map((i, k) => (
                  <ItemRow key={k} i={i} />
                ))}
              </div>
            ))}
          </div>

          {g.overdue.length > 0 && (
            <div className="card stack" style={{ gap: 6 }}>
              <div className="section-title">Muddati o‘tgan</div>
              <div className="list">
                {g.overdue.map((t) => (
                  <button key={t.taskId} className="row rep-li dg-row" onClick={() => go('tasks', t.taskId)}>
                    <span className="xs faint" style={{ width: 34 }}>#{t.number}</span>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="small b ellipsis">{t.title}</div>
                      <div className="xs muted ellipsis">{t.assignee}{t.project ? ` · ${t.project}` : ''}</div>
                    </div>
                    <span className="xs xb" style={{ color: 'var(--danger)' }}>{t.daysLate ? `${t.daysLate} kun` : '< 1 kun'}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {g.review.length > 0 && (
            <div className="card stack" style={{ gap: 6 }}>
              <div className="section-title">Tekshiruvni kutmoqda</div>
              <div className="list">
                {g.review.map((t) => (
                  <button key={t.taskId} className="row rep-li dg-row" onClick={() => go('tasks', t.taskId)}>
                    <span className="xs faint" style={{ width: 34 }}>#{t.number}</span>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="small b ellipsis">{t.title}</div>
                      <div className="xs muted ellipsis">{t.assignee} → {t.reviewer ?? 'tekshiruvchi yo‘q'}</div>
                    </div>
                    <span className="xs xb" style={{ color: t.hours >= 8 ? 'var(--warn)' : 'var(--muted)' }}>{t.hours} ish soati</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="stack" style={{ gap: 14 }}>
          {(waiting.length > 0 || silent.length > 0) && (
            <div className="card stack" style={{ gap: 8 }}>
              <div className="section-title">Mijozlar</div>
              {waiting.map((c) => (
                <button key={c.projectId} className="dg-item click" style={{ borderLeftColor: 'var(--info)' }} onClick={() => go('reports', c.projectId)}>
                  <span className="stack" style={{ gap: 2, textAlign: 'left' }}>
                    <span className="small b">{c.project} · javob kutmoqda {c.waitingHours} ish soati</span>
                    <span className="xs muted">“{c.lastText}”</span>
                  </span>
                  <Icon name="chevron" size={16} />
                </button>
              ))}
              {silent.map((c) => (
                <button key={c.projectId} className="dg-item click" style={{ borderLeftColor: 'var(--faint)' }} onClick={() => go('reports', c.projectId)}>
                  <span className="small">{c.project} — {c.silentDays} kundan beri yozmagan</span>
                  <Icon name="chevron" size={16} />
                </button>
              ))}
            </div>
          )}

          {g.load.length > 0 && (
            <div className="card stack" style={{ gap: 10 }}>
              <div className="row between">
                <div className="section-title">Yuklama</div>
                <span className="xs muted">ochiq ishlar ulushi</span>
              </div>
              {g.load.map((p) => (
                <div key={p.userId} className="stack" style={{ gap: 4 }}>
                  <div className="row between small">
                    <span className="b ellipsis">{p.name}</span>
                    <span className="muted xs">
                      {p.open} ta{p.overdue ? <b style={{ color: 'var(--danger)' }}> · {p.overdue} kech</b> : null} · {p.share}%
                    </span>
                  </div>
                  <div className={`bar ${p.overdue >= 3 ? 'danger' : p.share >= 35 ? 'warn' : ''}`}>
                    <i style={{ width: `${Math.max(4, p.share)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {y.tracked && y.day && (
            <div className="card stack" style={{ gap: 8 }}>
              <div className="section-title">Davomat · {dayLabel(y.day)}</div>
              <div className="rep-mini">
                <div><b>{y.present}</b><span>keldi</span></div>
                <div><b style={{ color: y.late ? 'var(--warn)' : undefined }}>{y.late}</b><span>kechikdi</span></div>
                <div><b style={{ color: y.absent ? 'var(--danger)' : undefined }}>{y.absent}</b><span>belgilanmagan</span></div>
              </div>
            </div>
          )}

          {g.shoots.length > 0 && (
            <div className="card stack" style={{ gap: 6 }}>
              <div className="section-title">Syomkalar</div>
              <div className="list">
                {g.shoots.map((s, i) => (
                  <button key={i} className="row rep-li dg-row" onClick={() => go('shoots')}>
                    <span className="xs b" style={{ width: 62 }}>{s.day === g.day ? 'Bugun' : 'Ertaga'}<br /><span className="muted">{s.start}</span></span>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="small b ellipsis">{s.title}</div>
                      <div className="xs muted ellipsis">{[s.project, s.location].filter(Boolean).join(' · ')}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {g.finance && (
            <div className="card stack" style={{ gap: 8 }}>
              <div className="row between">
                <div className="section-title">Muddati o‘tgan qarzlar</div>
                <span className="xs muted">faqat rahbariyat</span>
              </div>
              <div className="xb" style={{ fontSize: 22, color: 'var(--danger)' }}>{g.finance.overdueAmount.toLocaleString('ru-RU')} so‘m</div>
              {g.finance.parties.map((p) => (
                <div key={p.party} className="row between small">
                  <span>{p.party}</span>
                  <b>{p.debt.toLocaleString('ru-RU')}</b>
                </div>
              ))}
              <button className="btn sm" onClick={() => go('finance')}>Moliyaga o‘tish</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Dashboard card for leads: the top recommendations of the day. */
export function DigestPanel() {
  const d = useDigest();
  if (d.isPending) return <div className="skeleton" style={{ height: 120 }} />;
  if (!d.data) return null;
  const top = d.data.items.slice(0, 3);
  return (
    <div className="card stack" style={{ gap: 10 }}>
      <div className="row between">
        <div className="row section-title" style={{ gap: 8 }}>
          <span className="dg-spark"><Icon name="sparkle" size={16} /></span> Bugungi tavsiyalar
        </div>
        <button className="btn sm ghost" onClick={() => go('digest')}>
          Hammasi <Icon name="chevron" size={14} />
        </button>
      </div>
      {d.data.ai?.[0] && <div className="small" style={{ color: 'var(--review)', lineHeight: 1.45 }}>✨ {d.data.ai[0]}</div>}
      {top.length === 0 ? <div className="small muted">Bugun muammo ko‘rinmayapti 🙌</div> : top.map((i, k) => <ItemRow key={k} i={i} />)}
      {d.data.items.length > 3 && <div className="xs muted">yana {d.data.items.length - 3} ta tavsiya</div>}
    </div>
  );
}
