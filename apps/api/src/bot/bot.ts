import { DomainError, canAccess, type TaskAction } from '@retarget/shared';
import { and, eq } from 'drizzle-orm';
import { Bot, GrammyError, InlineKeyboard, InputFile, type Api, type Context } from 'grammy';
import { findUserByTelegram, upsertTelegramUser } from '../auth/telegram.js';
import { memberships, projects, tasks, users } from '../db/schema.js';
import { loadActor, type Ctx } from '../services/context.js';
import type { Notifier, ReminderDelivery, SentMessage, TaskCard } from '../services/notifier.js';
import { bindChat } from '../services/projects.js';
import { recordGroupMessage } from '../services/chatlog.js';
import { actOnTask, addTaskFile, taskCard } from '../services/tasks.js';
import { cardText, esc, reminderText } from './format.js';

const ACTION_BUTTON: Partial<Record<string, Array<[string, TaskAction]>>> = {
  NEW: [['▶️ Boshlash', 'START']],
  RETURNED: [['▶️ Qayta boshlash', 'START']],
  BLOCKED: [['▶️ Davom ettirish', 'START']],
  IN_PROGRESS: [
    ['📤 Topshirish', 'SUBMIT'],
    ['⛔ Bloklandi', 'BLOCK'],
  ],
  REVIEW: [
    ['✅ Qabul', 'APPROVE'],
    ['↩️ Qaytarish', 'RETURN'],
  ],
};

export function appLink(botUsername: string, param?: string) {
  return `https://t.me/${botUsername}/app${param ? `?startapp=${param}` : ''}`;
}

function keyboard(card: TaskCard, botUsername: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const [label, action] of ACTION_BUTTON[card.status] ?? []) kb.text(label, `t:${card.id}:${action}`);
  kb.row().url('📱 Batafsil', appLink(botUsername, `task_${card.id}`));
  return kb;
}

const ignorable = (e: unknown) => e instanceof GrammyError && /message is not modified|message to delete not found|message can't be deleted/.test(e.description);

/** The Telegram side of {@link Notifier}. */
export class TelegramNotifier implements Notifier {
  constructor(
    private api: Api,
    private botUsername: string,
    private onBlocked: (telegramId: number) => Promise<void> = async () => {},
  ) {}

  async upsertTaskCard(card: TaskCard): Promise<SentMessage | null> {
    if (!card.groupChatId) return null;
    const opts = { parse_mode: 'HTML' as const, reply_markup: keyboard(card, this.botUsername), link_preview_options: { is_disabled: true } };
    if (card.groupMessageId) {
      try {
        await this.api.editMessageText(card.groupChatId, card.groupMessageId, cardText(card), opts);
        return { chatId: card.groupChatId, messageId: card.groupMessageId };
      } catch (e) {
        if (ignorable(e)) return { chatId: card.groupChatId, messageId: card.groupMessageId };
        // Deleted or too old to edit: post a fresh card below.
      }
    }
    const m = await this.api.sendMessage(card.groupChatId, cardText(card), opts);
    return { chatId: m.chat.id, messageId: m.message_id };
  }

  async taskChanged(card: TaskCard, action: TaskAction, actorName: string, comment: string | null): Promise<void> {
    const head = `<b>#${card.number} · ${esc(card.title)}</b>`;
    const note = comment ? `\n💬 ${esc(comment)}` : '';
    const link = new InlineKeyboard().url('📱 Ochish', appLink(this.botUsername, `task_${card.id}`));
    const send = (to: number, text: string) => this.dm(to, text, link);
    if (action === 'SUBMIT' && card.reviewer) await send(card.reviewer.telegramId, `👀 Tekshiruvga keldi: ${head}\nIjrochi: ${esc(card.assignee.name)}`);
    if (action === 'RETURN') await send(card.assignee.telegramId, `↩️ Qaytarildi (R${card.revision}): ${head}\n${esc(actorName)}${note}`);
    if (action === 'APPROVE') await send(card.assignee.telegramId, `✅ Qabul qilindi: ${head}\n${esc(actorName)} — rahmat!`);
    if (action === 'BLOCK' && card.reviewer) await send(card.reviewer.telegramId, `⛔ Bloklandi: ${head}\n${esc(card.assignee.name)}${note}`);
  }

