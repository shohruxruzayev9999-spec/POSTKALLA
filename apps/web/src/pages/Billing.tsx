import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { Empty, Field, Icon, Ring, Sheet, Skeleton } from '../ui/kit';
import { useApp } from '../ui/state';

type PlanId = 'START' | 'BUSINESS' | 'PREMIUM';
interface Price {
  monthly: number;
  months: number;
  full: number;
  discountPct: number;
  total: number;
  perMonth: number;
  saved: number;
}
interface CatalogPlan {
  id: PlanId;
  name: string;
  monthly: number;
  maxMembers: number | null;
  maxProjects: number | null;
  tagline: string;
  features: string[];
  prices: Price[];
}
interface PaymentRequest {
  id: string;
  plan: string;
  months: number;
  amount: number;
  discountPct: number;
  status: 'PENDING' | 'PAID' | 'CANCELLED';
  method: string | null;
  createdAt: string;
  paidUntil: string | null;
}
interface Overview {
  plan: string;
  planName: string;
  planUntil: string | null;
  status: 'TRIAL' | 'ACTIVE' | 'EXPIRED' | 'UNLIMITED';
  daysLeft: number | null;
  usage: { members: number; projects: number };
  limits: { members: number | null; projects: number | null };
  catalog: CatalogPlan[];
  requests: PaymentRequest[];
  platformAdmin: boolean;
}

const DURATIONS = [1, 3, 6, 12];
const METHODS: Array<[string, string]> = [
  ['PAYME', 'Payme'],
  ['CLICK', 'Click'],
  ['BANK', 'Bank o‘tkazmasi'],
  ['CASH', 'Naqd'],
];
const STATUS_LABEL: Record<Overview['status'], string> = { TRIAL: 'Sinov davri', ACTIVE: 'Faol', EXPIRED: 'Muddati tugagan', UNLIMITED: 'Cheksiz' };
const REQ_LABEL: Record<PaymentRequest['status'], [string, string]> = {
  PENDING: ['Kutilmoqda', 'warn'],
  PAID: ['To‘langan', 'ok'],
  CANCELLED: ['Bekor qilingan', ''],
};
const PLAN_NAME: Record<string, string> = { TRIAL: 'Sinov', START: 'Start', BUSINESS: 'Biznes', PREMIUM: 'Premium' };
const num = (n: number) => n.toLocaleString('ru-RU');
const dateUz = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
};

