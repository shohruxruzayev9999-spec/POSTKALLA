import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { dateShort, money, ROLE } from '../lib/format';
import { useDepartments, useMembers } from '../lib/queries';
import type { Invitation, Member, Scores } from '../lib/types';
import { shareLink } from '../lib/tg';
import { Avatar, Empty, Field, Icon, Sheet, Skeleton } from '../ui/kit';
import { ScoresView } from '../ui/Scores';
import { go, useApp } from '../ui/state';

const RANK: Record<string, number> = { OWNER: 100, ADMIN: 90, HR: 70, FINANCE: 70, PM: 50, DEPT_HEAD: 50, EMPLOYEE: 10 };

/** Roles the current user may hand out (mirrors the server rule; the server decides). */
export function grantableRoles(myRoles: string[]): string[] {
  if (myRoles.includes('OWNER')) return Object.keys(RANK);
  if (myRoles.every((r) => r === 'DEPT_HEAD' || r === 'EMPLOYEE')) return myRoles.includes('DEPT_HEAD') ? ['EMPLOYEE'] : [];
  const mine = Math.max(...myRoles.map((r) => RANK[r] ?? 0));
  return Object.keys(RANK).filter((r) => RANK[r]! < mine);
}

export function Team({ openId }: { openId?: string }) {
  const { can } = useApp();
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

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row between">
        <h1 className="page-title">Jamoa</h1>
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
      <Sheet open={!!openId} onClose={() => go('team')} wide title="Hodim">
        {openId && <MemberView id={openId} />}
      </Sheet>
      <Sheet open={inviting} onClose={() => setInviting(false)} title="Jamoaga taklif">
        {inviting && <InviteForm />}
      </Sheet>
    </div>
  );
}

function MemberView({ id }: { id: string }) {
  const { session, can, fail, toast } = useApp();
  const qc = useQueryClient();
  const members = useMembers();
  const deps = useDepartments();
  const m = members.data?.find((x) => x.userId === id);
  const scores = useQuery({
    queryKey: ['scores', id],
    queryFn: () => api<Scores>(`/members/${id}/scores`),
    retry: (n, e) => !(e instanceof ApiError && e.status === 403) && n < 1,
  });
  const [edit, setEdit] = useState(false);
  const isSelf = id === session.user.id;
  const manageable = !isSelf && (can('employee.manage', 'COMPANY') || (can('employee.manage', 'DEPARTMENT') && !!m?.departmentId && session.ctx.headOfDepartmentIds.includes(m.departmentId)));
  const canRate = !isSelf && (can('kpi.rate', 'COMPANY') || (can('kpi.rate', 'DEPARTMENT') && !!m?.departmentId && session.ctx.headOfDepartmentIds.includes(m.departmentId)));

  const rate = useMutation({
    mutationFn: (rating: number) => api('/kpi/ratings', { method: 'POST', body: { userId: id, month: scores.data!.kpi.month, rating } }),
    onSuccess: () => {
      toast('Baho saqlandi');
      void qc.invalidateQueries({ queryKey: ['scores', id] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: fail,
  });

  if (!m) return <Skeleton h={80} n={3} />;
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row" style={{ gap: 14 }}>
        <Avatar name={m.name} src={m.photoUrl} size={56} />
        <div className="grow">
          <div className="xb" style={{ fontSize: 19 }}>{m.name}</div>
          <div className="small muted">{[m.position, m.department].filter(Boolean).join(' · ') || '—'}</div>
          <div className="xs" style={{ color: 'var(--accent-ink)', marginTop: 2 }}>{m.roles.map((r) => ROLE[r] ?? r).join(', ')}{m.status !== 'ACTIVE' ? ' · o‘chirilgan' : ''}</div>
        </div>
        {m.username && (
          <a className="btn icon-btn" href={`https://t.me/${m.username}`} aria-label="Telegram">
            <Icon name="chat" />
          </a>
        )}
      </div>

      <div className="grid grid-2">
        {m.phone && <div className="card tight"><div className="xs muted">Telefon</div><div className="b small">{m.phone}</div></div>}
        {m.salary !== undefined && <div className="card tight"><div className="xs muted">Oylik</div><div className="b small">{money(m.salary)}</div></div>}
        <div className="card tight"><div className="xs muted">Qo‘shilgan</div><div className="b small">{dateShort(m.joinedAt)}</div></div>
      </div>

      {scores.data && <ScoresView s={scores.data} />}

      {canRate && scores.data && (
        <div className="card stack">
          <div className="section-title">Rahbar bahosi · {scores.data.kpi.month}</div>
          <div className="row" style={{ gap: 8 }}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} className={`btn grow ${scores.data!.kpi.components.manager === n * 20 ? 'primary' : ''}`} disabled={rate.isPending} onClick={() => rate.mutate(n)}>
                {n}
              </button>
            ))}
          </div>
        </div>
      )}

      {manageable || (can('salary.manage') && !isSelf) ? (
        edit ? (
          <MemberEdit m={m} deps={deps.data ?? []} onDone={() => setEdit(false)} />
        ) : (
          <button className="btn" onClick={() => setEdit(true)}>Tahrirlash</button>
        )
      ) : null}
    </div>
  );
}

function MemberEdit({ m, deps, onDone }: { m: Member; deps: Array<{ id: string; name: string }>; onDone: () => void }) {
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