  async sendReminder(d: ReminderDelivery): Promise<SentMessage[]> {
    for (const p of d.previous) await this.api.deleteMessage(p.chatId, p.messageId).catch(() => undefined);
    const text = reminderText(d.card, d.step);
    const kb = new InlineKeyboard().url('📱 Ochish', appLink(this.botUsername, `task_${d.card.id}`));
    const out: SentMessage[] = [];
    const targets = [...new Set([...d.privateChatIds, ...(d.includeGroup && d.card.groupChatId ? [d.card.groupChatId] : [])])];
    for (const chatId of targets) {
      try {
        const m = await this.api.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb, link_preview_options: { is_disabled: true } });
        out.push({ chatId, messageId: m.message_id });
      } catch (e) {
        if (e instanceof GrammyError && e.error_code === 403 && chatId > 0) await this.onBlocked(chatId);
        else console.error('[bot] reminder failed', chatId, e);
      }
    }
    return out;
  }

  async direct(telegramId: number, text: string, button?: { text: string; startParam?: string }): Promise<void> {
    const kb = button ? new InlineKeyboard().url(button.text, appLink(this.botUsername, button.startParam)) : undefined;
    await this.dm(telegramId, text, kb);
  }

  private async dm(telegramId: number, text: string, kb?: InlineKeyboard): Promise<void> {
    try {
      await this.api.sendMessage(telegramId, text, { parse_mode: 'HTML', reply_markup: kb, link_preview_options: { is_disabled: true } });
    } catch (e) {
      if (e instanceof GrammyError && e.error_code === 403) await this.onBlocked(telegramId);
      else throw e;
    }
  }

  async sendDocument(telegramId: number, file: Uint8Array, fileName: string, caption: string): Promise<void> {
    try {
      await this.api.sendDocument(telegramId, new InputFile(file, fileName), { caption, parse_mode: 'HTML' });
    } catch (e) {
      if (e instanceof GrammyError && e.error_code === 403) {
        await this.onBlocked(telegramId);
        throw new DomainError('VALIDATION', 'Bot sizga yoza olmaydi: botni oching va /start bosing');
      }
      throw e;
    }
  }
}

/** Waiting for a comment typed as a reply (RETURN / BLOCK from a group). In-memory: single process. */
const pendingComments = new Map<string, { taskId: string; action: TaskAction; userTg: number; at: number }>();