/** Obuna: current plan, usage, plans with prepayment discounts and a payment request (no card data here). */
export function Billing() {
  const { fail, toast } = useApp();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['billing'], queryFn: () => api<Overview>('/billing') });
  const [months, setMonths] = useState(12);
  const [pick, setPick] = useState<CatalogPlan | null>(null);

  if (q.isPending) return <Skeleton n={3} h={160} />;
  if (q.isError) return <div className="banner danger">{(q.error as Error).message}</div>;
  const b = q.data;
  const pending = b.requests.find((r) => r.status === 'PENDING');
  const totalDays = b.status === 'TRIAL' ? 14 : 30;
  const ringValue = b.status === 'UNLIMITED' ? 100 : b.daysLeft === null ? 0 : Math.min(100, Math.round((b.daysLeft / Math.max(totalDays, b.daysLeft)) * 100));

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div>
        <h1 className="page-title">Obuna</h1>
        <div className="small muted">Tarif, to‘lovlar va limitlar</div>
      </div>

      <div className={`card bl-hero bl-${b.status.toLowerCase()}`}>
        <div className="grow stack" style={{ gap: 8, minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <span className="bl-crown"><Icon name="crown" size={18} /></span>
            <span className="xs xb" style={{ letterSpacing: '.12em', opacity: 0.8 }}>JORIY TARIF</span>
          </div>
          <div className="bl-plan">{b.planName}</div>
          <div className="row wrap" style={{ gap: 6 }}>
            <span className="rep-badge">{STATUS_LABEL[b.status]}</span>
            {b.planUntil && <span className="rep-badge">{b.status === 'EXPIRED' ? 'tugagan' : 'amal qiladi'}: {dateUz(b.planUntil)}</span>}
          </div>
          <div className="bl-usage">
            <Usage label="Hodimlar" used={b.usage.members} limit={b.limits.members} />
            <Usage label="Faol loyihalar" used={b.usage.projects} limit={b.limits.projects} />
          </div>
        </div>
        <Ring value={ringValue} size={108} stroke={10} tone={b.status === 'EXPIRED' || (b.daysLeft ?? 99) <= 3 ? 'coral' : (b.daysLeft ?? 99) <= 7 ? 'amber' : 'green'}>
          <span className="xb" style={{ fontSize: b.status === 'UNLIMITED' ? 26 : 24, lineHeight: 1 }}>{b.status === 'UNLIMITED' ? '∞' : b.daysLeft ?? 0}</span>
          <span style={{ fontSize: 10.5, opacity: 0.8 }}>{b.status === 'UNLIMITED' ? 'muddatsiz' : 'kun qoldi'}</span>
        </Ring>
      </div>

      {pending && (
        <div className="banner warn">
          <Icon name="clock" size={20} />
          <div>
            <b>{PLAN_NAME[pending.plan]} · {pending.months} oy</b> uchun to‘lov so‘rovi yuborilgan ({num(pending.amount)} so‘m). Menejerimiz siz bilan bog‘lanadi.
          </div>
        </div>
      )}

      <div className="row between wrap" style={{ gap: 10 }}>
        <div className="section-title">Tariflar</div>
        <div className="seg bl-dur">
          {DURATIONS.map((m) => {
            const pct = b.catalog[0]!.prices.find((p) => p.months === m)!.discountPct;
            return (
              <button key={m} className={months === m ? 'on' : ''} onClick={() => setMonths(m)}>
                {m} oy{pct ? <span className="bl-off">−{pct}%</span> : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="bl-plans">
        {b.catalog.map((p) => {
          const price = p.prices.find((x) => x.months === months)!;
          const current = b.plan === p.id && b.status !== 'EXPIRED';
          const popular = p.id === 'BUSINESS';
          return (
            <div key={p.id} className={`card bl-card ${popular ? 'popular' : ''} ${current ? 'current' : ''}`}>
              {popular && <span className="bl-flag">Mashhur</span>}
              {current && <span className="bl-flag cur">Joriy tarif</span>}
              <div className="stack" style={{ gap: 2 }}>
                <div className="bl-name">{p.name}</div>
                <div className="small muted">{p.tagline}</div>
              </div>
              <div className="stack" style={{ gap: 2 }}>
                <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                  <span className="bl-price">{num(price.perMonth)}</span>
                  <span className="small muted">so‘m / oy</span>
                </div>
                {price.discountPct > 0 ? (
                  <div className="xs">
                    <s className="faint">{num(p.monthly)}</s> · jami <b>{num(price.total)}</b> so‘m · <span style={{ color: 'var(--accent-ink)', fontWeight: 800 }}>{num(price.saved)} tejaysiz</span>
                  </div>
                ) : (
                  <div className="xs muted">har oy to‘lanadi</div>
                )}
              </div>
              <ul className="bl-feat">
                {p.features.map((f) => (
                  <li key={f}>
                    <Icon name="check" size={15} /> {f}
                  </li>
                ))}
              </ul>
              <button className={`btn block ${popular ? 'primary' : ''}`} onClick={() => setPick(p)}>
                {current ? 'Muddatni uzaytirish' : 'Tanlash'}
              </button>
            </div>
          );
        })}
      </div>

      <div className="grid desk-2" style={{ alignItems: 'start' }}>
        <div className="card stack" style={{ gap: 8 }}>
          <div className="section-title">To‘lovlar tarixi</div>
          {b.requests.length === 0 ? (
            <Empty icon="🧾" title="Hali to‘lov yo‘q" />
          ) : (
            <div className="list">
              {b.requests.map((r) => (
                <div key={r.id} className="row rep-li">
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="small b">{PLAN_NAME[r.plan]} · {r.months} oy{r.discountPct ? ` (−${r.discountPct}%)` : ''}</div>
                    <div className="xs muted">{dateUz(r.createdAt)}{r.paidUntil ? ` · ${dateUz(r.paidUntil)} gacha` : ''}{r.method ? ` · ${METHODS.find((m) => m[0] === r.method)?.[1] ?? r.method}` : ''}</div>
                  </div>
                  <div className="stack" style={{ gap: 2, alignItems: 'flex-end' }}>
                    <b className="small">{num(r.amount)}</b>
                    <span className={`tag ${REQ_LABEL[r.status][1]}`}>{REQ_LABEL[r.status][0]}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="card stack" style={{ gap: 10 }}>
          <div className="section-title">Savollar</div>
          <div className="stack" style={{ gap: 4 }}>
            <div className="small b">Qanday to‘layman?</div>
            <div className="small muted">Tarifni tanlab so‘rov yuboring — menejerimiz Payme, Click yoki bank orqali to‘lov havolasini yuboradi. Ilovada karta maʼlumotlari so‘ralmaydi.</div>
          </div>
          <div className="stack" style={{ gap: 4 }}>
            <div className="small b">Oldindan to‘lasam-chi?</div>
            <div className="small muted">3 oy — 10%, 6 oy — 20%, 12 oy — 30% chegirma. Qolgan kunlaringiz yo‘qolmaydi: yangi muddat ularga qo‘shiladi.</div>
          </div>
          <div className="stack" style={{ gap: 4 }}>
            <div className="small b">Limitdan oshsam nima bo‘ladi?</div>
            <div className="small muted">Ish to‘xtamaydi — ogohlantirish chiqadi va kattaroq tarifga o‘tishni taklif qilamiz.</div>
          </div>
        </div>
      </div>

      {b.platformAdmin && <PlatformPayments />}

      <Sheet open={!!pick} onClose={() => setPick(null)} title={pick ? `${pick.name} tarifi` : ''}>
        {pick && (
          <Checkout
            plan={pick}
            months={months}
            setMonths={setMonths}
            onDone={() => {
              setPick(null);
              toast('So‘rov yuborildi — tez orada bog‘lanamiz');
              void qc.invalidateQueries({ queryKey: ['billing'] });
            }}
            onError={fail}
          />
        )}
      </Sheet>
    </div>
  );
}

function Usage({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : null;
  const over = limit !== null && used > limit;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row between xs">
        <span style={{ opacity: 0.85 }}>{label}</span>
        <b>
          {used}
          {limit ? ` / ${limit}` : ' · cheksiz'}
        </b>
      </div>
      <div className="bl-track">
        <i style={{ width: `${pct ?? 100}%`, background: over ? '#FB7185' : pct !== null && pct >= 85 ? '#FBBF24' : 'rgba(255,255,255,.85)' }} />
      </div>
      {over && <span className="xs" style={{ color: '#FECDD3' }}>Limitdan oshgan — kattaroq tarifni tanlang</span>}
    </div>
  );
}

function Checkout({ plan, months, setMonths, onDone, onError }: { plan: CatalogPlan; months: number; setMonths: (m: number) => void; onDone: () => void; onError: (e: unknown) => void }) {
  const [method, setMethod] = useState('PAYME');
  const [contact, setContact] = useState('');
  const [note, setNote] = useState('');
  const price = plan.prices.find((p) => p.months === months)!;
  const send = useMutation({
    mutationFn: () => api('/billing/request', { method: 'POST', body: { plan: plan.id, months, method, contact: contact || undefined, note: note || undefined } }),
    onSuccess: onDone,
    onError,
  });
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="seg bl-dur">
        {DURATIONS.map((m) => (
          <button key={m} className={months === m ? 'on' : ''} onClick={() => setMonths(m)}>
            {m} oy
          </button>
        ))}
      </div>
      <div className="bl-sum">
        <div className="row between small"><span className="muted">Oylik narx</span><span>{num(price.monthly)} so‘m</span></div>
        <div className="row between small"><span className="muted">Muddat</span><span>{months} oy</span></div>
        {price.discountPct > 0 && (
          <div className="row between small"><span className="muted">Chegirma −{price.discountPct}%</span><span style={{ color: 'var(--accent-ink)', fontWeight: 800 }}>−{num(price.saved)} so‘m</span></div>
        )}
        <div className="row between" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          <b>Jami</b>
          <span className="xb" style={{ fontSize: 22 }}>{num(price.total)} so‘m</span>
        </div>
      </div>
      <div className="field">
        <span>To‘lov usuli</span>
        <div className="chips" style={{ flexWrap: 'wrap' }}>
          {METHODS.map(([k, label]) => (
            <button key={k} className={`chip ${method === k ? 'on' : ''}`} onClick={() => setMethod(k)}>{label}</button>
          ))}
        </div>
      </div>
      <Field label="Bog‘lanish uchun telefon (ixtiyoriy)">
        <input className="input" inputMode="tel" value={contact} onChange={(e) => setContact(e.target.value)} maxLength={60} placeholder="+998 __ ___ __ __" />
      </Field>
      <Field label="Izoh (ixtiyoriy)">
        <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Masalan: hisob-faktura kerak" />
      </Field>
      <div className="xs muted" style={{ lineHeight: 1.5 }}>
        So‘rovdan so‘ng menejerimiz to‘lov havolasini yuboradi. To‘lov tasdiqlangach tarif darhol yoqiladi. Ilova karta maʼlumotlarini so‘ramaydi va saqlamaydi.
      </div>
      <button className="btn primary block" disabled={send.isPending} onClick={() => send.mutate()}>
        {send.isPending ? 'Yuborilmoqda…' : 'To‘lov so‘rovini yuborish'}
      </button>
    </div>
  );
}

interface PendingRow {
  r: PaymentRequest & { contact: string | null; note: string | null };
  company: string;
}

function PlatformPayments() {
  const { fail, toast } = useApp();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['platform-payments'], queryFn: () => api<PendingRow[]>('/platform/payments') });
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: 'PAID' | 'CANCELLED' }) => api(`/platform/payments/${v.id}`, { method: 'POST', body: { decision: v.decision } }),
    onSuccess: (_d, v) => {
      toast(v.decision === 'PAID' ? 'To‘lov tasdiqlandi' : 'Bekor qilindi');
      void qc.invalidateQueries({ queryKey: ['platform-payments'] });
      void qc.invalidateQueries({ queryKey: ['billing'] });
    },
    onError: fail,
  });
  return (
    <div className="card stack" style={{ gap: 8 }}>
      <div className="row between">
        <div className="section-title">Platforma: kutilayotgan to‘lovlar</div>
        <span className="xs muted">faqat siz ko‘rasiz</span>
      </div>
      {(q.data ?? []).length === 0 && <div className="small muted">Kutilayotgan so‘rov yo‘q</div>}
      {(q.data ?? []).map(({ r, company }) => (
        <div key={r.id} className="row rep-li wrap" style={{ gap: 10 }}>
          <div className="grow" style={{ minWidth: 180 }}>
            <div className="small b">{company}</div>
            <div className="xs muted">
              {PLAN_NAME[r.plan]} · {r.months} oy · {num(r.amount)} so‘m{r.contact ? ` · ${r.contact}` : ''}{r.note ? ` · ${r.note}` : ''}
            </div>
          </div>
          <button className="btn sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, decision: 'CANCELLED' })}>Bekor</button>
          <button className="btn sm primary" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, decision: 'PAID' })}>To‘landi</button>
        </div>
      ))}
    </div>
  );
}
