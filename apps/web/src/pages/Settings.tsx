import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { useDepartments, useMembers } from '../lib/queries';
import type { Company, Department } from '../lib/types';
import { getLocation } from '../lib/tg';
import { Empty, Field, Icon, Sheet } from '../ui/kit';
import { useApp } from '../ui/state';

const DAYS = ['Du', 'Se', 'Ch', 'Pa', 'Ju', 'Sh', 'Ya'];

export function Settings() {
  const { can } = useApp();
  return (
    <div className="stack" style={{ gap: 14 }}>
      <h1 className="page-title">Sozlamalar</h1>
      <div className="grid desk-2" style={{ alignItems: 'start' }}>
        {can('settings.company') ? <CompanyForm /> : <div />}
        <Departments />
      </div>
    </div>
  );
}

function CompanyForm() {
  const { session, fail, toast } = useApp();
  const qc = useQueryClient();
  const c = session.ctx.company;
  const policy = c.reminderPolicy as { overdueWorkingHours?: number[]; managerAfterWorkingHours?: number; ceoAfterWorkingHours?: number; skipManager?: boolean; skipDeptHead?: boolean };
  const [form, setForm] = useState({
    name: c.name,
    workDays: c.workDays,
    workStart: c.workStart,
    workEnd: c.workEnd,
    timezone: c.timezone,
    officeLat: c.officeLat,
    officeLng: c.officeLng,
    officeRadiusM: c.officeRadiusM,
    reminders: policy.overdueWorkingHours?.length ?? 3,
    managerAfter: policy.managerAfterWorkingHours ?? 1,
    ceoAfter: policy.ceoAfterWorkingHours ?? 1,
    skipManager: policy.skipManager ?? policy.skipDeptHead ?? false,
  });
  const save = useMutation({
    mutationFn: () =>
      api<Company>('/company', {
        method: 'PATCH',
        body: {
          name: form.name,
          workDays: form.workDays,
          workStart: form.workStart,
          workEnd: form.workEnd,
          timezone: form.timezone,
          officeLat: form.officeLat,
          officeLng: form.officeLng,
          officeRadiusM: form.officeRadiusM,
          reminderPolicy: { overdueWorkingHours: Array.from({ length: form.reminders }, (_, i) => i * 2), managerAfterWorkingHours: form.managerAfter, ceoAfterWorkingHours: form.ceoAfter, skipManager: form.skipManager },
        },
      }),
    onSuccess: () => {
      toast('Saqlandi');
      void qc.invalidateQueries({ queryKey: ['context'] });
    },
    onError: fail,
  });
  const locate = async () => {
    const l = await getLocation();
    if (!l) return toast('Joylashuvni olib bo‘lmadi', 'error');
    setForm((f) => ({ ...f, officeLat: l.lat, officeLng: l.lng }));
    toast('Ofis joylashuvi belgilandi — saqlashni unutmang');
  };
  const toggleDay = (d: number) => setForm((f) => ({ ...f, workDays: f.workDays.includes(d) ? f.workDays.filter((x) => x !== d) : [...f.workDays, d].sort() }));

  return (
    <div className="card stack">
      <div className="section-title">Kompaniya</div>
      <Field label="Nomi">
        <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <div className="field">
        <span>Ish kunlari</span>
        <div className="row" style={{ gap: 6 }}>
          {DAYS.map((d, i) => (
            <button key={d} type="button" className={`chip ${form.workDays.includes(i + 1) ? 'on' : ''}`} style={{ flex: 1, justifyContent: 'center', padding: 0 }} onClick={() => toggleDay(i + 1)}>
              {d}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-2">
        <Field label="Ish boshlanishi">
          <input className="input" type="time" value={form.workStart} onChange={(e) => setForm({ ...form, workStart: e.target.value })} />
        </Field>
        <Field label="Ish tugashi">
          <input className="input" type="time" value={form.workEnd} onChange={(e) => setForm({ ...form, workEnd: e.target.value })} />
        </Field>
      </div>
      <Field label="Vaqt zonasi" hint="Eslatmalar va kechikishlar faqat ish vaqtida hisoblanadi.">
        <input className="input" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
      </Field>

      <div className="section-title" style={{ marginTop: 6 }}>Davomat</div>
      <div className="row">
        <div className="grow small">
          {form.officeLat != null ? (
            <>📍 Ofis belgilangan · radius {form.officeRadiusM} m</>
          ) : (
            <span className="muted">Ofis joylashuvi yo‘q — “Keldim” joylashuvsiz ishlaydi.</span>
          )}
        </div>
        <button className="btn sm" onClick={locate}>
          <Icon name="pin" size={15} /> Shu yer
        </button>
        {form.officeLat != null && (
          <button className="btn sm ghost" onClick={() => setForm({ ...form, officeLat: null, officeLng: null })}>O‘chirish</button>
        )}
      </div>
      {form.officeLat != null && (
        <Field label="Radius (metr)">
          <input className="input" type="number" min={50} max={5000} value={form.officeRadiusM} onChange={(e) => setForm({ ...form, officeRadiusM: Number(e.target.value) })} />
        </Field>
      )}

      <div className="section-title" style={{ marginTop: 6 }}>Eslatmalar</div>
      <div className="small muted" style={{ lineHeight: 1.5 }}>
        Deadline’dan 24 va 2 soat oldin eslatiladi. Muddat o‘tgach har 2 ish soatida ijrochiga eslatma keladi (har yangisi eskisini o‘chiradi).
        Keyin loyiha menejeriga, holat o‘zgarmasa — CEO’ga xabar boradi.
      </div>
      <div className="grid grid-2">
        <Field label="Ijrochiga necha eslatma">
          <select className="input" value={form.reminders} onChange={(e) => setForm({ ...form, reminders: Number(e.target.value) })}>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>{n} ta</option>
            ))}
          </select>
        </Field>
        <Field label="CEO'ga (menejerdan keyin)">
          <select className="input" value={form.ceoAfter} onChange={(e) => setForm({ ...form, ceoAfter: Number(e.target.value) })}>
            {[1, 2, 3, 4, 8].map((n) => (
              <option key={n} value={n}>{n} ish soatida</option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Loyiha menejeriga (oxirgi eslatmadan keyin)">
        <select className="input" value={form.managerAfter} onChange={(e) => setForm({ ...form, managerAfter: Number(e.target.value) })}>
          {[0, 1, 2, 4].map((n) => (
            <option key={n} value={n}>{n === 0 ? 'darhol' : `${n} ish soatida`}</option>
          ))}
        </select>
      </Field>
      <div className="seg">
        <button className={!form.skipManager ? 'on' : ''} onClick={() => setForm({ ...form, skipManager: false })}>Menejer → CEO</button>
        <button className={form.skipManager ? 'on' : ''} onClick={() => setForm({ ...form, skipManager: true })}>To‘g‘ri CEO</button>
      </div>
      <button className="btn primary block" disabled={save.isPending || form.workDays.length === 0} onClick={() => save.mutate()}>Saqlash</button>
    </div>
  );
}

function Departments() {
  const { can, session } = useApp();
  const deps = useDepartments();
  const [editing, setEditing] = useState<Department | 'new' | null>(null);
  const list = (deps.data ?? []).filter((d) => can('settings.company') || session.ctx.headOfDepartmentIds.includes(d.id));
  return (
    <div className="card stack">
      <div className="row between">
        <div className="section-title">Bo‘limlar</div>
        {can('settings.company') && (
          <button className="btn sm" onClick={() => setEditing('new')}>
            <Icon name="plus" size={15} /> Bo‘lim
          </button>
        )}
      </div>
      {list.length === 0 ? (
        <Empty icon="🏢" title="Bo‘lim yo‘q" />
      ) : (
        <div className="list">
          {list.map((d) => (
            <div key={d.id} className="list-item" onClick={() => setEditing(d)}>
              <span style={{ width: 10, height: 10, borderRadius: 5, background: d.color }} />
              <div className="grow">
                <div className="b">{d.name}</div>
                <div className="xs muted">
                  {d.memberCount} kishi{d.requireFileOnSubmit ? ' · fayl majburiy' : ''}
                </div>
              </div>
              <Icon name="chevron" size={16} />
            </div>
          ))}
        </div>
      )}
      <Sheet open={!!editing} onClose={() => setEditing(null)} title={editing === 'new' ? 'Yangi bo‘lim' : 'Bo‘lim'}>
        {editing && <DepartmentForm dep={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />}
      </Sheet>
    </div>
  );
}

function DepartmentForm({ dep, onDone }: { dep: Department | null; onDone: () => void }) {
  const { can, fail, toast } = useApp();
  const qc = useQueryClient();
  const members = useMembers();
  const [form, setForm] = useState({
    name: dep?.name ?? '',
    headUserId: dep?.headUserId ?? '',
    requireFileOnSubmit: dep?.requireFileOnSubmit ?? false,
    section: dep?.section ?? '',
  });
  const company = can('settings.company');
  const save = useMutation({
    mutationFn: () => {
      const body = { name: form.name, requireFileOnSubmit: form.requireFileOnSubmit, ...(form.section ? { section: form.section } : {}), ...(company ? { headUserId: form.headUserId || null } : {}) };
      return dep ? api(`/departments/${dep.id}`, { method: 'PATCH', body }) : api('/departments', { method: 'POST', body });
    },
    onSuccess: () => {
      toast('Saqlandi');
      void qc.invalidateQueries({ queryKey: ['departments'] });
      void qc.invalidateQueries({ queryKey: ['members'] });
      onDone();
    },
    onError: fail,
  });
  return (
    <div className="stack">
      <Field label="Nomi">
        <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      {company && (
        <Field label="Bo‘lim boshlig‘i">
          <select className="input" value={form.headUserId} onChange={(e) => setForm({ ...form, headUserId: e.target.value })}>
            <option value="">— Tayinlanmagan —</option>
            {(members.data ?? []).filter((m) => m.status === 'ACTIVE').map((m) => (
              <option key={m.userId} value={m.userId}>{m.name}</option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Qaysi doskaga tushadi" hint="Dizayn va Media bo‘limlarining vazifalari o‘z sahifasida alohida doskada ko‘rinadi.">
        <select className="input" value={form.section} onChange={(e) => setForm({ ...form, section: e.target.value })}>
          {!dep && <option value="">Nomidan aniqlansin</option>}
          <option value="DESIGN">Dizayn</option>
          <option value="MEDIA">Media (video, montaj, syomka)</option>
          <option value="NONE">Boshqa</option>
        </select>
      </Field>
      <label className="row small" style={{ gap: 10, cursor: 'pointer' }}>
        <input type="checkbox" checked={form.requireFileOnSubmit} onChange={(e) => setForm({ ...form, requireFileOnSubmit: e.target.checked })} style={{ width: 18, height: 18, accentColor: 'var(--accent)' }} />
        Tekshiruvga yuborishda natija fayli majburiy
      </label>
      <button className="btn primary block" disabled={!form.name.trim() || save.isPending} onClick={() => save.mutate()}>Saqlash</button>
    </div>
  );
}
