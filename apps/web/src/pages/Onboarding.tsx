import { useState } from 'react';
import { api } from '../lib/api';
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
  const [custom, setCustom] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const c = await api<{ id: string }>('/companies', {
        method: 'POST',
        body: { name, departments: [...PRESETS.map((p) => p.name), ...custom].filter((n) => picked.includes(n)).map((n) => ({ name: n })) },
      });
      onCreated(c.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  // A department the agency names itself is stored exactly like a preset one.
  const addCustom = () => {
    const n = draft.trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!n) return;
    const existing = [...PRESETS.map((p) => p.name), ...custom].find((x) => x.toLowerCase() === n.toLowerCase());
    const label = existing ?? n;
    if (!existing) setCustom((c) => [...c, n]);
    setPicked((x) => (x.includes(label) || x.length >= 20 ? x : [...x, label]));
    setDraft('');
  };
  const all = [...PRESETS.map((p) => p.name), ...custom];

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
            <span>Bo‘limlar</span>
            <div className="chips wrap" style={{ flexWrap: 'wrap' }}>
              {all.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`chip ${picked.includes(n) ? 'on' : ''}`}
                  onClick={() => setPicked((x) => (x.includes(n) ? x.filter((y) => y !== n) : x.length >= 20 ? x : [...x, n]))}
                >
                  {n}
                </button>
              ))}
            </div>
            <div className="row" style={{ gap: 8 }}>
              <input
                className="input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addCustom())}
                placeholder="O‘z bo‘limingiz, masalan: Copywriting"
                maxLength={60}
              />
              <button type="button" className="btn sm" disabled={!draft.trim() || picked.length >= 20} onClick={addCustom}>
                + Qo‘shish
              </button>
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
