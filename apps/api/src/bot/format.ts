import { localParts } from '@retarget/shared';
import type { ReminderStep } from '@retarget/shared';
import type { Person, TaskCard } from '../services/notifier.js';
import type { MyTaskLine, TaskDraft } from '../services/capture.js';

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

const WEEKDAY = ['', 'dushanba', 'seshanba', 'chorshanba', 'payshanba', 'juma', 'shanba', 'yakshanba'];

/** The draft shown after /task or a forward, before the author presses "Saqlash". */
export function draftText(d: TaskDraft, now = new Date()): string {
  const p = localParts(d.deadline, d.timezone);
  const lines = [
    '📝 <b>Vazifa qoralamasi</b>',
    '',
    `<b>${esc(d.title)}</b>`,
    d.description ? `<i>${esc(d.description.length > 300 ? `${d.description.slice(0, 300)}…` : d.description)}</i>` : null,
    '',
    `👤 ${esc(d.assigneeName)}`,
    `⏰ ${fmtDate(d.deadline, d.timezone)} (${WEEKDAY[p.weekday]})${d.deadlineSet ? '' : ' — avtomatik'}${d.deadline <= now ? '  <b>· o‘tib ketgan</b>' : ''}`,
    d.projectName ? `📁 ${esc(d.projectName)}` : null,
    d.companyOptions.length > 1 ? `🏢 ${esc(d.companyOptions.find((o) => o.id === d.companyId)?.name ?? '')}` : null,
    ...d.unknownMentions.map((u) => `⚠️ @${esc(u)} jamoada topilmadi — ijrochi: siz`),
    '',
    '<i>Tekshiring va «Saqlash»ni bosing. Muddatni pastdagi tugmalar bilan o‘zgartirish mumkin.</i>',
  ];
  return lines.filter((l) => l !== null).join('\n').replace(/\n{3,}/g, '\n\n');
}

/** /my and /due in a private chat. */
export function myTasksText(rows: MyTaskLine[], mode: 'my' | 'due', now = new Date()): string {
  const title = mode === 'my' ? '📋 <b>Mening ochiq vazifalarim</b>' : '⏰ <b>Muddati yaqin vazifalar</b> (48 soat ichida va o‘tganlar)';
  if (!rows.length) return `${title}\n\n${mode === 'my' ? 'Ochiq vazifa yo‘q 🎉' : 'Yaqin 48 soatda muddat yo‘q 👌'}`;
  const many = new Set(rows.map((r) => r.company)).size > 1;
  const shown = rows.slice(0, 20).map((r) => {
    const mark = r.overdue ? '🔴' : r.deadline.getTime() - now.getTime() < 24 * 3_600_000 ? '🟡' : '🟢';
    const extra = [r.toReview ? '👀 tekshirish' : null, r.status === 'RETURNED' ? '↩️ qaytarilgan' : null, many ? esc(r.company) : null].filter(Boolean).join(' · ');
    return `${mark} <b>#${r.number}</b> ${esc(r.title)}\n      ${fmtDate(r.deadline, r.timezone)}${r.overdue ? ' · <b>muddati o‘tdi</b>' : ''}${extra ? ` · ${extra}` : ''}`;
  });
  const more = rows.length > 20 ? `\n\n…yana ${rows.length - 20} ta — ilovada` : '';
  return `${title} — ${rows.length} ta\n\n${shown.join('\n')}${more}`;
}
