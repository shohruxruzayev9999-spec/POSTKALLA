import { useState } from 'react';
import { api } from '../lib/api';
import { TEMPLATE_LABEL } from '../lib/format';
import type { User } from '../lib/types';
import { Field, Ring } from '../ui/kit';

const PRESETS: Array<{ name: string; kpiTemplate: string }> = [
  { name: 'Dizayn', kpiTemplate: 'DESIGN' },
  { name: 'Video / montaj', kpiTemplate: 'VIDEO' },
  { name: 'SMM', kpiTemplate: 'SMM' },
  { name: 'Target', kpiTemplate: 'TARGET' },
  { name: 'Sotuv', kpiTemplate: 'SALES' },
  { name: 'Loyiha menejerlari', kpiTemplate: 'PM' },
];

export function Onboarding({ user, onCreated }: { user: User; onCreated: (companyId: string) => void }) {
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>(['Dizayn', 'Video / montaj', 'SMM', 'Target']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const c = await api<{ id: string }>('/companies', {
        method: 'POST',
        body: { name, departments: PRESETS.filter((p) => picked.includes(p.name)) },
      });
      onCreated(c.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="main" style={{ maxWidth: 520, paddingBottom: 40 }}>
      <div className="stack" style={{ gap: 18 }}>
        <div className="row" style={{ gap: 14, marginTop: 12 }}>
          <Ring value={25} size={64} stroke={8}>
            <span className="xb small">1/1</span>
          </Ring>
          <div>
            <div className="muted small">Xush kelibsiz, {user.firstName}</div>
            <h1 className="page-title">Kompaniyangizni yarating</h1>
          </div>
        </div>
        <p className="muted" style={{ margin: 0, lineHeight: 1.5 }}>
          Siz Owner (CEO) bo‘lasiz. Keyin hodimlarni havola orqali taklif qilasiz — har biri faqat o‘ziga ruxsat berilgan narsani ko‘radi.
          <br />
          Hodim sifatida qo‘shilmoqchi bo‘lsangiz, rahbaringizdan taklif havolasini so‘rang.
        </p>
        <div className="card stack">
          <Field label="Kompaniya nomi">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Masalan: Nova Agency" maxLength={80} autoFocus />
          </Field>
          <div className="field">
            <span>Bo‘limlar (KPI shabloni bilan)</span>
            <div className="chips wrap" style={{ flexWrap: 'wrap' }}>
              {PRESETS.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  className={`chip ${picked.includes(p.name) ? 'on' : ''}`}
                  onClick={() => setPicked((x) => (x.includes(p.name) ? x.filter((n) => n !== p.name) : [...x, p.name]))}
                  title={TEMPLATE_LABEL[p.kpiTemplate]}
                >
                  {p.name}
                </button>
              ))}
            </div>
            <small className="faint xs">Keyinroq Sozlamalarda o‘zgartirasiz.</small>
          </div>
          {error && <div className="banner danger">{error}</div>}
          <button className="btn primary block" disabled={busy || name.trim().length < 2} onClick={submit}>
            {busy ? 'Yaratilmoqda…' : 'Kompaniyani yaratish'}
          </button>
        </div>
      </div>
    </div>
  );
}
