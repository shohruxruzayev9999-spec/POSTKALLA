import { localParts } from '@retarget/shared';
import type { ReminderStep } from '@retarget/shared';
import type { Person, TaskCard } from '../services/notifier.js';

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const STATUS_LABEL: Record<string, string> = {
  NEW: '🆕 Yangi',
  IN_PROGRESS: '🔄 Jarayonda',
  REVIEW: '👀 Tekshiruvda',
  RETURNED: '↩️ Qaytarilgan',
  DONE: '✅ Bajarildi',
  BLOCKED: '⛔ Bloklangan',
  CANCELLED: '✖️ Bekor qilingan',
};

export const PRIORITY_LABEL: Record<string, string> = { HIGH: '🔴 Yuqori', MEDIUM: '🟡 O‘rta', LOW: '🟢 Past' };

const MONTHS = ['yan', 'fev', 'mar', 'apr', 'may', 'iyn', 'iyl', 'avg', 'sen', 'okt', 'noy', 'dek'];

export function fmtDate(d: Date, tz = 'Asia/Tashkent'): string {
  const p = localParts(d, tz);
  return `${p.day}-${MONTHS[p.month - 1]}, ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export function mention(p: Person): string {
  return p.username ? `@${esc(p.username)}` : `<a href="tg://user?id=${p.telegramId}">${esc(p.name)}</a>`;
}

export function cardText(c: TaskCard, now = new Date()): string {
  const overdue = !['DONE', 'CANCELLED'].includes(c.status) && c.deadline < now;
  const lines = [
    `<b>#${c.number} · ${esc(c.title)}</b>`,
    c.projectName ? `📁 ${esc(c.projectName)}` : null,
    `👤 ${mention(c.assignee)}${c.reviewer ? `  ·  🔎 ${esc(c.reviewer.name)}` : ''}`,
    `⏰ ${fmtDate(c.deadline)}${overdue ? '  <b>· MUDDATI O‘TDI</b>' : ''}`,
    `${STATUS_LABEL[c.status] ?? c.status}  ·  ${PRIORITY_LABEL[c.priority] ?? c.priority}${c.revision > 1 ? `  ·  R${c.revision}` : ''}`,
  ];
  return lines.filter(Boolean).join('\n');
}

export function reminderText(c: TaskCard, step: ReminderStep, tz?: string): string {
  const head = `<b>#${c.number} · ${esc(c.title)}</b>`;
  const who = mention(c.assignee);
  switch (true) {
    case step.key.startsWith('before-'):
      return `⏳ ${who}, eslatma: ${head}\nDeadline: <b>${fmtDate(c.deadline, tz)}</b>`;
    case step.escalation === 'CEO':
      return `🚨 <b>CEO diqqatiga</b>\n${head}\nIjrochi: ${who}\nDeadline ${fmtDate(c.deadline, tz)} edi — ${step.overdueCount} marta eslatildi, eskalatsiyadan keyin ham holat o‘zgarmadi.`;
    case step.escalation === 'MANAGER':
      return `⚠️ <b>Loyiha menejeri diqqatiga</b>\n${head}\nIjrochi: ${who}\nDeadline ${fmtDate(c.deadline, tz)} edi — ${step.overdueCount} marta eslatildi, hanuz yopilmagan. 1 ish soatida holat o‘zgarmasa, CEO’ga xabar beriladi.`;
    default:
      return `⏰ ${who}, ${head} muddati o‘tdi (${fmtDate(c.deadline, tz)}). ${step.overdueCount}-eslatma.`;
  }
}
