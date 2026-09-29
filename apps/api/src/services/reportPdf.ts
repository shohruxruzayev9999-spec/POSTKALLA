import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fontkit from 'fontkit';
import PDFDocument from 'pdfkit';
import { localParts } from '@retarget/shared';
import type { ReportData } from './reports.js';

const FONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/fonts');
const FONTS = {
  regular: path.join(FONT_DIR, 'Manrope-Regular.ttf'),
  bold: path.join(FONT_DIR, 'Manrope-Bold.ttf'),
  heavy: path.join(FONT_DIR, 'Manrope-ExtraBold.ttf'),
};

let glyphs: fontkit.Font | null = null;
const SUBST: Record<string, string> = { 'ʻ': '‘', 'ʼ': '’', 'қ': 'к', 'Қ': 'К', 'ғ': 'г', 'Ғ': 'Г', 'ҳ': 'х', 'Ҳ': 'Х', '\t': ' ' };

/** Text the embedded font can draw: Uzbek apostrophes normalised, emoji and unknown symbols dropped. */
export function pdfText(s: string): string {
  glyphs ??= fontkit.openSync(FONTS.regular) as fontkit.Font;
  let out = '';
  for (const ch of s) {
    const c = SUBST[ch] ?? ch;
    if (c === '\n' || glyphs.hasGlyphForCodePoint(c.codePointAt(0)!)) out += c;
  }
  return out.replace(/[  ]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

const C = {
  ink: '#0F172A',
  text: '#1F2937',
  muted: '#6B7280',
  faint: '#9CA3AF',
  line: '#E5E7EB',
  soft: '#F3F5F4',
  brand: '#1FA372',
  brandDark: '#0B3D2E',
  danger: '#DC2626',
  warn: '#D97706',
  info: '#2F6FEB',
  review: '#7C3AED',
};
const STATUS: Record<string, [string, string]> = {
  NEW: ['Yangi', '#9CA3AF'],
  IN_PROGRESS: ['Jarayonda', '#3B82F6'],
  REVIEW: ['Tekshiruvda', '#8B5CF6'],
  RETURNED: ['Qaytarilgan', '#F59E0B'],
  BLOCKED: ['Bloklangan', '#EF4444'],
  DONE: ['Bajarildi', '#1FA372'],
};
const SHOOT_STATUS: Record<string, string> = { PLANNING: 'Reja', SCHEDULED: 'Belgilangan', CONFIRMED: 'Tasdiqlangan', DONE: 'O‘tkazildi' };
const MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
const MON = ['yan', 'fev', 'mar', 'apr', 'may', 'iyn', 'iyl', 'avg', 'sen', 'okt', 'noy', 'dek'];

const num = (n: number) => n.toLocaleString('ru-RU').replace(/ /g, ' ');
function periodLabel(from: string, to: string) {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  if (fy === ty && fm === tm) return fd === td ? `${fd}-${MONTHS[fm - 1]} ${fy}` : `${fd}–${td} ${MONTHS[fm - 1]} ${fy}`;
  if (fy === ty) return `${fd}-${MONTHS[fm - 1]} – ${td}-${MONTHS[tm - 1]} ${fy}`;
  return `${fd}.${String(fm).padStart(2, '0')}.${fy} – ${td}.${String(tm).padStart(2, '0')}.${ty}`;
}
function dt(iso: string, tz: string, time = true) {
  const p = localParts(new Date(iso), tz);
  return `${p.day}-${MON[p.month - 1]}${time ? `, ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}` : ''}`;
}
const dayShort = (d: string) => {
  const [, m, dd] = d.split('-').map(Number) as [number, number, number];
  return `${dd}-${MON[m - 1]}`;
};

export function reportFileName(d: ReportData) {
  const base = (d.project?.name ?? d.company)
    .toLowerCase()
    .replace(/[ʻʼ‘’'`]/g, '')
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `hisobot-${base || 'loyiha'}-${d.period.from}_${d.period.to}.pdf`;
}

type Col = { label: string; width: number; align?: 'left' | 'right' | 'center' };
type Cell = string | { text: string; color?: string; bold?: boolean };

/** A4 report: header band, KPI tiles, conclusions, tasks, people, shoots, Telegram group, money. */
export async function renderReportPdf(d: ReportData): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 50, left: 40, right: 40 }, bufferPages: true, info: { Title: `Hisobot — ${pdfText(d.project?.name ?? d.company)}`, Author: 'Retarget ERP' } });
  doc.registerFont('r', FONTS.regular);
  doc.registerFont('b', FONTS.bold);
  doc.registerFont('h', FONTS.heavy);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const ensure = (h: number) => {
    if (doc.y + h > bottom()) doc.addPage();
  };
  const tz = d.timezone;

  // ---------------------------------------------------------------- header band
  const H = 132;
  const grad = doc.linearGradient(0, 0, doc.page.width, H);
  grad.stop(0, C.brandDark).stop(1, C.brand);
  doc.rect(0, 0, doc.page.width, H).fill(grad);
  doc.fillColor('#FFFFFF').opacity(0.75).font('b').fontSize(8.5).text(d.scope === 'PROJECT' ? 'LOYIHA HISOBOTI' : 'KOMPANIYA HISOBOTI', L, 34, { characterSpacing: 1.6 });
  doc.opacity(1).font('h').fontSize(23).text(pdfText(d.project?.name ?? d.company), L, 50, { width: W - 150, lineBreak: false, ellipsis: true });
  const sub = d.project ? [d.project.client && `Mijoz: ${d.project.client}`, d.project.manager && `Menejer: ${d.project.manager}`].filter(Boolean).join('   ·   ') : 'Barcha loyihalar';
  doc.font('r').fontSize(10).opacity(0.85).text(pdfText(sub), L, 84, { width: W - 150 });
  doc.opacity(1).font('b').fontSize(10).text(periodLabel(d.period.from, d.period.to), L, 34, { width: W, align: 'right' });
  doc.font('r').fontSize(8.5).opacity(0.75).text(pdfText(d.company), L, 50, { width: W, align: 'right' });
  doc.text(`Tuzildi: ${dt(d.generatedAt, tz)}`, L, 63, { width: W, align: 'right' });
  doc.opacity(1);
  doc.y = H + 22;

  // ---------------------------------------------------------------- KPI tiles
  const s = d.summary;
  const tiles: Array<[string, string, string]> = [
    [String(s.done), 'Bajarildi', C.ink],
    [s.onTimePct === null ? '—' : `${s.onTimePct}%`, 'Muddatida', s.onTimePct !== null && s.onTimePct < 70 ? C.warn : C.brand],
    [String(s.overdue), 'Muddati o‘tgan', s.overdue ? C.danger : C.ink],
    [d.scope === 'PROJECT' ? String(s.messages) : String(d.projects.length), d.scope === 'PROJECT' ? 'Guruh xabarlari' : 'Faol loyihalar', C.ink],
  ];
  const gap = 10;
  const tw = (W - gap * 3) / 4;
  const ty = doc.y;
  tiles.forEach(([v, label, color], i) => {
    const x = L + i * (tw + gap);
    doc.roundedRect(x, ty, tw, 62, 10).fill(C.soft);
    doc.fillColor(color).font('h').fontSize(21).text(v, x + 12, ty + 11, { width: tw - 24, lineBreak: false });
    doc.fillColor(C.muted).font('b').fontSize(8.5).text(label, x + 12, ty + 41, { width: tw - 24, lineBreak: false });
  });
  doc.y = ty + 62 + 8;
  doc.fillColor(C.faint).font('r').fontSize(8).text(
    `Yangi: ${s.created}   ·   Ochiq: ${s.open}   ·   Qayta ishlangan: ${s.returned}   ·   Ball: ${s.points}   ·   Syomka: ${s.shoots}${d.scope === 'PROJECT' ? '' : `   ·   Xabarlar: ${s.messages}`}`,
    L,
    doc.y,
    { width: W },
  );
  doc.moveDown(1.2);

  const section = (title: string, need = 70) => {
    ensure(need);
    doc.moveDown(0.4);
    const y = doc.y;
    doc.roundedRect(L, y + 2, 4, 13, 2).fill(C.brand);
    doc.fillColor(C.ink).font('h').fontSize(12.5).text(title, L + 12, y, { width: W - 12 });
    doc.moveDown(0.45);
  };

  const bulletList = (items: string[], color: string) => {
    for (const t of items) {
      const text = pdfText(t);
      doc.font('r').fontSize(9.5);
      const h = doc.heightOfString(text, { width: W - 16, lineGap: 1.5 });
      ensure(h + 6);
      const y = doc.y;
      doc.circle(L + 3, y + 6, 2.3).fill(color);
      doc.fillColor(C.text).text(text, L + 14, y, { width: W - 16, lineGap: 1.5 });
      doc.y += 4;
    }
  };

  const table = (cols: Col[], rows: Cell[][], empty = 'Maʼlumot yo‘q') => {
    const pad = 6;
    const header = () => {
      const y = doc.y;
      doc.rect(L, y, W, 20).fill(C.soft);
      let x = L;
      for (const c of cols) {
        doc.fillColor(C.muted).font('b').fontSize(7.5).text(c.label.toUpperCase(), x + pad, y + 6.5, { width: c.width - pad * 2, align: c.align ?? 'left', lineBreak: false, characterSpacing: 0.4 });
        x += c.width;
      }
      doc.y = y + 20;
    };
    ensure(44);
    header();
    if (!rows.length) {
      doc.fillColor(C.faint).font('r').fontSize(9).text(pdfText(empty), L + pad, doc.y + 7, { width: W - pad * 2 });
      doc.y += 8;
      return;
    }
    for (const row of rows) {
      doc.font('r').fontSize(9);
      const texts = row.map((c) => pdfText(typeof c === 'string' ? c : c.text));
      const h = Math.max(20, ...texts.map((t, i) => doc.heightOfString(t || ' ', { width: cols[i]!.width - pad * 2 }) + 11));
      if (doc.y + h > bottom()) {
        doc.addPage();
        header();
      }
      const y = doc.y;
      let x = L;
      row.forEach((c, i) => {
        const col = cols[i]!;
        const cell = typeof c === 'string' ? { text: c } : c;
        doc.fillColor(cell.color ?? C.text).font(cell.bold ? 'b' : 'r').fontSize(9).text(texts[i]!, x + pad, y + 5.5, { width: col.width - pad * 2, align: col.align ?? 'left' });
        x += col.width;
      });
      doc.moveTo(L, y + h).lineTo(L + W, y + h).lineWidth(0.6).strokeColor(C.line).stroke();
      doc.y = y + h;
    }
    doc.y += 4;
  };

  // ---------------------------------------------------------------- conclusions
  if (d.aiSummary?.length) {
    section('AI xulosa va tavsiyalar');
    bulletList(d.aiSummary, C.review);
    doc.fillColor(C.faint).font('r').fontSize(7.5).text('Model faqat tavsiya beradi; raqamlar quyidagi jadvallardan olingan.', L + 14, doc.y, { width: W - 14 });
    doc.moveDown(0.6);
  }
  section('Xulosa');
  bulletList(d.insights, C.brand);

  // ---------------------------------------------------------------- task status bar
  const order = ['DONE', 'IN_PROGRESS', 'REVIEW', 'RETURNED', 'BLOCKED', 'NEW'];
  const total = order.reduce((a, k) => a + (d.statusCounts[k] ?? 0), 0);
  if (total) {
    section('Vazifalar holati', 80);
    const y = doc.y + 2;
    doc.save();
    doc.roundedRect(L, y, W, 12, 6).clip();
    let x = L;
    for (const k of order) {
      const n = d.statusCounts[k] ?? 0;
      if (!n) continue;
      const w = (n / total) * W;
      doc.rect(x, y, w + 0.5, 12).fill(STATUS[k]![1]);
      x += w;
    }
    doc.restore();
    let lx = L;
    const ly = y + 20;
    for (const k of order) {
      const n = d.statusCounts[k] ?? 0;
      if (!n) continue;
      const label = `${STATUS[k]![0]} ${n}`;
      doc.font('b').fontSize(8.5);
      const lw = doc.widthOfString(label) + 22;
      doc.roundedRect(lx, ly + 1.5, 8, 8, 2).fill(STATUS[k]![1]);
      doc.fillColor(C.text).text(label, lx + 12, ly, { lineBreak: false });
      lx += lw;
    }
    doc.y = ly + 20;
  }

  // ---------------------------------------------------------------- projects (company scope)
  if (d.scope === 'COMPANY') {
    section('Loyihalar');
    table(
      [
        { label: 'Loyiha', width: W - 330 },
        { label: 'Bajarildi', width: 66, align: 'right' },
        { label: 'Muddatida', width: 70, align: 'right' },
        { label: 'Ochiq', width: 60, align: 'right' },
        { label: 'Kechikkan', width: 68, align: 'right' },
        { label: 'Xabar', width: 66, align: 'right' },
      ],
      d.projects.map((p) => [
        { text: p.name, bold: true },
        String(p.done),
        p.onTimePct === null ? '—' : `${p.onTimePct}%`,
        String(p.open),
        { text: String(p.overdue), color: p.overdue ? C.danger : C.text, bold: p.overdue > 0 },
        String(p.messages),
      ]),
      'Bu davrda faol loyiha yo‘q',
    );
  }

  // ---------------------------------------------------------------- people
  section('Jamoa bo‘yicha');
  table(
    [
      { label: 'Ijrochi', width: W - 300 },
      { label: 'Bajardi', width: 60, align: 'right' },
      { label: 'Muddatida', width: 70, align: 'right' },
      { label: 'Ball', width: 50, align: 'right' },
      { label: 'Ochiq', width: 55, align: 'right' },
      { label: 'Kechikkan', width: 65, align: 'right' },
    ],
    d.people.map((p) => [
      { text: p.name, bold: true },
      String(p.done),
      p.done ? `${Math.round((p.onTime / p.done) * 100)}%` : '—',
      String(p.points),
      String(p.open),
      { text: String(p.overdue), color: p.overdue ? C.danger : C.text, bold: p.overdue > 0 },
    ]),
  );

  // ---------------------------------------------------------------- done work
  section(`Bajarilgan ishlar (${d.summary.done})`);
  const withProject = d.scope === 'COMPANY';
  table(
    [
      { label: '#', width: 38 },
      { label: 'Vazifa', width: W - 38 - 110 - 78 - 62 },
      { label: 'Ijrochi', width: 110 },
      { label: 'Yopildi', width: 78 },
      { label: 'Muddat', width: 62, align: 'right' },
    ],
    d.doneTasks.map((t) => [
      { text: String(t.number), color: C.faint },
      `${t.title}${t.format ? ` · ${t.format}` : ''}${withProject && t.project ? `\n${t.project}` : ''}${t.revision > 1 ? `  (R${t.revision})` : ''}`,
      t.assignee,
      dt(t.completedAt, tz),
      { text: t.onTime ? 'O‘z vaqtida' : 'Kech', color: t.onTime ? C.brand : C.warn, bold: true },
    ]),
    'Bu davrda yopilgan vazifa yo‘q',
  );

  // ---------------------------------------------------------------- open work
  if (d.openTasks.length) {
    section(`Ochiq vazifalar (${d.summary.open})`);
    table(
      [
        { label: '#', width: 38 },
        { label: 'Vazifa', width: W - 38 - 110 - 84 - 80 },
        { label: 'Ijrochi', width: 110 },
        { label: 'Deadline', width: 84 },
        { label: 'Holat', width: 80, align: 'right' },
      ],
      d.openTasks.map((t) => [
        { text: String(t.number), color: C.faint },
        `${t.title}${withProject && t.project ? `\n${t.project}` : ''}`,
        t.assignee,
        { text: dt(t.deadline, tz), color: t.overdue ? C.danger : C.text, bold: t.overdue },
        { text: STATUS[t.status]?.[0] ?? t.status, color: STATUS[t.status]?.[1] ?? C.text, bold: true },
      ]),
    );
  }

  // ---------------------------------------------------------------- shoots
  if (d.shoots.length) {
    section(`Syomkalar (${d.shoots.length})`);
    table(
      [
        { label: 'Sana', width: 90 },
        { label: 'Syomka', width: W - 90 - 130 - 90 },
        { label: 'Joy', width: 130 },
        { label: 'Holat', width: 90, align: 'right' },
      ],
      d.shoots.map((x) => [`${dayShort(x.day)}, ${x.start}`, `${x.title}${withProject && x.project ? `\n${x.project}` : ''}`, x.location ?? '—', SHOOT_STATUS[x.status] ?? x.status]),
    );
  }

  // ---------------------------------------------------------------- Telegram group
  if (d.scope === 'PROJECT' || d.chat.total) {
    section('Telegram guruh', 150);
    const ch = d.chat;
    if (!ch.total) {
      doc.fillColor(C.muted).font('r').fontSize(9.5).text(d.project?.chat ? 'Bu davrda guruhdan xabar saqlanmagan. Bot guruhda administrator bo‘lishi kerak.' : 'Loyihaga Telegram guruh ulanmagan (guruhda /bind).', L, doc.y, { width: W });
      doc.moveDown(0.8);
    } else {
      const facts = [`Jami ${ch.total}`, `Jamoa ${ch.team}`, `Mijoz tomoni ${ch.client}`, `Rasm ${ch.media.PHOTO ?? 0}`, `Video ${ch.media.VIDEO ?? 0}`, `Fayl ${ch.media.DOCUMENT ?? 0}`, `Ovozli ${ch.media.VOICE ?? 0}`];
      doc.fillColor(C.text).font('b').fontSize(9).text(facts.join('   ·   '), L, doc.y, { width: W });
      doc.moveDown(0.6);

      // Activity per day: stacked bars (team / client).
      const days = ch.byDay;
      const max = Math.max(1, ...days.map((x) => x.team + x.client));
      const chH = 64;
      ensure(chH + 34);
      const y0 = doc.y;
      const bw = W / Math.max(1, days.length);
      days.forEach((x, i) => {
        const bx = L + i * bw + (bw > 4 ? bw * 0.15 : 0);
        const w = Math.max(0.8, bw > 4 ? bw * 0.7 : bw);
        const th = (x.team / max) * chH;
        const clh = (x.client / max) * chH;
        if (th) doc.rect(bx, y0 + chH - th, w, th).fill(C.brand);
        if (clh) doc.rect(bx, y0 + chH - th - clh, w, clh).fill(C.info);
      });
      doc.moveTo(L, y0 + chH).lineTo(L + W, y0 + chH).lineWidth(0.6).strokeColor(C.line).stroke();
      doc.fillColor(C.faint).font('r').fontSize(7.5);
      if (days.length) {
        doc.text(dayShort(days[0]!.day), L, y0 + chH + 4, { lineBreak: false });
        doc.text(dayShort(days.at(-1)!.day), L, y0 + chH + 4, { width: W, align: 'right' });
      }
      doc.text(`kuniga eng ko‘p: ${max}`, L, y0 - 2, { width: W, align: 'right' });
      const ly = y0 + chH + 16;
      doc.rect(L, ly + 1.5, 8, 8).fill(C.brand);
      doc.fillColor(C.text).font('b').fontSize(8).text('Jamoa', L + 12, ly, { lineBreak: false });
      doc.rect(L + 60, ly + 1.5, 8, 8).fill(C.info);
      doc.fillColor(C.text).text('Mijoz tomoni', L + 72, ly, { lineBreak: false });
      doc.y = ly + 18;

      if (ch.senders.length) {
        doc.fillColor(C.muted).font('b').fontSize(8.5).text('Eng faol:', L, doc.y, { continued: true });
        doc.font('r').fillColor(C.text).text(`  ${ch.senders.map((x) => `${pdfText(x.name)}${x.isTeam ? '' : ' (mijoz)'} — ${x.n}`).join(',  ')}`, { width: W });
        doc.moveDown(0.6);
      }

      if (ch.clientMessages.length) {
        section('Mijoz xabarlari', 90);
        for (const m of ch.clientMessages) {
          const body = pdfText(m.text) || (m.kind === 'PHOTO' ? '[rasm]' : m.kind === 'VIDEO' ? '[video]' : m.kind === 'DOCUMENT' ? '[fayl]' : m.kind === 'VOICE' ? '[ovozli xabar]' : '[xabar]');
          doc.font('r').fontSize(9);
          const h = doc.heightOfString(body, { width: W - 16, lineGap: 1 }) + 18;
          ensure(h + 6);
          const y = doc.y;
          doc.roundedRect(L, y, 3, h - 4, 1.5).fill(C.info);
          doc.fillColor(C.muted).font('b').fontSize(8).text(`${pdfText(m.name)}  ·  ${dt(m.at, tz)}`, L + 12, y, { width: W - 12 });
          doc.fillColor(C.text).font('r').fontSize(9).text(body, L + 12, y + 12, { width: W - 16, lineGap: 1 });
          doc.y = y + h + 2;
        }
      }
      if (ch.links.length) {
        section('Havolalar', 50);
        for (const l of ch.links) {
          ensure(14);
          doc.fillColor(C.info).font('r').fontSize(8.5).text(l, L, doc.y, { width: W, link: l, lineBreak: false, ellipsis: true });
          doc.y += 2;
        }
        doc.moveDown(0.5);
      }
      if (ch.files.length) {
        section('Fayllar', 50);
        doc.fillColor(C.text).font('r').fontSize(8.5).text(ch.files.map(pdfText).join(',  '), L, doc.y, { width: W });
        doc.moveDown(0.6);
      }
    }
  }

  // ---------------------------------------------------------------- money
  if (d.finance) {
    section('Moliya (faqat rahbariyat uchun)', 90);
    const f = d.finance;
    const items: Array<[string, string, string]> = [
      [`${num(f.expected)}`, 'Kutilgan tushum, so‘m', C.ink],
      [`${num(f.received)}`, 'Tushgan, so‘m', C.brand],
      [`${num(f.debt)}`, 'Qarzdorlik, so‘m', f.debt ? C.danger : C.ink],
    ];
    const fw = (W - gap * 2) / 3;
    const fy = doc.y;
    items.forEach(([v, label, color], i) => {
      const x = L + i * (fw + gap);
      doc.roundedRect(x, fy, fw, 54, 10).fill(C.soft);
      doc.fillColor(color).font('h').fontSize(15).text(v, x + 12, fy + 10, { width: fw - 24, lineBreak: false });
      doc.fillColor(C.muted).font('b').fontSize(8).text(label, x + 12, fy + 34, { width: fw - 24, lineBreak: false });
    });
    doc.y = fy + 62;
  }

  // ---------------------------------------------------------------- footers
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const mb = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const fy = doc.page.height - 30;
    doc.moveTo(L, fy - 8).lineTo(L + W, fy - 8).lineWidth(0.5).strokeColor(C.line).stroke();
    doc.fillColor(C.faint).font('r').fontSize(7.5).text(`Retarget ERP  ·  ${pdfText(d.company)}  ·  ${periodLabel(d.period.from, d.period.to)}`, L, fy, { lineBreak: false });
    doc.text(`${i - range.start + 1} / ${range.count}`, L, fy, { width: W, align: 'right', lineBreak: false });
    doc.page.margins.bottom = mb;
  }
  doc.end();
  return done;
}
