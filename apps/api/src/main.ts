import { Bot } from 'grammy';
import { markBlocked, registerHandlers, TelegramNotifier } from './bot/bot.js';
import { connect } from './db/client.js';
import { buildServer } from './http/server.js';
import { runReminders } from './jobs/reminders.js';
import type { Ctx } from './services/context.js';

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing env ${name}`);
  return v;
}

async function main() {
  const botToken = env('BOT_TOKEN');
  const jwtSecret = env('JWT_SECRET');
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  const { db, close } = await connect(env('DATABASE_URL'));

  const bot = new Bot(botToken);
  await bot.init();
  const botUsername = bot.botInfo.username;

  const ctx: Ctx = { db, now: () => new Date(), notifier: null as never };
  ctx.notifier = new TelegramNotifier(bot.api, botUsername, (id) => markBlocked(ctx, id));
  registerHandlers(bot, ctx, botUsername);

  const app = buildServer(ctx, {
    botToken,
    botUsername,
    jwtSecret,
    corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    devLogin: process.env.DEV_LOGIN === '1' && process.env.NODE_ENV !== 'production',
  });
  await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 8080) });

  await bot.api.setMyCommands([{ command: 'start', description: 'Ilovani ochish' }]).catch(() => undefined);
  await bot.api
    .setMyCommands([{ command: 'bind', description: 'Guruhni loyihaga ulash' }], { scope: { type: 'all_group_chats' } })
    .catch(() => undefined);
  if (process.env.WEBAPP_URL) {
    await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Ochish', web_app: { url: process.env.WEBAPP_URL } } }).catch(() => undefined);
  }

  // Reminder worker: every minute, never overlapping.
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const r = await runReminders(ctx);
      if (r.sent || r.skipped) app.log.info(r, 'reminders');
    } catch (e) {
      app.log.error(e, 'reminders failed');
    } finally {
      running = false;
    }
  }, 60_000);

  void bot.start({ allowed_updates: ['message', 'callback_query', 'my_chat_member'], onStart: () => app.log.info(`bot @${botUsername} polling`) });

  const shutdown = async () => {
    clearInterval(timer);
    await bot.stop();
    await app.close();
    await close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
