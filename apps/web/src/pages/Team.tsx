import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { dateShort, ROLE } from '../lib/format';
import { useDepartments, useMembers } from '../lib/queries';
import type { Invitation, Member } from '../lib/types';
import { shareLink } from '../lib/tg';
import { Avatar, Empty, Field, Icon, Sheet, Skeleton } from '../ui/kit';
import { MemberProfile } from './MemberProfile';
import { go, useApp } from '../ui/state';

const RANK: Record<string, number> = { OWNER: 100, ADMIN: 90, HR: 70, FINANCE: 70, MARKETER: 50, PM: 50, DEPT_HEAD: 50, EMPLOYEE: 10 };

/** Roles the current user may hand out (mirrors the server rule; the server decides). */
export function grantableRoles(myRoles: string[]): string[] {
  if (myRoles.includes('OWNER')) return Object.keys(RANK);
  if (myRoles.every((r) => r === 'DEPT_HEAD' || r === 'EMPLOYEE')) return myRoles.includes('DEPT_HEAD') ? ['EMPLOYEE'] : [];
  const mine = Math.max(...myRoles.map((r) => RANK[r] ?? 0));
  return Object.keys(RANK).filter((r) => RANK[r]! < mine);
}

export function Team({ openId }: { openId?: string }) {
  const { can, session } = useApp();
  const members = useMembers();
  const deps = useDepartments();
  const [dep, setDep] = useState<string>('all');
  const [q, setQ] = useState('');
  const [inviting, setInviting] = useState(false);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (members.data ?? [])
      .filter((m) => dep === 'all' || (dep === 'none' ? !m.departmentId : m.departmentId === dep))
      .filter((m) => !needle || `${m.name} ${m.position ?? ''} ${m.username ?? ''}`.toLowerCase().includes(needle))
      .sort((a, b) => Number(a.status !== 'ACTIVE') - Number(b.status !== 'ACTIVE'));
  }, [members.data, dep, q]);

  if (openId) return <MemberProfile key={openId} userId={openId} />;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row between">
        <h1 className="page-title">Jamoa</h1>
        <span className="grow" />
        <button className="btn sm" onClick={() => go('team', session.user.id)}>
          <Avatar name={session.user.firstName} src={session.user.photoUrl} size={22} /> Mening profilim
        </button>
        {can('employee.manage') && (
          <button className="btn primary sm" onClick={() => setInviting(true)}>
            <Icon name="plus" size={16} /> Taklif qilish
          </button>
        )}
      </div>
      <input className="input" placeholder="Ism yoki lavozim…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="chips">
        <button className={`chip ${dep === 'all' ? 'on' : ''}`} onClick={() => setDep('all')}>
          Hammasi <span className="count">{members.data?.length ?? 0}</span>
        </button>
        {(deps.data ?? []).map((d) => (
          <button key={d.id} className={`chip ${dep === d.id ? 'on' : ''}`} onClick={() => setDep(d.id)}>
            {d.name} <span className="count">{d.memberCount}</span>
          </button>
        ))}
      </div>
      {members.isPending ? (
        <Skeleton h={56} n={6} />
      ) : list.length === 0 ? (
        <div className="card"><Empty icon="👥" title="Hech kim topilmadi" /></div>
      ) : (
        <div className="card list" style={{ padding: '4px 14px' }}>
          {list.map((m) => (
            <div key={m.userId} className="list-item" onClick={() => go('team', m.userId)} style={{ opacity: m.status === 'ACTIVE' ? 1 : 0.5 }}>
              <Avatar name={m.name} src={m.photoUrl} size={40} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="b ellipsis">{m.name}</div>
                <div className="small muted ellipsis">
                  {[m.position, m.department].filter(Boolean).join(' · ') || ROLE[m.roles[0] ?? ''] || '—'}
                </div>
              </div>
              {m.roles.some((r) => r !== 'EMPLOYEE') && <span className="xs b" style={{ color: 'var(--accent-ink)' }}>{ROLE[m.roles.find((r) => r !== 'EMPLOYEE')!]}</span>}
              <span className="faint"><Icon name="chevron" size={16} /></span>
            </div>
          ))}
        </div>
      )}
      <Sheet open={inviting} onClose={() => setInviting(false)} title="Jamoaga taklif">
        {inviting && <InviteForm />}
      </Sheet>
    </div>
  );
}

