import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { dateShort } from '../lib/format';
import { useMembers, useProjects } from '../lib/queries';
import type { Project } from '../lib/types';
import { Empty, Field, Icon, Ring, Sheet, Skeleton } from '../ui/kit';
import { useApp } from '../ui/state';
import { TaskForm } from './Tasks';

const COLORS = ['#34D399', '#A3E635', '#14B8A6', '#60A5FA', '#A78BFA', '#F472B6', '#FB923C', '#FACC15'];
const FILTERS = [
  { key: 'ACTIVE', label: 'Faol' },
  { key: 'risk', label: 'Kechikkan' },
  { key: 'PAUSED', label: 'Pauza' },
  { key: 'DONE', label: 'Yakunlangan' },
];

export function Projects() {
  const { can } = useApp();
  const projects = useProjects();
  const [filter, setFilter] = useState('ACTIVE');
  const [editing, setEditing] = useState<Project | 'new' | null>(null);
  const [taskFor, setTaskFor] = useState<string | null>(null);
  const list = (projects.data ?? []).filter((p) => (filter === 'risk' ? p.status === 'ACTIVE' && p.taskOverdue > 0 : p.status === filter));

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row between">
        <h1 className="page-title">Loyihalar</h1>
        {can('client.manage', 'COMPANY') && (
          <button className="btn primary sm" onClick={() => setEditing('new')}>
            <Icon name="plus" size={16} /> Loyiha
          </button>
        )}
      </div>
      <div className="chips">
        {FILTERS.map((f) => (
          <button key={f.key} className={`chip ${filter === f.key ? 'on' : ''}`} onClick={() => setFilter(f.key)}>
            {f.label}{' '}
            <span className="count">
              {(projects.data ?? []).filter((p) => (f.key === 'risk' ? p.status === 'ACTIVE' && p.taskOverdue > 0 : p.status === f.key)).length}
            </span>
          </button>
        ))}
      </div>

      {projects.isPending ? (
        <Skeleton h={130} n={4} />
      ) : list.length === 0 ? (
        <div className="card">
          <Empty icon="📁" title="Loyiha yo‘q">
            {can('client.manage', 'COMPANY') ? 'Birinchi mijoz loyihasini qo‘shing va Telegram guruhini ulang.' : 'Sizni hali loyihaga qo‘shishmagan.'}
          </Empty>
        </div>
      ) : (
        <div className="grid grid-auto">
          {list.map((p) => (
            <ProjectCard key={p.id} p={p} onEdit={() => setEditing(p)} onTask={() => setTaskFor(p.id)} />
          ))}
        </div>
      )}

      <Sheet open={!!editing} onClose={() => setEditing(null)} title={editing === 'new' ? 'Yangi loyiha' : 'Loyiha'}>
        {editing && <ProjectForm project={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />}
      </Sheet>
      <Sheet open={!!taskFor} onClose={() => setTaskFor(null)} title="Yangi vazifa">
        {taskFor && <TaskForm projectId={taskFor} onDone={() => setTaskFor(null)} />}
      </Sheet>
    </div>
  );
}

function ProjectCard({ p, onEdit, onTask }: { p: Project; onEdit: () => void; onTask: () => void }) {
  const { can, session } = useApp();
  const manage = can('project.manage', 'COMPANY') || (can('project.manage', 'PROJECT') && session.ctx.projectIds.includes(p.id));
  return (
    <div className="card stack" style={{ gap: 12, position: 'relative', overflow: 'hidden' }}>
      <span style={{ position: 'absolute', inset: '0 0 auto 0', height: 3, background: p.color }} />
      <div className="row" style={{ gap: 14 }}>
        <Ring value={p.progress} size={62} stroke={7} tone={p.taskOverdue > 0 ? 'amber' : 'green'}>
          <span className="xb" style={{ fontSize: 14 }}>{p.progress}%</span>
        </Ring>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="xb ellipsis" style={{ fontSize: 16 }}>{p.name}</div>
          <div className="small muted ellipsis">{p.client ?? 'Ichki loyiha'}</div>
          <div className="xs" style={{ marginTop: 4, color: p.telegramChatId ? 'var(--accent-ink)' : 'var(--faint)' }}>
            <Icon name="chat" size={12} /> {p.telegramChatId ? p.telegramChatTitle || 'Guruh ulangan' : 'Guruh ulanmagan'}
          </div>
        </div>
      </div>
      <div className="row small" style={{ gap: 14 }}>
        <span><b>{p.taskDone}</b>/<span className="muted">{p.taskTotal}</span> bajarildi</span>
        {p.taskOverdue > 0 && <span className="b" style={{ color: 'var(--danger)' }}>{p.taskOverdue} kechikkan</span>}
        <span className="grow" />
        {p.deadline && <span className="muted">⏰ {dateShort(p.deadline)}</span>}
      </div>
      <div className="row" style={{ gap: 8 }}>
        {(manage || can('task.manage', 'COMPANY')) && (
          <button className="btn sm grow" onClick={onTask}>
            <Icon name="plus" size={15} /> Vazifa
          </button>
        )}
        {manage && (
          <button className="btn sm grow" onClick={onEdit}>
            Sozlash
          </button>
        )}
      </div>
    </div>
  );
}

