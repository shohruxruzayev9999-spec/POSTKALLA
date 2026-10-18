import { localParts } from '@retarget/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { useMembers, useProjects } from '../lib/queries';
import type { BoardColumn, TaskListItem } from '../lib/types';
import { Board } from '../ui/Board';
import { Empty, Field, Ring, Sheet, Skeleton } from '../ui/kit';
import { go, useApp } from '../ui/state';
import { TaskForm } from '../ui/TaskForm';
import { TaskView } from '../ui/TaskView';
import { ProjectForm } from './Projects';
import { STATUS, when } from '../lib/format';

type Period = { month: string; archived: boolean };
type MonthBoard = Period & { tasks: TaskListItem[]; columns: BoardColumn[] };
const MONTHS = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'];
const label = (m: string) => `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;
const following = (m: string) => Number(m.slice(5)) === 12 ? `${Number(m.slice(0, 4)) + 1}-01` : `${m.slice(0, 4)}-${String(Number(m.slice(5)) + 1).padStart(2, '0')}`;

export function ProjectDetail({ id }: { id: string }) {
  const { session, fail, toast } = useApp();
  const qc = useQueryClient();
  const projects = useProjects();
  const members = useMembers();
  const now = localParts(new Date(), session.ctx.company.timezone);
  const current = `${now.year}-${String(now.month).padStart(2, '0')}`;
  const [month, setMonth] = useState(current);
  const [newMonth, setNewMonth] = useState(following(current));
  const [addingMonth, setAddingMonth] = useState(false);
  const [editing, setEditing] = useState(false);
  const [addingTask, setAddingTask] = useState(false);
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [assignee, setAssignee] = useState('');
  const [filter, setFilter] = useState('all');
  const periods = useQuery({ queryKey: ['project-months', id], queryFn: () => api<Period[]>(`/projects/${id}/months`) });
  const data = useQuery({ queryKey: ['tasks', 'project-month', id, month], queryFn: () => api<MonthBoard>(`/projects/${id}/months/${month}`), enabled: !!periods.data });
  const p = projects.data?.find(x => x.id === id);
  const manage = session.ctx.roles.some(r => ['OWNER', 'ADMIN'].includes(r)) || p?.managerUserId === session.user.id;
  const admin = session.ctx.roles.some(r => ['OWNER', 'ADMIN'].includes(r));
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['project-months', id] }); void qc.invalidateQueries({ queryKey: ['tasks'] }); };
  const createMonth = useMutation({ mutationFn: () => api(`/projects/${id}/months`, { method: 'POST', body: { month: newMonth } }), onSuccess: () => { setMonth(newMonth); setAddingMonth(false); refresh(); toast('Oy tayyor'); }, onError: fail });
  const deleteMonth = useMutation({ mutationFn: () => api(`/projects/${id}/months/${month}`, { method: 'DELETE' }), onSuccess: () => { setDeleting(false); setMonth(current); refresh(); toast('Oy arxivi o‘chirildi'); }, onError: fail });
  if (projects.isPending) return <Skeleton h={120} n={3} />;
  if (!p) return <Empty icon="📁" title="Loyiha topilmadi" />;
  const all = data.data?.tasks ?? [];
  const live = all.filter(t => t.status !== 'CANCELLED');
  const done = live.filter(t => t.status === 'DONE').length;
  const overdue = live.filter(t => t.overdue).length;
  const progress = live.length ? Math.round(done * 100 / live.length) : 0;
  const archived = data.data?.archived ?? month < current;
  const list = all.filter(t => (!assignee || t.assigneeUserId === assignee) && (filter === 'all' || (filter === 'overdue' ? t.overdue : t.status === 'DONE')));
  const selected = all.find(t => t.id === openTask);
  const manager = members.data?.find(m => m.userId === p.managerUserId);
  return <div className="stack project-detail">
    <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => go('projects')}>‹ Loyihalar</button>
    <section className="card project-header" style={{ borderTop: `3px solid ${p.color}` }}>
      <div className="row between wrap">
        <div className="row" style={{ gap: 14 }}><span title={`${label(month)} bajarilishi`}><Ring value={progress} size={52} stroke={5}><span className="xs b">{progress}%</span></Ring></span><div><div className="row wrap"><h1 className="page-title">{p.name}</h1><span className="tag">{({ ACTIVE: 'Faol', PAUSED: 'Pauzada', DONE: 'Yakunlangan' } as Record<string, string>)[p.status]}</span></div><p className="small muted">{p.client ?? 'Ichki loyiha'} · Mas’ul: {manager?.name ?? 'Belgilanmagan'}</p></div></div>
        <div className="row wrap">{manage && <button className="btn sm" onClick={() => setEditing(true)}>Loyihani tahrirlash</button>}<button className="btn sm" onClick={() => go('reports', id)}>Hisobot</button></div>
      </div>
      <div className="project-stats">
        <div><span className="small muted">Jami vazifalar</span><strong>{data.isPending ? '—' : live.length}</strong></div>
        <div><span className="small muted">Bajarilgan</span><strong style={{ color: 'var(--accent)' }}>{data.isPending ? '—' : done}</strong></div>
        <div><span className="small muted">Kechikkan</span><strong style={{ color: 'var(--danger)' }}>{data.isPending ? '—' : overdue}</strong></div>
      </div>
    </section>
    <div className="row between wrap"><div className="row wrap"><h2 className="section-title">Vazifalar</h2><select aria-label="Loyiha oyi" className="input" style={{ width: 'auto' }} value={month} onChange={e => { setMonth(e.target.value); setOpenTask(null); }}>{(periods.data ?? [{ month: current, archived: false }]).map(m => <option key={m.month} value={m.month}>{label(m.month)}{m.archived ? ' · Arxiv' : m.month > current ? ' · Reja' : ' · Joriy oy'}</option>)}</select>{manage && <button className="btn sm" onClick={() => setAddingMonth(true)}>+ Yangi oy</button>}</div>{!archived && <button className="btn primary sm" onClick={() => setAddingTask(true)}>+ Vazifa</button>}</div>
    {archived ? <div className="banner"><div className="grow"><b>Oy arxivi</b><div className="small muted">Oy yakunidagi holat. Tugallanmagan vazifalar keyingi oyda davom etadi.</div></div>{admin && <button className="btn danger sm" onClick={() => setDeleting(true)}>Arxivni o‘chirish</button>}</div> : month > current ? <div className="banner"><span>Kelgusi oy rejasi — vazifalarni oldindan tayyorlashingiz mumkin.</span></div> : null}
    <div className="row between wrap"><div className="chips">{[['all', 'Barchasi'], ['overdue', 'Kechikkan'], ['done', 'Bajarilgan']].map(([k, text]) => <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k!)}>{text}</button>)}</div><select aria-label="Mas’ul bo‘yicha filtr" className="input" style={{ width: 'auto', maxWidth: '100%' }} value={assignee} onChange={e => setAssignee(e.target.value)}><option value="">Barcha ijrochilar</option>{members.data?.map(m => <option key={m.userId} value={m.userId}>{m.name}</option>)}</select></div>
    {periods.isError ? <div className="card"><p>Oylar yuklanmadi.</p><button className="btn" onClick={() => { void periods.refetch(); }}>Qayta urinish</button></div> : data.isPending ? <Skeleton h={280} /> : data.isError || periods.isError ? <div className="card"><Empty icon="⚠" title="Vazifalar yuklanmadi" /><button className="btn" onClick={() => { void periods.refetch(); void data.refetch(); }}>Qayta urinish</button></div> : <><Board board="main" tasks={list} projectId={id} month={month} readOnly={archived} columns={archived ? data.data.columns : undefined} onOpenTask={setOpenTask} />{!list.length && <div className="small muted">{all.length ? 'Tanlangan filtrga mos vazifa yo‘q.' : 'Bu oyda hali vazifa yo‘q.'}</div>}</>}
    <Sheet open={editing} onClose={() => setEditing(false)} title="Loyihani tahrirlash"><ProjectForm key={p.id + p.managerUserId} project={p} onDone={() => setEditing(false)} /></Sheet>
    <Sheet open={addingTask} onClose={() => setAddingTask(false)} title={`${label(month)} — yangi vazifa`}>{addingTask && <TaskForm projectId={id} month={month} stayInProject onDone={() => setAddingTask(false)} />}</Sheet>
    <Sheet open={addingMonth} onClose={() => setAddingMonth(false)} title="Yangi oy"><div className="stack"><Field label="Rejalashtirish oyi"><input className="input" type="month" min={current} value={newMonth} onChange={e => setNewMonth(e.target.value)} /></Field><p className="small muted">Mavjud Kanban ustunlari saqlanadi. Yangi oyga vazifalar qo‘shishingiz mumkin.</p><button className="btn primary" disabled={!newMonth || newMonth < current || createMonth.isPending} onClick={() => createMonth.mutate()}>Oyni ochish</button></div></Sheet>
    <Sheet open={deleting} onClose={() => setDeleting(false)} title="Oy arxivini o‘chirish"><div className="stack"><p>{label(month)} arxivi butunlay o‘chiriladi. Joriy oydagi vazifalar va ularning tarixi saqlanadi.</p><button className="btn danger" disabled={deleteMonth.isPending} onClick={() => deleteMonth.mutate()}>Ha, arxivni o‘chirish</button><button className="btn" onClick={() => setDeleting(false)}>Bekor qilish</button></div></Sheet>
    <Sheet open={!!openTask} onClose={() => setOpenTask(null)} title={archived ? 'Arxivdagi vazifa' : 'Vazifa'}>{openTask && (archived && selected ? <div className="stack"><h2>{selected.title}</h2><p>{STATUS[selected.status]} · {selected.assignee.name}</p><p className="small muted">Muddat: {when(selected.deadline, session.ctx.company.timezone)}</p><p className="small muted">Bu ma’lumotlar {label(month)} yakunidagi holatni ko‘rsatadi.</p></div> : <TaskView key={openTask} id={openTask} />)}</Sheet>
  </div>;
}
