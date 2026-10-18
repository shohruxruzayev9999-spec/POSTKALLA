import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { ROLE } from '../lib/format';
import { useDepartments } from '../lib/queries';
import type { JoinRequest, TgGroup } from '../lib/types';
import { grantableRoles } from '../pages/Team';
import { Avatar, Field } from './kit';
import { useApp } from './state';

/** People who pressed «POSTKALLA'ga qo'shilish» in a team group, waiting for approval. */
export function JoinRequests() {
  const q = useQuery({ queryKey: ['join-requests'], queryFn: () => api<JoinRequest[]>('/join-requests') });
  const [open, setOpen] = useState<string | null>(null);
  const list = q.data ?? [];
  if (!list.length) return null;
  return (
    <div className="card stack" style={{ gap: 10 }}>
      <div className="row">
        <div className="b">Kutilayotganlar</div>
        <span className="count" style={{ background: 'var(--danger)', color: '#fff', borderRadius: 9, padding: '0 7px', fontSize: 11, fontWeight: 700 }}>{list.length}</span>
      </div>
      {list.map((r) => (
        <div key={r.id} className="stack" style={{ gap: 8 }}>
          <div className="row" style={{ cursor: 'pointer' }} onClick={() => setOpen(open === r.id ? null : r.id)}>
            <Avatar name={r.name} src={r.photoUrl} size={36} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="b ellipsis">{r.name}</div>
              <div className="small muted ellipsis">{[r.username && `@${r.username}`, r.group && `«${r.group}» guruhi`].filter(Boolean).join(' · ')}</div>
            </div>
            <button className="btn sm primary" onClick={(e) => (e.stopPropagation(), setOpen(r.id))}>Ko‘rish</button>
          </div>
          {open === r.id && <Decide r={r} onDone={() => setOpen(null)} />}
        </div>
      ))}
    </div>
  );
}

function Decide({ r, onDone }: { r: JoinRequest; onDone: () => void }) {
  const { session, can, fail, toast } = useApp();
  const qc = useQueryClient();
  const deps = useDepartments();
  const companyWide = can('employee.manage', 'COMPANY');
  const myDeps = (deps.data ?? []).filter((d) => companyWide || session.ctx.headOfDepartmentIds.includes(d.id));
  const grantable = grantableRoles(session.ctx.roles);
  const [form, setForm] = useState({ departmentId: r.departmentId ?? (companyWide ? '' : (myDeps[0]?.id ?? '')), role: 'EMPLOYEE', position: '' });
  const done = (msg: string) => {
    toast(msg);
    void qc.invalidateQueries({ queryKey: ['join-requests'] });
    void qc.invalidateQueries({ queryKey: ['members'] });
    void qc.invalidateQueries({ queryKey: ['groups'] });
    onDone();
  };
  const approve = useMutation({
    mutationFn: () => api(`/join-requests/${r.id}/approve`, { method: 'POST', body: { departmentId: form.departmentId || null, role: form.role, position: form.position || null } }),
    onSuccess: () => done(`${r.name} jamoaga qo‘shildi`),
    onError: fail,
  });
  const reject = useMutation({
    mutationFn: () => api(`/join-requests/${r.id}/reject`, { method: 'POST' }),
    onSuccess: () => done('Rad etildi'),
    onError: fail,
  });
  return (
    <div className="stack" style={{ gap: 10, padding: 12, borderRadius: 14, background: 'var(--surface-2)' }}>
      <Field label="Bo‘lim">
        <select className="input" value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })}>
          {companyWide && <option value="">— Bo‘limsiz —</option>}
          {myDeps.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </Field>
      <div className="grid grid-2">
        <Field label="Rol">
          <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {grantable.map((x) => (
              <option key={x} value={x}>{ROLE[x] ?? x}</option>
            ))}
          </select>
        </Field>
        <Field label="Lavozim">
          <input className="input" placeholder="SMM menejer" value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} />
        </Field>
      </div>
      <div className="row">
        <button className="btn grow" disabled={reject.isPending} onClick={() => reject.mutate()}>Rad etish</button>
        <button className="btn primary grow" disabled={approve.isPending} onClick={() => approve.mutate()}>Tasdiqlash</button>
      </div>
    </div>
  );
}

/** Telegram groups the bot is in: team vs client, and the department newcomers land in. */
export function Groups() {
  const { can, session, fail } = useApp();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['groups'], queryFn: () => api<TgGroup[]>('/groups') });
  const deps = useDepartments();
  const companyWide = can('employee.manage', 'COMPANY');
  const myDeps = (deps.data ?? []).filter((d) => companyWide || session.ctx.headOfDepartmentIds.includes(d.id));
  const save = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api(`/groups/${id}`, { method: 'PATCH', body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['groups'] }),
    onError: fail,
  });
  const list = q.data ?? [];
  return (
    <div className="card stack" style={{ gap: 10 }}>
      <div className="b">Telegram guruhlar</div>
      {!list.length && (
        <div className="small muted">@postkallabot ni jamoa guruhiga qo‘shing: bot guruhga qo‘shilish tugmasini yozadi, a’zolar bosgach shu yerda tasdiqlaysiz.</div>
      )}
      {list.map((g) => (
        <div key={g.id} className="stack" style={{ gap: 8, paddingTop: 8, borderTop: '1px solid var(--line)' }}>
          <div className="row">
            <div className="grow b ellipsis">{g.title || 'Nomsiz guruh'}</div>
            {g.pending > 0 && <span className="xs b" style={{ color: 'var(--warn)' }}>{g.pending} kutmoqda</span>}
          </div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <div className="seg">
              <button className={g.kind === 'TEAM' ? 'on' : ''} onClick={() => save.mutate({ id: g.id, body: { kind: 'TEAM' } })}>Jamoa</button>
              <button className={g.kind === 'CLIENT' ? 'on' : ''} onClick={() => save.mutate({ id: g.id, body: { kind: 'CLIENT' } })}>Mijoz</button>
            </div>
            {g.kind === 'TEAM' && (
              <select className="input" style={{ width: 'auto', flex: 1, minWidth: 140 }} value={g.departmentId ?? ''} onChange={(e) => save.mutate({ id: g.id, body: { departmentId: e.target.value || null } })}>
                {companyWide && <option value="">Bo‘lim tanlanmagan</option>}
                {myDeps.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
