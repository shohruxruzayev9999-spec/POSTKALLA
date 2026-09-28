import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useProjects } from '../lib/queries';
import { Empty, Icon, Ring, Sheet, Skeleton } from '../ui/kit';
import { useApp } from '../ui/state';

type Kind = 'INCOME' | 'EXPENSE';
type Status = 'PAID' | 'PARTIAL' | 'OVERDUE' | 'UNPAID';
interface FinRow {
  id: string;
  kind: Kind;
  month: string;
  projectId: string | null;
  project: string | null;
  party: string;
  title: string;
  amount: number;
  paid: number;
  debt: number;
  dueDate: string | null;
  paidAt: string | null;
  note: string | null;
  status: Status;
}
interface Debtor {
  party: string;
  debt: number;
  overdue: number;
  months: string[];
  overdueDays: number;
}
interface FinMonth {
  month: string;
  rows: FinRow[];
  debtors: Debtor[];
  summary: {
    expected: number;
    received: number;
    receivable: number;
    overdue: number;
    expenses: number;
    expensesPaid: number;
    payable: number;
    profit: number;
    plannedProfit: number;
    collectedPct: number | null;
    counts: Record<Status, number>;
  };
}
interface TrendPoint {
  month: string;
  expected: number;
  received: number;
  expenses: number;
}

const MONTHS = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'];
const SHORT = ['yan', 'fev', 'mar', 'apr', 'may', 'iyn', 'iyl', 'avg', 'sen', 'okt', 'noy', 'dek'];
const STATUS: Record<Status, { label: string; cls: string }> = {
  PAID: { label: "To'langan", cls: 'fs-paid' },
  PARTIAL: { label: 'Qisman', cls: 'fs-partial' },
  OVERDUE: { label: "Muddati o'tgan", cls: 'fs-overdue' },
  UNPAID: { label: "To'lanmagan", cls: 'fs-unpaid' },
};
const EXPENSE_CATS = ['Oylik', 'Reklama byudjeti', 'Ijara', 'Texnika', 'Servislar', 'Soliq', 'Transport', 'Boshqa'];

