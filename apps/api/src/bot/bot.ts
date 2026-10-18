import { DomainError, QUICK_DEADLINES, canAccess, quickDeadline, quickDeadlineLabel, type QuickDeadline, type TaskAction } from '@retarget/shared';
import { and, eq } from 'drizzle-orm';
import { Bot, GrammyError, InlineKeyboard, InputFile, type Api, type Context } from 'grammy';
import type { Message } from 'grammy/types';
import { findUserByTelegram, upsertTelegramUser } from '../auth/telegram.js';
import { companies, memberships, projects, tasks, users } from '../db/schema.js';
import { confirmDraft, draftFromTelegram, myOpenTasks, switchDraftCompany, type CaptureInput, type TaskDraft } from '../services/capture.js';
import { loadActor, scheduleOf, type Ctx } from '../services/context.js';
import type { Notifier, ReminderDelivery, SentMessage, TaskCard } from '../services/notifier.js';
import { bindChat } from '../services/projects.js';
import { recordGroupMessage } from '../services/chatlog.js';
import { decidePayment } from '../services/billing.js';
import { actOnTask, addTaskFile, taskCard } from '../services/tasks.js';
import { cardText, draftText, esc, myTasksText, reminderText } from './format.js';

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

  async paymentRequest(telegramId: number, text: string, requestId: string): Promise<void> {
    const kb = new InlineKeyboard().text('✅ To‘landi', `pay:${requestId}:ok`).text('✖️ Bekor', `pay:${requestId}:no`);
    await this.dm(telegramId, text, kb);
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

/** Task drafts waiting for "Saqlash" (from /task or a forward). In-memory: single process, 1 day. */
const drafts = new Map<string, { draft: TaskDraft; ownerTg: number; at: number }>();
let draftSeq = 0;

function draftKeyboard(key: string, d: TaskDraft, schedule: Parameters<typeof quickDeadlineLabel>[1]): InlineKeyboard {
  const kb = new InlineKeyboard().text('✅ Saqlash', `cap:${key}:ok`).text('✖️ Bekor', `cap:${key}:no`).row();
  QUICK_DEADLINES.forEach((q, i) => {
    kb.text(`⏰ ${quickDeadlineLabel(q, schedule)}`, `cap:${key}:due:${q}`);
    if (i % 2 === 1) kb.row();
  });
  if (!d.projectId && d.companyOptions.length > 1) {
    for (const [i, o] of d.companyOptions.entries()) if (o.id !== d.companyId) kb.row().text(`🏢 ${o.name}`, `cap:${key}:co:${i}`);
  }
  return kb;
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

  // ------------------------------------------------------------------ tasks from Telegram
  async function scheduleFor(companyId: string) {
    const [c] = await ctx.db.select().from(companies).where(eq(companies.id, companyId));
    return scheduleOf(c!);
  }

  async function sendDraft(c: Context, input: CaptureInput) {
    try {
      const draft = await draftFromTelegram(ctx, input);
      const key = `${Date.now().toString(36)}${(++draftSeq).toString(36)}`;
      drafts.set(key, { draft, ownerTg: input.telegramId, at: Date.now() });
      const schedule = await scheduleFor(draft.companyId);
      await c.reply(draftText(draft, ctx.now()), {
        parse_mode: 'HTML',
        reply_markup: draftKeyboard(key, draft, schedule),
        reply_parameters: c.message ? { message_id: c.message.message_id, allow_sending_without_reply: true } : undefined,
        link_preview_options: { is_disabled: true },
      });
    } catch (e) {
      await c.reply(errorText(e));
    }
  }

  /** The message replied to or forwarded, as capture input. */
  function sourceOf(m: Message): CaptureInput['source'] {
    const text = m.text ?? m.caption ?? '';
    if (!text.trim()) return null;
    const o = m.forward_origin;
    if (o) {
      const author = o.type === 'user' ? [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(' ') : o.type === 'hidden_user' ? o.sender_user_name : o.type === 'chat' ? ('title' in o.sender_chat ? o.sender_chat.title ?? null : null) : o.type === 'channel' ? ('title' in o.chat ? o.chat.title ?? null : null) : null;
      return { text, author, authorTelegramId: o.type === 'user' ? o.sender_user.id : null };
    }
    return { text, author: m.from ? [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') : null, authorTelegramId: m.from && !m.from.is_bot ? m.from.id : null };
  }

  bot.command('task', async (c) => {
    if (!c.from || !c.message) return;
    const reply = c.message.reply_to_message;
    await sendDraft(c, {
      telegramId: c.from.id,
      text: typeof c.match === 'string' ? c.match : '',
      source: reply ? sourceOf(reply) : null,
      groupChatId: c.chat.type === 'private' ? null : c.chat.id,
    });
  });

  for (const mode of ['my', 'due'] as const) {
    bot.command(mode, async (c) => {
      if (!c.from) return;
      if (c.chat.type !== 'private') {
        await c.reply(`Ro‘yxat shaxsiy: @${botUsername} ga /${mode} deb yozing.`);
        return;
      }
      try {
        const rows = await myOpenTasks(ctx, c.from.id, mode);
        await c.reply(myTasksText(rows, mode, ctx.now()), {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().url('📱 Ilovada ochish', appLink(botUsername)),
          link_preview_options: { is_disabled: true },
        });
      } catch (e) {
        await c.reply(errorText(e));
      }
    });
  }

  bot.callbackQuery(/^cap:([0-9a-z]+):(ok|no|due|co)(?::([A-Z_0-9]+))?$/, async (c) => {
    const [, key, op, arg] = c.match;
    const held = drafts.get(key!);
    try {
      if (!held) throw new DomainError('NOT_FOUND', 'Qoralama eskirgan — /task ni qayta yuboring');
      if (held.ownerTg !== c.from.id) throw new DomainError('FORBIDDEN', 'Faqat qoralama muallifi');
      if (op === 'no') {
        drafts.delete(key!);
        await c.editMessageText('✖️ Bekor qilindi').catch(() => undefined);
        return void (await c.answerCallbackQuery());
      }
      if (op === 'ok') {
        const t = await confirmDraft(ctx, held.draft);
        drafts.delete(key!);
        await c.editMessageText(`✅ <b>#${t.number} · ${esc(t.title)}</b> yaratildi`, {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().url('📱 Ochish', appLink(botUsername, `task_${t.id}`)),
        }).catch(() => undefined);
        return void (await c.answerCallbackQuery({ text: '✔️ Saqlandi' }));
      }
      if (op === 'due') {
        if (!(QUICK_DEADLINES as readonly string[]).includes(arg ?? '')) throw new DomainError('VALIDATION', 'Noma’lum muddat');
        held.draft = { ...held.draft, deadline: quickDeadline(arg as QuickDeadline, ctx.now(), await scheduleFor(held.draft.companyId)), deadlineSet: true };
      }
      if (op === 'co') {
        const o = held.draft.companyOptions[Number(arg)];
        if (!o) throw new DomainError('NOT_FOUND', 'Kompaniya topilmadi');
        held.draft = await switchDraftCompany(ctx, held.draft, o.id);
      }
      await c.editMessageText(draftText(held.draft, ctx.now()), {
        parse_mode: 'HTML',
        reply_markup: draftKeyboard(key!, held.draft, await scheduleFor(held.draft.companyId)),
        link_preview_options: { is_disabled: true },
      }).catch(() => undefined);
      await c.answerCallbackQuery();
    } catch (e) {
      await c.answerCallbackQuery({ text: errorText(e), show_alert: true });
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

  // ------------------------------------------------------------------ payment confirmations (platform admins)
  bot.callbackQuery(/^pay:([0-9a-f-]{36}):(ok|no)$/, async (c) => {
    try {
      const user = await findUserByTelegram(ctx.db, c.from.id);
      if (!user) throw new DomainError('FORBIDDEN', 'Ruxsat yo‘q');
      const decision = c.match[2] === 'ok' ? 'PAID' : 'CANCELLED';
      const r = await decidePayment(ctx, user.id, c.match[1]!, decision);
      const mark = decision === 'PAID' ? `✅ Tasdiqlandi — ${r.request.paidUntil} gacha` : '✖️ Bekor qilindi';
      const original = c.callbackQuery.message && 'text' in c.callbackQuery.message ? (c.callbackQuery.message.text ?? '') : '';
      await c.editMessageText(`${esc(original)}\n\n<b>${mark}</b>`, { parse_mode: 'HTML' }).catch(() => undefined);
      await c.answerCallbackQuery({ text: mark });
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

  // A message forwarded to the bot becomes a task draft.
  bot.on('message', async (c, next) => {
    if (c.chat.type !== 'private' || !c.from || !c.message.forward_origin) return next();
    const source = sourceOf(c.message);
    if (!source) return c.reply('Matnli xabarni forward qiling — undan vazifa qoralamasi tayyorlanadi.');
    await sendDraft(c, { telegramId: c.from.id, text: '', source });
  });

  // Housekeeping: forget prompts nobody answered within a day.
  setInterval(() => {
    const cutoff = Date.now() - 86_400_000;
    for (const [k, v] of pendingComments) if (v.at < cutoff) pendingComments.delete(k);
    for (const [k, v] of drafts) if (v.at < cutoff) drafts.delete(k);
  }, 3_600_000).unref();

  bot.catch((err) => console.error('[bot]', err.error));
}

export async function markBlocked(ctx: Ctx, telegramId: number) {
  await ctx.db.update(users).set({ canDm: false }).where(eq(users.telegramId, telegramId));
}

