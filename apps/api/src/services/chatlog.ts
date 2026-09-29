import { and, eq } from 'drizzle-orm';
import { chatMessages, memberships, projects, users } from '../db/schema.js';
import type { Ctx } from './context.js';

/** The part of a Telegram message the log needs (structurally compatible with grammY's Message). */
export interface IncomingMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string };
  from?: { id: number; is_bot: boolean; first_name: string; last_name?: string; username?: string };
  text?: string;
  caption?: string;
  photo?: unknown[];
  video?: unknown;
  video_note?: unknown;
  animation?: unknown;
  document?: { file_name?: string };
  voice?: unknown;
  audio?: { file_name?: string; title?: string };
}

function kindOf(m: IncomingMessage): string {
  if (m.photo?.length) return 'PHOTO';
  if (m.video || m.video_note || m.animation) return 'VIDEO';
  if (m.document) return 'DOCUMENT';
  if (m.voice || m.audio) return 'VOICE';
  if (m.text) return 'TEXT';
  return 'OTHER';
}

/**
 * Keeps a message from a project group. Unbound chats, bots and commands are ignored; a message
 * is stored once even if Telegram delivers it twice.
 */
export async function recordGroupMessage(ctx: Ctx, m: IncomingMessage): Promise<boolean> {
  if (!m.from || m.from.is_bot) return false;
  if (m.text?.startsWith('/')) return false;
  const [p] = await ctx.db
    .select({ id: projects.id, companyId: projects.companyId })
    .from(projects)
    .where(eq(projects.telegramChatId, m.chat.id));
  if (!p) return false;

  const [u] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.telegramId, m.from.id));
  let isTeam = false;
  if (u) {
    const [mem] = await ctx.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.userId, u.id), eq(memberships.companyId, p.companyId), eq(memberships.status, 'ACTIVE')));
    isTeam = !!mem;
  }
  const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || (m.from.username ? `@${m.from.username}` : 'Nomaʼlum');
  const rows = await ctx.db
    .insert(chatMessages)
    .values({
      companyId: p.companyId,
      projectId: p.id,
      chatId: m.chat.id,
      messageId: m.message_id,
      fromTelegramId: m.from.id,
      fromName: name.slice(0, 120),
      userId: u?.id ?? null,
      isTeam,
      kind: kindOf(m),
      text: (m.text ?? m.caption ?? '').slice(0, 4000),
      fileName: m.document?.file_name ?? m.audio?.file_name ?? null,
      sentAt: new Date(m.date * 1000),
    })
    .onConflictDoNothing()
    .returning({ id: chatMessages.id });
  return rows.length > 0;
}
