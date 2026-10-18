import { eq } from 'drizzle-orm';
import { Bot } from 'grammy';
import { describe, expect, it } from 'vitest';
import { tasks, users } from '../db/schema.js';
import { agency } from '../test/fixtures.js';
import { createTask } from '../services/tasks.js';
import { registerHandlers } from './bot.js';

/** A bot wired to the test database with the Telegram API replaced by a recorder. */
async function harness() {
  const a = await agency(); // Mon 21 Sep 2026, 10:00 Tashkent
  await a.db.update(users).set({ username: 'aziz_design' }).where(eq(users.id, a.users.aziz.id));
  const bot = new Bot('1:test', { botInfo: { id: 1, is_bot: true, first_name: 'Postkalla', username: 'postkallabot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never });
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  let mid = 500;
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const chat = { id: (payload as { chat_id?: number }).chat_id ?? 0, type: 'private' };
    return { ok: true, result: method === 'sendMessage' ? { message_id: ++mid, date: 0, chat, text: (payload as { text: string }).text } : true } as never;
  });
  registerHandlers(bot, a.ctx, 'postkallabot');
  let uid = 1;
  const from = (u: { telegramId: number; firstName: string }) => ({ id: u.telegramId, is_bot: false, first_name: u.firstName });
  const send = (u: { telegramId: number; firstName: string }, text: string, extra: Record<string, unknown> = {}, chat: Record<string, unknown> = { id: u.telegramId, type: 'private' }) =>
    bot.handleUpdate({
      update_id: uid++,
      message: { message_id: uid, date: 0, chat, from: from(u), text, ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] } : {}), ...extra },
    } as never);
  const press = (u: { telegramId: number; firstName: string }, data: string) =>
    bot.handleUpdate({ update_id: uid++, callback_query: { id: String(uid), from: from(u), chat_instance: 'x', data, message: { message_id: mid, date: 0, chat: { id: u.telegramId, type: 'private' }, text: '' } } } as never);
  const lastButtons = () => {
    const m = [...calls].reverse().find((c) => c.method === 'sendMessage' && (c.payload.reply_markup as { inline_keyboard?: unknown })?.inline_keyboard);
    return ((m?.payload.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> }).inline_keyboard ?? []).flat();
  };
  return { a, bot, calls, send, press, lastButtons };
}

describe('bot: tasks from Telegram', () => {
  it('/task → draft → quick deadline → Saqlash creates the task', async () => {
    const h = await harness();
    await h.send(h.a.users.head, '/task ertaga 17:00 @aziz_design Kuz kolleksiyasi posteri');
    const draft = h.calls.find((c) => c.method === 'sendMessage')!;
    expect(draft.payload.text).toContain('Vazifa qoralamasi');
    expect(draft.payload.text).toContain('Kuz kolleksiyasi posteri');
    expect(draft.payload.text).toContain('Aziz');
    const buttons = h.lastButtons();
    expect(buttons.map((b) => b.text)).toEqual(expect.arrayContaining(['✅ Saqlash', '✖️ Bekor', '⏰ Ertaga 10:00']));

    // Someone else cannot press the author's buttons.
    const save = buttons.find((b) => b.text === '✅ Saqlash')!.callback_data!;
    await h.press(h.a.users.bekzod, save);
    expect(h.calls.at(-1)).toMatchObject({ method: 'answerCallbackQuery', payload: { show_alert: true } });

    await h.press(h.a.users.head, buttons.find((b) => b.text === '⏰ Ertaga 10:00')!.callback_data!);
    expect(h.calls.find((c) => c.method === 'editMessageText')!.payload.text).toContain('10:00');
    await h.press(h.a.users.head, save);
    const [t] = await h.a.db.select().from(tasks);
    expect(t).toMatchObject({ title: 'Kuz kolleksiyasi posteri', assigneeUserId: h.a.users.aziz.id, createdBy: h.a.users.head.id });
    expect(t!.deadline.toISOString()).toBe('2026-09-22T05:00:00.000Z'); // Tue 10:00
    expect(String(h.calls.filter((c) => c.method === 'editMessageText').at(-1)!.payload.text)).toContain('yaratildi');
    // Pressing again does nothing new.
    await h.press(h.a.users.head, save);
    expect(await h.a.db.select().from(tasks)).toHaveLength(1);
  });

  it('a forwarded message becomes a draft; "Bekor" drops it', async () => {
    const h = await harness();
    await h.send(h.a.users.aziz, 'Ertangi syomka uchun ssenariy kerak', { forward_origin: { type: 'user', date: 0, sender_user: { id: 77, is_bot: false, first_name: 'Mijoz' } } });
    const draft = h.calls.find((c) => c.method === 'sendMessage')!;
    expect(draft.payload.text).toContain('Ertangi syomka uchun ssenariy kerak');
    await h.press(h.a.users.aziz, h.lastButtons().find((b) => b.text === '✖️ Bekor')!.callback_data!);
    expect(await h.a.db.select().from(tasks)).toHaveLength(0);
  });

  it('/my lists open work; in a group it points to the private chat', async () => {
    const h = await harness();
    const head = await h.a.actor(h.a.users.head.id);
    await createTask(h.a.ctx, head, { title: 'Banner A', assigneeUserId: h.a.users.aziz.id, deadline: new Date(h.a.clock.t.getTime() + 86_400_000) });
    await h.send(h.a.users.aziz, '/my');
    expect(h.calls.at(-1)!.payload.text).toContain('Banner A');
    await h.send(h.a.users.aziz, '/due');
    expect(h.calls.at(-1)!.payload.text).toContain('Banner A');
    await h.send(h.a.users.aziz, '/my', {}, { id: -100, type: 'supergroup', title: 'G' });
    expect(h.calls.at(-1)!.payload.text).toContain('shaxsiy');
  });

  it('a hint instead of a draft when /task has no text', async () => {
    const h = await harness();
    await h.send(h.a.users.head, '/task');
    expect(h.calls.at(-1)!.payload.text).toContain('/task ertaga 17:00');
  });
});
