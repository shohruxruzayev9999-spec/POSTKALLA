import { eq } from 'drizzle-orm';
import { users } from '../db/schema.js';
import type { Ctx, ResolvedActor } from './context.js';
import { renderReportPdf, reportFileName } from './reportPdf.js';
import { buildReport, type ReportQuery } from './reports.js';

export async function reportPdf(ctx: Ctx, actor: ResolvedActor, q: ReportQuery) {
  const data = await buildReport(ctx, actor, { ...q, ai: true });
  return { data, fileName: reportFileName(data), pdf: await renderReportPdf(data) };
}

/** Builds the PDF and sends it to the requester's Telegram chat. */
export async function sendReport(ctx: Ctx, actor: ResolvedActor, q: ReportQuery) {
  const { data, fileName, pdf } = await reportPdf(ctx, actor, q);
  const [u] = await ctx.db.select({ telegramId: users.telegramId }).from(users).where(eq(users.id, actor.userId));
  const title = data.project?.name ?? data.company;
  const s = data.summary;
  const caption = `📊 <b>${title.replace(/[<>&]/g, '')}</b> — hisobot\n${data.period.from} … ${data.period.to}\nBajarildi: ${s.done}${s.onTimePct !== null ? ` (${s.onTimePct}% muddatida)` : ''} · Kechikkan: ${s.overdue}`;
  await ctx.notifier.sendDocument(u!.telegramId, pdf, fileName, caption);
  return { ok: true, fileName, bytes: pdf.byteLength };
}