export function registerHandlers(bot: Bot, ctx: Ctx, botUsername: string) {
  const errorText = (e: unknown) => (e instanceof DomainError ? e.message : 'Xatolik yuz berdi');

  /** Resolve the pressing user as an actor in the task's company. */
  async function actorForTask(from: { id: number }, taskId: string) {
    const user = await findUserByTelegram(ctx.db, from.id);
    if (!user) throw new DomainError('FORBIDDEN', 'Avval botni oching va ro‘yxatdan o‘ting');
    const [t] = await ctx.db.select({ companyId: tasks.companyId }).from(tasks).where(eq(tasks.id, taskId));
    if (!t) throw new DomainError('NOT_FOUND', 'Vazifa topilmadi');
    return loadActor(ctx.db, user.id, t.companyId);
  }

  // Every message in a bound project group is kept for reports (needs admin rights or privacy mode off).
  bot.use(async (c, next) => {
    if (c.message && c.chat && c.chat.type !== 'private') {
      await recordGroupMessage(ctx, c.message).catch((e) => console.error('[bot] chat log', e));
    }
    return next();
  });

  bot.command('start', async (c) => {
    if (c.chat.type !== 'private' || !c.from) return;
    const u = await upsertTelegramUser(ctx.db, { id: c.from.id, first_name: c.from.first_name, last_name: c.from.last_name, username: c.from.username, language_code: c.from.language_code });
    await ctx.db.update(users).set({ canDm: true }).where(eq(users.id, u.id));
    await c.reply(
      `Assalomu alaykum, ${esc(u.firstName)}! 👋\n\nRetarget ERP — vazifalar, KPI, davomat va loyihalar bir joyda.\nIlovani ochish uchun pastdagi tugmani bosing.`,
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().url('🚀 Ilovani ochish', appLink(botUsername)) },
    );
  });

  bot.on('my_chat_member', async (c) => {
    if (c.chat.type === 'private' && ['kicked', 'left'].includes(c.myChatMember.new_chat_member.status)) {
      await ctx.db.update(users).set({ canDm: false }).where(eq(users.telegramId, c.chat.id));
    }
  });

  // ------------------------------------------------------------------ bind a group to a project
  bot.command('bind', async (c) => {
    if (c.chat.type === 'private' || !c.from) return c.reply('Bu buyruq guruhda ishlaydi: botni loyiha guruhiga qo‘shing va /bind yozing.');
    const member = await c.getChatMember(c.from.id);
    if (!['creator', 'administrator'].includes(member.status)) return c.reply('Faqat guruh administratori loyihani ulay oladi.');
    const user = await findUserByTelegram(ctx.db, c.from.id);
    if (!user) return c.reply(`Avval @${botUsername} ni oching.`);
    const rows = await ctx.db
      .select({ p: projects })
      .from(projects)
      .innerJoin(memberships, and(eq(memberships.companyId, projects.companyId), eq(memberships.userId, user.id), eq(memberships.status, 'ACTIVE')))
      .where(eq(projects.status, 'ACTIVE'));
    const kb = new InlineKeyboard();
    let n = 0;
    for (const { p } of rows) {
      const actor = await loadActor(ctx.db, user.id, p.companyId);
      if (!canAccess(actor, 'project.manage', { companyId: p.companyId, projectId: p.id })) continue;
      kb.text(p.name, `bind:${p.id}`).row();
      if (++n >= 30) break;
    }
    if (!n) return c.reply('Siz boshqaradigan faol loyiha topilmadi.');
    return c.reply('Bu guruhni qaysi loyihaga ulaymiz?', { reply_markup: kb });
  });

  bot.callbackQuery(/^bind:([0-9a-f-]{36})$/, async (c) => {
    try {
      if (!c.chat || c.chat.type === 'private') return;
      const member = await c.getChatMember(c.from.id);
      if (!['creator', 'administrator'].includes(member.status)) throw new DomainError('FORBIDDEN', 'Faqat guruh administratori');
      const user = await findUserByTelegram(ctx.db, c.from.id);
      const [p] = await ctx.db.select().from(projects).where(eq(projects.id, c.match[1]!));
      if (!user || !p) throw new DomainError('NOT_FOUND', 'Loyiha topilmadi');
      const actor = await loadActor(ctx.db, user.id, p.companyId);
      await bindChat(ctx, actor, p.id, c.chat.id, 'title' in c.chat ? (c.chat.title ?? '') : '');
      await c.editMessageText(`✅ Guruh «${esc(p.name)}» loyihasiga ulandi. Yangi vazifalar shu yerda tugmalari bilan chiqadi.`, { parse_mode: 'HTML' });
      await c.answerCallbackQuery();
    } catch (e) {
      await c.answerCallbackQuery({ text: errorText(e), show_alert: true });
    }
  });

  // ------------------------------------------------------------------ status buttons
  bot.callbackQuery(/^t:([0-9a-f-]{36}):([A-Z_]+)$/, async (c) => {
    const taskId = c.match[1]!;
    const action = c.match[2] as TaskAction;
    try {
      const actor = await actorForTask(c.from, taskId);
      if (action === 'RETURN' || action === 'BLOCK') {
        const card = await taskCard(ctx.db, taskId);
        const prompt = action === 'RETURN' ? 'qaytarish sababini' : 'nima to‘sqinlik qilayotganini';
        const target = c.chat?.id ?? c.from.id;
        const m = await c.api.sendMessage(target, `✍️ ${c.from.first_name}, #${card.number} uchun ${prompt} shu xabarga javob qilib yozing.`, {
          reply_markup: { force_reply: true, selective: true },
        });
        pendingComments.set(`${target}:${m.message_id}`, { taskId, action, userTg: c.from.id, at: Date.now() });
        await c.answerCallbackQuery();
        return;
      }
      await actOnTask(ctx, actor, taskId, action);
      await c.answerCallbackQuery({ text: '✔️ Bajarildi' });
    } catch (e) {
      await c.answerCallbackQuery({ text: errorText(e), show_alert: true });
    }
  });

  bot.on('message', async (c, next) => {
    const reply = c.message.reply_to_message;
    if (!reply || !c.from) return next();

    // A comment for RETURN / BLOCK.
    const key = `${c.chat.id}:${reply.message_id}`;
    const pending = pendingComments.get(key);
    if (pending && pending.userTg === c.from.id && c.message.text) {
      pendingComments.delete(key);
      try {
        const actor = await actorForTask(c.from, pending.taskId);
        await actOnTask(ctx, actor, pending.taskId, pending.action, c.message.text);
        await c.api.deleteMessage(c.chat.id, reply.message_id).catch(() => undefined);
        await c.react('👍').catch(() => undefined);
      } catch (e) {
        await c.reply(errorText(e));
      }
      return;
    }

    // A result file sent as a reply to the task card.
    const file = c.message.document ?? c.message.video ?? c.message.photo?.at(-1);
    if (file) {
      const [t] = await ctx.db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.groupChatId, c.chat.id), eq(tasks.groupMessageId, reply.message_id)));
      if (!t) return next();
      try {
        const actor = await actorForTask(c.from, t.id);
        const kind = c.message.document ? 'document' : c.message.video ? 'video' : 'photo';
        await addTaskFile(ctx, actor, t.id, { telegramFileId: file.file_id, fileName: c.message.document?.file_name ?? undefined, kind });
        await c.react('👌').catch(() => undefined);
      } catch (e) {
        await c.reply(errorText(e));
      }
      return;
    }
    return next();
  });

  // Housekeeping: forget prompts nobody answered within a day.
  setInterval(() => {
    const cutoff = Date.now() - 86_400_000;
    for (const [k, v] of pendingComments) if (v.at < cutoff) pendingComments.delete(k);
  }, 3_600_000).unref();

  bot.catch((err) => console.error('[bot]', err.error));
}

export async function markBlocked(ctx: Ctx, telegramId: number) {
  await ctx.db.update(users).set({ canDm: false }).where(eq(users.telegramId, telegramId));
}

