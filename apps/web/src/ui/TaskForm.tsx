import { QUICK_DEADLINES, RECURRENCES, RECURRENCE_LABEL, localParts, quickDeadline, quickDeadlineLabel, zonedTime, type WorkSchedule } from '@retarget/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { FORMATS, PLATFORMS } from '../lib/format';
import { useMembers, useProjects } from '../lib/queries';
import type { TaskDetail } from '../lib/types';
import { Field } from './kit';
import { go, useApp } from './state';

export function toLocalInput(d: Date, tz: string) {
  const p = localParts(d, tz);
  const z = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${z(p.month)}-${z(p.day)}T${z(p.hour)}:${z(p.minute)}`;
}
export function fromLocalInput(v: string, tz: string): Date {
  const [date, hm] = v.split('T');
  const [y, m, d] = date!.split('-').map(Number) as [number, number, number];
  const [h, mi] = (hm ?? '18:00').split(':').map(Number) as [number, number];
  return zonedTime(y, m, d, h, mi, tz);
}

export function DeadlineEditor({ task, onDone }: { task: TaskDetail; onDone: () => void }) {
  const { session, fail, toast } = useApp();
  const tz = session.ctx.company.timezone;
  const qc = useQueryClient();
  const [value, setValue] = useState(toLocalInput(new Date(task.deadline), tz));
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () => api(`/tasks/${task.id}`, { method: 'PATCH', body: { deadline: fromLocalInput(value, tz).toISOString(), reason } }),
    onSuccess: () => {
      toast('Deadline yangilandi');
      void qc.invalidateQueries({ queryKey: ['task', task.id] });
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      onDone();
    },
    onError: fail,
  });
  return (
    <div className="card stack">
      <Field label="Yangi deadline">
        <input className="input" type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
      <Field label="Sabab" hint="Motivatsiya asl deadline bo‘yicha hisoblanadi.">
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Masalan: mijoz materialni kech berdi" />
      </Field>
      <div className="row">
        <button className="btn grow" onClick={onDone}>Bekor</button>
        <button className="btn primary grow" disabled={!reason.trim() || save.isPending} onClick={() => save.mutate()}>Saqlash</button>
      </div>
    </div>
  );
}

export function scheduleOf(c: { timezone: string; workDays?: number[]; workStart?: string; workEnd?: string; holidays?: string[] }): WorkSchedule {
  return { timezone: c.timezone, workDays: c.workDays ?? [1, 2, 3, 4, 5, 6], start: c.workStart ?? '10:00', end: c.workEnd ?? '18:00', holidays: c.holidays ?? [] };
}

/** "Bugun 18:00 · Ertaga 10:00 · …" under a deadline input (same buttons as the bot draft). */
export function QuickDeadlines({ schedule, onPick }: { schedule: WorkSchedule; onPick: (d: Date) => void }) {
  return (
    <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
      {QUICK_DEADLINES.map((q) => (
        <button key={q} type="button" className="chip" style={{ height: 28, fontSize: 12 }} onClick={() => onPick(quickDeadline(q, new Date(), schedule))}>
          {quickDeadlineLabel(q, schedule)}
        </button>
      ))}
    </div>
  );
}

function defaultDeadline(tz: string) {
  const now = new Date();
  const p = localParts(new Date(now.getTime() + 86_400_000), tz);
  return zonedTime(p.year, p.month, p.day, 18, 0, tz);
}

export function TaskForm({ onDone, projectId, assigneeUserId, columnId, departmentId, month, stayInProject = false }: { onDone: () => void; projectId?: string; assigneeUserId?: string; columnId?: string; departmentId?: string; month?: string; stayInProject?: boolean }) {
  const { session, fail, toast, can } = useApp();
  const tz = session.ctx.company.timezone;
  const qc = useQueryClient();
  const members = useMembers();
  const projects = useProjects();
  const onlySelf = !can('task.manage', 'COMPANY') && !can('task.manage', 'DEPARTMENT') && !can('task.manage', 'PROJECT');
  const [form, setForm] = useState({
    title: '',
    description: '',
    projectId: projectId ?? '',
    assigneeUserId: onlySelf ? session.user.id : (assigneeUserId ?? ''),
    isPrivate: false,
    format: '',
    platform: '',
    links: '',
    deadline: toLocalInput(month && month > toLocalInput(new Date(), tz).slice(0, 7) ? fromLocalInput(`${month}-01T18:00`, tz) : defaultDeadline(tz), tz),
    priority: 'MEDIUM',
    points: 1,
    recurrence: '',
  });
  const set = (k: keyof typeof form, v: string | number | boolean) => setForm((f) => ({ ...f, [k]: v }));
  const create = useMutation({
    mutationFn: () =>
      api<{ id: string }>('/tasks', {
        method: 'POST',
        body: {
          title: form.title,
          description: form.description || undefined,
          projectId: form.projectId || null,
          plannedMonth: month,
          assigneeUserId: form.assigneeUserId,
          deadline: fromLocalInput(form.deadline, tz).toISOString(),
          priority: form.priority,
          points: Number(form.points),
          isPrivate: form.isPrivate,
          format: form.format || null,
          platform: form.platform || null,
          links: form.links.split(/\s+/).map((l) => l.trim()).filter((l) => /^https?:\/\//.test(l)).slice(0, 5),
          columnId: columnId ?? null,
          departmentId: departmentId ?? undefined,
          recurrence: form.recurrence || null,
        },
      }),
    onSuccess: (t) => {
      toast('Vazifa yaratildi');
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: ['projects'] });
      onDone();
      if (!stayInProject) go('tasks', t.id);
    },
    onError: fail,
  });
  const active = (members.data ?? []).filter((m) => m.status === 'ACTIVE');
  const project = projects.data?.find((p) => p.id === form.projectId);
  const candidates = project ? active.filter((m) => project.memberUserIds.includes(m.userId)) : active;

  return (
    <div className="stack">
      <Field label="Nima qilish kerak?">
        <input className="input" autoFocus value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="Masalan: Oktabr aksiyasi uchun banner" maxLength={200} />
      </Field>
      <Field label="Loyiha">
        <select className="input" disabled={!!month} value={form.projectId} onChange={(e) => set('projectId', e.target.value)}>
          <option value="">— Loyihasiz —</option>
          {(projects.data ?? []).filter((p) => p.status === 'ACTIVE').map((p) => (
            <option key={p.id} value={p.id}>{p.name}{p.telegramChatId ? ' · 💬' : ''}</option>
          ))}
        </select>
      </Field>
      {!onlySelf && (
        <Field label="Ijrochi">
          <select className="input" value={form.assigneeUserId} onChange={(e) => set('assigneeUserId', e.target.value)}>
            <option value="">— Tanlang —</option>
            {candidates.map((m) => (
              <option key={m.userId} value={m.userId}>{m.name}{m.department ? ` · ${m.department}` : ''}</option>
            ))}
          </select>
        </Field>
      )}
      <div className="grid grid-2">
        <Field label="Deadline">
          <input className="input" type="datetime-local" value={form.deadline} onChange={(e) => set('deadline', e.target.value)} />
          {!month && <QuickDeadlines schedule={scheduleOf(session.ctx.company)} onPick={(d) => set('deadline', toLocalInput(d, tz))} />}
        </Field>
        <Field label="Muhimlik">
          <select className="input" value={form.priority} onChange={(e) => set('priority', e.target.value)}>
            <option value="HIGH">🔴 Yuqori</option>
            <option value="MEDIUM">🟡 O‘rta</option>
            <option value="LOW">🟢 Past</option>
          </select>
        </Field>
      </div>
      <div className="grid grid-2">
        <Field label="Format">
          <select className="input" value={form.format} onChange={(e) => set('format', e.target.value)}>
            <option value="">—</option>
            {FORMATS.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        </Field>
        <Field label="Platforma">
          <select className="input" value={form.platform} onChange={(e) => set('platform', e.target.value)}>
            <option value="">—</option>
            {PLATFORMS.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Izoh / TZ (ixtiyoriy)">
        <textarea className="input" value={form.description} onChange={(e) => set('description', e.target.value)} maxLength={4000} placeholder="Texnik topshiriq, havolalar, o‘lchamlar…" />
      </Field>
      <Field label="Havolalar (ixtiyoriy)" hint="Figma, Drive, referens — har birini yangi qatordan, 5 tagacha.">
        <textarea className="input" style={{ minHeight: 60 }} value={form.links} onChange={(e) => set('links', e.target.value)} placeholder="https://…" />
      </Field>
      <Field label="Takrorlanish" hint="Muddati kelganda yoki yopilganda keyingisi o‘zi yaratiladi.">
        <select className="input" value={form.recurrence} onChange={(e) => set('recurrence', e.target.value)}>
          <option value="">Takrorlanmaydi</option>
          {RECURRENCES.map((r) => (
            <option key={r} value={r}>🔁 {RECURRENCE_LABEL[r]}</option>
          ))}
        </select>
      </Field>
      <Field label="Ball (hajm)" hint="Oylik reja va KPI “hajm” ko‘rsatkichi uchun. Oddiy vazifa — 1.">
        <input className="input" type="number" min={1} max={20} value={form.points} onChange={(e) => set('points', Number(e.target.value))} />
      </Field>
      <label className="row small" style={{ gap: 10, cursor: 'pointer' }}>
        <input type="checkbox" checked={form.isPrivate} onChange={(e) => set('isPrivate', e.target.checked)} style={{ width: 18, height: 18, accentColor: 'var(--accent)' }} />
        <span>
          <b>1:1 (maxfiy)</b> <span className="muted">— faqat siz, ijrochi va CEO ko'radi; guruhga chiqmaydi</span>
        </span>
      </label>
      {project && !project.telegramChatId && <div className="xs muted">💡 Loyihaga Telegram guruh ulansa, vazifa guruhga tugmalari bilan tushadi.</div>}
      <button className="btn primary block" disabled={form.title.trim().length < 2 || !form.assigneeUserId || create.isPending} onClick={() => create.mutate()}>
        {create.isPending ? 'Yaratilmoqda…' : 'Vazifani berish'}
      </button>
    </div>
  );
}