export function MemberEdit({ m, deps, onDone }: { m: Member; deps: Array<{ id: string; name: string }>; onDone: () => void }) {
  const { session, can, fail, toast } = useApp();
  const qc = useQueryClient();
  const hrEdit = can('employee.manage');
  const grantable = grantableRoles(session.ctx.roles);
  const [form, setForm] = useState({
    roles: m.roles,
    departmentId: m.departmentId ?? '',
    position: m.position ?? '',
    phone: m.phone ?? '',
    status: m.status,
    salary: m.salary ?? null,
  });
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {};
      if (hrEdit) Object.assign(body, { roles: form.roles, departmentId: form.departmentId || null, position: form.position || null, phone: form.phone || null, status: form.status });
      if (can('salary.manage') && form.salary !== (m.salary ?? null)) body.salary = form.salary;
      return api(`/members/${m.userId}`, { method: 'PATCH', body });
    },
    onSuccess: () => {
      toast('Saqlandi');
      void qc.invalidateQueries({ queryKey: ['members'] });
      onDone();
    },
    onError: fail,
  });
  const toggleRole = (r: string) => setForm((f) => ({ ...f, roles: f.roles.includes(r) ? f.roles.filter((x) => x !== r) : [...f.roles, r] }));

  return (
    <div className="card stack">
      {hrEdit && (
        <>
          <div className="field">
            <span>Rollar</span>
            <div className="chips" style={{ flexWrap: 'wrap' }}>
              {Object.keys(ROLE).map((r) => (
                <button key={r} type="button" disabled={!grantable.includes(r)} className={`chip ${form.roles.includes(r) ? 'on' : ''}`} style={!grantable.includes(r) ? { opacity: 0.4 } : undefined} onClick={() => toggleRole(r)}>
                  {ROLE[r]}
                </button>
              ))}
            </div>
          </div>
          <Field label="Bo‘lim">
            <select className="input" value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })}>
              <option value="">— Bo‘limsiz —</option>
              {deps.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </Field>
          <div className="grid grid-2">
            <Field label="Lavozim">
              <input className="input" value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} />
            </Field>
            <Field label="Telefon">
              <input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </Field>
          </div>
          <div className="seg">
            <button className={form.status === 'ACTIVE' ? 'on' : ''} onClick={() => setForm({ ...form, status: 'ACTIVE' })}>Faol</button>
            <button className={form.status === 'DISABLED' ? 'on' : ''} onClick={() => setForm({ ...form, status: 'DISABLED' })}>O‘chirilgan</button>
          </div>
        </>
      )}
      {can('salary.manage') && (
        <Field label="Oylik (so‘m)">
          <input className="input" type="number" min={0} value={form.salary ?? ''} onChange={(e) => setForm({ ...form, salary: e.target.value === '' ? null : Number(e.target.value) })} />
        </Field>
      )}
      <div className="row">
        <button className="btn grow" onClick={onDone}>Bekor</button>
        <button className="btn primary grow" disabled={save.isPending || form.roles.length === 0} onClick={() => save.mutate()}>Saqlash</button>
      </div>
    </div>
  );
}

function InviteForm() {
  const { session, fail, toast, can } = useApp();
  const qc = useQueryClient();
  const deps = useDepartments();
  const invites = useQuery({ queryKey: ['invitations'], queryFn: () => api<Invitation[]>('/invitations') });
  const grantable = grantableRoles(session.ctx.roles);
  const companyWide = can('employee.manage', 'COMPANY');
  const myDeps = (deps.data ?? []).filter((d) => companyWide || session.ctx.headOfDepartmentIds.includes(d.id));
  const [form, setForm] = useState({ role: 'EMPLOYEE', departmentId: companyWide ? '' : (myDeps[0]?.id ?? ''), position: '', maxUses: 1 });
  const [created, setCreated] = useState<Invitation | null>(null);

  const create = useMutation({
    mutationFn: () => api<Invitation>('/invitations', { method: 'POST', body: { ...form, departmentId: form.departmentId || myDeps[0]?.id || null, position: form.position || undefined } }),
    onSuccess: (inv) => {
      setCreated(inv);
      void qc.invalidateQueries({ queryKey: ['invitations'] });
    },
    onError: fail,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/invitations/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['invitations'] }),
    onError: fail,
  });
  const live = (invites.data ?? []).filter((i) => !i.revoked && i.uses < i.maxUses && new Date(i.expiresAt) > new Date());

  if (created) {
    return (
      <div className="stack">
        <div className="banner warn" style={{ background: 'color-mix(in srgb, var(--accent) 12%, transparent)', borderColor: 'color-mix(in srgb, var(--accent) 35%, transparent)' }}>
          ✅ Havola tayyor. Uni faqat kerakli odamga yuboring — {created.maxUses} marta ishlaydi, 7 kun amal qiladi.
        </div>
        <div className="card tight small" style={{ wordBreak: 'break-all' }}>{created.link}</div>
        <div className="row">
          <button className="btn grow" onClick={() => void navigator.clipboard?.writeText(created.link).then(() => toast('Nusxalandi'))}>
            <Icon name="link" size={16} /> Nusxa
          </button>
          <button className="btn primary grow" onClick={() => shareLink(created.link, `${session.ctx.company.name} jamoasiga qo‘shiling`)}>Telegramda yuborish</button>
        </div>
        <button className="btn ghost" onClick={() => setCreated(null)}>Yana taklif</button>
      </div>
    );
  }

  return (
    <div className="stack">
      <Field label="Rol">
        <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          {grantable.map((r) => (
            <option key={r} value={r}>{ROLE[r]}</option>
          ))}
        </select>
      </Field>
      <Field label="Bo‘lim">
        <select className="input" value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })}>
          {companyWide && <option value="">— Bo‘limsiz —</option>}
          {myDeps.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </Field>
      <div className="grid grid-2">
        <Field label="Lavozim (ixtiyoriy)">
          <input className="input" value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} placeholder="Grafik dizayner" />
        </Field>
        <Field label="Necha kishi">
          <input className="input" type="number" min={1} max={100} value={form.maxUses} onChange={(e) => setForm({ ...form, maxUses: Math.max(1, Number(e.target.value)) })} />
        </Field>
      </div>
      <button className="btn primary block" disabled={create.isPending || !grantable.length} onClick={() => create.mutate()}>Havola yaratish</button>

      {live.length > 0 && (
        <div className="stack" style={{ gap: 8, marginTop: 6 }}>
          <div className="section-title">Faol havolalar</div>
          {live.map((i) => (
            <div key={i.id} className="card tight row small">
              <div className="grow">
                <b>{ROLE[i.role]}</b> <span className="muted">· {i.uses}/{i.maxUses} · {dateShort(i.expiresAt)} gacha</span>
              </div>
              <button className="btn sm" onClick={() => shareLink(i.link, 'Jamoaga qo‘shiling')}>Yuborish</button>
              <button className="btn sm danger" onClick={() => revoke.mutate(i.id)}>Bekor</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
