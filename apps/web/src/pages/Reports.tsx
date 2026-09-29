import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { STATUS } from '../lib/format';
import { useProjects } from '../lib/queries';
import { tg } from '../lib/tg';
import { Empty, Icon, Ring, Skeleton, scoreTone } from '../ui/kit';
import { go, useApp } from '../ui/state';

interface Report {
  scope: 'PROJECT' | 'COMPANY';
  company: string;
  generatedAt: string;
  period: { from: string; to: string };
  project: { id: string; name: string; client: string | null; manager: string | null; status: string; chat: string | null; color: string } | null;
  summary: { created: number; done: number; doneOnTime: number; onTimePct: number | null; open: number; overdue: number; returned: number; points: number; messages: number; clientMessages: number; shoots: number };
  statusCounts: Record<string, number>;
  people: Array<{ userId: string; name: string; done: number; onTime: number; open: number; overdue: number; points: number }>;
  doneTasks: Array<{ number: number; title: string; assignee: string; completedAt: string; onTime: boolean; revision: number; project: string | null; format: string | null }>;
  openTasks: Array<{ number: number; title: string; assignee: string; deadline: string; status: string; overdue: boolean; project: string | null }>;
  shoots: Array<{ day: string; start: string; title: string; type: string; status: string; location: string | null; project: string | null }>;
  chat: {
    total: number;
    team: number;
    client: number;
    media: Record<string, number>;
    byDay: Array<{ day: string; team: number; client: number }>;
    senders: Array<{ name: string; n: number; isTeam: boolean }>;
    clientMessages: Array<{ at: string; name: string; text: string; kind: string }>;
    links: string[];
    files: string[];
    lastClientAt: string | null;
  };
  projects: Array<{ id: string; name: string; color: string; done: number; onTimePct: number | null; open: number; overdue: number; messages: number }>;
  finance: { expected: number; received: number; debt: number; months: string[] } | null;
  insights: string[];
  aiSummary: string[] | null;
  aiAvailable: boolean;
}

type Preset = 'month' | 'prev' | 'week' | '30' | 'custom';
const PRESETS: Array<[Preset, string]> = [
  ['month', 'Shu oy'],
  ['prev', 'O‘tgan oy'],
  ['week', 'Shu hafta'],
  ['30', '30 kun'],
  ['custom', 'Tanlash'],
];
const STATUS_COLOR: Record<string, string> = { DONE: 'var(--accent)', IN_PROGRESS: 'var(--info)', REVIEW: 'var(--review)', RETURNED: 'var(--warn)', BLOCKED: 'var(--danger)', NEW: 'var(--faint)' };
const PEOPLE_COLS = 'minmax(0,1fr) 50px 54px 44px 40px';
const ORDER = ['DONE', 'IN_PROGRESS', 'REVIEW', 'RETURNED', 'BLOCKED', 'NEW'];
const MON = ['yan', 'fev', 'mar', 'apr', 'may', 'iyn', 'iyl', 'avg', 'sen', 'okt', 'noy', 'dek'];
const MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];

const num = (n: number) => n.toLocaleString('ru-RU');
const iso = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
function range(p: Preset, today: string): { from: string; to: string } {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  if (p === 'prev') return { from: iso(new Date(Date.UTC(y, m - 2, 1))), to: iso(new Date(Date.UTC(y, m - 1, 0))) };
  if (p === 'week') {
    const wd = (t.getUTCDay() + 6) % 7;
    return { from: iso(new Date(t.getTime() - wd * 86_400_000)), to: today };
  }
  if (p === '30') return { from: iso(new Date(t.getTime() - 29 * 86_400_000)), to: today };
  return { from: `${today.slice(0, 7)}-01`, to: today };
}
function periodLabel(from: string, to: string) {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  if (fy === ty && fm === tm) return fd === td ? `${fd}-${MONTHS[fm - 1]} ${fy}` : `${fd}–${td} ${MONTHS[fm - 1]} ${fy}`;
  return `${fd}-${MON[fm - 1]} – ${td}-${MON[tm - 1]} ${ty}`;
}
const shortDay = (d: string) => {
  const [, m, dd] = d.split('-').map(Number) as [number, number, number];
  return `${dd}-${MON[m - 1]}`;
};