function ProjectForm({ project, onDone }: { project: Project | null; onDone: () => void }) {
  const { fail, toast, can } = useApp();
  const qc = useQueryClient();
  const members = useMembers();
  const [form, setForm] = useState({
    name: project?.name ?? '',
    clientName: project?.client ?? '',
    color: project?.color ?? COLORS[0]!,
    status: project?.status ?? 'ACTIVE',
    managerUserId: project?.managerUserId ?? '',
    memberUserIds: project?.memberUserIds ?? [],
  });
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name,
        color: form.color,
        status: form.status,
        memberUserIds: form.memberUserIds,
        ...(can('client.manage', 'COMPANY') ? { managerUserId: form.managerUserId || null } : {}),
        ...(project ? {} : { clientName: form.clientName || undefined }),
      };
      return project ? api(`/projects/${project.id}`, { method: 'PATCH', body }) : api('/projects', { method: 'POST', body });
    },
    onSuccess: () => {
      toast(project ? 'Saqlandi' : 'Loyiha yaratildi');
      void qc.invalidateQueries({ queryKey: ['projects'] });
      onDone();
    },
    onError: fail,
  });
  const active = (members.data ?? []).filter((m) => m.status === 'ACTIVE');
  const toggle = (id: string) => setForm((f) => ({ ...f, memberUserIds: f.memberUserIds.includes(id) ? f.memberUserIds.filter((x) => x !== id) : [...f.memberUserIds, id] }));

  return (
    <div className="stack">
      <Field label="Loyiha nomi">
        <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Masalan: Kafe Bahor — SMM" />
      </Field>
      {!project && (
        <Field label="Mijoz">
          <input className="input" value={form.clientName} onChange={(e) => setForm({ ...form, clientName: e.target.value })} placeholder="Mijoz kompaniyasi" />
        </Field>
      )}
      {can('client.manage', 'COMPANY') && (
        <Field label="Loyiha menejeri (tekshiruvchi)">
          <select className="input" value={form.managerUserId} onChange={(e) => setForm({ ...form, managerUserId: e.target.value })}>
            <option value="">— O‘zim —</option>
            {active.map((m) => (
              <option key={m.userId} value={m.userId}>{m.name}</option>
            ))}
          </select>
        </Field>
      )}
      <div className="field">
        <span>Jamoa</span>
        <div className="chips" style={{ flexWrap: 'wrap' }}>
          {active.map((m) => (
            <button key={m.userId} type="button" className={`chip ${form.memberUserIds.includes(m.userId) ? 'on' : ''}`} onClick={() => toggle(m.userId)}>
              {m.name}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span>Rang</span>
        <div className="row" style={{ gap: 8 }}>
          {COLORS.map((c) => (
            <button key={c} type="button" aria-label={c} onClick={() => setForm({ ...form, color: c })} style={{ width: 30, height: 30, borderRadius: 15, background: c, border: form.color === c ? '3px solid var(--text)' : '0', cursor: 'pointer' }} />
          ))}
        </div>
      </div>
      {project && (
        <div className="seg">
          {[
            ['ACTIVE', 'Faol'],
            ['PAUSED', 'Pauza'],
            ['DONE', 'Yakunlandi'],
          ].map(([k, l]) => (
            <button key={k} className={form.status === k ? 'on' : ''} onClick={() => setForm({ ...form, status: k! })}>{l}</button>
          ))}
        </div>
      )}
      {project && (
        <div className="card tight small" style={{ lineHeight: 1.5 }}>
          <b>Telegram guruhini ulash:</b> botni loyiha guruhiga admin qilib qo‘shing va guruhda <code>/bind</code> yozing, so‘ng shu loyihani tanlang.
          {project.telegramChatTitle && <div className="muted">Hozir ulangan: {project.telegramChatTitle}</div>}
        </div>
      )}
      <button className="btn primary block" disabled={form.name.trim().length < 1 || save.isPending} onClick={() => save.mutate()}>
        {project ? 'Saqlash' : 'Yaratish'}
      </button>
    </div>
  );
}