export const sum = (n: number) => new Intl.NumberFormat('ru-RU').format(Math.round(n)).replace(/,/g, ' ');
const compact = (n: number) => (Math.abs(n) >= 1e9 ? `${(n / 1e9).toFixed(1)} mlrd` : Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)} mln` : Math.abs(n) >= 1e3 ? `${Math.round(n / 1e3)} ming` : String(n));
const shiftMonth = (m: string, n: number) => {
  const [y, mm] = m.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, mm - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const monthLabel = (m: string) => {
  const [y, mm] = m.split('-').map(Number) as [number, number];
  return `${MONTHS[mm - 1]} ${y}`;
};

export function Finance() {
  const { session, can, fail, toast } = useApp();
  const qc = useQueryClient();
  const tz = session.ctx.company.timezone;
  const [month, setMonth] = useState(() => new Date().toLocaleDateString('en-CA', { timeZone: tz }).slice(0, 7));
  const [tab, setTab] = useState<'INCOME' | 'EXPENSE' | 'DEBT'>('INCOME');
  const [filter, setFilter] = useState<Status | ''>('');
  const [history, setHistory] = useState<FinRow | null>(null);
  const editable = can('finance.manage');
  const q = useQuery({ queryKey: ['finance', month], queryFn: () => api<FinMonth>('/finance', { query: { month } }) });
  const trend = useQuery({ queryKey: ['finance-trend', month], queryFn: () => api<TrendPoint[]>('/finance/trend', { query: { until: month } }) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['finance'] });
    void qc.invalidateQueries({ queryKey: ['finance-trend'] });
  };
  const copy = useMutation({
    mutationFn: () => api<{ copied: number }>('/finance/copy', { method: 'POST', body: { from: shiftMonth(month, -1), to: month } }),
    onSuccess: (r) => {
      toast(r.copied ? `${r.copied} ta qator ko'chirildi` : "Ko'chiradigan yangi qator yo'q");
      refresh();
    },
    onError: fail,
  });

  if (!can('finance.view')) {
    return (
      <div className="card">
        <Empty icon="🔒" title="Moliya faqat rahbar uchun" />
      </div>
    );
  }
  const d = q.data;
  const s = d?.summary;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row wrap between" style={{ gap: 10 }}>
        <h1 className="page-title">Moliya</h1>
        <div className="row wrap" style={{ gap: 8 }}>
          <div className="row month-pick">
            <button className="btn sm ghost" aria-label="Oldingi oy" onClick={() => setMonth(shiftMonth(month, -1))}>‹</button>
            <span className="b small" style={{ minWidth: 110, textAlign: 'center' }}>{monthLabel(month)}</span>
            <button className="btn sm ghost" aria-label="Keyingi oy" onClick={() => setMonth(shiftMonth(month, 1))}>›</button>
          </div>
          {editable && (
            <button className="btn sm" disabled={copy.isPending} onClick={() => copy.mutate()} title="Oylik abonent mijozlar va doimiy xarajatlarni ko‘chiradi">
              ⤵︎ {MONTHS[Number(shiftMonth(month, -1).slice(5)) - 1]}dan ko'chirish
            </button>
          )}
        </div>
      </div>

      {!s ? (
        <Skeleton n={2} h={100} />
      ) : (
        <div className="fin-top">
          <div className="card row fin-hero">
            <Ring value={s.collectedPct} size={92} stroke={10} tone={s.collectedPct == null || s.collectedPct >= 80 ? 'green' : s.collectedPct >= 50 ? 'amber' : 'coral'}>
              <div className="xb" style={{ fontSize: 19 }}>{s.collectedPct == null ? '—' : `${s.collectedPct}%`}</div>
            </Ring>
            <div className="stack" style={{ gap: 3, minWidth: 0 }}>
              <div className="xs muted">Tushdi / kutilgan</div>
              <div className="xb fin-big">{sum(s.received)}</div>
              <div className="small muted">/ {sum(s.expected)} so'm</div>
            </div>
          </div>
          <Money label="Qarzdorlik" v={s.receivable} sub={s.overdue ? `${sum(s.overdue)} muddati o'tgan` : 'muddati o‘tgani yo‘q'} tone={s.overdue ? 'var(--danger)' : undefined} />
          <Money label="Xarajatlar" v={s.expensesPaid} sub={s.payable ? `+${sum(s.payable)} to'lanishi kerak` : `reja: ${sum(s.expenses)}`} />
          <Money label="Sof foyda (kassa)" v={s.profit} sub={`reja: ${sum(s.plannedProfit)}`} tone={s.profit < 0 ? 'var(--danger)' : 'var(--accent-ink)'} />
        </div>
      )}

      {trend.data && <TrendChart data={trend.data} current={month} onPick={setMonth} />}

      <div className="row wrap between" style={{ gap: 8 }}>
        <div className="seg" style={{ width: 380, maxWidth: '100%' }}>
          <button className={tab === 'INCOME' ? 'on' : ''} onClick={() => setTab('INCOME')}>Tushumlar</button>
          <button className={tab === 'EXPENSE' ? 'on' : ''} onClick={() => setTab('EXPENSE')}>Xarajatlar</button>
          <button className={tab === 'DEBT' ? 'on' : ''} onClick={() => setTab('DEBT')}>Qarzdorlar{d?.debtors.length ? <span className="count" style={{ marginLeft: 4, opacity: 0.7 }}>{d.debtors.length}</span> : null}</button>
        </div>
        {tab === 'INCOME' && s && (
          <div className="chips">
            <button className={`chip ${filter === '' ? 'on' : ''}`} onClick={() => setFilter('')}>Hammasi</button>
            {(['UNPAID', 'PARTIAL', 'OVERDUE', 'PAID'] as Status[]).map((k) => (
              <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(filter === k ? '' : k)}>
                {STATUS[k].label} <span className="count">{s.counts[k]}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {!d ? (
        <Skeleton n={4} />
      ) : tab === 'DEBT' ? (
        <Debtors list={d.debtors} />
      ) : (
        <Grid
          key={`${tab}-${month}`}
          kind={tab}
          month={month}
          rows={d.rows.filter((r) => r.kind === tab && (tab !== 'INCOME' || !filter || r.status === filter))}
          editable={editable}
          onChanged={refresh}
          onHistory={setHistory}
        />
      )}

      <Sheet open={!!history} onClose={() => setHistory(null)} title="O'zgarishlar tarixi">
        {history && <History row={history} />}
      </Sheet>
    </div>
  );
}

function Money({ label, v, sub, tone }: { label: string; v: number; sub?: string; tone?: string }) {
  return (
    <div className="card stack" style={{ gap: 4 }}>
      <div className="xs muted">{label}</div>
      <div className="xb fin-big" style={{ color: tone }}>{sum(v)}</div>
      {sub && <div className="xs faint">{sub}</div>}
    </div>
  );
}

// ------------------------------------------------------------------------------------------ trend chart

function TrendChart({ data: all, current, onPick }: { data: TrendPoint[]; current: string; onPick: (m: string) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  // Skip the empty months before the company started keeping books (keep at least 6).
  const first = all.findIndex((p) => p.expected || p.expenses || p.received);
  const data = all.slice(Math.max(0, Math.min(first < 0 ? 0 : first, all.length - 6)));
  const max = Math.max(1, ...data.flatMap((p) => [p.received, p.expenses, p.expected]));
  const H = 140;
  if (data.every((p) => !p.expected && !p.expenses)) return null;
  const h = hover != null ? data[hover] : null;
  return (
    <div className="card stack" style={{ gap: 10 }}>
      <div className="row wrap between" style={{ gap: 8 }}>
        <div className="section-title">Oylar kesimida</div>
        <div className="row small" style={{ gap: 14 }}>
          <span className="row" style={{ gap: 6 }}><i className="fin-key" style={{ background: 'var(--fin-in)' }} />Tushgan</span>
          <span className="row" style={{ gap: 6 }}><i className="fin-key" style={{ background: 'var(--fin-out)' }} />Xarajat</span>
          <span className="row muted" style={{ gap: 6 }}><i className="fin-key dash" />Kutilgan</span>
        </div>
      </div>
      <div className="fin-chart" style={{ height: H + 22, gridTemplateColumns: `repeat(${data.length}, minmax(0, 1fr))` }} onMouseLeave={() => setHover(null)}>
        {data.map((p, i) => {
          const [, mm] = p.month.split('-').map(Number) as [number, number];
          return (
            <button key={p.month} className={`fin-col ${p.month === current ? 'cur' : ''}`} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onClick={() => onPick(p.month)} aria-label={`${monthLabel(p.month)}: tushgan ${sum(p.received)}, xarajat ${sum(p.expenses)}`}>
              <div className="fin-bars" style={{ height: H }}>
                {p.expected > 0 && <span className="fin-exp" style={{ height: `${(p.expected / max) * 100}%` }} />}
                <i style={{ height: `${(p.received / max) * 100}%`, background: 'var(--fin-in)' }} />
                <i style={{ height: `${(p.expenses / max) * 100}%`, background: 'var(--fin-out)' }} />
              </div>
              <span className="xs muted">{SHORT[mm - 1]}</span>
            </button>
          );
        })}
        {h && (
          <div className="fin-tip" style={{ left: `${((hover! + 0.5) / data.length) * 100}%` }}>
            <div className="b small">{monthLabel(h.month)}</div>
            <div className="xs">Tushgan: <b>{sum(h.received)}</b></div>
            <div className="xs">Xarajat: <b>{sum(h.expenses)}</b></div>
            <div className="xs muted">Kutilgan: {sum(h.expected)}</div>
            <div className="xs">Foyda: <b>{compact(h.received - h.expenses)}</b></div>
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------ editable grid

function Cell({ value, type = 'text', onSave, disabled, placeholder, list }: { value: string | number | null; type?: 'text' | 'money' | 'date'; onSave: (v: string) => void; disabled?: boolean; placeholder?: string; list?: string }) {
  const shown = (v: string | number | null) => (v == null ? '' : type === 'money' ? (Number(v) ? sum(Number(v)) : '') : String(v));
  const [text, setText] = useState(shown(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(shown(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const commit = () => {
    focused.current = false;
    const raw = type === 'money' ? text.replace(/[^\d]/g, '') || '0' : text.trim();
    const before = type === 'money' ? String(Number(value ?? 0)) : String(value ?? '');
    if (raw !== before) onSave(raw);
    setText(shown(type === 'money' ? Number(raw) : raw || null));
  };
  return (
    <input
      className={`fin-cell ${type === 'money' ? 'num' : ''}`}
      type={type === 'date' ? 'date' : 'text'}
      inputMode={type === 'money' ? 'numeric' : undefined}
      value={text}
      disabled={disabled}
      placeholder={placeholder}
      list={list}
      onFocus={(e) => {
        focused.current = true;
        if (type === 'money') setText(text.replace(/[^\d]/g, ''));
        e.currentTarget.select();
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setText(shown(value));
          focused.current = false;
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function Grid({ kind, month, rows, editable, onChanged, onHistory }: { kind: Kind; month: string; rows: FinRow[]; editable: boolean; onChanged: () => void; onHistory: (r: FinRow) => void }) {
  const { fail } = useApp();
  const qc = useQueryClient();
  const projects = useProjects();
  const income = kind === 'INCOME';
  const patch = useMutation({
    mutationFn: (v: { id: string; body: Record<string, unknown> }) => api<FinRow>(`/finance/rows/${v.id}`, { method: 'PATCH', body: v.body }),
    onSuccess: (r) => {
      // Update in place so the row does not jump while typing, then refresh totals.
      qc.setQueryData<FinMonth>(['finance', month], (old) => (old ? { ...old, rows: old.rows.map((x) => (x.id === r.id ? { ...x, ...r, project: x.project } : x)) } : old));
      onChanged();
    },
    onError: (e) => {
      fail(e);
      onChanged();
    },
  });
  const add = useMutation({
    mutationFn: () => api<FinRow>('/finance/rows', { method: 'POST', body: { kind, month, party: income ? '' : 'Boshqa' } }),
    onSuccess: onChanged,
    onError: fail,
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/finance/rows/${id}`, { method: 'DELETE' }),
    onSuccess: onChanged,
    onError: fail,
  });
  const save = (r: FinRow, field: string, v: string) => {
    const body: Record<string, unknown> = {};
    if (field === 'amount' || field === 'paid') body[field] = Number(v);
    else if (field === 'dueDate' || field === 'projectId') body[field] = v || null;
    else body[field] = v;
    patch.mutate({ id: r.id, body });
  };
  const totals = useMemo(() => rows.reduce((a, r) => ({ amount: a.amount + r.amount, paid: a.paid + r.paid, debt: a.debt + r.debt }), { amount: 0, paid: 0, debt: 0 }), [rows]);
  const parties = useMemo(() => [...new Set(rows.map((r) => r.party).filter(Boolean))], [rows]);

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="fin-scroll">
        <table className="fin-table">
          <thead>
            <tr>
              <th className="sticky">{income ? 'Mijoz' : 'Kategoriya'}</th>
              {income && <th>Loyiha</th>}
              <th>{income ? 'Xizmat' : 'Tavsif'}</th>
              <th className="num">Summa</th>
              <th className="num">To'landi</th>
              <th className="num">Qoldiq</th>
              <th>Muddat</th>
              <th>Holat</th>
              <th>Izoh</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.status === 'OVERDUE' ? 'late' : ''}>
                <td className="sticky"><Cell value={r.party} disabled={!editable} placeholder={income ? 'Mijoz nomi' : 'Kategoriya'} list={income ? 'fin-parties' : 'fin-cats'} onSave={(v) => save(r, 'party', v)} /></td>
                {income && (
                  <td>
                    <select className="fin-cell" value={r.projectId ?? ''} disabled={!editable} onChange={(e) => save(r, 'projectId', e.target.value)}>
                      <option value="">—</option>
                      {(projects.data ?? []).map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </td>
                )}
                <td><Cell value={r.title} disabled={!editable} placeholder={income ? 'SMM, target, video…' : 'Tavsif'} onSave={(v) => save(r, 'title', v)} /></td>
                <td className="num"><Cell type="money" value={r.amount} disabled={!editable} placeholder="0" onSave={(v) => save(r, 'amount', v)} /></td>
                <td className="num"><Cell type="money" value={r.paid} disabled={!editable} placeholder="0" onSave={(v) => save(r, 'paid', v)} /></td>
                <td className="num b" style={{ color: r.debt ? (r.status === 'OVERDUE' ? 'var(--danger)' : 'var(--text)') : 'var(--faint)', paddingRight: 12 }}>{r.debt ? sum(r.debt) : '—'}</td>
                <td><Cell type="date" value={r.dueDate} disabled={!editable} onSave={(v) => save(r, 'dueDate', v)} /></td>
                <td>
                  <button
                    className={`fin-status ${STATUS[r.status].cls}`}
                    disabled={!editable || r.status === 'PAID' || !r.amount}
                    title={r.status !== 'PAID' && editable ? "Bosing — to'liq to'landi deb belgilash" : r.paidAt ? `To'langan: ${r.paidAt}` : undefined}
                    onClick={() => patch.mutate({ id: r.id, body: { paid: r.amount } })}
                  >
                    {STATUS[r.status].label}
                  </button>
                </td>
                <td><Cell value={r.note} disabled={!editable} placeholder="…" onSave={(v) => save(r, 'note', v)} /></td>
                <td>
                  <div className="row" style={{ gap: 2 }}>
                    <button className="btn sm ghost icon-btn" style={{ width: 30, height: 30 }} aria-label="Tarix" onClick={() => onHistory(r)}><Icon name="clock" size={15} /></button>
                    {editable && <button className="btn sm ghost icon-btn" style={{ width: 30, height: 30, color: 'var(--danger)' }} aria-label="O'chirish" onClick={() => del.mutate(r.id)}><Icon name="trash" size={15} /></button>}
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={income ? 10 : 9} className="muted small" style={{ padding: 24, textAlign: 'center' }}>
                  {income ? "Bu oyda tushum qatori yo'q. «+ Qator» bilan qo'shing yoki o'tgan oydan ko'chiring." : "Bu oyda xarajat yo'q."}
                </td>
              </tr>
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr>
                <td className="sticky b">Jami · {rows.length}</td>
                {income && <td />}
                <td />
                <td className="num b" style={{ paddingRight: 12 }}>{sum(totals.amount)}</td>
                <td className="num b" style={{ paddingRight: 12 }}>{sum(totals.paid)}</td>
                <td className="num b" style={{ paddingRight: 12, color: totals.debt ? 'var(--danger)' : undefined }}>{sum(totals.debt)}</td>
                <td colSpan={4} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <datalist id="fin-parties">{parties.map((p) => <option key={p} value={p} />)}</datalist>
      <datalist id="fin-cats">{EXPENSE_CATS.map((p) => <option key={p} value={p} />)}</datalist>
      {editable && (
        <button className="fin-add" disabled={add.isPending} onClick={() => add.mutate()}>
          <Icon name="plus" size={16} /> Qator
        </button>
      )}
    </div>
  );
}

function Debtors({ list }: { list: Debtor[] }) {
  if (!list.length) return <div className="card"><Empty icon="🎉" title="Qarzdor yo'q" /></div>;
  const total = list.reduce((a, d) => a + d.debt, 0);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row between small muted"><span>{list.length} ta mijoz</span><span>Jami: <b style={{ color: 'var(--danger)' }}>{sum(total)} so'm</b></span></div>
      {list.map((d) => (
        <div key={d.party} className="card tight row" style={{ gap: 12 }}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="b ellipsis">{d.party}</div>
            <div className="xs muted">
              {d.months.map((m) => SHORT[Number(m.slice(5)) - 1]).join(', ')}
              {d.overdueDays ? <span style={{ color: 'var(--danger)', fontWeight: 700 }}> · {d.overdueDays} kun kechikkan</span> : null}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="xb">{sum(d.debt)}</div>
            {d.overdue > 0 && d.overdue !== d.debt && <div className="xs" style={{ color: 'var(--danger)' }}>{sum(d.overdue)} muddati o'tgan</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function History({ row }: { row: FinRow }) {
  const q = useQuery({ queryKey: ['finance-history', row.id], queryFn: () => api<Array<{ id: string; action: string; data: Record<string, unknown> | null; createdAt: string; name: string | null }>>(`/finance/rows/${row.id}/history`) });
  const FIELD: Record<string, string> = { party: 'Mijoz', title: 'Xizmat', amount: 'Summa', paid: "To'landi", dueDate: 'Muddat', note: 'Izoh', projectId: 'Loyiha', paidAt: "To'langan sana", month: 'Oy' };
  const fmt = (k: string, v: unknown) => (v == null || v === '' ? '—' : k === 'amount' || k === 'paid' ? sum(Number(v)) : k === 'projectId' ? 'o‘zgardi' : String(v));
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="b">{row.party || 'Nomsiz'} · {row.title}</div>
      {q.isPending ? (
        <Skeleton n={3} h={40} />
      ) : (
        (q.data ?? []).map((h) => (
          <div key={h.id} className="card tight stack" style={{ gap: 4 }}>
            <div className="row between xs muted">
              <span className="b" style={{ color: 'var(--text)' }}>{h.name ?? '—'}</span>
              <span>{new Date(h.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            {h.action === 'finance.create' && <div className="small">Qator yaratildi</div>}
            {h.action === 'finance.update' &&
              Object.entries((h.data ?? {}) as Record<string, { from: unknown; to: unknown }>).map(([k, c]) => (
                <div key={k} className="small">
                  {FIELD[k] ?? k}: <span className="muted">{fmt(k, c.from)}</span> → <b>{fmt(k, c.to)}</b>
                </div>
              ))}
          </div>
        ))
      )}
    </div>
  );
}