/** Hisobotlar: a project (or company) report built from ERP data and the project's Telegram group — preview, PDF, send to Telegram. */
export function Reports({ projectId: initialProject }: { projectId?: string }) {
  const { session, fail, toast } = useApp();
  const tz = session.ctx.company.timezone;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const projects = useProjects();
  const [scope, setScope] = useState<'PROJECT' | 'COMPANY'>('PROJECT');
  const [projectId, setProjectId] = useState(initialProject ?? '');
  const [preset, setPreset] = useState<Preset>('month');
  const [custom, setCustom] = useState(() => range('month', today));
  const [withAi, setWithAi] = useState(false);
  const period = preset === 'custom' ? custom : range(preset, today);
  const sorted = useMemo(() => [...(projects.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [projects.data]);
  const pid = scope === 'PROJECT' ? projectId || (sorted.find((p) => p.telegramChatId) ?? sorted[0])?.id || '' : '';
  const ready = scope === 'COMPANY' || !!pid;
  const q = { projectId: pid || undefined, from: period.from, to: period.to };

  const report = useQuery({
    queryKey: ['report', q, withAi],
    queryFn: () => api<Report>('/reports', { query: { ...q, ai: withAi || undefined } }),
    enabled: ready && period.from <= period.to,
  });
  const pdf = useMutation({
    mutationFn: () => api<{ url: string }>('/reports/link', { method: 'POST', body: q }),
    onSuccess: ({ url }) => {
      const abs = new URL(url, window.location.origin).toString();
      if (tg) tg.openLink(abs);
      else window.open(abs, '_blank', 'noopener');
    },
    onError: fail,
  });
  const send = useMutation({
    mutationFn: () => api('/reports/send', { method: 'POST', body: q }),
    onSuccess: () => toast('PDF Telegram’ga yuborildi'),
    onError: fail,
  });

  const r = report.data;
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row between wrap" style={{ gap: 10 }}>
        <div>
          <h1 className="page-title">Hisobotlar</h1>
          <div className="small muted">ERP maʼlumotlari va loyiha Telegram guruhidan</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn sm" disabled={!ready || send.isPending} onClick={() => send.mutate()}>
            <Icon name="chat" size={16} /> {send.isPending ? 'Yuborilmoqda…' : 'Telegram’ga'}
          </button>
          <button className="btn sm primary" disabled={!ready || pdf.isPending} onClick={() => pdf.mutate()}>
            <Icon name="file" size={16} /> PDF
          </button>
        </div>
      </div>

      <div className="card stack rep-controls" style={{ gap: 10 }}>
        <div className="row wrap" style={{ gap: 8 }}>
          <div className="seg" style={{ width: 210 }}>
            <button className={scope === 'PROJECT' ? 'on' : ''} onClick={() => setScope('PROJECT')}>Loyiha</button>
            <button className={scope === 'COMPANY' ? 'on' : ''} onClick={() => setScope('COMPANY')}>Umumiy</button>
          </div>
          {scope === 'PROJECT' && (
            <select className="input" style={{ minHeight: 40, width: 'auto', minWidth: 190, flex: '1 1 190px', maxWidth: 320 }} value={pid} onChange={(e) => setProjectId(e.target.value)} aria-label="Loyiha">
              {sorted.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          )}
        </div>
        <div className="chips">
          {PRESETS.map(([k, label]) => (
            <button key={k} className={`chip ${preset === k ? 'on' : ''}`} onClick={() => setPreset(k)}>{label}</button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="row wrap" style={{ gap: 8 }}>
            <input className="input" type="date" style={{ minHeight: 40, width: 'auto' }} value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} aria-label="Boshlanish" />
            <span className="muted">—</span>
            <input className="input" type="date" style={{ minHeight: 40, width: 'auto' }} value={custom.to} min={custom.from} onChange={(e) => setCustom({ ...custom, to: e.target.value })} aria-label="Tugash" />
          </div>
        )}
      </div>

      {!ready && projects.data && (
        <div className="card">
          <Empty icon="📁" title="Loyiha yo‘q">
            <button className="btn sm" onClick={() => go('projects')}>Loyiha yaratish</button>
          </Empty>
        </div>
      )}
      {report.isPending && ready && <Skeleton n={4} h={110} />}
      {report.isError && <div className="banner danger">{(report.error as Error).message}</div>}
      {r && <ReportView r={r} tz={tz} withAi={withAi} onAi={() => setWithAi(true)} aiLoading={withAi && report.isFetching} />}
    </div>
  );
}

function ReportView({ r, tz, withAi, onAi, aiLoading }: { r: Report; tz: string; withAi: boolean; onAi: () => void; aiLoading: boolean }) {
  const s = r.summary;
  const dt = (d: string) => {
    const x = new Date(d);
    return `${x.toLocaleDateString('en-CA', { timeZone: tz }).slice(8)}-${MON[Number(x.toLocaleDateString('en-CA', { timeZone: tz }).slice(5, 7)) - 1]}, ${x.toLocaleTimeString('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit' })}`;
  };
  const statusTotal = ORDER.reduce((a, k) => a + (r.statusCounts[k] ?? 0), 0);
  const maxDay = useMemo(() => Math.max(1, ...r.chat.byDay.map((d) => d.team + d.client)), [r.chat.byDay]);

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="card rep-hero">
        <div className="grow stack" style={{ gap: 6, minWidth: 0 }}>
          <div className="xs xb rep-kicker">{r.scope === 'PROJECT' ? 'LOYIHA HISOBOTI' : 'KOMPANIYA HISOBOTI'}</div>
          <div className="rep-title">{r.project?.name ?? r.company}</div>
          <div className="small rep-sub">
            {r.project ? [r.project.client && `Mijoz: ${r.project.client}`, r.project.manager && `Menejer: ${r.project.manager}`].filter(Boolean).join(' · ') || '—' : 'Barcha loyihalar'}
          </div>
          <div className="row wrap" style={{ gap: 6, marginTop: 4 }}>
            <span className="rep-badge">{periodLabel(r.period.from, r.period.to)}</span>
            {r.project?.chat && <span className="rep-badge">✈︎ {r.project.chat}</span>}
          </div>
        </div>
        <Ring value={s.onTimePct} size={100} stroke={10} tone={scoreTone(s.onTimePct)}>
          <span className="xb" style={{ fontSize: 24, lineHeight: 1 }}>{s.onTimePct === null ? '—' : `${s.onTimePct}%`}</span>
          <span style={{ fontSize: 10.5, opacity: 0.8 }}>muddatida</span>
        </Ring>
      </div>

      <div className="rep-tiles">
        <Tile v={s.done} l="Bajarildi" sub={`${s.points} ball`} />
        <Tile v={s.open} l="Ochiq" sub={`${s.created} ta yangi`} />
        <Tile v={s.overdue} l="Muddati o‘tgan" tone={s.overdue ? 'danger' : undefined} sub={s.returned ? `${s.returned} ta qayta ishlangan` : 'qayta ishlash yo‘q'} />
        {r.scope === 'PROJECT' ? <Tile v={s.messages} l="Guruh xabarlari" sub={`mijozdan ${s.clientMessages}`} /> : <Tile v={r.projects.length} l="Faol loyihalar" sub={`${s.messages} xabar`} />}
      </div>

      <div className="grid desk-2" style={{ alignItems: 'start' }}>
        <div className="stack" style={{ gap: 14 }}>
          <div className="card stack" style={{ gap: 10 }}>
            <div className="row between">
              <div className="section-title">Xulosa</div>
              {r.aiAvailable && !withAi && (
                <button className="btn sm ghost" onClick={onAi}>
                  <Icon name="sparkle" size={15} /> AI xulosa
                </button>
              )}
            </div>
            <ul className="rep-bullets">
              {r.insights.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
            {aiLoading && <div className="skeleton" style={{ height: 70 }} />}
            {r.aiSummary && (
              <div className="rep-ai">
                <div className="row xs xb" style={{ gap: 6, color: 'var(--review)' }}>
                  <Icon name="sparkle" size={14} /> AI TAHLIL — faqat tavsiya
                </div>
                <ul className="rep-bullets">
                  {r.aiSummary.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {statusTotal > 0 && (
            <div className="card stack" style={{ gap: 10 }}>
              <div className="section-title">Vazifalar holati</div>
              <div className="rep-stack">
                {ORDER.filter((k) => r.statusCounts[k]).map((k) => (
                  <span key={k} style={{ flex: r.statusCounts[k], background: STATUS_COLOR[k] }} title={`${STATUS[k]}: ${r.statusCounts[k]}`} />
                ))}
              </div>
              <div className="row wrap xs" style={{ gap: 12 }}>
                {ORDER.filter((k) => r.statusCounts[k]).map((k) => (
                  <span key={k} className="row" style={{ gap: 5 }}>
                    <span style={{ width: 9, height: 9, borderRadius: 3, background: STATUS_COLOR[k] }} />
                    <span className="muted">{STATUS[k]}</span> <b>{r.statusCounts[k]}</b>
                  </span>
                ))}
              </div>
            </div>
          )}

          {r.scope === 'COMPANY' && (
            <div className="card stack" style={{ gap: 6 }}>
              <div className="section-title">Loyihalar</div>
              {r.projects.length === 0 && <div className="small muted">Bu davrda faollik yo‘q</div>}
              <div className="rep-table">
                {r.projects.length > 0 && (
                  <div className="rep-tr rep-th" style={{ gridTemplateColumns: PEOPLE_COLS }}>
                    <span>Loyiha</span>
                    <span>Bajardi</span>
                    <span>Vaqtida</span>
                    <span>Ochiq</span>
                    <span>Kech</span>
                  </div>
                )}
                {r.projects.map((p) => (
                  <button key={p.id} className="rep-tr rep-click" style={{ gridTemplateColumns: PEOPLE_COLS }} onClick={() => go('reports', p.id)}>
                    <span className="row b ellipsis" style={{ gap: 8 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 4, background: p.color, flexShrink: 0 }} />
                      <span className="ellipsis">{p.name}</span>
                    </span>
                    <span>{p.done}</span>
                    <span>{p.onTimePct === null ? '—' : `${p.onTimePct}%`}</span>
                    <span>{p.open}</span>
                    <span style={{ color: p.overdue ? 'var(--danger)' : undefined, fontWeight: p.overdue ? 800 : undefined }}>{p.overdue}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="card stack" style={{ gap: 6 }}>
            <div className="section-title">Bajarilgan ishlar · {s.done}</div>
            {r.doneTasks.length === 0 && <div className="small muted">Bu davrda yopilgan vazifa yo‘q</div>}
            <div className="list">
              {[...r.doneTasks].reverse().slice(0, 30).map((t) => (
                <div key={t.number} className="row rep-li">
                  <span className="xs faint" style={{ width: 34 }}>#{t.number}</span>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="small b ellipsis">{t.title}{t.revision > 1 && <span style={{ color: 'var(--warn)' }}> · R{t.revision}</span>}</div>
                    <div className="xs muted ellipsis">{t.assignee}{r.scope === 'COMPANY' && t.project ? ` · ${t.project}` : ''} · {dt(t.completedAt)}</div>
                  </div>
                  <span className={`tag ${t.onTime ? 'ok' : ''}`} style={t.onTime ? undefined : { color: 'var(--warn)' }}>{t.onTime ? 'O‘z vaqtida' : 'Kech'}</span>
                </div>
              ))}
            </div>
          </div>

          {r.openTasks.length > 0 && (
            <div className="card stack" style={{ gap: 6 }}>
              <div className="section-title">Ochiq vazifalar · {s.open}</div>
              <div className="list">
                {r.openTasks.slice(0, 30).map((t) => (
                  <div key={t.number} className="row rep-li">
                    <span className="xs faint" style={{ width: 34 }}>#{t.number}</span>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="small b ellipsis">{t.title}</div>
                      <div className="xs muted ellipsis">
                        {t.assignee}{r.scope === 'COMPANY' && t.project ? ` · ${t.project}` : ''} · <span style={{ color: t.overdue ? 'var(--danger)' : undefined, fontWeight: t.overdue ? 800 : undefined }}>{dt(t.deadline)}</span>
                      </div>
                    </div>
                    <span className="xs xb" style={{ color: STATUS_COLOR[t.status] }}>{STATUS[t.status]}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="stack" style={{ gap: 14 }}>
          <div className="card stack" style={{ gap: 6 }}>
            <div className="section-title">Jamoa</div>
            {r.people.length === 0 && <div className="small muted">Bu davrda vazifa yo‘q</div>}
            {r.people.length > 0 && (
              <div className="rep-table">
                <div className="rep-tr rep-th" style={{ gridTemplateColumns: PEOPLE_COLS }}>
                  <span>Ijrochi</span>
                  <span>Bajardi</span>
                  <span>Vaqtida</span>
                  <span>Ochiq</span>
                  <span>Kech</span>
                </div>
                {r.people.map((p) => (
                  <div key={p.userId} className="rep-tr" style={{ gridTemplateColumns: PEOPLE_COLS }}>
                    <span className="b ellipsis">{p.name}</span>
                    <span>{p.done}</span>
                    <span>{p.done ? `${Math.round((p.onTime / p.done) * 100)}%` : '—'}</span>
                    <span>{p.open}</span>
                    <span style={{ color: p.overdue ? 'var(--danger)' : undefined, fontWeight: p.overdue ? 800 : undefined }}>{p.overdue}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card stack" style={{ gap: 10 }}>
            <div className="row between">
              <div className="section-title">Telegram guruh</div>
              <span className="xs muted">{r.chat.total} xabar</span>
            </div>
            {r.chat.total === 0 ? (
              <div className="small muted">
                {r.scope === 'PROJECT' && !r.project?.chat ? 'Loyihaga guruh ulanmagan: botni guruhga qo‘shing va /bind yozing.' : 'Bu davrda xabar saqlanmagan. Bot guruhda administrator bo‘lishi kerak.'}
              </div>
            ) : (
              <>
                <div className="rep-mini">
                  <div><b>{r.chat.team}</b><span>jamoa</span></div>
                  <div><b style={{ color: 'var(--info)' }}>{r.chat.client}</b><span>mijoz</span></div>
                  <div><b>{r.chat.media.PHOTO ?? 0}</b><span>rasm</span></div>
                  <div><b>{r.chat.media.VIDEO ?? 0}</b><span>video</span></div>
                  <div><b>{r.chat.media.DOCUMENT ?? 0}</b><span>fayl</span></div>
                </div>
                <div className="rep-bars" aria-label="Kunlik faollik">
                  {r.chat.byDay.map((d) => (
                    <span key={d.day} title={`${shortDay(d.day)}: jamoa ${d.team}, mijoz ${d.client}`}>
                      <i style={{ height: `${(d.client / maxDay) * 100}%`, background: 'var(--info)' }} />
                      <i style={{ height: `${(d.team / maxDay) * 100}%`, background: 'var(--accent)' }} />
                    </span>
                  ))}
                </div>
                <div className="row between xs faint">
                  <span>{shortDay(r.chat.byDay[0]?.day ?? r.period.from)}</span>
                  <span className="row" style={{ gap: 10 }}>
                    <span className="row" style={{ gap: 4 }}><i className="rep-key" style={{ background: 'var(--accent)' }} />jamoa</span>
                    <span className="row" style={{ gap: 4 }}><i className="rep-key" style={{ background: 'var(--info)' }} />mijoz</span>
                  </span>
                  <span>{shortDay(r.chat.byDay.at(-1)?.day ?? r.period.to)}</span>
                </div>
                {r.chat.senders.length > 0 && (
                  <div className="row wrap" style={{ gap: 6 }}>
                    {r.chat.senders.slice(0, 6).map((x) => (
                      <span key={x.name} className="tag" style={x.isTeam ? undefined : { color: 'var(--info)' }}>{x.name} · {x.n}</span>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {r.chat.clientMessages.length > 0 && (
            <div className="card stack" style={{ gap: 8 }}>
              <div className="section-title">Mijoz xabarlari</div>
              {[...r.chat.clientMessages].reverse().slice(0, 12).map((m, i) => (
                <div key={i} className="rep-msg">
                  <div className="xs muted b">{m.name} · {dt(m.at)}</div>
                  <div className="small" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.text || (m.kind === 'PHOTO' ? '📷 rasm' : m.kind === 'VIDEO' ? '🎬 video' : m.kind === 'VOICE' ? '🎤 ovozli' : '📎 fayl')}</div>
                </div>
              ))}
              {r.chat.links.length > 0 && (
                <div className="stack" style={{ gap: 4 }}>
                  <div className="xs xb muted">HAVOLALAR</div>
                  {r.chat.links.slice(0, 8).map((l) => (
                    <a key={l} className="xs ellipsis" href={l} target="_blank" rel="noreferrer" style={{ color: 'var(--info)' }}>{l}</a>
                  ))}
                </div>
              )}
            </div>
          )}

          {r.shoots.length > 0 && (
            <div className="card stack" style={{ gap: 6 }}>
              <div className="section-title">Syomkalar · {r.shoots.length}</div>
              <div className="list">
                {r.shoots.map((x, i) => (
                  <div key={i} className="row rep-li">
                    <span className="xs b" style={{ width: 64 }}>{shortDay(x.day)}<br /><span className="muted">{x.start}</span></span>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="small b ellipsis">{x.title}</div>
                      <div className="xs muted ellipsis">{[x.location, r.scope === 'COMPANY' ? x.project : null].filter(Boolean).join(' · ') || '—'}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {r.finance && (
            <div className="card stack" style={{ gap: 10 }}>
              <div className="row between">
                <div className="section-title">Moliya</div>
                <span className="xs muted">faqat rahbariyat</span>
              </div>
              <div className="rep-mini">
                <div><b>{num(r.finance.expected)}</b><span>kutilgan, so‘m</span></div>
                <div><b style={{ color: 'var(--accent-ink)' }}>{num(r.finance.received)}</b><span>tushgan, so‘m</span></div>
                <div><b style={{ color: r.finance.debt ? 'var(--danger)' : undefined }}>{num(r.finance.debt)}</b><span>qarz, so‘m</span></div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Tile({ v, l, sub, tone }: { v: number | string; l: string; sub?: string; tone?: 'danger' }) {
  return (
    <div className="card stat rep-tile">
      <span className="v" style={{ color: tone === 'danger' ? 'var(--danger)' : undefined }}>{v}</span>
      <span className="l">{l}</span>
      {sub && <span className="xs faint">{sub}</span>}
    </div>
  );
}
