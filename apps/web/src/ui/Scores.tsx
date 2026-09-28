import { KPI_LABEL, monthName, STAGE } from '../lib/format';
import type { Scores } from '../lib/types';
import { Bar, Ring, scoreTone } from './kit';

export function ScoresView({ s }: { s: Scores }) {
  const k = s.kpi;
  const m = s.motivation;
  const comps = Object.entries(k.components).filter(([key]) => (k.weights[key] ?? 0) > 0 || k.components[key] != null);
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="grid grid-2">
        <div className="card stack" style={{ alignItems: 'center', gap: 8 }}>
          <Ring value={k.score} tone={scoreTone(k.score)} size={108} label={`KPI · ${monthName(k.month).split(' ')[0]}`} />
          <div className="xs muted" style={{ textAlign: 'center' }}>
            Bonus koeff.: <b style={{ color: 'var(--text)' }}>{k.bonus}</b>
            {k.toNextBand != null && k.toNextBand > 0 && <> · keyingi bosqichgacha {k.toNextBand} ball</>}
          </div>
        </div>
        <div className="card stack" style={{ alignItems: 'center', gap: 8 }}>
          <Ring value={m.score} tone={scoreTone(m.score)} size={108} label="motivatsiya" />
          <div className="xs muted" style={{ textAlign: 'center' }}>
            {m.stage ? <b style={{ color: 'var(--text)' }}>{STAGE[m.stage]}</b> : 'Ma’lumot yo‘q'} · 30 kun, deadline bo‘yicha
          </div>
        </div>
      </div>

      <div className="card stack" style={{ gap: 12 }}>
        <div className="row between">
          <div className="section-title">KPI tarkibi</div>
          <span className="xs muted">hamma uchun bir xil</span>
        </div>
        {comps.map(([key, v]) => (
          <div key={key}>
            <div className="row between small">
              <span className="muted">
                {KPI_LABEL[key] ?? key} <span className="faint">· {k.weights[key] ?? 0}%</span>
              </span>
              <span className="xb">{v == null ? '—' : Math.round(v)}</span>
            </div>
            <div style={{ marginTop: 4 }}>
              <Bar value={v} tone={v != null && v < 50 ? 'danger' : v != null && v < 70 ? 'warn' : undefined} />
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-2">
        <div className="card stat"><span className="v">{m.onTime}</span><span className="l">O‘z vaqtida</span></div>
        <div className="card stat"><span className="v" style={{ color: m.doneLate ? 'var(--warn)' : undefined }}>{m.doneLate}</span><span className="l">Kech topshirilgan</span></div>
        <div className="card stat"><span className="v" style={{ color: m.openOverdue ? 'var(--danger)' : undefined }}>{m.openOverdue}</span><span className="l">Hozir kechikkan</span></div>
        <div className="card stat"><span className="v">{s.counts.presentDays}/{s.counts.workDays}</span><span className="l">Ish kunlari · {s.counts.lateDays} kechikish</span></div>
      </div>
    </div>
  );
}
